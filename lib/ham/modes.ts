// Mode table, keyed by ADIF 3.x `MODE` enumeration names.
//
// An earlier iteration collapsed everything digital into a single "DIG" mode, which is
// correct for a Field Day Cabrillo submission but wrong for a general logbook:
// FT8 and FT4 are separate ADIF modes, LoTW matches on them, and the spec's
// Phase 4 work needs to tell them apart. So they are distinct here.

export type RstStyle =
  /** 599 — CW and other on/off keying. */
  | "RST"
  /** 59 — voice, no tone digit. */
  | "RS"
  /** dB signal report, e.g. -12. What FT8/FT4 actually exchange. */
  | "DB"
  /** No report is conventionally exchanged. */
  | "NONE";

// FT4 is ADIF MODE=MFSK SUBMODE=FT4, but WSJT-X reports it as "FT4" and
// operators think of it as its own mode. DigiShack stores what the operator and
// the decoder call it; the ADIF writer in Phase 2 is responsible for splitting
// "FT4" back into MODE/SUBMODE on export. Keeping "FT4" here means the Phase 4
// bridge can persist decoder output verbatim without a lookup table.
export const LOGGABLE_MODES: readonly string[] = [
  "SSB",
  "CW",
  "FM",
  "AM",
  "FT8",
  "FT4",
  "FT2",
  "JS8",
  "RTTY",
  "PSK31",
  "JT65",
  "JT9",
  "MSK144",
  "OLIVIA",
  "CONTESTI",
  "HELL",
  "SSTV",
  "DIGITALVOICE",
];

const RST_STYLE_BY_MODE = new Map<string, RstStyle>([
  ["SSB", "RS"],
  ["FM", "RS"],
  ["AM", "RS"],
  ["SSTV", "RS"],
  ["DIGITALVOICE", "RS"],
  ["CW", "RST"],
  ["RTTY", "RST"],
  ["PSK31", "RST"],
  ["OLIVIA", "RST"],
  ["CONTESTI", "RST"],
  ["HELL", "RST"],
  ["FT8", "DB"],
  ["FT4", "DB"],
  ["FT2", "DB"],
  ["JS8", "DB"],
  ["JT65", "DB"],
  ["JT9", "DB"],
  ["MSK144", "DB"],
]);

const DIGITAL_MODES = new Set([
  "FT8",
  "FT4",
  "FT2",
  "JS8",
  "RTTY",
  "PSK31",
  "JT65",
  "JT9",
  "MSK144",
  "OLIVIA",
  "CONTESTI",
  "HELL",
]);

export function isLoggableMode(mode: string): boolean {
  return LOGGABLE_MODES.includes(mode);
}

export function isDigitalMode(mode: string): boolean {
  return DIGITAL_MODES.has(mode);
}

export function rstStyleFor(mode: string): RstStyle {
  return RST_STYLE_BY_MODE.get(mode) ?? "RS";
}

/** Conventional default report to prefill on the entry form for a given mode. */
export function defaultRst(mode: string): string {
  switch (rstStyleFor(mode)) {
    case "RST":
      return "599";
    case "RS":
      return "59";
    case "DB":
      return "-10";
    default:
      return "";
  }
}
