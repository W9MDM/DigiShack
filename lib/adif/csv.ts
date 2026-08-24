import type { AdifQsoInput } from "@/lib/adif/write";
import { toAdifDate, toAdifMode, toAdifTime } from "@/lib/adif/fields";

// CSV export, for spreadsheets.
//
// ADIF is the interchange format and every logger reads it; CSV is what someone opens in
// Excel or LibreOffice to sort, filter and count by hand. Different jobs, so this is not a
// worse ADIF — it is a flat table with one row per contact and no tag syntax to strip.
//
// THE QUOTING IS THE WHOLE PROBLEM, and it is not hypothetical here. Contact notes are free
// text and routinely contain commas; a name can contain a comma ("Smith, John"); a comment can
// contain a double quote or a newline pasted from an email. Any of those written naively
// shifts every later column on that row, and a spreadsheet reports no error — it just shows a
// grid that is silently wrong from that row down, which is worse than a refusal.

/**
 * Does this value need protecting from Excel's formula parser?
 *
 * A leading `=`, `+`, `-`, `@`, tab or CR makes Excel and LibreOffice evaluate the cell on
 * open. A log holds text typed by other people, arriving over the air and out of QRZ, so an
 * export of it is a delivery mechanism and the guard is not optional.
 *
 * BUT A PLAIN SIGNED NUMBER IS NOT A FORMULA, and excluding it matters more than it looks. An
 * FT8 signal report IS `-03` or `+12` — every digital contact in this log has one — so the
 * first version of this guard turned both RST columns into text on essentially every row.
 * Excel reads `-03` as minus three quite happily; what it must not be handed bare is something
 * like `-1+1` or `=SUM(...)`. Quoting the numbers as text costs the one thing somebody exports
 * an SNR column in order to do, which is sort by it.
 */
function needsFormulaGuard(s: string): boolean {
  if (!/^[=+\-@\t\r]/.test(s)) return false;
  // Entirely a signed number, decimals allowed: safe as it is, and wanted as a number.
  return !/^[+-]?\d+(?:\.\d+)?$/.test(s);
}

/** RFC 4180: wrap in quotes when needed, and double any quote inside. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (s === "") return "";
  // A leading =, +, - or @ makes Excel and LibreOffice treat the cell as a FORMULA.
  //
  // A contact note beginning "=" would be evaluated on open, and a note beginning "+1..." can
  // become a broken formula reference. Prefixed with a single quote, which both applications
  // read as "this is text" — the conventional mitigation, and the reason exports are a known
  // injection vector rather than a formatting nicety.
  const guarded = needsFormulaGuard(s) ? `'${s}` : s;
  return /[",\n\r]/.test(guarded) ? `"${guarded.split('"').join('""')}"` : guarded;
}

export function csvRow(cells: unknown[]): string {
  // CRLF, per RFC 4180. Excel on Windows is the main consumer and handles bare LF
  // inconsistently across versions.
  return `${cells.map(csvCell).join(",")}\r\n`;
}

/**
 * Columns, in the order a person reads a log.
 *
 * Deliberately not every ADIF field. A hundred mostly-empty columns is not a useful
 * spreadsheet, and anyone who needs the complete record wants the ADIF export instead — this
 * is the set someone sorts and filters by.
 */
export const CSV_COLUMNS = [
  "Date",
  "Time",
  "Callsign",
  "Band",
  "Mode",
  "Submode",
  "Frequency (MHz)",
  "RST Sent",
  "RST Rcvd",
  "Grid",
  "Name",
  "QTH",
  "State",
  "County",
  "DXCC",
  "Continent",
  "CQ Zone",
  "ITU Zone",
  "IOTA",
  "Power (W)",
  "Program",
  "Reference",
  "QSL Sent",
  "QSL Rcvd",
  "LoTW Sent",
  "LoTW Rcvd",
  "eQSL Sent",
  "eQSL Rcvd",
  "Station",
  "Operator",
  "Notes",
] as const;

export function csvHeader(): string {
  return csvRow([...CSV_COLUMNS]);
}

export function csvRecord(q: AdifQsoInput): string {
  const { mode, submode } = toAdifMode(q.mode);
  return csvRow([
    toAdifDate(q.startTime),
    toAdifTime(q.startTime),
    q.callsign,
    q.band,
    mode,
    submode ?? "",
    // Six decimals, not trimmed. A spreadsheet column sorts and aligns better with a fixed
    // shape, and unlike the LoTW signature nothing here depends on the exact string.
    (Number(q.freqHz) / 1_000_000).toFixed(6),
    q.rstSent,
    q.rstRcvd,
    q.gridSquare,
    q.name,
    q.qth,
    q.state,
    q.county,
    q.dxcc,
    q.continent,
    q.cqZone,
    q.ituZone,
    q.iota,
    q.txPowerW,
    q.sig,
    // Several references are possible on one contact. Joined with a space rather than a
    // comma so the cell does not need quoting for a reason that is ours rather than the
    // data's.
    (q.sigRefs ?? []).join(" ") || q.sigInfo,
    q.qslSent,
    q.qslRcvd,
    q.lotwSent ? "Y" : "",
    q.lotwRcvd ? "Y" : "",
    q.eqslSent ? "Y" : "",
    q.eqslRcvd ? "Y" : "",
    q.station?.callsign,
    q.operator?.callsign,
    q.notes,
  ]);
}

export function csvFilename(now = new Date()): string {
  return `digishack-log-${now.toISOString().slice(0, 10)}.csv`;
}
