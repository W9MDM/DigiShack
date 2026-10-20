// Wavelength and frequency: λ = c / f, both ways, and which band a frequency is in.

import { freqToBand } from "@/lib/ham/bands";
import { METRES_PER_FOOT, parseNumber, type Parsed } from "@/lib/ham/tools/number";

/** Speed of light, m/s. Exact by definition of the metre. */
export const C = 299_792_458;

export function wavelengthM(mhz: number): number {
  return C / (mhz * 1e6);
}

export function mhzFromWavelength(metres: number): number {
  return C / metres / 1e6;
}

/** Wide enough for anything an amateur calculates, narrow enough to stay finite. */
const MHZ_MAX = 1_000_000;

/** A frequency in MHz, as the antenna and feedline tools take it. */
export function parseMHz(text: string): Parsed<number> {
  return parseNumber(text, {
    label: "Frequency",
    unit: "MHz",
    min: 0,
    exclusiveMin: true,
    max: MHZ_MAX,
  });
}

export type WaveUnit = "MHz" | "kHz" | "GHz" | "m" | "cm" | "ft";
export const WAVE_UNITS: readonly WaveUnit[] = ["MHz", "kHz", "GHz", "m", "cm", "ft"];

export interface Wave {
  mhz: number;
  metres: number;
}

const TO_MHZ: Partial<Record<WaveUnit, number>> = { MHz: 1, kHz: 1e-3, GHz: 1e3 };
const TO_METRES: Partial<Record<WaveUnit, number>> = { m: 1, cm: 0.01, ft: METRES_PER_FOOT };

/** A frequency or a wavelength in any of the units, as both. */
export function parseWave(text: string, unit: WaveUnit): Parsed<Wave> {
  const isFreq = TO_MHZ[unit] !== undefined;
  const r = parseNumber(text, {
    label: isFreq ? "Frequency" : "Wavelength",
    unit,
    min: 0,
    exclusiveMin: true,
  });
  if (!r.ok) return r;
  const mhz = isFreq ? r.value * (TO_MHZ[unit] ?? 1) : mhzFromWavelength(r.value * (TO_METRES[unit] ?? 1));
  if (!(mhz > 0) || mhz > MHZ_MAX * 1e3 || !Number.isFinite(wavelengthM(mhz))) {
    return { ok: false, error: "That is outside anything radio — check the unit" };
  }
  return { ok: true, value: { mhz, metres: wavelengthM(mhz) } };
}

/**
 * An ADIF band name the way an operator says it: "20M" is "20 m", "70CM" is "70 cm".
 *
 * ADIF calls the 135.7 kHz band 2190M; nobody on the air does, and it is 2200 m in Part 97
 * and in every band chart.
 */
export function bandLabel(adif: string): string {
  if (adif === "2190M") return "2200 m";
  const m = /^([\d.]+)(MM|CM|M)$/.exec(adif);
  return m ? `${m[1]} ${m[2]!.toLowerCase()}` : adif;
}

/** The amateur band a frequency is in, as a label, or null. */
export function bandForMHz(mhz: number): string | null {
  const adif = freqToBand(Math.round(mhz * 1e6));
  return adif ? bandLabel(adif) : null;
}
