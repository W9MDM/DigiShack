/* eslint-disable no-console */
// Recovering contacts from WSJT-X's ALL.TXT.
//
// THE FAULT THIS GUARDS AGAINST is inventing a contact. Every record this produces goes into
// the log as something that happened, and from there to LoTW and eQSL as a claim against
// another operator's log. A reconstruction that is too eager does not produce a warning — it
// produces a QSO the other party has no record of, which is worse than the missing entry it
// was meant to fix.
//
// So the fixtures below are REAL lines from a real ALL.TXT, and they include the failure next
// to the success: the same station, the previous day, on a different band and mode, exchanged
// reports twice and was never acknowledged. One of those is a contact and one is not, and
// telling them apart is the whole job.

import { freqToBand } from "@/lib/ham/bands";
import {
  isAcknowledgement,
  missingFromLog,
  parseDecodeLine,
  recoverQsos,
  reportIn,
  splitMessage,
} from "@/lib/wsjtx/all-txt";

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string): void {
  if (cond) {
    pass++;
    console.log(`  ok    ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}`);
  }
}
function eq(got: unknown, want: unknown, label: string): void {
  const good = got === want;
  if (!good) {
    console.log(`        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);
  }
  ok(good, label);
}

// CAPTURED VERBATIM. The 2026-01-10 block on 20 m FT4 is an exchange that never completed;
// the 2026-01-11 block on 40 m FT8 is a contact. Both are with the same station.
const REAL = [
  "260110_213315    14.080 Tx FT4      0  0.0 1340 KD3ATB K9XYZ EN61",
  "260110_213330    14.080 Tx FT4      0  0.0 1340 KD3ATB K9XYZ EN61",
  "260110_213337    14.080 Rx FT4     -8 -0.1  826 K9XYZ KD3ATB +03",
  "260110_213345    14.080 Tx FT4      0  0.0 1340 KD3ATB K9XYZ R-08",
  "260110_213352    14.080 Rx FT4     -7 -0.1  825 K9XYZ KD3ATB +03",
  "260110_213400    14.080 Tx FT4      0  0.0 1340 KD3ATB K9XYZ R-08",
  "260111_162115     7.074 Tx FT8      0  0.0 1340 KD3ATB K9XYZ EN61",
  "260111_162145     7.074 Tx FT8      0  0.0 1340 KD3ATB K9XYZ EN61",
  "260111_162215     7.074 Tx FT8      0  0.0 1340 KD3ATB K9XYZ EN61",
  "260111_162230     7.074 Rx FT8    -21  0.1  819 K9XYZ KD3ATB -09",
  "260111_162245     7.074 Tx FT8      0  0.0 1340 KD3ATB K9XYZ R-21",
  "260111_162315     7.074 Tx FT8      0  0.0 1340 KD3ATB K9XYZ R-21",
  "260111_162345     7.074 Tx FT8      0  0.0 1340 KD3ATB K9XYZ R-21",
  "260111_162400     7.074 Rx FT8    -24  0.1  820 K9XYZ KD3ATB RR73",
  "260111_162415     7.074 Tx FT8      0  0.0 1340 KD3ATB K9XYZ 73",
];

console.log("reading a line");
{
  const d = parseDecodeLine(REAL[9]!)!;
  ok(d !== null, "a real Rx line parses");
  eq(d.at.toISOString(), "2026-01-11T16:22:30.000Z", "the two-digit year becomes 2026, in UTC");
  eq(d.mhz, 7.074, "the dial frequency");
  eq(d.dir, "Rx", "the direction");
  eq(d.mode, "FT8", "the mode");
  eq(d.snr, -21, "and the decode's own SNR, which is NOT the exchanged report");
  eq(d.message, "K9XYZ KD3ATB -09", "the message body is everything after the audio offset");

  // A years-old 388 MB file contains truncated lines from crashes and power cuts. One of them
  // must not end the recovery.
  ok(parseDecodeLine("") === null, "an empty line reads as nothing");
  ok(parseDecodeLine("260111_1624") === null, "and a truncated one, rather than throwing");
  ok(parseDecodeLine("garbage in the middle of the file") === null, "and a corrupt one");
}

console.log("\nsplitting a message");
{
  const a = splitMessage("K9XYZ KD3ATB RR73")!;
  eq(a.to, "K9XYZ", "the addressee comes first");
  eq(a.from, "KD3ATB", "then the sender");
  eq(a.rest, "RR73", "then the rest");

  // A CQ is addressed to nobody. Treating token two as a correspondent would pair us with
  // every station we ever heard calling — thousands of contacts that never happened.
  ok(splitMessage("CQ KD3ATB FM19") === null, "a CQ is not an exchange with anybody");
  ok(splitMessage("QRZ KD3ATB FM19") === null, "nor is a QRZ");
  ok(splitMessage("KD3ATB") === null, "and one token is not a message");
  // WSJT-X brackets a callsign it could not send in full; the brackets are notation.
  eq(splitMessage("<K9XYZ> KD3ATB -09")!.to, "K9XYZ", "hashed-callsign brackets are stripped");
}

console.log("\nreports, and what is not one");
{
  eq(reportIn("-09"), "-09", "a bare negative report");
  eq(reportIn("+03"), "+03", "a bare positive one");
  eq(reportIn("R-21"), "-21", "and one inside an R-acknowledgement");
  eq(reportIn("R+03"), "+03", "either sign");
  // A GRID is not a report, and it occupies the same position in the message.
  ok(reportIn("EN61") === null, "a grid square is not a report");
  ok(reportIn("RR73") === null, "nor is RR73");
  ok(reportIn("73") === null, "nor a bare 73");
}

console.log("\nacknowledgement is the whole test");
{
  ok(isAcknowledgement("RR73"), "RR73 acknowledges");
  ok(isAcknowledgement("RRR"), "RRR acknowledges");
  ok(isAcknowledgement("73"), "73 acknowledges");
  ok(!isAcknowledgement("R-21"), "R-21 does NOT — it is a report being rogered, not a contact");
  ok(!isAcknowledgement("EN61"), "and a grid does not");
  ok(!isAcknowledgement("-09"), "nor a report");
}

console.log("\nreconstructing from the real file");
{
  const r = recoverQsos(REAL, { myCall: "K9XYZ", bandOf: freqToBand });
  eq(r.lines, 15, "every line was read");
  eq(r.unparsed, 0, "and all of them parsed");

  // ONE contact out of two exchanges. The 20 m FT4 attempt swapped reports twice and was
  // never acknowledged, so it is not a QSO however complete it looks.
  eq(r.recovered.length, 1, "one contact recovered, not two");
  eq(r.incomplete, 1, "and the unacknowledged exchange is counted, not logged");

  const q = r.recovered[0]!;
  eq(q.callsign, "KD3ATB", "the correspondent");
  eq(q.band, "40M", "the band, from the dial frequency");
  eq(q.mode, "FT8", "the mode");
  eq(q.freqHz, 7_074_000, "the frequency in Hz");
  eq(q.startTime.toISOString(), "2026-01-11T16:21:15.000Z", "start is our first transmission");
  eq(q.endTime.toISOString(), "2026-01-11T16:24:15.000Z", "end is the last line of the exchange");

  // THE DIRECTION OF THE REPORTS, which is the one thing no later check could catch: both
  // values are plausible either way round. We SENT -21 (our Tx said R-21) and RECEIVED -09
  // (their Rx said -09).
  eq(q.rstSent, "-21", "the report WE sent them comes from our own transmission");
  eq(q.rstRcvd, "-09", "and the report THEY sent us from theirs");
  ok(q.evidence.length > 0, `the lines it was built from are kept (${q.evidence.length})`);
  ok(
    q.evidence.some((l) => l.includes("RR73")),
    "including the acknowledgement that justifies the record",
  );
}

console.log("\nthe same station on two bands at once");
{
  // Simultaneous exchanges must not be merged: the reports belong to different contacts.
  const both = [
    "260111_162115     7.074 Tx FT8      0  0.0 1340 KD3ATB K9XYZ EN61",
    "260111_162130    14.074 Tx FT8      0  0.0 1500 KD3ATB K9XYZ EN61",
    "260111_162230     7.074 Rx FT8    -21  0.1  819 K9XYZ KD3ATB -09",
    "260111_162245    14.074 Rx FT8    -05  0.1  900 K9XYZ KD3ATB -15",
    "260111_162300     7.074 Tx FT8      0  0.0 1340 KD3ATB K9XYZ R-21",
    "260111_162315    14.074 Tx FT8      0  0.0 1500 KD3ATB K9XYZ R-02",
    "260111_162400     7.074 Rx FT8    -24  0.1  820 K9XYZ KD3ATB RR73",
    "260111_162415    14.074 Rx FT8    -06  0.1  900 K9XYZ KD3ATB RR73",
  ];
  const r = recoverQsos(both, { myCall: "K9XYZ", bandOf: freqToBand });
  eq(r.recovered.length, 2, "two contacts, one per band");
  const by = new Map(r.recovered.map((q) => [q.band, q]));
  eq(by.get("40M")?.rstRcvd, "-09", "40m keeps its own received report");
  eq(by.get("20M")?.rstRcvd, "-15", "and 20m keeps its own");
  eq(by.get("40M")?.rstSent, "-21", "the sent reports do not cross either");
  eq(by.get("20M")?.rstSent, "-02", "on either band");
}

console.log("\na wrong callsign recovers nothing, rather than something wrong");
{
  // ALL.TXT's Tx/Rx markers are from the FILE OWNER's point of view: `Tx` means this station
  // transmitted. So the same file cannot be reinterpreted as the correspondent's log, and
  // running the recovery with the wrong `myCall` yields nothing at all.
  //
  // That is the safe failure, and worth asserting because the unsafe one was available: if
  // "ours" were taken from the message position rather than from the direction, a wrong
  // callsign would produce a full set of contacts with every report INVERTED — rstSent and
  // rstRcvd swapped on every record, both values entirely plausible, and nothing downstream
  // able to notice. Nothing recovered is a result somebody investigates; hundreds of records
  // with the reports the wrong way round is not.
  eq(
    recoverQsos(REAL, { myCall: "KD3ATB", bandOf: freqToBand }).recovered.length,
    0,
    "the correspondent's own callsign recovers no contacts from our file",
  );
  eq(
    recoverQsos(REAL, { myCall: "W1XYZ", bandOf: freqToBand }).recovered.length,
    0,
    "and an unrelated callsign likewise",
  );
}

console.log("\nnothing is invented");
{
  // A station heard calling CQ, never worked.
  const heard = [
    "260111_162115     7.074 Rx FT8    -10  0.1  819 CQ DL1YTT JO31",
    "260111_162145     7.074 Rx FT8    -11  0.1  819 CQ DL1YTT JO31",
  ];
  eq(recoverQsos(heard, { myCall: "K9XYZ", bandOf: freqToBand }).recovered.length, 0,
     "hearing a CQ is not a contact");

  // We called, they never answered.
  const called = [
    "260111_162115     7.074 Tx FT8      0  0.0 1340 DL1YTT K9XYZ EN61",
    "260111_162145     7.074 Tx FT8      0  0.0 1340 DL1YTT K9XYZ EN61",
  ];
  const r2 = recoverQsos(called, { myCall: "K9XYZ", bandOf: freqToBand });
  eq(r2.recovered.length, 0, "calling somebody is not a contact");
  eq(r2.incomplete, 0, "and with no reports exchanged it is not even a near miss");

  // Reports exchanged, we acknowledged, THEY never did. Our own 73 is not evidence they
  // logged it — this is precisely the case the operator described in reverse.
  const oneSided = [
    "260111_162115     7.074 Tx FT8      0  0.0 1340 DL1YTT K9XYZ EN61",
    "260111_162130     7.074 Rx FT8    -10  0.1  819 K9XYZ DL1YTT -12",
    "260111_162145     7.074 Tx FT8      0  0.0 1340 DL1YTT K9XYZ R-10",
    "260111_162215     7.074 Tx FT8      0  0.0 1340 DL1YTT K9XYZ RR73",
  ];
  const r3 = recoverQsos(oneSided, { myCall: "K9XYZ", bandOf: freqToBand });
  eq(r3.recovered.length, 0, "our own acknowledgement alone does not make a contact");
  eq(r3.incomplete, 1, "it is counted as an exchange that did not complete");
}

console.log("\ncomparing against the log needs a window, not an exact time");
{
  const recovered = recoverQsos(REAL, { myCall: "K9XYZ", bandOf: freqToBand }).recovered;
  const q = recovered[0]!;

  // THE BUG THIS ENCODES. A recovered contact's start is our first transmission; the log
  // recorded whatever WSJT-X called the start, a median of 45 seconds later. An exact-minute
  // comparison reported 10,265 contacts as missing when only 1,389 were - 381 of every 400
  // sampled were present all along, just across a minute boundary.
  const shifted = [
    { callsign: "KD3ATB", band: "40M", mode: "FT8", startTime: new Date(q.startTime.getTime() + 45_000) },
  ];
  eq(missingFromLog(recovered, shifted).length, 0, "45 seconds later is the same contact");
  eq(
    missingFromLog(recovered, [
      { callsign: "KD3ATB", band: "40M", mode: "FT8", startTime: new Date(q.startTime.getTime() + 25 * 60_000) },
    ]).length,
    0,
    "and so is twenty-five minutes later",
  );

  // THE MEASURED ASYMMETRY. Past two minutes, offsets to the nearest log entry run 99% "log
  // later" — 2,038 later against 8 earlier in the 2-10 minute band, 296 against 0 from 10-15.
  // Separate contacts would scatter both ways, so a one-sided tail is the same QSOs written
  // down late, and the window has to cover it: 1,389 missing at fifteen minutes against 765
  // at three hours.
  eq(
    missingFromLog(recovered, [
      { callsign: "KD3ATB", band: "40M", mode: "FT8", startTime: new Date(q.startTime.getTime() + 2 * 3_600_000) },
    ]).length,
    0,
    "two hours later is still the same contact, given the logged-late tail",
  );

  // Wide enough is not unlimited. Past the point where the count stops moving, a match is
  // more likely a genuinely separate contact than a late entry.
  eq(
    missingFromLog(recovered, [
      { callsign: "KD3ATB", band: "40M", mode: "FT8", startTime: new Date(q.startTime.getTime() + 20 * 3_600_000) },
    ]).length,
    1,
    "twenty hours later is a different contact, so this one is still missing",
  );

  eq(missingFromLog(recovered, []).length, 1, "an empty log means everything is missing");
  // Band and mode are part of the identity: the same station on another band is another QSO.
  eq(
    missingFromLog(recovered, [{ callsign: "KD3ATB", band: "20M", mode: "FT8", startTime: q.startTime }]).length,
    1,
    "a contact on a different band does not count as this one",
  );
  eq(
    missingFromLog(recovered, [{ callsign: "KD3ATB", band: "40M", mode: "FT4", startTime: q.startTime }]).length,
    1,
    "nor one in a different mode",
  );
}


console.log("\nunacknowledged exchanges, when asked for by name");
{
  const off = recoverQsos(REAL, { myCall: "K9XYZ", bandOf: freqToBand });
  eq(off.unacknowledged.length, 0, "not returned unless requested");

  const on = recoverQsos(REAL, { myCall: "K9XYZ", bandOf: freqToBand, keepIncomplete: true });
  eq(on.recovered.length, 1, "asking for them does not change what counts as a contact");
  eq(on.unacknowledged.length, 1, "and the unacknowledged 20m FT4 exchange comes back in full");

  const u = on.unacknowledged[0]!;
  eq(u.callsign, "KD3ATB", "with the correspondent");
  eq(u.band, "20M", "the band it was actually on");
  eq(u.mode, "FT4", "and the mode");
  // Both reports are present. That is exactly why these are dangerous: they look complete.
  eq(u.rstSent, "-08", "our report to them");
  eq(u.rstRcvd, "+03", "and theirs to us");
  ok(
    !u.evidence.some((l) => /Rx .*K9XYZ KD3ATB (RR73|RRR|73)/.test(l)),
    "and no acknowledgement anywhere in its evidence, which is the whole distinction",
  );

  // The two lists must never overlap: one exchange cannot be both a contact and not one.
  const ids = (q: { callsign: string; band: string; startTime: Date }) =>
    q.callsign + "|" + q.band + "|" + q.startTime.toISOString();
  const both = new Set(on.recovered.map(ids));
  eq(on.unacknowledged.filter((q) => both.has(ids(q))).length, 0, "nothing appears in both lists");
}


console.log("\nRR73 is not a grid square");
{
  // RR73 is two letters in A-R followed by two digits, so it satisfies the grid pattern
  // exactly, and it sits in the same position in the message. The first version tested for an
  // acknowledgement and a grid independently and wrote GRIDSQUARE=RR73 into recovered
  // contacts. Nothing downstream would question it: RR73 is a real square in the South
  // Atlantic. It surfaced only from reading the generated ADIF.
  const withAck = [
    "260111_162115     7.074 Tx FT8      0  0.0 1340 KD3ATB K9XYZ EN61",
    "260111_162130     7.074 Rx FT8    -10  0.1  819 K9XYZ KD3ATB -09",
    "260111_162145     7.074 Tx FT8      0  0.0 1340 KD3ATB K9XYZ R-21",
    "260111_162200     7.074 Rx FT8    -10  0.1  819 K9XYZ KD3ATB RR73",
  ];
  const q = recoverQsos(withAck, { myCall: "K9XYZ", bandOf: freqToBand }).recovered[0]!;
  eq(q.gridSquare, null, "an acknowledged contact with no grid sent has no grid");
  ok(q.gridSquare !== "RR73", "and RR73 specifically is never stored as one");

  // A real grid still lands, so the fix did not simply disable grids.
  const withGrid = [
    "260111_162115     7.074 Tx FT8      0  0.0 1340 KD3ATB K9XYZ EN61",
    "260111_162130     7.074 Rx FT8    -10  0.1  819 K9XYZ KD3ATB FM19",
    "260111_162145     7.074 Tx FT8      0  0.0 1340 KD3ATB K9XYZ -09",
    "260111_162200     7.074 Rx FT8    -10  0.1  819 K9XYZ KD3ATB R-21",
    "260111_162215     7.074 Tx FT8      0  0.0 1340 KD3ATB K9XYZ RR73",
    "260111_162230     7.074 Rx FT8    -10  0.1  819 K9XYZ KD3ATB 73",
  ];
  eq(
    recoverQsos(withGrid, { myCall: "K9XYZ", bandOf: freqToBand }).recovered[0]?.gridSquare,
    "FM19",
    "a grid they actually sent is still recorded",
  );
}


console.log("\nwhen they first came back to us");
{
  // startTime is our first transmission, which on a station called repeatedly is minutes of
  // unanswered calling. In the real fixture we call three times before KD3ATB answers.
  const q = recoverQsos(REAL, { myCall: "K9XYZ", bandOf: freqToBand }).recovered[0]!;
  eq(q.startTime.toISOString(), "2026-01-11T16:21:15.000Z", "start is still our first call");
  eq(
    q.theirFirstReportAt?.toISOString(),
    "2026-01-11T16:22:30.000Z",
    "and their first report back is the moment it became two-way",
  );

  // FIRST, not last. A station repeats its report while waiting for our roger, and the last
  // repetition is not when the exchange became a QSO.
  const repeated = [
    "260111_162115     7.074 Tx FT8      0  0.0 1340 KD3ATB K9XYZ EN61",
    "260111_162130     7.074 Rx FT8    -10  0.1  819 K9XYZ KD3ATB -09",
    "260111_162200     7.074 Rx FT8    -10  0.1  819 K9XYZ KD3ATB -09",
    "260111_162230     7.074 Rx FT8    -10  0.1  819 K9XYZ KD3ATB -09",
    "260111_162245     7.074 Tx FT8      0  0.0 1340 KD3ATB K9XYZ R-21",
    "260111_162300     7.074 Rx FT8    -10  0.1  819 K9XYZ KD3ATB RR73",
  ];
  eq(
    recoverQsos(repeated, { myCall: "K9XYZ", bandOf: freqToBand }).recovered[0]?.theirFirstReportAt?.toISOString(),
    "2026-01-11T16:21:30.000Z",
    "the first repetition wins, not the last",
  );

  // Unacknowledged exchanges carry it too - that is the whole reason it exists.
  const u = recoverQsos(REAL, { myCall: "K9XYZ", bandOf: freqToBand, keepIncomplete: true }).unacknowledged[0]!;
  eq(
    u.theirFirstReportAt?.toISOString(),
    "2026-01-10T21:33:37.000Z",
    "an unacknowledged exchange records it as well",
  );

  // A station answering with RR73 and no report at all leaves it null rather than guessing.
  const straightAck = [
    "260111_162115     7.074 Tx FT8      0  0.0 1340 KD3ATB K9XYZ EN61",
    "260111_162130     7.074 Rx FT8    -10  0.1  819 K9XYZ KD3ATB RR73",
  ];
  eq(
    recoverQsos(straightAck, { myCall: "K9XYZ", bandOf: freqToBand }).recovered[0]?.theirFirstReportAt,
    null,
    "and it is null when they never sent a report",
  );
}


console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
