// Wire antenna lengths from frequency.
//
// Physical lengths are the free-space wavelength times an END-EFFECT factor, because a
// real wire resonates shorter than the wavelength it is cut for: capacitance at the open
// ends makes it electrically longer than it is. The familiar 468/f is exactly this with a
// factor of 0.9516; the default here is the rounder 0.95, which is 0.17 % shorter — a
// little over an inch on 20 m — and the factor is the operator's to change, since it moves
// with wire gauge, insulation and height.
//
// A LOOP has no ends, so the end-effect factor does not apply to it. A full-wave loop
// resonates slightly LONG, and the classic 1005/f (about 1.02 λ) is used as written.

import { METRES_PER_FOOT, parseNumber, type Parsed } from "@/lib/ham/tools/number";
import { C, wavelengthM } from "@/lib/ham/tools/wave";

export const DEFAULT_END_EFFECT = 0.95;

/** The range a factor can plausibly take; outside it the number is a typo, not a wire. */
export const END_EFFECT_MIN = 0.8;
export const END_EFFECT_MAX = 1;

export interface AntennaLengths {
  wavelengthM: number;
  dipoleTotalM: number;
  dipoleLegM: number;
  quarterRadiatorM: number;
  /** Elevated radials are resonant and cut like the radiator. */
  quarterRadialM: number;
  loopPerimeterM: number;
  loopSquareSideM: number;
  loopDeltaSideM: number;
  fiveEighthsM: number;
}

export function antennaLengths(mhz: number, endEffect: number): AntennaLengths {
  const lambda = wavelengthM(mhz);
  const quarter = (lambda / 4) * endEffect;
  const loop = classicLoopFt(mhz) * METRES_PER_FOOT;
  return {
    wavelengthM: lambda,
    dipoleTotalM: (lambda / 2) * endEffect,
    dipoleLegM: quarter,
    quarterRadiatorM: quarter,
    quarterRadialM: quarter,
    loopPerimeterM: loop,
    loopSquareSideM: loop / 4,
    loopDeltaSideM: loop / 3,
    fiveEighthsM: lambda * 0.625 * endEffect,
  };
}

/** The 468/f rule of thumb for a half-wave dipole, in feet. */
export function classicDipoleFt(mhz: number): number {
  return 468 / mhz;
}

/** The 1005/f rule for a full-wave loop's perimeter, in feet. */
export function classicLoopFt(mhz: number): number {
  return 1005 / mhz;
}

/** The end-effect factor 468/f implies: 468 ft·MHz over a free-space half wave. */
export const RULE_468_FACTOR = 468 / ((C / 1e6 / 2) / METRES_PER_FOOT);

export function parseEndEffect(text: string): Parsed<number> {
  const r = parseNumber(text, {
    label: "End-effect factor",
    min: END_EFFECT_MIN,
    max: END_EFFECT_MAX,
  });
  if (!r.ok && r.error.includes("must be")) {
    return { ok: false, error: `${r.error}; wire is usually 0.93 to 0.97` };
  }
  return r;
}
