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

export interface Mode {
  /** ADIF MODE enumeration value. */
  name: string;
  label: string;
  digital: boolean;
  rstStyle: RstStyle;
  /** ADIF SUBMODE, where the mode requires one. */
  submode?: string;
}

export const MODES: readonly Mode[] = [
  { name: "SSB", label: "SSB", digital: false, rstStyle: "RS" },
  { name: "CW", label: "CW", digital: false, rstStyle: "RST" },
  { name: "FM", label: "FM", digital: false, rstStyle: "RS" },
  { name: "AM", label: "AM", digital: false, rstStyle: "RS" },
  { name: "FT8", label: "FT8", digital: true, rstStyle: "DB" },
  { name: "MFSK", label: "FT4", digital: true, rstStyle: "DB", submode: "FT4" },
  // FT2: ADIF 3.1.7 certified (March 2026). Same 77-bit payload, LDPC(174,91)
  // and 4-GFSK core as FT8/FT4, on a 3.8 s T/R cycle. DigiShack cannot decode it
  // yet — our codec is FT8/FT4 only — but QSOs made elsewhere must import,
  // export and log correctly, which needs the mode to exist here.
  { name: "MFSK", label: "FT2", digital: true, rstStyle: "DB", submode: "FT2" },
  { name: "JS8", label: "JS8Call", digital: true, rstStyle: "DB" },
  { name: "RTTY", label: "RTTY", digital: true, rstStyle: "RST" },
  { name: "PSK", label: "PSK31", digital: true, rstStyle: "RST", submode: "PSK31" },
  { name: "JT65", label: "JT65", digital: true, rstStyle: "DB" },
  { name: "JT9", label: "JT9", digital: true, rstStyle: "DB" },
  { name: "MSK144", label: "MSK144", digital: true, rstStyle: "DB" },
  { name: "OLIVIA", label: "Olivia", digital: true, rstStyle: "RST" },
  { name: "CONTESTI", label: "Contestia", digital: true, rstStyle: "RST" },
  { name: "SSTV", label: "SSTV", digital: false, rstStyle: "RS" },
  { name: "DIGITALVOICE", label: "Digital Voice", digital: false, rstStyle: "RS" },
];

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
