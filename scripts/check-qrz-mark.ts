// Marking local contacts from QRZ's own logbook, and the cursor that makes a download
// differential instead of a full re-read every time.
//
// The database half is not exercised here: `markFromQrzAdif` needs a live log to match
// against, and a test that stands up a MySQL instance to prove an updateMany runs would
// be proving Prisma works. What is worth pinning is the part that decides WHICH contact a
// QRZ record refers to and WHAT it claims about it — because a matching rule that
// disagrees with the importer's marks the wrong contact, or marks nothing at all, and
// both look exactly like the sync working.

import { dupeKey } from "@/lib/adif/parse";
import { isQrzConfirmed, qrzMarkables } from "@/lib/integrations/qrz-mark";

let pass = 0;
let fail = 0;

function ok(cond: boolean, what: string, detail = ""): void {
  if (cond) {
    pass++;
    console.log(`  ok    ${what}`);
  } else {
    fail++;
    console.log(`  FAIL  ${what}${detail ? ` — ${detail}` : ""}`);
  }
}

function eq(got: unknown, want: unknown, what: string): void {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  ok(a === b, what, a === b ? "" : `got ${a}, want ${b}`);
}

/** An ADIF document in the shape QRZ's FETCH returns. */
function adif(...records: Record<string, string>[]): string {
  const head = "DigiShack test\n<ADIF_VER:5>3.1.4\n<EOH>\n";
  return (
    head +
    records
      .map(
        (r) =>
          Object.entries(r)
            .map(([k, v]) => `<${k}:${Buffer.byteLength(v, "utf8")}>${v}`)
            .join(" ") + " <EOR>\n",
      )
      .join("")
  );
}

const BASE = {
  CALL: "W1ABC",
  QSO_DATE: "20260802",
  TIME_ON: "031600",
  BAND: "20M",
  MODE: "FT8",
};

console.log("\nwhat QRZ says about a contact");
{
  const m = qrzMarkables(
    adif({ ...BASE, APP_QRZLOG_LOGID: "1234567", APP_QRZLOG_STATUS: "C" }),
  );
  eq(m.length, 1, "one record in, one markable out");
  eq(m[0]?.callsign, "W1ABC", "the callsign comes off the parsed contact");
  eq(m[0]?.logId, 1234567, "QRZ's own record id is kept — the cursor depends on it");
  ok(m[0]?.confirmed === true, "status C is a confirmation");
}

console.log("\nthe match key is the importer's, not a second opinion");
{
  // The whole design rests on this: `markFromQrzAdif` looks contacts up by the key the
  // ADIF importer dedupes with. If these two ever disagree the sync marks the wrong
  // contact or silently marks none, and the run still reports success either way.
  const m = qrzMarkables(adif({ ...BASE, APP_QRZLOG_LOGID: "1" }));
  eq(
    m[0]?.key,
    dupeKey({
      callsign: "W1ABC",
      band: "20M",
      mode: "FT8",
      startTime: new Date("2026-08-02T03:16:00Z"),
    }),
    "identical to dupeKey for the same contact",
  );

  // Seconds are dropped by dupeKey, so a logging program that records them cannot fail
  // to match one that does not. QRZ returns TIME_ON with seconds; DigiShack logs them.
  const withSeconds = qrzMarkables(
    adif({ ...BASE, TIME_ON: "031637", APP_QRZLOG_LOGID: "2" }),
  );
  eq(withSeconds[0]?.key, m[0]?.key, "and seconds do not break the match");
}

console.log("\nFT8 arrives spelled more than one way");
{
  // The reason this goes through the project's parser rather than reading BAND and MODE
  // off the record. WSJT-X writes MODE:FT8; ADIF 3.1 says FT8 is a submode of MFSK and
  // several programs write it that way. A hand-rolled reader keying on MODE would
  // produce "MFSK" and match nothing — for every digital contact in the log, which here
  // is nearly all of them.
  const plain = qrzMarkables(adif({ ...BASE, APP_QRZLOG_LOGID: "1" }));
  const submode = qrzMarkables(
    adif({ ...BASE, MODE: "MFSK", SUBMODE: "FT8", APP_QRZLOG_LOGID: "2" }),
  );
  eq(submode[0]?.key, plain[0]?.key, "MODE:MFSK SUBMODE:FT8 matches MODE:FT8");
}

console.log("\nonly a confirmation counts as a confirmation");
{
  // QRZ's status codes are not documented anywhere authoritative. Treating an unknown
  // one as confirmed would put a confirmation in the log that QRZ never claimed, and
  // nothing downstream could tell it from a real one.
  ok(isQrzConfirmed("C"), "C confirms");
  ok(isQrzConfirmed(" c "), "case and whitespace do not matter");
  ok(!isQrzConfirmed("V"), "V does not");
  ok(!isQrzConfirmed("Y"), "nor does Y, whatever it once meant");
  ok(!isQrzConfirmed(""), "nor does an empty status");
  ok(!isQrzConfirmed(undefined), "nor a missing one");

  const m = qrzMarkables(adif({ ...BASE, APP_QRZLOG_LOGID: "1", APP_QRZLOG_STATUS: "V" }));
  ok(m[0]?.confirmed === false, "and an unconfirmed record is still markable as sent");
  eq(m[0]?.logId, 1, "with its id, so the cursor still advances past it");
}

console.log("\nrecords QRZ sends that cannot be matched");
{
  // A record with no callsign is rejected by the parser, and the id beside it must go
  // with it. Converting one record at a time is what guarantees that: zipping a list of
  // parsed contacts against a list of scraped ids would pair every record after the
  // first rejection with the wrong contact's id.
  const m = qrzMarkables(
    adif(
      { ...BASE, CALL: "K1DEF", APP_QRZLOG_LOGID: "10" },
      { QSO_DATE: "20260802", TIME_ON: "0400", BAND: "20M", MODE: "FT8", APP_QRZLOG_LOGID: "11" },
      { ...BASE, CALL: "W9ABC", APP_QRZLOG_LOGID: "12" },
    ),
  );
  eq(m.length, 2, "the record with no callsign is dropped");
  eq(
    m.map((x) => [x.callsign, x.logId]),
    [
      ["K1DEF", 10],
      ["W9ABC", 12],
    ],
    "and every surviving contact keeps its OWN id, not the next one along",
  );
}

console.log("\na record with no QRZ id at all");
{
  const m = qrzMarkables(adif({ ...BASE }));
  eq(m.length, 1, "is still markable — QRZ has the contact either way");
  eq(m[0]?.logId, null, "but contributes nothing to the cursor");
  const bad = qrzMarkables(adif({ ...BASE, APP_QRZLOG_LOGID: "not-a-number" }));
  eq(bad[0]?.logId, null, "and neither does an unreadable one");
  const zero = qrzMarkables(adif({ ...BASE, APP_QRZLOG_LOGID: "0" }));
  eq(zero[0]?.logId, null, "nor a zero, which would mean 'start from the beginning'");
}

console.log("\nan empty logbook");
{
  eq(qrzMarkables("").length, 0, "no records, no markables");
  eq(qrzMarkables(adif()).length, 0, "a header with nothing after it is not an error");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
