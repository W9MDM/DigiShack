/* eslint-disable no-console */
// The per-UTC-day decode CSV.
//
// Written against a real temporary directory rather than a mocked filesystem: the whole
// feature is "does a correct file appear on disk", and the interesting cases — a day
// boundary inside one window, a restart mid-day, a message with a comma in it — are all
// about what the bytes end up being.

import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { csvField, csvLine, DecodeCsvLog, fileNameFor, type DecodeRow } from "@/lib/radio/decode-log";

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
function eq<T>(a: T, b: T, label: string): void {
  ok(
    JSON.stringify(a) === JSON.stringify(b),
    label,
    `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`,
  );
}

function row(over: Partial<DecodeRow> = {}): DecodeRow {
  return {
    at: new Date("2026-08-02T14:30:00.000Z"),
    band: "20M",
    mode: "FT8",
    snr: -8,
    dt: 0.123456,
    offsetHz: 1234.6,
    dialHz: 14_074_000,
    message: "CQ K1DEF DM33",
    callsign: "K1DEF",
    radio: "FLEX-6400",
    ...over,
  };
}

async function main(): Promise<void> {
  console.log("\na row on its own");
  {
    eq(
      csvLine(row()),
      "2026-08-02T14:30:00.000Z,20M,FT8,-8,0.12,1235,14074000,K1DEF,CQ K1DEF DM33,FLEX-6400",
      "every column, DT to two places and the offset rounded",
    );
    eq(
      csvLine(row({ band: null, dialHz: null, callsign: null, radio: null })),
      "2026-08-02T14:30:00.000Z,,FT8,-8,0.12,1235,,,CQ K1DEF DM33,",
      "nulls are empty fields, not the word null",
    );
  }

  console.log("\nfields that would corrupt the file");
  {
    eq(csvField("plain"), "plain", "nothing to quote is left alone");
    eq(csvField('a,b'), '"a,b"', "a comma is quoted");
    eq(csvField('say "hi"'), '"say ""hi"""', "quotes are doubled");
    eq(csvField("two\nlines"), '"two\nlines"', "a newline is quoted");
    eq(csvField(null), "", "null is empty");
    // Not hypothetical: park names come through here, and "Indiana Dunes, IN" would
    // shift every later column by one.
    ok(csvLine(row({ message: "TNX, 73" })).includes('"TNX, 73"'), "and a real row is protected");
  }

  console.log("\nthe file, on disk");
  const dir = await mkdtemp(join(tmpdir(), "digishack-decodes-"));
  try {
    const errors: string[] = [];
    const log = new DecodeCsvLog(dir, (m) => errors.push(m));
    await log.open();

    await log.append([row(), row({ callsign: "W1AW", message: "CQ W1AW FN31" })]);
    const name = fileNameFor(new Date("2026-08-02T14:30:00.000Z"));
    eq(name, "decodes-2026-08-02.csv", "named for the UTC day");

    const text = await readFile(join(dir, name), "utf8");
    const lines = text.trimEnd().split("\n");
    eq(lines.length, 3, "a header and two rows");
    ok(lines[0]?.startsWith("utc,band,mode,snr,dt,offset_hz") ?? false, "header first", lines[0]);
    ok(lines[2]?.includes("W1AW") ?? false, "and both decodes are there");

    await log.append([row({ snr: -3 })]);
    const grown = (await readFile(join(dir, name), "utf8")).trimEnd().split("\n");
    eq(grown.length, 4, "a second window appends");
    eq(grown.filter((l) => l.startsWith("utc,")).length, 1, "and does not repeat the header");

    console.log("\na window that straddles midnight");
    {
      // The day comes from the decode's own timestamp, not from the clock when it was
      // written. A window at 23:59:45 belongs to the day it happened in.
      await log.append([
        row({ at: new Date("2026-08-03T23:59:45.000Z"), callsign: "LATE" }),
        row({ at: new Date("2026-08-04T00:00:00.000Z"), callsign: "EARLY" }),
      ]);
      const late = await readFile(join(dir, "decodes-2026-08-03.csv"), "utf8");
      const early = await readFile(join(dir, "decodes-2026-08-04.csv"), "utf8");
      ok(late.includes("LATE") && !late.includes("EARLY"), "each row lands in its own day");
      ok(early.includes("EARLY") && !early.includes("LATE"), "and the other file has the other");
      eq(
        (await readdir(dir)).sort(),
        ["decodes-2026-08-02.csv", "decodes-2026-08-03.csv", "decodes-2026-08-04.csv"],
        "three days, three files",
      );
    }

    console.log("\na restart part way through a day");
    {
      // A fresh process has no memory of which files it has written. Assuming a new one
      // would put a header in the middle of an existing day.
      const second = new DecodeCsvLog(dir, (m) => errors.push(m));
      await second.open();
      await second.append([row({ callsign: "AFTER" })]);
      const text2 = await readFile(join(dir, name), "utf8");
      eq(text2.split("\n").filter((l) => l.startsWith("utc,")).length, 1, "still one header");
      ok(text2.includes("AFTER"), "and the new row is appended to the same day");
    }

    console.log("\nwhen the disk says no");
    {
      // A file where the directory should be: every write fails. Operating must not
      // notice, and the complaint must not repeat every window.
      const blocked = join(dir, "not-a-directory");
      await writeFile(blocked, "");
      const seen: string[] = [];
      const bad = new DecodeCsvLog(join(blocked, "sub"), (m) => seen.push(m));
      let threw = false;
      await bad.open().catch(() => {
        threw = true;
      });
      ok(threw, "open() reports a bad path rather than failing silently later");

      await bad.append([row()]);
      await bad.append([row()]);
      await bad.append([row()]);
      eq(seen.length, 1, "three failed windows, one complaint");
      eq(errors.length, 0, "and the working log never complained at all");
    }

    eq(errors.length, 0, "no errors on the happy path");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

void main();
