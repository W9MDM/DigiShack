/* eslint-disable no-console */
// Checks for the SQL literal writer and statement splitter behind database backup.
// Run: npm run check:backup
//
// Nothing here touches a database. These two functions are the whole correctness
// risk of a hand-rolled dump: get the escaping wrong and the restore either fails
// loudly or — far worse — succeeds with mangled data, and nobody looks at a backup
// until they need it.

import { splitStatements, sqlLiteral } from "../lib/db/backup";
import { gunzipSync, gzipSync } from "node:zlib";
import { tarPack, tarUnpack } from "@/lib/db/tar";

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail = ""): void {
  if (cond) {
    pass++;
    console.log(`  ok    ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("\nSQL literals");
{
  ok(sqlLiteral(null) === "NULL", "null becomes NULL, unquoted");
  ok(sqlLiteral(undefined) === "NULL", "undefined too");
  ok(sqlLiteral(42) === "42", "numbers are bare");
  ok(sqlLiteral(-1.5) === "-1.5", "including negatives and decimals");
  // NaN/Infinity have no SQL spelling. NULL is the honest answer; emitting the word
  // NaN produces a dump that fails to load with a syntax error.
  ok(sqlLiteral(NaN) === "NULL", "NaN becomes NULL rather than invalid SQL");
  ok(sqlLiteral(Infinity) === "NULL", "Infinity too");
  ok(sqlLiteral(123n) === "123", "BigInt prints as digits, no n suffix");
  ok(sqlLiteral(true) === "1" && sqlLiteral(false) === "0", "booleans are 1 and 0");

  ok(sqlLiteral("plain") === "'plain'", "a plain string is quoted");
  ok(sqlLiteral("it's") === "'it\\'s'", "single quote escaped", sqlLiteral("it's"));
  ok(sqlLiteral("back\\slash") === "'back\\\\slash'", "backslash doubled", sqlLiteral("back\\slash"));
  ok(sqlLiteral('say "hi"') === "'say \\\"hi\\\"'", "double quote escaped", sqlLiteral('say "hi"'));
  ok(sqlLiteral("a\nb") === "'a\\nb'", "newline escaped, so a row stays on one line");
  ok(sqlLiteral("a\rb") === "'a\\rb'", "carriage return escaped");
  ok(sqlLiteral("a\tb") === "'a\\tb'", "tab escaped");
  ok(sqlLiteral("a\0b") === "'a\\0b'", "NUL escaped — MySQL requires it");
  ok(sqlLiteral("a\x1ab") === "'a\\Zb'", "0x1A escaped as \\Z");

  // The injection-shaped case. Not user input here, but a QSO comment or a QSL
  // template can contain anything, and the dump has to survive it.
  const nasty = "'; DROP TABLE Qso; --";
  const lit = sqlLiteral(nasty);
  ok(lit === "'\\'; DROP TABLE Qso; --'", "a statement-shaped string stays one literal", lit);
  ok(splitStatements(`INSERT INTO t VALUES (${lit});`).length === 1, "and does not split");

  // Dates in UTC with milliseconds. Local time would shift every timestamp in the
  // log by the offset of whichever machine made the backup.
  ok(
    sqlLiteral(new Date("2026-08-01T17:59:28.058Z")) === "'2026-08-01 17:59:28.058'",
    "dates are UTC with milliseconds",
    sqlLiteral(new Date("2026-08-01T17:59:28.058Z")),
  );

  // Buffers as hex. Run through string escaping a BLOB is corrupted silently and
  // only surfaces when something reads it back.
  ok(sqlLiteral(Buffer.from([0xff, 0x00, 0x1a])) === "0xff001a", "buffers become hex literals");
  ok(sqlLiteral(Buffer.alloc(0)) === "''", "an empty buffer is an empty string");

  ok(sqlLiteral({ a: 1 }) === "'{\\\"a\\\":1}'", "objects are JSON, escaped", sqlLiteral({ a: 1 }));
}

console.log("\nstatement splitting");
{
  ok(splitStatements("SELECT 1; SELECT 2;").length === 2, "splits on semicolons");
  ok(splitStatements("SELECT 1").length === 1, "a trailing semicolon is optional");
  ok(splitStatements("   \n  ").length === 0, "whitespace yields nothing");

  // The case a naive split(";") gets wrong. This log is full of comment fields and
  // QSL templates containing semicolons.
  const inLiteral = "INSERT INTO t VALUES ('semi; colon');";
  ok(splitStatements(inLiteral).length === 1, "a semicolon inside a string does not split");
  ok(
    splitStatements(`INSERT INTO t VALUES ("also; here");`).length === 1,
    "nor inside double quotes",
  );
  ok(
    splitStatements("INSERT INTO `we;ird` VALUES (1);").length === 1,
    "nor inside a backticked identifier",
  );

  // An escaped quote must not be mistaken for the end of the literal — that would
  // resynchronise the parser and split in the middle of a row.
  const escaped = "INSERT INTO t VALUES ('it\\'s; fine');";
  ok(splitStatements(escaped).length === 1, "an escaped quote keeps the literal open");

  // `--` is only a comment when followed by whitespace, per MySQL. `5--3` is
  // arithmetic, and treating it as a comment would silently truncate a statement.
  ok(splitStatements("-- a; comment\nSELECT 1;").length === 1, "line comments are dropped");
  ok(splitStatements("SELECT 5--3;").length === 1, "5--3 is not a comment");
  ok(
    splitStatements("SELECT 1; -- trailing; comment").length === 1,
    "a trailing comment adds no statement",
  );

  const multi = splitStatements(
    ["DROP TABLE IF EXISTS `a`;", "CREATE TABLE `a` (x INT);", "INSERT INTO `a` VALUES (1),(2);"].join("\n"),
  );
  ok(multi.length === 3, "a realistic dump fragment splits into three", String(multi.length));
  ok(multi[0]!.startsWith("DROP TABLE"), "in order");
}

console.log("\nround trip: literal then split");
{
  // Every awkward value written as a literal, embedded in a statement, and split
  // back out as exactly one statement.
  const values = [
    "quote's",
    'double"quote',
    "back\\slash",
    "semi;colon",
    "new\nline",
    "-- looks like a comment",
    "'; DROP TABLE Qso; --",
    "mixed '\\\" ;-- \n\t end",
  ];
  let allOne = true;
  for (const v of values) {
    const stmt = `INSERT INTO t (c) VALUES (${sqlLiteral(v)});`;
    if (splitStatements(stmt).length !== 1) {
      allOne = false;
      console.log(`    would split: ${JSON.stringify(v)}`);
    }
  }
  ok(allOne, `all ${values.length} awkward values survive as single statements`);
}

console.log("\ntar: pack and unpack");
{
  // The archive format carries the whole backup. A tar that packs cleanly and
  // unpacks wrong is the worst outcome available here: the restore succeeds and the
  // data is mangled, and nobody looks at a backup until they need it.
  const entries = [
    { name: "manifest.json", data: Buffer.from('{"format":1}') },
    { name: "database.sql", data: Buffer.from("CREATE TABLE x;" + "-".repeat(1000)) },
    { name: "files/data/qsl/card-base.png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255, 13, 10]) },
  ];
  const packed = tarPack(entries);
  ok(packed.length % 512 === 0, "the archive is a whole number of blocks", String(packed.length));

  const back = tarUnpack(packed);
  ok(back.length === 3, "every entry comes back", String(back.length));
  ok(
    back.map((e) => e.name).join(",") ===
      "manifest.json,database.sql,files/data/qsl/card-base.png",
    "names and order preserved",
    back.map((e) => e.name).join(","),
  );
  ok(
    back.every((e, i) => e.data.equals(entries[i]!.data)),
    "contents byte-for-byte identical",
  );
}
{
  // A file whose length is not a multiple of 512 is the normal case, and getting
  // the padding wrong shifts every subsequent entry — so the SECOND file is what
  // actually proves it.
  const sizes = [0, 1, 511, 512, 513, 1023, 1024];
  let allOk = true;
  for (const n of sizes) {
    const data = Buffer.alloc(n, 0xab);
    const back = tarUnpack(tarPack([{ name: "a.bin", data }, { name: "b.bin", data: Buffer.from("sentinel") }]));
    if (
      back.length !== 2 ||
      !back[0]!.data.equals(data) ||
      back[1]!.data.toString() !== "sentinel"
    ) {
      allOk = false;
      console.log(`        size ${n} broke it`);
    }
  }
  ok(allOk, `padding is right at every boundary (${sizes.join(", ")})`);
}
{
  // UTF-8 in a filename: the name field is 100 BYTES, not 100 characters, and
  // treating them as the same is how a hand-rolled tar corrupts one entry in fifty.
  const name = "files/data/qsl/kártya-日本.png";
  const back = tarUnpack(tarPack([{ name, data: Buffer.from("x") }]));
  ok(back[0]?.name === name, "a multi-byte filename survives", back[0]?.name);
}
{
  let threw = false;
  try {
    tarPack([{ name: "f/".repeat(60) + "x.png", data: Buffer.alloc(1) }]);
  } catch {
    threw = true;
  }
  ok(threw, "a name too long to encode is refused, not truncated");
}
{
  // Corruption has to be caught. A restore that refuses is recoverable; one that
  // applies half a mangled dump is not.
  const packed = tarPack([{ name: "database.sql", data: Buffer.from("CREATE TABLE x;") }]);
  const corrupt = Buffer.from(packed);
  corrupt[0] = 0x5a; // change the first byte of the name, invalidating the checksum
  let threw = false;
  try {
    tarUnpack(corrupt);
  } catch {
    threw = true;
  }
  ok(threw, "a bad checksum is an error");

  let truncThrew = false;
  try {
    // Drop the trailing blocks AND part of the payload.
    tarUnpack(packed.subarray(0, 600));
  } catch {
    truncThrew = true;
  }
  ok(truncThrew, "a truncated archive is an error");
}
{
  // gzip round trip, which is how a bundle is actually stored.
  const data = Buffer.from("CREATE TABLE x;" + "y".repeat(50_000));
  const back = tarUnpack(gunzipSync(gzipSync(tarPack([{ name: "database.sql", data }]))));
  ok(back[0]!.data.equals(data), "survives gzip");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
