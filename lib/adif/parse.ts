import {
  adifToBool,
  adifToQslRcvd,
  adifToQslSent,
  fromAdifDateTime,
  adifToQslRoute,
  fromAdifMode,
  type QslStatus,
} from "@/lib/adif/fields";
import { freqToBand, getBand, isBandName } from "@/lib/ham/bands";
import { isLoggableMode } from "@/lib/ham/modes";

// ADIF 3.x parser.
//
// Written as a scanner rather than a regex sweep because ADIF field values are
// length-prefixed and may legally contain '<' and '>'. Anything that reads the
// value by searching for the next delimiter will corrupt those records.

export type AdifFields = Record<string, string>;

/**
 * Split an ADIF document into records.
 *
 * The header is everything before `<EOH>` — but the tag is optional, since a
 * file consisting only of records is legal. Detected by looking for EOH before
 * the first EOR.
 */
export function parseAdifRecords(input: string | Buffer): AdifFields[] {
  const records: AdifFields[] = [];
  let current: AdifFields = {};
  let hasFields = false;

  // ADIF field lengths are BYTE counts, so every offset here has to be a byte
  // offset. Slicing the value out of a JS string would use UTF-16 code units
  // instead, and one multi-byte character (an em-dash in a COMMENT is enough)
  // desynchronises the scanner and silently swallows the following record.
  //
  // `latin1` is decoded purely for index arithmetic: it maps one byte to one
  // character, so string offsets equal byte offsets. Values are then pulled from
  // the Buffer and decoded as UTF-8.
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
  const scan = buf.toString("latin1");

  let i = 0;
  const len = scan.length;

  // Skip the header if there is one.
  const eoh = findTag(scan, "EOH");
  const firstEor = findTag(scan, "EOR");
  if (eoh !== -1 && (firstEor === -1 || eoh < firstEor)) {
    i = eoh;
  }

  while (i < len) {
    const lt = scan.indexOf("<", i);
    if (lt === -1) break;

    const gt = scan.indexOf(">", lt + 1);
    if (gt === -1) break;

    // Tag names are ASCII, so reading the spec from the latin1 view is safe.
    const spec = scan.slice(lt + 1, gt);
    const upper = spec.toUpperCase();

    if (upper === "EOR") {
      if (hasFields) {
        records.push(current);
        current = {};
        hasFields = false;
      }
      i = gt + 1;
      continue;
    }

    if (upper === "EOH") {
      // A second header mid-file shouldn't happen, but resetting is the safe
      // interpretation — anything accumulated so far isn't a record.
      current = {};
      hasFields = false;
      i = gt + 1;
      continue;
    }

    // NAME:LENGTH or NAME:LENGTH:TYPE
    const bits = spec.split(":");
    const name = (bits[0] ?? "").trim().toUpperCase();
    const length = Number(bits[1]);

    if (!name || !Number.isInteger(length) || length < 0) {
      // Not a field spec — skip past it rather than aborting the whole file.
      i = gt + 1;
      continue;
    }

    // Byte-accurate slice out of the Buffer, decoded as UTF-8.
    current[name] = buf
      .subarray(gt + 1, gt + 1 + length)
      .toString("utf8");
    hasFields = true;
    i = gt + 1 + length;
  }

  // A trailing record with no <EOR> — common in hand-edited files.
  if (hasFields) records.push(current);

  return records;
}

/** A zone number, or null if absent or out of range. */
function zone(raw: string | undefined, max: number): number | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > max) return null;
  return n;
}

function findTag(text: string, tag: string): number {
  const re = new RegExp(`<${tag}>`, "i");
  const m = re.exec(text);
  return m ? m.index + m[0].length : -1;
}

// ---------------------------------------------------------------------------
// Record -> QSO
// ---------------------------------------------------------------------------

export interface ParsedQso {
  callsign: string;
  band: string;
  freqHz: number;
  mode: string;
  startTime: Date;
  endTime: Date | null;
  rstSent: string | null;
  rstRcvd: string | null;
  gridSquare: string | null;
  /** ADIF TX_PWR, watts. */
  txPowerW: number | null;
  dxcc: number | null;
  name: string | null;
  qth: string | null;
  state: string | null;
  county: string | null;
  cqZone: number | null;
  ituZone: number | null;
  iota: string | null;
  continent: string | null;
  sig: string | null;
  sigInfo: string | null;
  /** ADIF MY_RIG — which radio the contact was made on. */
  radio: string | null;
  sigRefs: string[];
  qslSent: QslStatus;
  /** ADIF QSL_SENT_VIA — BUREAU | DIRECT | ELECTRONIC | MANAGER. */
  qslSentVia?: string | null;
  qslRcvdVia?: string | null;
  qslRcvd: QslStatus;
  qslSentAt: Date | null;
  qslRcvdAt: Date | null;
  lotwSent: boolean;
  lotwRcvd: boolean;
  eqslSent: boolean;
  eqslRcvd: boolean;
  notes: string | null;
  /** STATION_CALLSIGN, so the importer can match a station automatically. */
  stationCallsign: string | null;
  /** OPERATOR, so the importer can match an operator automatically. */
  operatorCallsign: string | null;
  /** True when FREQ was absent and the frequency was inferred from BAND. */
  freqInferred: boolean;
}

export interface RecordProblem {
  /** 1-based index of the record in the file. */
  record: number;
  callsign?: string;
  message: string;
}

export interface ParseResult {
  qsos: ParsedQso[];
  problems: RecordProblem[];
}

/**
 * Convert parsed ADIF fields into QSO shapes, collecting per-record problems
 * rather than throwing. A single malformed record in a 20,000-QSO file must not
 * abort the whole import.
 */
export function recordsToQsos(records: AdifFields[]): ParseResult {
  const qsos: ParsedQso[] = [];
  const problems: RecordProblem[] = [];

  records.forEach((r, idx) => {
    const n = idx + 1;
    const callsign = (r.CALL ?? "").trim().toUpperCase();

    if (!callsign) {
      problems.push({ record: n, message: "No CALL field" });
      return;
    }

    const startTime = fromAdifDateTime(r.QSO_DATE ?? "", r.TIME_ON);
    if (!startTime) {
      problems.push({
        record: n,
        callsign,
        message: `Unparseable QSO_DATE/TIME_ON ("${r.QSO_DATE ?? ""}" / "${r.TIME_ON ?? ""}")`,
      });
      return;
    }

    const mode = fromAdifMode(r.MODE ?? "", r.SUBMODE);
    if (!mode) {
      problems.push({ record: n, callsign, message: "No MODE field" });
      return;
    }
    if (!isLoggableMode(mode)) {
      problems.push({
        record: n,
        callsign,
        message: `Unsupported mode "${r.MODE ?? ""}${r.SUBMODE ? `/${r.SUBMODE}` : ""}"`,
      });
      return;
    }

    // Frequency: prefer FREQ (MHz), fall back to the band's low edge. The schema
    // requires a frequency, and rejecting an otherwise-valid QSO for lacking one
    // would refuse a lot of legitimate older logs — so it is inferred and
    // reported instead.
    let freqHz: number | null = null;
    let freqInferred = false;

    const freqRaw = (r.FREQ ?? "").trim();
    if (freqRaw) {
      const mhz = Number(freqRaw);
      if (Number.isFinite(mhz) && mhz > 0) freqHz = Math.round(mhz * 1_000_000);
    }

    const bandRaw = (r.BAND ?? "").trim().toUpperCase();

    if (freqHz === null) {
      const band = bandRaw ? getBand(bandRaw) : undefined;
      if (!band) {
        problems.push({
          record: n,
          callsign,
          message: bandRaw
            ? `No usable FREQ, and BAND "${bandRaw}" is not a known band`
            : "Neither FREQ nor BAND present",
        });
        return;
      }
      freqHz = band.lowHz;
      freqInferred = true;
    }

    // Band: trust FREQ over BAND when they disagree, because FREQ is the more
    // precise value and a mismatched band corrupts per-band award tracking.
    const derived = freqToBand(freqHz);
    let band: string;
    if (derived) {
      band = derived;
    } else if (bandRaw && isBandName(bandRaw)) {
      band = bandRaw;
    } else {
      problems.push({
        record: n,
        callsign,
        message: `${(freqHz / 1e6).toFixed(6)} MHz is outside every amateur band`,
      });
      return;
    }

    const endTime =
      r.TIME_OFF !== undefined
        ? fromAdifDateTime(r.QSO_DATE_OFF ?? r.QSO_DATE ?? "", r.TIME_OFF)
        : null;

    const dxccRaw = (r.DXCC ?? "").trim();
    const dxcc =
      dxccRaw && Number.isInteger(Number(dxccRaw)) ? Number(dxccRaw) : null;

    const grid = (r.GRIDSQUARE ?? "").trim().toUpperCase() || null;
    const txPowerRaw = (r.TX_PWR ?? "").trim();
    const txPowerW = txPowerRaw === "" ? null : Number(txPowerRaw);

    qsos.push({
      callsign,
      band,
      freqHz,
      mode,
      startTime,
      // A TIME_OFF that lands before TIME_ON is a bad record, not a reason to
      // reject the QSO — drop the end time and keep the contact.
      endTime: endTime && endTime >= startTime ? endTime : null,
      rstSent: (r.RST_SENT ?? "").trim() || null,
      rstRcvd: (r.RST_RCVD ?? "").trim() || null,
      gridSquare: grid && /^[A-R]{2}(\d{2}([A-X]{2}(\d{2})?)?)?$/.test(grid) ? grid : null,
      // TX_PWR is watts and may be fractional — QRP logs record 0.5 and 2.5.
      // Anything unparseable, zero, negative or beyond what any licence permits is
      // dropped rather than stored: NaN passes none of these, and a bogus power is
      // worse than none because it would be exported onward as fact.
      txPowerW: txPowerW !== null && txPowerW > 0 && txPowerW <= 2000 ? txPowerW : null,
      // dxcc > 0, not >= 0. ADIF uses 0 for "no DXCC entity" (maritime mobile and
      // similar), and accepting it put a literal 0 into the awards code, where it
      // became a distinct key in the worked-entities set and counted toward the
      // DXCC total. The tile then rendered blank because no entity has adif 0.
      dxcc: dxcc !== null && dxcc > 0 && dxcc <= 1000 ? dxcc : null,
      state: (r.STATE ?? "").trim().toUpperCase() || null,
      county: (r.CNTY ?? "").trim() || null,
      cqZone: zone(r.CQZ, 40),
      ituZone: zone(r.ITUZ, 90),
      iota: (r.IOTA ?? "").trim().toUpperCase() || null,
      continent: (r.CONT ?? "").trim().toUpperCase() || null,
      name: (r.NAME ?? "").trim() || null,
      qth: (r.QTH ?? "").trim() || null,
      sig: (r.SIG ?? "").trim().toUpperCase() || null,
      sigInfo: (r.SIG_INFO ?? "").trim().toUpperCase() || null,
      // Not upper-cased: a model name is a name, and "IC-7300MK2" reading as
      // shouting in the log is a small thing that looks wrong every time.
      radio: (r.MY_RIG ?? "").trim().slice(0, 64) || null,
      // Our own extras field, so a DigiShack export round-trips every park. The
      // primary is listed too, and duplicates are harmless — the reference rows
      // are unique per (contact, programme, reference).
      sigRefs: [(r.SIG_INFO ?? ""), ...(r.APP_DIGISHACK_SIGREFS ?? "").split(",")]
        .map((s) => s.trim().toUpperCase())
        .filter((s, i, a) => s.length > 0 && a.indexOf(s) === i),
      qslSent: adifToQslSent(r.QSL_SENT ?? ""),
      qslSentVia: adifToQslRoute(r.QSL_SENT_VIA),
      qslRcvdVia: adifToQslRoute(r.QSL_RCVD_VIA),
      qslRcvd: adifToQslRcvd(r.QSL_RCVD ?? ""),
      qslSentAt: r.QSLSDATE ? fromAdifDateTime(r.QSLSDATE) : null,
      qslRcvdAt: r.QSLRDATE ? fromAdifDateTime(r.QSLRDATE) : null,
      lotwSent: adifToBool(r.LOTW_QSL_SENT ?? ""),
      lotwRcvd: adifToBool(r.LOTW_QSL_RCVD ?? ""),
      eqslSent: adifToBool(r.EQSL_QSL_SENT ?? ""),
      eqslRcvd: adifToBool(r.EQSL_QSL_RCVD ?? ""),
      notes: (r.COMMENT ?? r.NOTES ?? "").trim() || null,
      stationCallsign: (r.STATION_CALLSIGN ?? "").trim().toUpperCase() || null,
      operatorCallsign: (r.OPERATOR ?? "").trim().toUpperCase() || null,
      freqInferred,
    });
  });

  return { qsos, problems };
}

export function parseAdif(input: string | Buffer): ParseResult {
  return recordsToQsos(parseAdifRecords(input));
}

/**
 * Key used for duplicate detection, both within a file and against the database.
 * Minute precision: ADIF TIME_ON is often recorded only to the minute, so
 * comparing seconds would treat re-exports of the same log as new QSOs.
 */
export function dupeKey(q: {
  callsign: string;
  band: string;
  mode: string;
  startTime: Date;
}): string {
  const t = new Date(q.startTime);
  t.setUTCSeconds(0, 0);
  return `${q.callsign}|${q.band}|${q.mode}|${t.toISOString()}`;
}
