// Mapping between DigiShack's storage values and ADIF 3.1.x enumerations.
//
// DigiShack stores what the operator and the decoder call a mode ("FT4"), while
// ADIF encodes some of those as a MODE/SUBMODE pair (MODE=MFSK SUBMODE=FT4).
// That translation lives here so the writer, the parser and the Phase 2 upload
// integrations all agree on it.

export const ADIF_VERSION = "3.1.4";

export interface AdifMode {
  mode: string;
  submode?: string;
}

/** DigiShack mode -> ADIF MODE/SUBMODE. */
const TO_ADIF: Record<string, AdifMode> = {
  SSB: { mode: "SSB" },
  CW: { mode: "CW" },
  FM: { mode: "FM" },
  AM: { mode: "AM" },
  FT8: { mode: "FT8" },
  FT4: { mode: "MFSK", submode: "FT4" },
  FT2: { mode: "MFSK", submode: "FT2" },
  JS8: { mode: "JS8" },
  RTTY: { mode: "RTTY" },
  PSK31: { mode: "PSK", submode: "PSK31" },
  JT65: { mode: "JT65" },
  JT9: { mode: "JT9" },
  MSK144: { mode: "MSK144" },
  OLIVIA: { mode: "OLIVIA" },
  CONTESTI: { mode: "CONTESTI" },
  SSTV: { mode: "SSTV" },
  DIGITALVOICE: { mode: "DIGITALVOICE" },
};

export function toAdifMode(mode: string): AdifMode {
  return TO_ADIF[mode.toUpperCase()] ?? { mode: mode.toUpperCase() };
}

/**
 * ADIF MODE/SUBMODE -> DigiShack mode.
 *
 * Handles more than the exact inverse of the table above, because real ADIF in
 * the wild is inconsistent: WSJT-X and some loggers emit MODE=FT4 directly even
 * though the standard says MFSK/FT4, and plenty of software writes USB/LSB where
 * ADIF wants SSB.
 */
export function fromAdifMode(mode: string, submode?: string): string {
  const m = mode.trim().toUpperCase();
  const s = submode?.trim().toUpperCase();

  if (s) {
    // A recognised submode wins — it is the more specific value.
    if (s === "FT4") return "FT4";
    if (s === "FT2") return "FT2";
    if (s === "PSK31") return "PSK31";
    if (s === "JS8") return "JS8";
    if (s === "USB" || s === "LSB") return "SSB";
  }

  switch (m) {
    case "USB":
    case "LSB":
      return "SSB";
    case "MFSK":
      // MFSK with no usable submode is ambiguous; FT4 is by far the most common
      // producer of bare MFSK records in amateur logs.
      return s ?? "FT4";
    case "PSK":
      return s ?? "PSK31";
    default:
      return m;
  }
}

// ---------------------------------------------------------------------------
// QSL status
// ---------------------------------------------------------------------------
//
// ADIF QSL_SENT: Y(es) N(o) R(equested) Q(ueued) I(gnore)
// ADIF QSL_RCVD: Y(es) N(o) R(equested) I(gnore) V(erified)

export type QslStatus = "NONE" | "REQUESTED" | "SENT" | "CONFIRMED";

/**
 * ADIF QSL_SENT_VIA / QSL_RCVD_VIA single-letter codes.
 *
 * Exported so a card batch can be round-tripped: without the route, an imported
 * log cannot tell a bureau card from direct mail, and the two are worked as
 * completely separate batches.
 */
export function qslRouteToAdif(route: string | null | undefined): string {
  switch (route) {
    case "BUREAU":
      return "B";
    case "DIRECT":
      return "D";
    case "ELECTRONIC":
      return "E";
    case "MANAGER":
      return "M";
    default:
      return "";
  }
}

/** Inverse of the above. Unknown codes yield null rather than a guess. */
export function adifToQslRoute(code: string | undefined): string | null {
  switch ((code ?? "").trim().toUpperCase()) {
    case "B":
      return "BUREAU";
    case "D":
      return "DIRECT";
    case "E":
      return "ELECTRONIC";
    case "M":
      return "MANAGER";
    default:
      return null;
  }
}

export function qslSentToAdif(status: QslStatus): string {
  switch (status) {
    case "REQUESTED":
      return "R";
    case "SENT":
    case "CONFIRMED":
      return "Y";
    default:
      return "N";
  }
}

export function qslRcvdToAdif(status: QslStatus): string {
  switch (status) {
    case "CONFIRMED":
      return "Y";
    case "REQUESTED":
      return "R";
    // "SENT" is meaningless for a received QSL; treat as nothing received.
    default:
      return "N";
  }
}

export function adifToQslSent(value: string): QslStatus {
  switch (value.trim().toUpperCase()[0]) {
    case "Y":
      return "SENT";
    case "R":
    case "Q":
      return "REQUESTED";
    default:
      return "NONE";
  }
}

export function adifToQslRcvd(value: string): QslStatus {
  switch (value.trim().toUpperCase()[0]) {
    // V(erified) is LoTW's "confirmed" — same meaning for our purposes.
    case "Y":
    case "V":
      return "CONFIRMED";
    case "R":
      return "REQUESTED";
    default:
      return "NONE";
  }
}

/** LoTW/eQSL flags are booleans here, but ADIF still uses the letter enum. */
export function boolToAdif(value: boolean): string {
  return value ? "Y" : "N";
}

export function adifToBool(value: string): boolean {
  const c = value.trim().toUpperCase()[0];
  return c === "Y" || c === "V";
}

// ---------------------------------------------------------------------------
// Date / time
// ---------------------------------------------------------------------------

/** Date -> ADIF QSO_DATE, always UTC: YYYYMMDD. */
export function toAdifDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

/** Date -> ADIF TIME_ON/TIME_OFF, always UTC: HHMMSS. */
export function toAdifTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

/**
 * ADIF date + time -> Date, interpreted as UTC.
 *
 * TIME_ON is allowed to be either HHMM or HHMMSS by the standard, and both turn
 * up in practice. Returns null on anything unparseable rather than an Invalid
 * Date, so the importer can report the record instead of writing garbage.
 */
export function fromAdifDateTime(date: string, time?: string): Date | null {
  const d = date.trim();
  if (!/^\d{8}$/.test(d)) return null;

  const t = (time ?? "0000").trim();
  if (!/^\d{4}(\d{2})?$/.test(t)) return null;

  const year = Number(d.slice(0, 4));
  const month = Number(d.slice(4, 6));
  const day = Number(d.slice(6, 8));
  const hour = Number(t.slice(0, 2));
  const minute = Number(t.slice(2, 4));
  const second = t.length === 6 ? Number(t.slice(4, 6)) : 0;

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;

  const parsed = new Date(
    Date.UTC(year, month - 1, day, hour, minute, second),
  );
  // Rejects things like 20260231 that Date.UTC silently rolls over.
  if (parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    return null;
  }
  return parsed;
}
