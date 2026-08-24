import { createSign } from "node:crypto";
import { gzipSync } from "node:zlib";

import { toAdifMode } from "@/lib/adif/fields";
import type { LotwCert } from "@/lib/integrations/lotw-cert";

// Building the .tq8 file that LoTW accepts, and signing every contact in it.
//
// A .tq8 is GZIP OF AN ADIF-SHAPED RECORD STREAM. The extension suggests something
// structured and it is not: `<TAG:length>value` fields terminated by `<EOR>`, three record
// kinds, gzipped. Nothing here is XML.
//
// THE SIGNATURE IS THE WHOLE PROBLEM. A malformed field gets a readable complaint back from
// LoTW; a signature over the wrong bytes gets the upload rejected with no indication which
// part was wrong, and there is no test server to try it against. So the layout below is
// transcribed from Cloudlog's own `lotw_views/adif_views/adif_export.php`, which is known to
// work against the live service, rather than from any published specification -- ARRL
// documents the TQSL program, not this format.
//
// docs/lotw-upload.md previously recorded this ORDER WRONG. It said the signed string began
// with the station callsign and DXCC and used `YYYYMMDD` dates. It does neither: the station
// call and DXCC are absent from the signature entirely, the parts are concatenated in
// alphabetical order OF THEIR ADIF FIELD NAMES, and the dates carry dashes and colons. That
// error was written from memory of the source instead of the source, and would have produced
// a well-formed file that LoTW silently refused.

/** ADIF field. The length is in BYTES of the value, and there is no trailing newline in it. */
function f(name: string, value: string): string {
  return `<${name}:${Buffer.byteLength(value, "utf8")}>${value}\n`;
}

/**
 * The two fields whose declared length INCLUDES the newline after the value.
 *
 * Not a quirk to be tidied away. TQSL writes the certificate body and the signature with a
 * trailing newline inside the field, and the length count says so; Cloudlog reproduces it as
 * `strlen(...) + 1`. A reader that trusts the length -- which LoTW's does -- would take one
 * byte too few off the base64 and fail to verify.
 */
function fPlusNewline(name: string, value: string, typeSuffix = ""): string {
  const v = `${value}\n`;
  return `<${name}:${Buffer.byteLength(v, "utf8")}${typeSuffix}>${v}`;
}

/**
 * Hz as the MHz string LoTW expects: trailing zeros trimmed, no exponent.
 *
 * `String(hz / 1e6)` would usually agree, and occasionally would not -- binary floating
 * point turns some divisions into `14.074000000000001`, and that string goes into both the
 * FREQ field and the signed data, so it has to be stable rather than usually right. Fixed
 * decimals then trimmed gives the same answer PHP's default precision does for every
 * frequency an amateur logs.
 */
export function mhz(hz: number): string {
  const s = (hz / 1_000_000).toFixed(6);
  return s.replace(/\.?0+$/, "");
}

/**
 * Submodes LoTW keeps as modes in their own right. Anything else under the same parent
 * collapses -- either to the parent family or to `DATA`.
 */
const SUBMODE_KEPT: Record<string, readonly string[]> = {
  MFSK: ["FT4", "FST4", "FST4W", "MFSK16", "MFSK8", "Q65"],
  PSK: ["PSK31", "PSK63", "PSK63F", "PSK125", "PSK10", "PSK2K", "FSK31", "PSKFEC31"],
  HELL: ["HFSK"],
  JT9: ["JT9G"],
  TOR: ["GTOR"],
};

/** Submodes LoTW spells differently from ADIF. */
const SUBMODE_RENAMED: Record<string, string> = {
  BPSK31: "PSK31",
  QPSK31: "PSK31",
  BPSK63: "PSK63",
  QPSK63: "PSK63",
  BPSK125: "PSK125",
  QPSK125: "PSK125",
  PSKAM10: "PSKAM",
  PSKAM31: "PSKAM",
  PSKAM50: "PSKAM",
};

/** Parents that collapse to a single LoTW mode whatever the submode says. */
const PARENT_COLLAPSE: Record<string, string> = {
  PKT: "PACKET",
  PAC: "PACTOR",
  PAX: "PAX",
  TOR: "AMTOR",
  THRB: "THROB",
  CLO: "CLOVER",
  V4: "DATA",
  SSB: "SSB",
  RTTY: "RTTY",
  CW: "CW",
  JT65: "JT65",
  JT4: "JT4",
  JT9: "JT9",
  QRA64: "QRA64",
  ISCAT: "ISCAT",
  OLIVIA: "OLIVIA",
  OPERA: "OPERA",
  ROS: "ROS",
  HELL: "HELL",
  DOMINO: "DOMINO",
  CHIP: "CHIP",
};

/** Parents where an unrecognised submode means `DATA` rather than the parent name. */
const DATA_PARENTS = new Set(["MFSK", "PSK"]);

/**
 * ADIF mode and submode to the mode name LoTW uses.
 *
 * LoTW's mode list is its own -- narrower than ADIF's in places and differently spelled in
 * others -- and it rejects a name it does not know rather than ignoring the field. FT8 and
 * FT4 are distinct LoTW modes, so sending `MFSK` or `DATA` for an FT4 contact loses the
 * mode; sending `FT4` for something that is merely MFSK is refused.
 */
export function lotwMode(mode: string, submode?: string | null): string {
  const m = mode.trim().toUpperCase();
  const s = (submode ?? "").trim().toUpperCase();

  if (s) {
    if (SUBMODE_KEPT[m]?.includes(s)) return s;
    const renamed = SUBMODE_RENAMED[s];
    if (renamed && (m === "PSK" || m === "MFSK")) return renamed;
  }
  if (DATA_PARENTS.has(m)) return "DATA";
  return PARENT_COLLAPSE[m] ?? m;
}

/**
 * The station location, as LoTW understands one.
 *
 * DigiShack's `Station` holds a callsign and a grid and nothing else, which is enough for
 * DXCC credit and NOT enough for WAS or county awards -- LoTW grants those from the state
 * and county on the tSTATION record, and a contact uploaded without them is credited without
 * them permanently unless the operator notices and re-uploads. So these come from settings
 * (`lotw.station.*`) rather than being quietly left out.
 *
 * Everything except the callsign and DXCC is optional, and an absent value is OMITTED rather
 * than sent empty: an empty field would still be a field, and it changes the signed bytes.
 */
export interface LotwStation {
  callsign: string;
  dxcc: number | null;
  grid: string | null;
  /** Two-letter US state or Canadian province, per LoTW's own list. */
  state: string | null;
  county: string | null;
  cqZone: number | null;
  ituZone: number | null;
  iota: string | null;
  /** True when `state` should be sent as CA_PROVINCE rather than US_STATE. */
  canadian: boolean;
}

export interface LotwContact {
  callsign: string;
  band: string;
  bandRx: string | null;
  /** DigiShack's own mode name. Mapped through ADIF, then to LoTW's list. */
  mode: string;
  freqHz: number | null;
  freqRxHz: number | null;
  propMode: string | null;
  satName: string | null;
  startTime: Date;
}

function up(s: string | null | undefined): string | null {
  const v = (s ?? "").trim();
  return v ? v.toUpperCase() : null;
}

/** UTC, `YYYY-MM-DD`. Dashes: the signed string carries them, not the bare ADIF form. */
function sigDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** UTC, `HH:MM:SS`. The `Z` is appended by the caller, because it is inside the field. */
function sigTime(d: Date): string {
  return d.toISOString().slice(11, 19);
}

/**
 * The exact bytes that get signed for one contact.
 *
 * A concatenation with NO separators, in this order, each part upper-cased and each absent
 * part omitted entirely rather than left as an empty string. The order is ALPHABETICAL BY
 * ADIF FIELD NAME -- station fields first, then contact fields -- which is not obvious and
 * is not documented; it is what Cloudlog does, and Cloudlog's uploads are accepted.
 *
 * Deliberately NOT included, though a reasonable person would expect them: the station
 * callsign and the station DXCC. They appear in the tSTATION record and not in the
 * signature. Adding them is the single most likely way to break this, so it is written down
 * here rather than left to be rediscovered.
 */
export function signData(st: LotwStation, q: LotwContact): string {
  const parts: (string | null)[] = [
    // Station, alphabetical: CA_PROVINCE, CQZ, GRIDSQUARE, IOTA, ITUZ, US_COUNTY, US_STATE.
    st.canadian ? up(st.state) : null,
    st.cqZone === null ? null : String(st.cqZone),
    up(st.grid),
    up(st.iota),
    st.ituZone === null ? null : String(st.ituZone),
    up(st.county),
    st.canadian ? null : up(st.state),
    // Contact, alphabetical: BAND, BAND_RX, CALL, FREQ, FREQ_RX, MODE, PROP_MODE, then the
    // date and time, then SAT_NAME.
    up(q.band),
    up(q.bandRx),
    up(q.callsign),
    q.freqHz ? mhz(q.freqHz) : null,
    q.freqRxHz ? mhz(q.freqRxHz) : null,
    lotwMode(...adifModeOf(q.mode)),
    up(q.propMode),
    sigDate(q.startTime),
    `${sigTime(q.startTime)}Z`,
    up(q.satName),
  ];
  return parts.filter((p): p is string => p !== null && p !== "").join("");
}

/**
 * DigiShack's mode name as the ADIF mode/submode pair LoTW's map expects.
 *
 * Routed through the ADIF writer's own table rather than a second one, so `FT4` cannot mean
 * MFSK/FT4 in an export and something else in a LoTW upload.
 */
function adifModeOf(mode: string): [string, string | undefined] {
  const a = toAdifMode(mode);
  return [a.mode, a.submode];
}

/** RSA-SHA1 over the signed string, base64. SHA-1 is LoTW's choice, not ours. */
export function signContact(keyPem: string, data: string): string {
  return createSign("RSA-SHA1").update(data, "utf8").sign(keyPem, "base64");
}

/**
 * The version banner. LoTW reads it, so it says what a TQSL of this vintage says.
 *
 * Claiming to be TQSL is not a pretence anybody is harmed by -- the field records the format
 * version the file conforms to, and this file conforms to what TQSL 2.5.4 writes. Sending a
 * DigiShack version here would be more honest and would be rejected, because the value is
 * matched rather than logged.
 */
const IDENT = "TQSL V2.5.4 Lib: V2.5 Config: V11.12 AllowDupes: false";

function certRecord(certPem: string): string {
  const body = certPem
    .replace(/-----BEGIN CERTIFICATE-----/g, "")
    .replace(/-----END CERTIFICATE-----/g, "")
    .trim();
  return (
    f("Rec_Type", "tCERT") + f("CERT_UID", "1") + fPlusNewline("CERTIFICATE", body) + "<EOR>\n\n"
  );
}

function stationRecord(st: LotwStation): string {
  const out = [
    f("Rec_Type", "tSTATION"),
    f("STATION_UID", "1"),
    f("CERT_UID", "1"),
    f("CALL", st.callsign.toUpperCase()),
    f("DXCC", String(st.dxcc ?? 0)),
  ];
  const grid = up(st.grid);
  if (grid) out.push(f("GRIDSQUARE", grid));
  if (st.ituZone !== null) out.push(f("ITUZ", String(st.ituZone)));
  if (st.cqZone !== null) out.push(f("CQZ", String(st.cqZone)));
  const iota = up(st.iota);
  if (iota) out.push(f("IOTA", iota));
  const state = up(st.state);
  if (state) out.push(f(st.canadian ? "CA_PROVINCE" : "US_STATE", state));
  const county = up(st.county);
  if (county) out.push(f("US_COUNTY", county));
  return out.join("") + "<EOR>\n\n";
}

function contactRecord(st: LotwStation, q: LotwContact, keyPem: string): string {
  const sd = signData(st, q);
  const out = [
    f("Rec_Type", "tCONTACT"),
    f("STATION_UID", "1"),
    f("CALL", q.callsign.toUpperCase()),
    f("BAND", q.band.toUpperCase()),
    f("MODE", lotwMode(...adifModeOf(q.mode))),
  ];
  if (q.freqHz) out.push(f("FREQ", mhz(q.freqHz)));
  if (q.freqRxHz) out.push(f("FREQ_RX", mhz(q.freqRxHz)));
  const prop = up(q.propMode);
  if (prop) out.push(f("PROP_MODE", prop));
  const sat = up(q.satName);
  if (sat) out.push(f("SAT_NAME", sat));
  const bandRx = up(q.bandRx);
  if (bandRx) out.push(f("BAND_RX", bandRx));
  out.push(f("QSO_DATE", sigDate(q.startTime)));
  out.push(f("QSO_TIME", `${sigTime(q.startTime)}Z`));
  // `:6` is TQSL's ADIF data-type indicator for the signature field, and the declared
  // length counts the newline the value ends with. Both are reproduced exactly.
  out.push(fPlusNewline("SIGN_LOTW_V2.0", signContact(keyPem, sd), ":6"));
  out.push(f("SIGNDATA", sd));
  return out.join("") + "<EOR>\n\n";
}

export interface Tq8Result {
  /** The gzipped file, ready to POST. */
  gz: Buffer;
  /** Contacts actually in it. */
  included: number;
  /** Contacts left out, with the reason -- shown to the operator rather than swallowed. */
  excluded: { callsign: string; startTime: Date; reason: string }[];
}

/**
 * Build a signed `.tq8` for a batch of contacts.
 *
 * Contacts outside the certificate's QSO date window are EXCLUDED HERE rather than sent and
 * refused. LoTW rejects the whole file when one record fails, so a single 1998 contact under
 * a certificate that starts in 2003 would cost the entire batch -- and the reply would not
 * say which contact did it.
 */
export function buildTq8(cert: LotwCert, st: LotwStation, qsos: LotwContact[]): Tq8Result {
  const excluded: Tq8Result["excluded"] = [];
  const usable: LotwContact[] = [];

  for (const q of qsos) {
    const t = q.startTime.getTime();
    if (cert.qsoStart && t < cert.qsoStart.getTime()) {
      excluded.push({
        callsign: q.callsign,
        startTime: q.startTime,
        reason: `before the certificate's QSO window opens (${cert.qsoStart.toISOString().slice(0, 10)})`,
      });
      continue;
    }
    if (cert.qsoEnd && t > cert.qsoEnd.getTime()) {
      excluded.push({
        callsign: q.callsign,
        startTime: q.startTime,
        reason: `after the certificate's QSO window closes (${cert.qsoEnd.toISOString().slice(0, 10)})`,
      });
      continue;
    }
    usable.push(q);
  }

  const body =
    `<TQSL_IDENT:${IDENT.length}>${IDENT}\n\n` +
    certRecord(cert.certPem) +
    stationRecord(st) +
    usable.map((q) => contactRecord(st, q, cert.keyPem)).join("");

  return { gz: gzipSync(Buffer.from(body, "utf8"), { level: 9 }), included: usable.length, excluded };
}
