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
  // Submodes stored as modes, as FT4 is, so each exports as its own ADIF SUBMODE.
  ...["PSK63","PSK125","FSKH105","FSKH245","HELL80","SLOWHELL","PSKHELL"],
  // The fldigi modes added after: MFSK, DominoEX and MT63, and the other PSK speeds and QPSK.
  ...["MFSK8", "MFSK11", "MFSK16", "MFSK22", "MFSK32", "DOMINOEX", "MT63", "QPSK31", "QPSK63", "QPSK125", "PSK250", "PSK500", "PSK63F", "PSK125R", "PSK250R", "PSK500R"],
  "SSTV",
  "DIGITALVOICE",
];

/**
 * The modes the text-mode log bar logs (pages/api/digital/log.ts): the keyboard modes,
 * with each Hell mode and PSK speed as its own ADIF submode. Not JTTY, which has no ADIF
 * mode yet, and not SSTV, which logs from its picture.
 */
export const TEXT_LOG_MODES: readonly string[] = ["RTTY", "CW", "PSK31", "OLIVIA", "CONTESTI", "HELL", ...["PSK63","PSK125","FSKH105","FSKH245","HELL80","SLOWHELL","PSKHELL"], ...["MFSK8", "MFSK11", "MFSK16", "MFSK22", "MFSK32", "DOMINOEX", "MT63", "QPSK31", "QPSK63", "QPSK125", "PSK250", "PSK500", "PSK63F", "PSK125R", "PSK250R", "PSK500R"]];

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
  ["PSK63", "RST"],
  ["PSK125", "RST"],
  ["FSKH105", "RST"],
  ["FSKH245", "RST"],
  ["HELL80", "RST"],
  ["SLOWHELL", "RST"],
  ["PSKHELL", "RST"],
  ["MFSK8", "RST"],
  ["MFSK11", "RST"],
  ["MFSK16", "RST"],
  ["MFSK22", "RST"],
  ["MFSK32", "RST"],
  ["DOMINOEX", "RST"],
  ["MT63", "RST"],
  ["QPSK31", "RST"],
  ["QPSK63", "RST"],
  ["QPSK125", "RST"],
  ["PSK250", "RST"],
  ["PSK500", "RST"],
  ["PSK63F", "RST"],
  ["PSK125R", "RST"],
  ["PSK250R", "RST"],
  ["PSK500R", "RST"],
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
  "PSK63",
  "PSK125",
  "FSKH105",
  "FSKH245",
  "HELL80",
  "SLOWHELL",
  "PSKHELL",
  "MFSK8",
  "MFSK11",
  "MFSK16",
  "MFSK22",
  "MFSK32",
  "DOMINOEX",
  "MT63",
  "QPSK31",
  "QPSK63",
  "QPSK125",
  "PSK250",
  "PSK500",
  "PSK63F",
  "PSK125R",
  "PSK250R",
  "PSK500R",
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
