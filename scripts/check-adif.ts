// Round-trip + edge-case check for the ADIF writer and parser.
// Run: npm run check:adif

import { adifHeader, adifRecord, type AdifQsoInput } from "../lib/adif/write";
import { adifToQslRoute, qslRouteToAdif } from "../lib/adif/fields";
import { parseAdif, parseAdifRecords, dupeKey } from "../lib/adif/parse";

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
console.log("\n1. round-trip a fully-populated QSO");

const qso: AdifQsoInput = {
  callsign: "VP2E/K9XYZ",
  band: "20M",
  freqHz: 14_074_000n,
  mode: "FT4",
  startTime: new Date("2026-07-31T19:42:15Z"),
  endTime: new Date("2026-07-31T19:44:00Z"),
  rstSent: "-12",
  rstRcvd: "-08",
  gridSquare: "EN61BX",
  name: "Sam Example",
  qth: "Porter County, Indiana",
  dxcc: 291,
  state: "IN",
  county: "Porter",
  cqZone: 4,
  ituZone: 8,
  iota: "NA-001",
  continent: "NA",
  sig: "POTA",
  sigInfo: "US-1689",
  sigRefs: ["US-1689", "US-2258"],
  qslSent: "SENT",
  qslRcvd: "CONFIRMED",
  qslSentAt: new Date("2026-08-01T00:00:00Z"),
  qslRcvdAt: new Date("2026-08-05T00:00:00Z"),
  lotwSent: true,
  lotwRcvd: true,
  eqslSent: false,
  eqslRcvd: false,
  notes: "line one\nline two",
  station: { callsign: "K9XYZ", grid: "EN61" },
  operator: { callsign: "W9ABC" },
};

const doc =
  adifHeader({ programVersion: "0.3.0", createdAt: new Date("2026-07-31T19:42:00Z") }) +
  adifRecord(qso);

const { qsos, problems } = parseAdif(doc);
check("exactly one record parsed", qsos.length === 1, { qsos: qsos.length, problems });
check("no problems", problems.length === 0, problems);

const r = qsos[0]!;
check("callsign with slash survives", r.callsign === "VP2E/K9XYZ", r.callsign);
check("FT4 survives MODE=MFSK/SUBMODE=FT4", r.mode === "FT4", r.mode);
check("frequency exact", r.freqHz === 14_074_000, r.freqHz);
check("band derived from freq", r.band === "20M", r.band);
check("start time to the second", r.startTime.toISOString() === "2026-07-31T19:42:15.000Z", r.startTime.toISOString());
check("end time", r.endTime?.toISOString() === "2026-07-31T19:44:00.000Z", r.endTime?.toISOString());
check("negative dB report", r.rstSent === "-12" && r.rstRcvd === "-08", [r.rstSent, r.rstRcvd]);
check("6-char grid", r.gridSquare === "EN61BX", r.gridSquare);
// Deliberately not upper-cased on the way through: a name shouted back at its
// owner reads badly on a QSL card, and QTH is free text rather than a code.
check("NAME round-trips with its case", r.name === "Sam Example", r.name);
check("QTH round-trips", r.qth === "Porter County, Indiana", r.qth);
check("dxcc", r.dxcc === 291, r.dxcc);
check("qslSent SENT -> Y -> SENT", r.qslSent === "SENT", r.qslSent);
check("qslRcvd CONFIRMED round-trips", r.qslRcvd === "CONFIRMED", r.qslRcvd);
check("lotw flags", r.lotwSent && r.lotwRcvd, [r.lotwSent, r.lotwRcvd]);
check("eqsl flags false", !r.eqslSent && !r.eqslRcvd, [r.eqslSent, r.eqslRcvd]);
check("newlines stripped from notes", r.notes === "line one line two", r.notes);
check("state round-trips (WAS)", r.state === "IN", r.state);
check("county round-trips", r.county === "Porter", r.county);
check("CQ zone round-trips (WAZ)", r.cqZone === 4, r.cqZone);
check("ITU zone round-trips", r.ituZone === 8, r.ituZone);
check("IOTA round-trips", r.iota === "NA-001", r.iota);
check("continent round-trips (WAC)", r.continent === "NA", r.continent);
// SIG and SIG_INFO are how POTA travels between programs. Getting them wrong means
// a park chase that exports as an ordinary contact, and a hunter log POTA rejects.
check("SIG round-trips", r.sig === "POTA", r.sig);
check("SIG_INFO round-trips (park reference)", r.sigInfo === "US-1689", r.sigInfo);
// A contact can be two parks at once — nested parks are common — and ADIF has no
// repeated fields, so the extras ride in the APP_ space. Losing them on export
// would silently drop half of every n-fer.
check(
  "every reference survives a round trip",
  r.sigRefs.join(",") === "US-1689,US-2258",
  r.sigRefs.join(","),
);
check("station callsign captured", r.stationCallsign === "K9XYZ", r.stationCallsign);
check("operator captured", r.operatorCallsign === "W9ABC", r.operatorCallsign);
check("freq not inferred", r.freqInferred === false);

// --------------------------------------------------------------------------
console.log("\n2. field values containing '<' and '>' (length-prefix parsing)");

const tricky = "<CALL:4>W1AW<COMMENT:11>a <b> c >d<<EOR>";
const t = parseAdifRecords(tricky);
check("one record", t.length === 1, t);
check("angle brackets preserved verbatim", t[0]?.COMMENT === "a <b> c >d<", JSON.stringify(t[0]?.COMMENT));
check("call still parsed after it", t[0]?.CALL === "W1AW", t[0]?.CALL);

// --------------------------------------------------------------------------
// Regression: ADIF lengths are BYTE counts. Every fixture above is ASCII, where
// bytes and JS string indices coincide — so an index-based parser passes all of
// them and still corrupts any record containing a multi-byte character. This was
// a real bug, caught only by exporting seeded data whose notes contain an
// em-dash: 61 QSOs exported, 54 parsed back.
console.log("\n2b. multi-byte UTF-8 in field values");

const emdash = "Seed data — FT8 on 160M, decoded at -22 dB"; // '—' is 3 bytes
const mbDoc =
  adifRecord({ ...qso, callsign: "W1AW", notes: emdash }) +
  adifRecord({ ...qso, callsign: "K2BBB", notes: "plain ascii" }) +
  adifRecord({ ...qso, callsign: "W3CCC", notes: "日本語のコメント" });

const mb = parseAdif(mbDoc);
check("all three records survive a multi-byte value", mb.qsos.length === 3, {
  got: mb.qsos.length,
  calls: mb.qsos.map((q) => q.callsign),
  problems: mb.problems,
});
check(
  "the record AFTER a multi-byte one is not swallowed",
  mb.qsos[1]?.callsign === "K2BBB",
  mb.qsos.map((q) => q.callsign),
);
check("em-dash comes back intact", mb.qsos[0]?.notes === emdash, mb.qsos[0]?.notes);
check(
  "CJK comes back intact",
  mb.qsos[2]?.notes === "日本語のコメント",
  mb.qsos[2]?.notes,
);

// Buffer input must behave identically to string input.
const mbFromBuffer = parseAdif(Buffer.from(mbDoc, "utf8"));
check(
  "Buffer input parses the same as string input",
  mbFromBuffer.qsos.length === 3 && mbFromBuffer.qsos[0]?.notes === emdash,
  mbFromBuffer.qsos.length,
);

// --------------------------------------------------------------------------
console.log("\n3. real-world variants");

const variants = [
  // no header, lowercase tags, HHMM time, MODE=FT4 emitted directly
  "<call:5>K0ABC<qso_date:8>20260731<time_on:4>1942<mode:3>FT4<band:3>20m<eor>",
  // USB instead of SSB, FREQ only, no BAND
  "<CALL:5>G0XYZ<QSO_DATE:8>20260731<TIME_ON:6>194200<MODE:3>USB<FREQ:6>14.250<EOR>",
  // BAND only, no FREQ
  "<CALL:5>JA1ZZ<QSO_DATE:8>20260731<TIME_ON:4>1942<MODE:2>CW<BAND:3>40M<EOR>",
  // PSK/PSK31 pair
  "<CALL:5>VK2QQ<QSO_DATE:8>20260731<TIME_ON:4>1942<MODE:3>PSK<SUBMODE:5>PSK31<BAND:3>20M<EOR>",
].join("\n");

const v = parseAdif(variants);
check("all four variants accepted", v.qsos.length === 4, { got: v.qsos.length, problems: v.problems });
check("lowercase tags + bare FT4", v.qsos[0]?.mode === "FT4", v.qsos[0]?.mode);
check("HHMM time works", v.qsos[0]?.startTime.toISOString() === "2026-07-31T19:42:00.000Z", v.qsos[0]?.startTime.toISOString());
check("USB -> SSB", v.qsos[1]?.mode === "SSB", v.qsos[1]?.mode);
check("band derived when only FREQ given", v.qsos[1]?.band === "20M", v.qsos[1]?.band);
check("freq inferred when only BAND given", v.qsos[2]?.freqInferred === true, v.qsos[2]);
check("inferred freq lands in the right band", v.qsos[2]?.band === "40M", v.qsos[2]?.band);
check("PSK/PSK31 -> PSK31", v.qsos[3]?.mode === "PSK31", v.qsos[3]?.mode);

// --------------------------------------------------------------------------
console.log("\n4. bad records are reported, not fatal");

const bad = [
  "<CALL:4>W1AW<QSO_DATE:8>20260231<TIME_ON:4>1942<MODE:3>FT8<BAND:3>20M<EOR>", // Feb 31
  "<QSO_DATE:8>20260731<TIME_ON:4>1942<MODE:3>FT8<BAND:3>20M<EOR>", // no CALL
  "<CALL:5>W2AAA<QSO_DATE:8>20260731<TIME_ON:4>1942<MODE:7>BOGUSXX<BAND:3>20M<EOR>", // bad mode
  "<CALL:5>W3AAA<QSO_DATE:8>20260731<TIME_ON:4>1942<MODE:3>FT8<FREQ:7>999.999<EOR>", // out of band
  "<CALL:5>W4AAA<QSO_DATE:8>20260731<TIME_ON:4>1942<MODE:3>FT8<BAND:3>20M<EOR>", // good
].join("\n");

const b = parseAdif(bad);
check("only the good record survives", b.qsos.length === 1, b.qsos.map((q) => q.callsign));
check("four problems reported", b.problems.length === 4, b.problems);
check("rolled-over date rejected", b.problems.some((p) => /QSO_DATE/.test(p.message)));
check("missing CALL rejected", b.problems.some((p) => /No CALL/.test(p.message)));
check("bad mode rejected", b.problems.some((p) => /Unsupported mode/.test(p.message)));
check("out-of-band freq rejected", b.problems.some((p) => /outside every amateur band/.test(p.message)));

// --------------------------------------------------------------------------
console.log("\n5. dupe key ignores seconds");

const a = dupeKey({ callsign: "W1AW", band: "20M", mode: "FT8", startTime: new Date("2026-07-31T19:42:00Z") });
const c = dupeKey({ callsign: "W1AW", band: "20M", mode: "FT8", startTime: new Date("2026-07-31T19:42:59Z") });
const d = dupeKey({ callsign: "W1AW", band: "20M", mode: "FT8", startTime: new Date("2026-07-31T19:43:00Z") });
check("same minute collides", a === c, [a, c]);
check("next minute does not", a !== d, [a, d]);

// --------------------------------------------------------------------------
console.log("\n6. trailing record with no <EOR>");
const noEor = parseAdif("<CALL:4>W1AW<QSO_DATE:8>20260731<TIME_ON:4>1942<MODE:3>FT8<BAND:3>20M");
check("still parsed", noEor.qsos.length === 1, noEor);


// --------------------------------------------------------------------------
console.log("\n7. QSL routes (ADIF QSL_SENT_VIA / QSL_RCVD_VIA)");
for (const [route, code] of [
  ["BUREAU", "B"],
  ["DIRECT", "D"],
  ["ELECTRONIC", "E"],
  ["MANAGER", "M"],
] as [string, string][]) {
  check(`${route} -> ${code}`, qslRouteToAdif(route) === code, qslRouteToAdif(route));
  check(`${code} -> ${route}`, adifToQslRoute(code) === route, adifToQslRoute(code));
}
// An unset route must emit nothing rather than a bogus letter: a wrong route on
// export tells the recipient's logger the card travelled a way it did not.
check("unset route emits empty", qslRouteToAdif(null) === "", qslRouteToAdif(null));
check("undefined route emits empty", qslRouteToAdif(undefined) === "");
check("unknown code yields null", adifToQslRoute("X") === null, adifToQslRoute("X"));
check("missing code yields null", adifToQslRoute(undefined) === null);
check("codes are case-insensitive", adifToQslRoute("b") === "BUREAU", adifToQslRoute("b"));

// --------------------------------------------------------------------------
console.log(
  failures === 0
    ? "\nAll ADIF checks passed.\n"
    : `\n${failures} ADIF CHECK(S) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
