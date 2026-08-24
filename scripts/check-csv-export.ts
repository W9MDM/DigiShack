/* eslint-disable no-console */
// CSV quoting.
//
// The failure this guards against is silent. A cell containing a comma, written naively, shifts
// every later column on that row — and a spreadsheet reports no error, it just shows a grid that
// is wrong from that row down. Contact notes are free text, names contain commas ("Smith,
// John"), and comments get pasted out of email complete with quotes and line breaks, so this is
// ordinary data rather than a hypothetical.
//
// The other half is formula injection. A cell beginning `=`, `+`, `-` or `@` is evaluated by
// Excel and LibreOffice on open, which makes a log export a delivery mechanism — the log holds
// text typed by other people, arriving over the air and out of QRZ.

import { csvCell, csvHeader, csvRow, CSV_COLUMNS } from "@/lib/adif/csv";

let pass = 0;
let fail = 0;
function eq(got: unknown, want: unknown, label: string): void {
  if (got === want) {
    pass++;
    console.log(`  ok    ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);
  }
}
function ok(cond: boolean, label: string): void {
  if (cond) {
    pass++;
    console.log(`  ok    ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}`);
  }
}

console.log("plain values are left alone");
eq(csvCell("W1ABC"), "W1ABC", "a callsign needs no quoting");
eq(csvCell(20), "20", "a number");
eq(csvCell(null), "", "null is an empty cell, not the word null");
eq(csvCell(undefined), "", "and so is undefined");
eq(csvCell(""), "", "an empty string stays empty");

console.log("\nseparators are quoted");
eq(csvCell("Smith, John"), '"Smith, John"', "a comma forces quotes");
eq(csvCell('He said "hi"'), '"He said ""hi"""', "an inner quote is doubled, per RFC 4180");
eq(csvCell("line one\nline two"), '"line one\nline two"', "a newline forces quotes");
eq(csvCell("carriage\rreturn"), '"carriage\rreturn"', "and so does a bare CR");

console.log("\nformula injection is neutralised");
// Each of these is evaluated on open by Excel and LibreOffice if written bare.
eq(csvCell("=1+1"), "'=1+1", "a leading = is prefixed so it is read as text");
eq(csvCell("+1 555 0100"), "'+1 555 0100", "and a leading +, which a phone number starts with");
eq(csvCell("-5 dB"), "'-5 dB", "and a leading minus followed by text");
// AN FT8 SIGNAL REPORT IS A SIGNED NUMBER, and every digital contact in the log has one. The
// first version of the guard prefixed these, turning both RST columns into text on essentially
// every row — which costs the one thing somebody exports an SNR column to do, sort by it.
// Excel reads "-03" as minus three; what it must not be given bare is "-1+1".
eq(csvCell("-03"), "-03", "a bare negative number is left as a number — it is not a formula");
eq(csvCell("+12"), "+12", "and so is a bare positive one, which FT8 reports also use");
eq(csvCell("-14.5"), "-14.5", "decimals too");
eq(csvCell("-1+1"), "'-1+1", "but arithmetic that merely starts like a number is guarded");
eq(csvCell("+1-800-555"), "'+1-800-555", "and a phone number, which is not a single number");
eq(csvCell("@SomeName"), "'@SomeName", "and a leading @");
// The guard must not fire on ordinary text, or every note gains a stray apostrophe.
eq(csvCell("Nice QSO, thanks"), '"Nice QSO, thanks"', "ordinary text is not prefixed");
eq(csvCell("59 into Indiana"), "59 into Indiana", "nor a report that merely contains digits");
// Guarded AND quoted when it needs both.
eq(csvCell("=SUM(A1,A2)"), `"'=SUM(A1,A2)"`, "a formula containing a comma gets both treatments");

console.log("\nrows and the header");
eq(csvRow(["a", "b"]), "a,b\r\n", "CRLF line endings, per RFC 4180");
eq(csvRow([]), "\r\n", "an empty row is still a line");
ok(csvHeader().startsWith("Date,Time,Callsign,"), "the header leads with what a person reads first");
ok(csvHeader().endsWith("\r\n"), "and ends with CRLF");
// A header cell needing quotes would break the column count against the rows below it.
eq(
  CSV_COLUMNS.filter((c) => csvCell(c) !== c).length,
  0,
  `none of the ${CSV_COLUMNS.length} column names need quoting`,
);
ok(new Set(CSV_COLUMNS).size === CSV_COLUMNS.length, "and none is duplicated");

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
