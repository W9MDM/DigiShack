// Amateur band plan, keyed by ADIF 3.x `BAND` enumeration names.
//
// Band names follow ADIF deliberately, not a contest-only set.
// The old logger knew 10 contest bands and omitted 30M/17M/12M entirely — the
// WARC bands, which is where most FT8 activity actually lives. Award tracking
// (DXCC/IOTA/WAS per band) and ADIF import/export both key off these strings,
// so they have to match the standard exactly.
//
// Edges are the ADIF band boundaries (widest allocation across IARU regions),
// not US license privileges — a logbook must be able to record a DX station
// operating outside your own allocation.

export interface Band {
  /** ADIF BAND enumeration value. */
  name: string;
  lowHz: number;
  highHz: number;
  /** True for bands where mode/propagation behaviour is HF-like. */
  hf: boolean;
}

export const BANDS: readonly Band[] = [
  { name: "2190M", lowHz: 135_700, highHz: 137_800, hf: true },
  { name: "630M", lowHz: 472_000, highHz: 479_000, hf: true },
  { name: "560M", lowHz: 501_000, highHz: 504_000, hf: true },
  { name: "160M", lowHz: 1_800_000, highHz: 2_000_000, hf: true },
  { name: "80M", lowHz: 3_500_000, highHz: 4_000_000, hf: true },
  { name: "60M", lowHz: 5_060_000, highHz: 5_450_000, hf: true },
  { name: "40M", lowHz: 7_000_000, highHz: 7_300_000, hf: true },
  { name: "30M", lowHz: 10_100_000, highHz: 10_150_000, hf: true },
  { name: "20M", lowHz: 14_000_000, highHz: 14_350_000, hf: true },
  { name: "17M", lowHz: 18_068_000, highHz: 18_168_000, hf: true },
  { name: "15M", lowHz: 21_000_000, highHz: 21_450_000, hf: true },
  { name: "12M", lowHz: 24_890_000, highHz: 24_990_000, hf: true },
  { name: "10M", lowHz: 28_000_000, highHz: 29_700_000, hf: true },
  { name: "8M", lowHz: 40_000_000, highHz: 45_000_000, hf: false },
  { name: "6M", lowHz: 50_000_000, highHz: 54_000_000, hf: false },
  { name: "5M", lowHz: 54_000_001, highHz: 69_900_000, hf: false },
  { name: "4M", lowHz: 70_000_000, highHz: 71_000_000, hf: false },
  { name: "2M", lowHz: 144_000_000, highHz: 148_000_000, hf: false },
  { name: "1.25M", lowHz: 222_000_000, highHz: 225_000_000, hf: false },
  { name: "70CM", lowHz: 420_000_000, highHz: 450_000_000, hf: false },
  { name: "33CM", lowHz: 902_000_000, highHz: 928_000_000, hf: false },
  { name: "23CM", lowHz: 1_240_000_000, highHz: 1_300_000_000, hf: false },
  { name: "13CM", lowHz: 2_300_000_000, highHz: 2_450_000_000, hf: false },
  { name: "9CM", lowHz: 3_300_000_000, highHz: 3_500_000_000, hf: false },
  { name: "6CM", lowHz: 5_650_000_000, highHz: 5_925_000_000, hf: false },
  { name: "3CM", lowHz: 10_000_000_000, highHz: 10_500_000_000, hf: false },
  { name: "1.25CM", lowHz: 24_000_000_000, highHz: 24_250_000_000, hf: false },
  { name: "6MM", lowHz: 47_000_000_000, highHz: 47_200_000_000, hf: false },
  { name: "4MM", lowHz: 75_500_000_000, highHz: 81_000_000_000, hf: false },
  { name: "2.5MM", lowHz: 119_980_000_000, highHz: 123_000_000_000, hf: false },
  { name: "2MM", lowHz: 134_000_000_000, highHz: 149_000_000_000, hf: false },
  { name: "1MM", lowHz: 241_000_000_000, highHz: 250_000_000_000, hf: false },
];

export const BAND_NAMES: readonly string[] = BANDS.map((b) => b.name);

const BY_NAME = new Map(BANDS.map((b) => [b.name, b]));

/** Bands worth putting at the top of a manual-entry dropdown. */
export const COMMON_BANDS: readonly string[] = [
  "160M",
  "80M",
  "40M",
  "30M",
  "20M",
  "17M",
  "15M",
  "12M",
  "10M",
  "6M",
  "2M",
  "70CM",
];

export function isBandName(name: string): boolean {
  return BY_NAME.has(name);
}

export function getBand(name: string): Band | undefined {
  return BY_NAME.get(name);
}

/**
 * Resolve a frequency in Hz to its ADIF band name, or null if it falls in no
 * amateur allocation. Callers should treat null as "out of band" rather than
 * silently defaulting — a wrong band poisons award tracking.
 */
export function freqToBand(hz: number): string | null {
  for (const b of BANDS) {
    if (hz >= b.lowHz && hz <= b.highHz) return b.name;
  }
  return null;
}

export function freqInBand(hz: number, bandName: string): boolean {
  const b = BY_NAME.get(bandName);
  if (!b) return false;
  return hz >= b.lowHz && hz <= b.highHz;
}

/** Hz → MHz string for display, trimming trailing zeros past 3 decimals. */
/**
 * A dial frequency the way a radio's own display shows it: `14.300.000`.
 *
 * Groups MHz, kHz and Hz with separators, which is how every commercial rig front panel
 * and both of the SDR clients this one is measured against present the dial. The reason
 * is legibility at a glance rather than decoration: `14.3` and `14.03` differ by one
 * character and by 270 kHz, and an operator reading a dial mid-contact is not parsing
 * decimal places. Fixed width also stops the number jittering as it is tuned, which a
 * trailing-zero-trimming format does on every step.
 *
 * `formatFreqMHz` stays the compact form for lists, rulers and logs, where a column of
 * fixed-width nine-character numbers would be worse than the trimmed ones.
 */
export function formatFreqDial(hz: number | bigint): string {
  const n = typeof hz === "bigint" ? Number(hz) : hz;
  if (!Number.isFinite(n) || n <= 0) return "—";
  const whole = Math.floor(n);
  const mhz = Math.floor(whole / 1_000_000);
  const khz = Math.floor((whole % 1_000_000) / 1000);
  const rest = whole % 1000;
  return `${mhz}.${String(khz).padStart(3, "0")}.${String(rest).padStart(3, "0")}`;
}

export function formatFreqMHz(hz: number | bigint): string {
  const n = typeof hz === "bigint" ? Number(hz) : hz;
  if (!Number.isFinite(n) || n <= 0) return "—";
  return (n / 1_000_000).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * Parse a user-typed frequency to Hz.
 *
 * Hams type MHz ("14.074"), paste Hz from WSJT-X ("14074000") and read kHz off
 * band plans and repeater lists ("146520"). The unit is not in the string, so it
 * has to be inferred — and the previous version inferred it from MAGNITUDE alone:
 *
 *     if (n < 300_000) return n * 1_000_000;   // "MHz"
 *
 * with a comment claiming the ranges "are chosen not to overlap any plausible
 * amateur value in the wrong unit". That was false for every kHz value under
 * 300 MHz. Typing 146520 — how a club prints your 2 m repeater — produced
 * 146,520,000,000 Hz, which sits inside the 2 mm band, passed validation, and the
 * form cheerfully rendered "2MM" before accepting it.
 *
 * So: choose the interpretation that lands in an actual amateur band, rather than
 * guessing from size. A decimal point means MHz by convention and is trusted as
 * such. A bare integer is tried as MHz, kHz and Hz; exactly one candidate in a
 * real band wins. None, or more than one, returns null so the caller can ask for
 * units instead of silently picking wrong.
 */
export function parseFreqToHz(input: string): number | null {
  const cleaned = input.trim().replace(/,/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n <= 0) return null;

  // A decimal point is an explicit statement of MHz — nobody writes 14074.5 kHz
  // in a logging field. Trusted without band-checking so an out-of-band MHz value
  // still reaches the validator with a sensible message.
  if (/[.]/.test(cleaned)) return Math.round(n * 1_000_000);

  const candidates: { hz: number; unit: string }[] = [
    { hz: Math.round(n * 1_000_000), unit: "MHz" },
    { hz: Math.round(n * 1_000), unit: "kHz" },
    { hz: Math.round(n), unit: "Hz" },
  ];
  const inBand = candidates.filter((c) => freqToBand(c.hz) !== null);

  // Exactly one plausible reading: take it. 14074 is 14.074 MHz (20 m) and not
  // 14.074 GHz; 1840 is 1.84 MHz (160 m) and not 1.84 GHz; 7 is 7 MHz (40 m).
  if (inBand.length === 1) return inBand[0]!.hz;

  // More than one reading lands in a band — take the LOWEST.
  //
  // 146520 is the only common case: as kHz it is the 2 m repeater a club prints on
  // a card, and as MHz it is 146 GHz, which is inside 2 mm. The bands above
  // 100 GHz see essentially no logged activity, and anyone genuinely working them
  // will write a decimal point or paste Hz. Choosing the lowest gets the everyday
  // answer right and leaves the microwave operator an unambiguous way to say what
  // they mean, which is the better trade in both directions.
  if (inBand.length > 1) {
    return inBand.reduce((lo, c) => (c.hz < lo.hz ? c : lo)).hz;
  }

  // No reading lands in a band. Returning null is the honest answer — the caller
  // reports that it could not read the frequency, and the operator adds a decimal
  // point or types Hz, rather than the form accepting a value off by 1000x.
  return null;
}
