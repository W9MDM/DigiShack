// Checks for the cty.xml parser and the callsign->entity resolution rules.
// Run: npm run check:dxcc
//
// The parser is exercised against a synthetic cty.xml built to the published XSD
// (https://cdn.clublog.org/cty.xsd). No real Club Log data is committed here —
// the file is maintained upstream and is not ours to redistribute.
//
// Resolution is tested through the same scoring function the resolver uses,
// against an in-memory table, so this runs with no database.

import { gzipSync } from "node:zlib";

import { parseCtyXml, decompressIfNeeded } from "../lib/dxcc/parse";
import { candidateTokens, choosePrefixMatch } from "../lib/dxcc/resolve";
import { parseAlias, parseCtyCsv } from "../lib/dxcc/cty-csv";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}`, extra ?? "");
  }
}

// --------------------------------------------------------------------------
// A miniature cty.xml covering the cases that make DXCC awkward.
// --------------------------------------------------------------------------

const CTY = `<?xml version="1.0" encoding="UTF-8"?>
<clublog date="2026-07-01T00:00:00+00:00">
 <entities>
  <entity><adif>291</adif><name>UNITED STATES OF AMERICA</name><prefix>K</prefix><deleted>FALSE</deleted><cqz>5</cqz><cont>NA</cont><lat>37.00</lat><long>-95.00</long></entity>
  <entity><adif>110</adif><name>HAWAII</name><prefix>KH6</prefix><deleted>FALSE</deleted><cqz>31</cqz><cont>OC</cont></entity>
  <entity><adif>6</adif><name>ALASKA</name><prefix>KL</prefix><deleted>FALSE</deleted><cqz>1</cqz><cont>NA</cont></entity>
  <entity><adif>202</adif><name>PUERTO RICO</name><prefix>KP4</prefix><deleted>FALSE</deleted><cqz>8</cqz><cont>NA</cont></entity>
  <entity><adif>12</adif><name>ANGUILLA</name><prefix>VP2E</prefix><deleted>FALSE</deleted><cqz>8</cqz><cont>NA</cont></entity>
  <entity><adif>227</adif><name>FRANCE</name><prefix>F</prefix><deleted>FALSE</deleted><cqz>14</cqz><cont>EU</cont></entity>
  <entity><adif>230</adif><name>FEDERAL REPUBLIC OF GERMANY</name><prefix>DL</prefix><deleted>FALSE</deleted><cqz>14</cqz><cont>EU</cont></entity>
  <entity><adif>296</adif><name>YUGOSLAVIA</name><prefix>YU</prefix><deleted>TRUE</deleted><cqz>15</cqz><cont>EU</cont><end>2003-02-04T23:59:59+00:00</end></entity>
  <entity><adif>501</adif><name>SERBIA</name><prefix>YU</prefix><deleted>FALSE</deleted><cqz>15</cqz><cont>EU</cont><start>2006-06-28T00:00:00+00:00</start></entity>
 </entities>
 <exceptions>
  <exception record="1"><call>K9XYZ/VP2E</call><entity>ANGUILLA</entity><adif>12</adif><cqz>8</cqz><cont>NA</cont></exception>
  <exception record="2"><call>K1ODD</call><entity>FRANCE</entity><adif>227</adif><cqz>14</cqz><cont>EU</cont><start>2024-01-01T00:00:00+00:00</start></exception>
 </exceptions>
 <prefixes>
  <prefix record="1"><call>K</call><entity>UNITED STATES OF AMERICA</entity><adif>291</adif><cqz>5</cqz><cont>NA</cont></prefix>
  <prefix record="2"><call>W</call><entity>UNITED STATES OF AMERICA</entity><adif>291</adif><cqz>5</cqz><cont>NA</cont></prefix>
  <prefix record="3"><call>KH6</call><entity>HAWAII</entity><adif>110</adif><cqz>31</cqz><cont>OC</cont></prefix>
  <prefix record="4"><call>KL7</call><entity>ALASKA</entity><adif>6</adif><cqz>1</cqz><cont>NA</cont></prefix>
  <prefix record="5"><call>KP4</call><entity>PUERTO RICO</entity><adif>202</adif><cqz>8</cqz><cont>NA</cont></prefix>
  <prefix record="6"><call>VP2E</call><entity>ANGUILLA</entity><adif>12</adif><cqz>8</cqz><cont>NA</cont></prefix>
  <prefix record="7"><call>F</call><entity>FRANCE</entity><adif>227</adif><cqz>14</cqz><cont>EU</cont></prefix>
  <prefix record="8"><call>DL</call><entity>FEDERAL REPUBLIC OF GERMANY</entity><adif>230</adif><cqz>14</cqz><cont>EU</cont></prefix>
  <prefix record="9"><call>YU</call><entity>YUGOSLAVIA</entity><adif>296</adif><cqz>15</cqz><cont>EU</cont><end>2003-02-04T23:59:59+00:00</end></prefix>
  <prefix record="10"><call>YU</call><entity>SERBIA</entity><adif>501</adif><cqz>15</cqz><cont>EU</cont><start>2006-06-28T00:00:00+00:00</start></prefix>
 </prefixes>
 <invalid_operations><invalid record="1"><call>XX0BOGUS</call></invalid></invalid_operations>
 <zone_exceptions><zone_exception record="1"><call>VE7XYZ</call><zone>3</zone></zone_exception></zone_exceptions>
</clublog>`;

// --------------------------------------------------------------------------
console.log("\n1. parsing cty.xml");

const cty = parseCtyXml(CTY);

check("file date read from the root attribute", cty.fileDate?.toISOString() === "2026-07-01T00:00:00.000Z", cty.fileDate);
check("all 9 entities parsed", cty.entities.length === 9, cty.entities.length);
check("10 prefixes parsed", cty.prefixes.length === 10, cty.prefixes.length);
check("2 exceptions parsed", cty.exceptions.length === 2, cty.exceptions.length);
check("no parser problems", cty.problems.length === 0, cty.problems);

const usa = cty.entities.find((e) => e.adif === 291);
check("entity fields", usa?.name === "UNITED STATES OF AMERICA" && usa?.prefix === "K" && usa?.cqZone === 5 && usa?.continent === "NA", usa);
check("latitude/longitude parsed incl. negative", usa?.latitude === 37 && usa?.longitude === -95, [usa?.latitude, usa?.longitude]);

const yugo = cty.entities.find((e) => e.adif === 296);
check("deleted entity flagged", yugo?.deleted === true, yugo?.deleted);
check("entity end date parsed", yugo?.validTo?.toISOString().startsWith("2003-02-04") === true, yugo?.validTo);
check("non-deleted entity is false, not undefined", usa?.deleted === false, usa?.deleted);

// <entity> contains a <prefix> child; the section scan must not mistake those
// for records in the <prefixes> section.
check("entity <prefix> children are not counted as prefix records", cty.prefixes.length === 10, cty.prefixes.map((p) => p.call));

// --------------------------------------------------------------------------
console.log("\n2. gzip handling (Club Log serves a GZIP archive)");

const gz = gzipSync(Buffer.from(CTY, "utf8"));
check("gzip magic detected", gz.length > 2 && gz[0] === 0x1f && gz[1] === 0x8b);
const fromGz = parseCtyXml(decompressIfNeeded(gz));
check("gzipped file parses identically", fromGz.entities.length === 9 && fromGz.prefixes.length === 10, fromGz.entities.length);
const plain = decompressIfNeeded(Buffer.from(CTY, "utf8"));
check("plain XML passes through untouched", plain.toString("utf8") === CTY);

// --------------------------------------------------------------------------
console.log("\n3. rejecting things that are not cty.xml");

let threw = false;
try {
  parseCtyXml("<html><body>Invalid API key</body></html>");
} catch {
  threw = true;
}
check("an HTML error page is rejected", threw);

threw = false;
try {
  parseCtyXml('<clublog date="2026-01-01T00:00:00+00:00"><entities></entities></clublog>');
} catch {
  threw = true;
}
check("a cty.xml with no entities is rejected", threw);

// --------------------------------------------------------------------------
console.log("\n4. callsign tokenisation");

const tok = (c: string) => candidateTokens(c).tokens;

/** Same candidates, in any order. The order is not part of what these assertions claim. */
function sameTokens(actual: string[], expected: string): boolean {
  const norm = (xs: string[]) => [...xs].sort().join(",");
  return norm(actual) === norm(expected.split(","));
}

check("plain call", tok("K9XYZ").join(",") === "K9XYZ", tok("K9XYZ"));
check("/P is dropped", tok("K9XYZ/P").join(",") === "K9XYZ", tok("K9XYZ/P"));
check("/M is dropped", tok("K9XYZ/M").join(",") === "K9XYZ", tok("K9XYZ/M"));
check("/QRP is dropped", tok("K9XYZ/QRP").join(",") === "K9XYZ", tok("K9XYZ/QRP"));
check("bare digit region indicator is dropped", tok("K9XYZ/9").join(",") === "K9XYZ", tok("K9XYZ/9"));
check("prefix and base are both candidates", sameTokens(tok("VP2E/K9XYZ"), "VP2E,K9XYZ"), tok("VP2E/K9XYZ"));
check("suffix form is also both", sameTokens(tok("K9XYZ/KH6"), "KH6,K9XYZ"), tok("K9XYZ/KH6"));
check("/MM means no entity", candidateTokens("K9XYZ/MM").noEntity === true);
check("/AM means no entity", candidateTokens("K9XYZ/AM").noEntity === true);
check("/MM yields no tokens", candidateTokens("K9XYZ/MM").tokens.length === 0);
check("lowercase is normalised", sameTokens(tok("vp2e/k9xyz"), "VP2E,K9XYZ"), tok("vp2e/k9xyz"));

// --------------------------------------------------------------------------
// The resolver's scoring rule, mirrored here so it can be tested without a DB:
// longest matched prefix wins; on a tie the shorter token wins.
console.log("\n5. resolution scoring");

interface Row { call: string; adif: number; name: string; from?: string; to?: string }
const PREFIX_ROWS: Row[] = cty.prefixes.map((p) => ({
  call: p.call,
  adif: p.adif,
  name: p.entity,
  from: p.validFrom?.toISOString(),
  to: p.validTo?.toISOString(),
}));
const EXACT_ROWS: Row[] = cty.exceptions.map((p) => ({
  call: p.call,
  adif: p.adif,
  name: p.entity,
  from: p.validFrom?.toISOString(),
  to: p.validTo?.toISOString(),
}));

function validAt(r: Row, when: Date): boolean {
  if (r.from && when < new Date(r.from)) return false;
  if (r.to && when > new Date(r.to)) return false;
  return true;
}

function resolve(callsign: string, when = new Date("2026-07-01T00:00:00Z")) {
  const whole = callsign.trim().toUpperCase();
  const { tokens, noEntity } = candidateTokens(whole);
  if (noEntity) return { adif: null, name: "no-entity" };

  const exact = EXACT_ROWS.filter(
    (r) => validAt(r, when) && (r.call === whole || tokens.includes(r.call)),
  ).sort((a, b) => (b.call === whole ? 1 : 0) - (a.call === whole ? 1 : 0))[0];
  if (exact) return { adif: exact.adif, name: exact.name };

  // The REAL scorer from lib/dxcc/resolve.ts, not a copy of it. This function
  // used to reimplement the scoring, and as a result asserted "F/K9XYZ -> France"
  // for years while the production resolver returned the USA — the test was only
  // ever validating its own copy of the rules.
  const best = choosePrefixMatch(
    tokens,
    PREFIX_ROWS.map((r) => ({
      ...r,
      validFrom: r.from ? new Date(r.from) : null,
      validTo: r.to ? new Date(r.to) : null,
    })),
    when,
  );
  return best ? { adif: best.row.adif, name: best.row.name } : { adif: null, name: "not-found" };
}

check("K9XYZ -> USA", resolve("K9XYZ").adif === 291, resolve("K9XYZ"));
check("K1ABC -> USA", resolve("K1ABC").adif === 291, resolve("K1ABC"));
check("KH6XYZ -> Hawaii, not USA", resolve("KH6XYZ").adif === 110, resolve("KH6XYZ"));
check("KL7AA -> Alaska, not USA", resolve("KL7AA").adif === 6, resolve("KL7AA"));
check("KP4XX -> Puerto Rico, not USA", resolve("KP4XX").adif === 202, resolve("KP4XX"));
check("VP2E/K9XYZ -> Anguilla (portable prefix beats home call)", resolve("VP2E/K9XYZ").adif === 12, resolve("VP2E/K9XYZ"));
check("K9XYZ/KH6 -> Hawaii (suffix beats home call)", resolve("K9XYZ/KH6").adif === 110, resolve("K9XYZ/KH6"));
check("F/K9XYZ -> France (the shorter token is the location)", resolve("F/K9XYZ").adif === 227, resolve("F/K9XYZ"));
check("K9XYZ/P -> USA (modifier ignored)", resolve("K9XYZ/P").adif === 291, resolve("K9XYZ/P"));
check("K9XYZ/MM -> no entity", resolve("K9XYZ/MM").adif === null, resolve("K9XYZ/MM"));
check("DL1ABC -> Germany", resolve("DL1ABC").adif === 230, resolve("DL1ABC"));
check("unknown prefix resolves to nothing", resolve("QQ9ZZZ").adif === null, resolve("QQ9ZZZ"));

console.log("\n6. whole-callsign exceptions beat prefixes");
check(
  "K9XYZ/VP2E hits the exception, not the W prefix",
  resolve("K9XYZ/VP2E").adif === 12,
  resolve("K9XYZ/VP2E"),
);
check(
  "K1ODD is France by exception despite the K prefix",
  resolve("K1ODD", new Date("2026-01-01T00:00:00Z")).adif === 227,
  resolve("K1ODD", new Date("2026-01-01T00:00:00Z")),
);
check(
  "the same exception does NOT apply before its start date",
  resolve("K1ODD", new Date("2020-01-01T00:00:00Z")).adif === 291,
  resolve("K1ODD", new Date("2020-01-01T00:00:00Z")),
);

console.log("\n7. deleted entities resolve by QSO date");
check(
  "YU1ABC in 1995 -> Yugoslavia (deleted entity)",
  resolve("YU1ABC", new Date("1995-06-01T00:00:00Z")).adif === 296,
  resolve("YU1ABC", new Date("1995-06-01T00:00:00Z")),
);
check(
  "YU1ABC in 2026 -> Serbia",
  resolve("YU1ABC", new Date("2026-06-01T00:00:00Z")).adif === 501,
  resolve("YU1ABC", new Date("2026-06-01T00:00:00Z")),
);
check(
  "YU1ABC in the 2003-2006 gap -> nothing",
  resolve("YU1ABC", new Date("2004-06-01T00:00:00Z")).adif === null,
  resolve("YU1ABC", new Date("2004-06-01T00:00:00Z")),
);


// --------------------------------------------------------------------------
// 8. AD1C cty.csv — the no-API-key country file
// --------------------------------------------------------------------------
console.log("");
console.log("8. AD1C cty.csv parser");
{
  // A miniature file in the real format. The last two records are sub-entities:
  // a leading * means "region sharing its parent's ADIF number", not a separate
  // entity, and `adif` is the primary key of DxccEntity so emitting them as
  // entities would collide.
  const CSV = [
    "K,United States,291,NA,5,8,37.60,91.87,5.0,K W KG4(4) =KG1ABC;",
    "JA,Japan,339,AS,25,45,36.40,-138.38,-9.0,JA JE JF;",
    "I,Italy,248,EU,15,28,42.82,-12.58,-1.0,I IK IZ;",
    "GM,Scotland,279,EU,14,27,56.82,4.18,0.0,GM MM =GM0AAA;",
    "*IT9,Sicily,248,EU,15,28,37.50,-14.00,-1.0,IT9 IB9;",
    "*IG9,African Italy,248,AF,33,37,35.67,-12.67,-1.0,IG9;",
  ].join("\n");

  const f = parseCtyCsv(CSV);
  check("4 entities, sub-entities excluded", f.entities.length === 4, f.entities.length);
  check("no problems", f.problems.length === 0, f.problems);

  const byAdif = new Map(f.entities.map((e) => [e.adif, e]));
  check("ADIF numbers come from the file", byAdif.has(291) && byAdif.has(339), [...byAdif.keys()]);
  check(
    "Italy appears once despite three records for it",
    f.entities.filter((e) => e.adif === 248).length === 1,
  );

  // THE trap. cty.csv is WEST-POSITIVE: the file says the USA is +91.87 and Japan
  // -138.38, both negated from the normal east-positive convention. Imported raw,
  // every station lands on the wrong side of the planet — and no check of entity
  // names or counts would notice.
  check("USA longitude is negated to -91.87", byAdif.get(291)!.longitude === -91.87, byAdif.get(291)!.longitude);
  check("Japan longitude is negated to +138.38", byAdif.get(339)!.longitude === 138.38, byAdif.get(339)!.longitude);
  check("latitude is NOT negated", byAdif.get(291)!.latitude === 37.6, byAdif.get(291)!.latitude);

  // Sub-entity data survives as per-prefix overrides, which matters because
  // African Italy is CQ 33 / AF while mainland Italy is CQ 15 / EU — same entity.
  const ig9 = f.prefixes.find((p) => p.call === "IG9");
  check("IG9 attaches to Italy's ADIF 248", ig9?.adif === 248, ig9);
  check("IG9 keeps its own CQ zone 33", ig9?.cqZone === 33, ig9);
  check("IG9 keeps its own continent AF", ig9?.continent === "AF", ig9);
  check(
    "Italy the entity is still CQ 15 / EU",
    byAdif.get(248)!.cqZone === 15 && byAdif.get(248)!.continent === "EU",
  );

  // Exact callsigns go to exceptions, bare prefixes to prefixes.
  check("=KG1ABC became an exception", f.exceptions.some((e) => e.call === "KG1ABC" && e.adif === 291));
  check("=GM0AAA became an exception", f.exceptions.some((e) => e.call === "GM0AAA" && e.adif === 279));
  check("no '=' survives into a call", ![...f.prefixes, ...f.exceptions].some((r) => r.call.includes("=")));

  // An unannotated alias must store nulls so it inherits, or a genuine override
  // becomes indistinguishable from an inherited value.
  const w = f.prefixes.find((p) => p.call === "W");
  check("unannotated alias W inherits (null cqZone)", w?.cqZone === null, w);
  const kg4 = f.prefixes.find((p) => p.call === "KG4");
  check("annotated alias KG4(4) keeps its override", kg4?.cqZone === 4, kg4);

  const dupes = new Set<string>();
  let dupCount = 0;
  for (const r of [...f.prefixes, ...f.exceptions]) {
    const k = `${r.call}|${r.adif}`;
    if (dupes.has(k)) dupCount++;
    dupes.add(k);
  }
  check("no duplicate (call, adif) rows", dupCount === 0, dupCount);

  // Alias annotation syntax.
  const base = { cqZone: null, continent: null, latitude: null, longitude: null };
  check("=CALL is exact", parseAlias("=W1AW", base)?.exact === true);
  check("bare prefix is not exact", parseAlias("VE2", base)?.exact === false);
  check("(n) sets the CQ zone", parseAlias("VE2(2)", base)?.overrides.cqZone === 2);
  check("[n] ITU is stripped, not left in the call", parseAlias("VE2(2)[4]", base)?.call === "VE2");
  check("{CC} sets the continent", parseAlias("XX1A{SA}", base)?.overrides.continent === "SA");
  check("<lat/lon> is negated like the columns", parseAlias("XX1A<10.0/20.0>", base)?.overrides.longitude === -20);
  check("a malformed line is reported, not fatal", parseCtyCsv("only,three,fields").problems.length === 1);
  check("an empty file is reported", parseCtyCsv("").problems.length === 1);
}

// --------------------------------------------------------------------------
// 9. The KG4 rule — length decides, and no country file can express it
// --------------------------------------------------------------------------
console.log("");
console.log("9. the KG4 rule");
{
  // cty.csv lists bare KG4 as a Guantanamo Bay prefix and enumerates the US KG4
  // calls it happens to know as exceptions. The real rule is about LENGTH: KG4
  // plus exactly two characters is Guantanamo, anything else is an ordinary US
  // call. Every KG4 entry in the real file agrees — Guantanamo's are KG4AC,
  // KG4AS, KG4AW; the USA's are KG1ABC, KG4GYO, KG4MLB. Without this rule, 14
  // QSOs in this log were credited a rare entity they never worked.
  const isGuantanamo = (call: string): boolean => {
    const m = /^KG4([A-Z0-9]+)$/.exec(call);
    return m ? m[1]!.length === 2 : false;
  };
  for (const c of ["KG4AC", "KG4AS", "KG4AW", "KG4DY"]) {
    check(`${c} (KG4+2) is Guantanamo Bay`, isGuantanamo(c));
  }
  for (const c of ["KG1ABC", "KG4GYO", "KG4OJT", "KG4IXS", "KG4VUK"]) {
    check(`${c} (KG4+3) is the USA`, !isGuantanamo(c));
  }
  check("KG4F (KG4+1) is the USA", !isGuantanamo("KG4F"));
  check("bare KG4 falls through to the prefix table", !isGuantanamo("KG4"));
}

console.log(
  failures === 0
    ? "\nAll DXCC checks passed.\n"
    : `\n${failures} DXCC CHECK(S) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
