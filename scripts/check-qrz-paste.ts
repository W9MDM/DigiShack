/* eslint-disable no-console */
// Parsing the QRZ incoming-QSL-request table out of a clipboard paste.
//
// THE FAULT THIS GUARDS AGAINST is reading the wrong date column. QRZ shows "Request Received"
// first and "QSO Date" second, and they are routinely months apart — one real row has a QSO on
// 2025-10-25 against a request filed 2026-04-20. Matching on the request date produces a
// comparison that looks entirely plausible and is wrong on every row that was not filed the
// same day, which is most of them.
//
// The fixtures are real rows, in the shapes a browser actually puts on the clipboard.

import { parseIncomingPaste } from "@/lib/qrz/incoming-paste";

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

console.log("the QSO date column, not the request date");
{
  // Tab-separated, which is what selecting the table gives. The two dates differ by months.
  const paste = [
    "\tRequest Received\tQSO Date\tCallsign\tActions",
    "1\t2026-04-20 02:10:21\t2025-10-25\tK9XYZ de KD8VAX\t",
    "2\t2026-02-05 23:20:57\t2025-10-24\tK9XYZ de WD8DFW\t",
    "3\t2026-08-09 23:10:34\t2026-01-08\tK9XYZ de NR6AM\t",
  ].join("\n");
  const r = parseIncomingPaste(paste);
  eq(r.requests.length, 3, "three rows read");
  eq(r.unread.length, 0, "nothing unread");
  eq(r.requests[0]?.callsign, "KD8VAX", "the callsign comes from after 'de'");
  // THE POINT. 2025-10-25 is the QSO; 2026-04-20 is when the card was asked for.
  eq(r.requests[0]?.qsoDate, "2025-10-25", "the SECOND date is the QSO date");
  eq(
    r.requests[0]?.requestedAt?.toISOString().slice(0, 10),
    "2026-04-20",
    "and the first is kept separately as the request date",
  );
  eq(r.requests[1]?.qsoDate, "2025-10-24", "second row");
  eq(r.requests[2]?.qsoDate, "2026-01-08", "third row, seven months before its request");
  // The header must not become a row.
  ok(!r.requests.some((x) => x.callsign === "DE"), "the header line is skipped");
}

console.log("\nthe shapes a browser actually pastes");
{
  // Row number on its own line, then the fields — what happens when a table row wraps.
  const wrapped = "1\n2026-01-08 19:59:53\t2026-01-05\tK9XYZ de EA8ATE";
  const r = parseIncomingPaste(wrapped);
  eq(r.requests.length, 1, "a leading row number on its own line is ignored");
  eq(r.requests[0]?.qsoDate, "2026-01-05", "and the QSO date still comes from the second date");

  // Space-separated rather than tabbed.
  const spaced = parseIncomingPaste("2026-01-11 00:19:09  2026-01-11  K9XYZ de W3GLP");
  eq(spaced.requests.length, 1, "space separation works too");
  eq(spaced.requests[0]?.callsign, "W3GLP", "with the callsign read correctly");

  // Only one date, because the timestamp column was not selected.
  const oneDate = parseIncomingPaste("2026-02-20\tK9XYZ de SP9TBT");
  eq(oneDate.requests.length, 1, "a single date is read");
  eq(oneDate.requests[0]?.qsoDate, "2026-02-20", "and taken as the QSO date");
  eq(oneDate.requests[0]?.requestedAt, null, "with no request date invented");

  // A portable callsign carries a slash.
  eq(
    parseIncomingPaste("2026-06-21 13:26:45\t2026-06-20\tK9XYZ de W2/JR1AQN").requests[0]?.callsign,
    "W2/JR1AQN",
    "a portable prefix survives",
  );
}

console.log("\nduplicates and rubbish");
{
  // QRZ's own list repeats rows — the same request appears three times in a real capture.
  const dupes = parseIncomingPaste(
    [
      "1\t2026-01-17 11:04:32\t2026-01-11\tK9XYZ de EA8ATE",
      "2\t2026-01-17 11:04:32\t2026-01-11\tK9XYZ de EA8ATE",
      "3\t2026-01-17 11:04:32\t2026-01-11\tK9XYZ de EA8ATE",
    ].join("\n"),
  );
  eq(dupes.requests.length, 1, "an exact repeat is collapsed");
  eq(dupes.duplicates, 2, "and counted, so the operator sees the paste was not truncated");

  // The SAME station on two different dates is two requests, not a duplicate.
  const twoDates = parseIncomingPaste(
    ["2026-02-15 17:43:54\t2026-02-08\tK9XYZ de N4EJC", "2026-02-15 17:43:54\t2026-02-04\tK9XYZ de N4EJC"].join("\n"),
  );
  eq(twoDates.requests.length, 2, "two dates for one station are two requests");
  eq(twoDates.duplicates, 0, "and neither is a duplicate");

  eq(parseIncomingPaste("").requests.length, 0, "an empty paste yields nothing");
  eq(parseIncomingPaste("   \n\n  ").requests.length, 0, "and so does whitespace");
  // Prose must not be reported as unreadable data — only lines that look like rows.
  eq(
    parseIncomingPaste("Here is my list\nthanks\n").unread.length,
    0,
    "ordinary prose is ignored rather than flagged",
  );
  // But a row that looks like data and cannot be read MUST be surfaced, or a bad paste
  // silently loses entries.
  ok(
    parseIncomingPaste("2026-01-05\tK9XYZ de\t").unread.length === 1,
    "a row with no callsign after 'de' is reported as unread",
  );
}

console.log("\na real capture, end to end");
{
  // Twelve consecutive rows, verbatim from the operator's screen.
  const real = [
    "1\t2026-01-08 19:59:53\t2026-01-05\tK9XYZ de EA8ATE\t",
    "2\t2026-01-10 11:42:37\t2026-01-10\tK9XYZ de KI5LFM\t",
    "3\t2026-01-11 00:19:09\t2026-01-11\tK9XYZ de W3GLP\t",
    "4\t2026-01-12 23:55:59\t2026-01-12\tK9XYZ de HI3QMT\t",
    "5\t2026-01-13 02:56:07\t2026-01-13\tK9XYZ de NZ3C\t",
    "6\t2026-01-14 04:10:59\t2026-01-13\tK9XYZ de KM6JBI\t",
    "7\t2026-01-14 04:56:06\t2026-01-14\tK9XYZ de HP3BSM\t",
    "8\t2026-01-14 18:56:37\t2026-01-14\tK9XYZ de W9CIB\t",
    "9\t2026-01-15 12:46:20\t2026-01-15\tK9XYZ de N6S\t",
    "10\t2026-01-15 21:07:40\t2026-01-14\tK9XYZ de KC1YHT\t",
    "11\t2026-01-17 04:20:40\t2026-01-17\tK9XYZ de KH2SR\t",
    "12\t2026-01-17 11:04:32\t2026-01-11\tK9XYZ de EA8ATE\t",
  ].join("\n");
  const r = parseIncomingPaste(real);
  eq(r.requests.length, 12, "all twelve rows read");
  eq(r.unread.length, 0, "none unreadable");
  eq(r.duplicates, 0, "and no duplicates — the two EA8ATE rows are different QSO dates");
  // Rows 6 and 10 have a QSO date one day BEFORE the request, which is the ordinary case
  // and must not be mistaken for the request date.
  eq(r.requests[5]?.qsoDate, "2026-01-13", "row 6 takes the QSO date, a day before the request");
  eq(r.requests[9]?.qsoDate, "2026-01-14", "and so does row 10");
  ok(
    r.requests.every((x) => x.callsign !== "K9XYZ"),
    "our own callsign is never read as the correspondent",
  );
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
