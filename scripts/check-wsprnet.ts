/* eslint-disable no-console */
// Assertions on what is sent to wsprnet.org, and on reading a spot out of a decode.
// Run: npm run check:wsprnet
//
// The request format is reproduced from WSJT-X's WSPRNet.cpp - there is no documented API
// beyond what that program sends - so what can be asserted is that every field it sends is
// here, spelled and formatted the same way: six-decimal megahertz, YYMMDD and HHMM in UTC,
// integer dB, one-decimal DT, and `mode=2` for the two-minute mode. Whether wsprnet accepts
// it is a thing only a spot on the map can prove, and the changelog says so.

import { wsprSpotOf, wsprnetQuery } from "../lib/wsprnet/upload";

let failed = 0;
function ok(cond: boolean, what: string, extra?: unknown): void {
  if (cond) {
    console.log(`  ok    ${what}`);
  } else {
    failed++;
    console.log(`  FAIL  ${what}`, extra ?? "");
  }
}
function eq(a: unknown, b: unknown, what: string): void {
  ok(Object.is(a, b), what, `expected ${String(b)}, got ${String(a)}`);
}

// ---------------------------------------------------------------------------
console.log("the query string, field by field");
// ---------------------------------------------------------------------------
{
  const q = wsprnetQuery({
    rcall: "W1AW",
    rgrid: "FN31",
    dialHz: 14_095_600,
    at: new Date("2026-10-14T09:18:00Z"),
    tcall: "ND6P",
    tgrid: "DM04",
    dbm: 30,
    snrDb: -9,
    dtS: 1.1,
    driftHz: 0,
    txHz: 14_097_046,
  });
  eq(q.get("function"), "wspr", "function=wspr");
  eq(q.get("rcall"), "W1AW", "the reporting callsign");
  eq(q.get("rgrid"), "FN31", "and grid");
  eq(q.get("rqrg"), "14.095600", "the dial in MHz to six places");
  eq(q.get("date"), "261014", "the date as YYMMDD, UTC");
  eq(q.get("time"), "0918", "the time as HHMM, UTC");
  eq(q.get("sig"), "-9", "the SNR as an integer");
  eq(q.get("dt"), "1.1", "DT to one decimal");
  eq(q.get("drift"), "0", "drift as an integer");
  eq(q.get("tqrg"), "14.097046", "the transmitter's frequency in MHz to six places");
  eq(q.get("tcall"), "ND6P", "the station heard");
  eq(q.get("tgrid"), "DM04", "its grid");
  eq(q.get("dbm"), "30", "its power");
  ok((q.get("version") ?? "").startsWith("DigiShack "), "the version names this program", q.get("version"));
  eq(q.get("mode"), "2", "mode=2, the two-minute mode");
  const missingGrid = wsprnetQuery({
    rcall: "W1AW", rgrid: "FN31", dialHz: 14_095_600, at: new Date("2026-10-14T09:18:00Z"),
    tcall: "PJ4/K1ABC", tgrid: null, dbm: 37, snrDb: -20, dtS: -0.3, driftHz: -1, txHz: 14_097_100,
  });
  eq(missingGrid.get("tgrid"), "", "a type 2 spot sends an empty grid rather than inventing one");
  eq(missingGrid.get("dt"), "-0.3", "a negative DT keeps its sign");
  eq(missingGrid.get("drift"), "-1", "and so does drift");
}

// ---------------------------------------------------------------------------
console.log("\nreading a spot out of a decoded message");
// ---------------------------------------------------------------------------
{
  const t1 = wsprSpotOf("K1ABC FN42 37");
  eq(t1?.tcall, "K1ABC", "type 1: the callsign");
  eq(t1?.tgrid, "FN42", "the grid");
  eq(t1?.dbm, 37, "the power");
  const t2 = wsprSpotOf("PJ4/K1ABC 37");
  eq(t2?.tcall, "PJ4/K1ABC", "type 2: a compound callsign");
  eq(t2?.tgrid, null, "with no grid");
  const t3 = wsprSpotOf("<PJ4/K1ABC> FK52UD 37");
  eq(t3?.tcall, "PJ4/K1ABC", "type 3: the callsign without its brackets");
  eq(t3?.tgrid, "FK52UD", "and the six-character grid");
  eq(wsprSpotOf("<...> FK52UD 37"), null, "an unresolved hash is not a station to report");
  eq(wsprSpotOf("CQ W1AW FN31"), null, "an FT8 message is not a spot");
  eq(wsprSpotOf("K1ABC FN42 99"), null, "a power the format cannot carry is refused");
}

console.log("");
if (failed > 0) {
  console.log(`${failed} FAILED`);
  process.exit(1);
}
console.log("all wsprnet assertions passed");
