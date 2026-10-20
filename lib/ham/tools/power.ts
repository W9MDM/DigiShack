// Power in watts and decibels, a chain of gains and losses, and the S-meter.
//
// The S-meter scale is IARU Region 1 Technical Recommendation R.1: S9 is -73 dBm into
// 50 ohms below 30 MHz and -93 dBm above it, six dB per S-unit. Most receivers are not
// calibrated to it — an S-meter is an indication, not a measurement — so this converts
// the standard, not anyone's radio.

import { parseNumber, type Parsed } from "@/lib/ham/tools/number";

export type PowerUnit = "W" | "dBm" | "dBW";
export const POWER_UNITS: readonly PowerUnit[] = ["W", "dBm", "dBW"];

export interface PowerLevel {
  watts: number;
  dbm: number;
  dbw: number;
}

export function wattsToDbm(w: number): number {
  return 10 * Math.log10(w) + 30;
}

export function dbmToWatts(dbm: number): number {
  return 10 ** ((dbm - 30) / 10);
}

export function levelFromWatts(w: number): PowerLevel {
  return { watts: w, dbm: wattsToDbm(w), dbw: 10 * Math.log10(w) };
}

export function levelFromDbm(dbm: number): PowerLevel {
  return { watts: dbmToWatts(dbm), dbm, dbw: dbm - 30 };
}

/** Bounds that keep every derived figure finite: 1e-30 W to 1e30 W is plenty for a shack. */
const DB_LIMIT = 300;

/** A power typed in any of the three units. Watts must be above zero: 0 W is -∞ dBm. */
export function parsePower(text: string, unit: PowerUnit): Parsed<PowerLevel> {
  if (unit === "W") {
    const r = parseNumber(text, { label: "Power", unit: "W", min: 0, exclusiveMin: true });
    if (!r.ok) return r;
    const level = levelFromWatts(r.value);
    if (!Number.isFinite(level.dbm)) return { ok: false, error: "Power is out of range" };
    return { ok: true, value: level };
  }
  const r = parseNumber(text, { label: "Level", unit, min: -DB_LIMIT, max: DB_LIMIT });
  if (!r.ok) return r;
  return { ok: true, value: levelFromDbm(unit === "dBm" ? r.value : r.value + 30) };
}

export interface ChainStage {
  label: string;
  /** Positive is gain, negative is loss. */
  db: number;
}

export interface ChainResult {
  totalDb: number;
  out: PowerLevel;
}

/** Power through a chain of stages: sum the decibels, then convert once. */
export function applyChain(input: PowerLevel, stages: readonly ChainStage[]): ChainResult {
  const totalDb = stages.reduce((sum, s) => sum + s.db, 0);
  return { totalDb, out: levelFromDbm(input.dbm + totalDb) };
}

// ---------------------------------------------------------------------------
// S-meter
// ---------------------------------------------------------------------------

export type SMeterScale = "hf" | "vhf";

/** IARU Region 1 R.1: S9 below and above 30 MHz. */
export const S9_DBM: Record<SMeterScale, number> = { hf: -73, vhf: -93 };
export const DB_PER_S_UNIT = 6;
export const SMETER_OHMS = 50;

/** RMS volts across 50 ohms for a power in dBm. */
export function dbmToMicrovolts(dbm: number, ohms = SMETER_OHMS): number {
  return Math.sqrt(dbmToWatts(dbm) * ohms) * 1e6;
}

export function microvoltsToDbm(uv: number, ohms = SMETER_OHMS): number {
  const v = uv * 1e-6;
  return wattsToDbm((v * v) / ohms);
}

export interface SReading {
  /** 1 to 9. */
  s: number;
  /** dB over S9; zero below it. */
  over: number;
}

export function sReadingToDbm(r: SReading, scale: SMeterScale): number {
  return S9_DBM[scale] + (r.s - 9) * DB_PER_S_UNIT + r.over;
}

/**
 * The nearest S-meter reading for a level: "S7", "S9", "S9+20", or "below S1".
 * Above S9 the meter reads in dB over, rounded to the nearest dB.
 */
export function dbmToSLabel(dbm: number, scale: SMeterScale): string {
  if (!Number.isFinite(dbm)) return "—";
  const over = dbm - S9_DBM[scale];
  if (over >= 0.5) return `S9+${Math.round(over)}`;
  const s = Math.round(9 + over / DB_PER_S_UNIT);
  if (s >= 9) return "S9";
  if (s < 1) return "below S1";
  return `S${s}`;
}

const S_TEXT = /^s?\s*(\d{1,2})(?:\s*\+\s*(\d+(?:\.\d+)?)\s*(?:db)?)?$/i;

/** "S7", "s9+20", "9 + 10 dB". Only S9 takes a figure over. */
export function parseSReading(text: string): Parsed<SReading> {
  const t = text.trim();
  if (t === "") return { ok: false, error: "Enter an S reading such as S7 or S9+20" };
  const m = S_TEXT.exec(t);
  if (!m) return { ok: false, error: "Write the reading as S1 to S9, or S9+10, S9+20 …" };
  const s = Number(m[1]);
  const over = m[2] === undefined ? 0 : Number(m[2]);
  if (s < 1 || s > 9) return { ok: false, error: "S-units run from S1 to S9" };
  if (over > 0 && s !== 9) return { ok: false, error: "Only S9 takes a figure over it, as in S9+20" };
  if (over > 100) return { ok: false, error: "S9+100 is past any receiver's front end" };
  return { ok: true, value: { s, over } };
}

/** The scale the band calls for: R.1 switches at 30 MHz. */
export function scaleForMHz(mhz: number): SMeterScale {
  return mhz > 30 ? "vhf" : "hf";
}

/** The readings worth tabulating: S1–S9, then 10 dB steps over. */
export const S_TABLE: readonly SReading[] = [
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((s) => ({ s, over: 0 })),
  ...[10, 20, 30, 40].map((over) => ({ s: 9, over })),
];

export function sReadingLabel(r: SReading): string {
  return r.over > 0 ? `S9+${r.over}` : `S${r.s}`;
}
