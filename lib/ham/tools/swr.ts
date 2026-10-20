// SWR and what it costs.
//
// Everything follows from the magnitude of the reflection coefficient, |Γ|:
//   from SWR       |Γ| = (SWR − 1) / (SWR + 1)
//   from power     |Γ| = √(reflected / forward)
//   return loss    −20·log10|Γ|        (bigger is better; infinite for a perfect match)
//   mismatch loss  −10·log10(1 − |Γ|²) (what the mismatch alone costs at the load)
//   reflected      |Γ|² of the forward power
//
// Mismatch loss is NOT feedline loss. A lossy line makes the SWR at the radio look better
// than at the antenna, and this knows nothing about the line.

import { parseNumber, type Parsed } from "@/lib/ham/tools/number";

export interface Mismatch {
  swr: number;
  gamma: number;
  /** Null for a perfect match, where return loss is infinite. */
  returnLossDb: number | null;
  mismatchLossDb: number;
  reflectedPct: number;
  deliveredPct: number;
}

function fromGamma(gamma: number): Mismatch {
  const g2 = gamma * gamma;
  return {
    swr: (1 + gamma) / (1 - gamma),
    gamma,
    returnLossDb: gamma === 0 ? null : -20 * Math.log10(gamma),
    mismatchLossDb: -10 * Math.log10(1 - g2),
    reflectedPct: g2 * 100,
    deliveredPct: (1 - g2) * 100,
  };
}

/** Past this the line is open or shorted, and the figures are noise. */
export const SWR_MAX = 1000;

/** SWR is 1 at a perfect match and climbs without limit; anything under 1 is a typo. */
export function mismatchFromSwr(swr: number): Parsed<Mismatch> {
  if (!Number.isFinite(swr) || swr < 1) {
    return { ok: false, error: "SWR is 1 or more; 1.0 is a perfect match" };
  }
  if (swr > SWR_MAX) {
    return { ok: false, error: `Above ${SWR_MAX}:1 the line is effectively open or shorted` };
  }
  const gamma = (swr - 1) / (swr + 1);
  return { ok: true, value: { ...fromGamma(gamma), swr } };
}

/** "1.5" or "1.5:1". */
export function parseSwr(text: string): Parsed<Mismatch> {
  const cleaned = text.trim().replace(/\s*:\s*1$/, "");
  const r = parseNumber(cleaned, { label: "SWR" });
  if (!r.ok) return r;
  return mismatchFromSwr(r.value);
}

export interface PowerMismatch extends Mismatch {
  deliveredW: number;
}

/** From a wattmeter: forward and reflected power. */
export function mismatchFromPower(forwardW: number, reflectedW: number): Parsed<PowerMismatch> {
  if (!(forwardW > 0) || !Number.isFinite(forwardW)) {
    return { ok: false, error: "Forward power must be greater than 0 W" };
  }
  if (!(reflectedW >= 0) || !Number.isFinite(reflectedW)) {
    return { ok: false, error: "Reflected power can't be negative" };
  }
  if (reflectedW > forwardW) {
    return {
      ok: false,
      error: "Reflected power is more than forward — check the meter's direction or the readings",
    };
  }
  if (reflectedW === forwardW) {
    return {
      ok: false,
      error: "Everything is coming back: SWR is infinite. Look for an open or a short.",
    };
  }
  const m = fromGamma(Math.sqrt(reflectedW / forwardW));
  if (!(m.swr <= SWR_MAX)) {
    return { ok: false, error: `That is above ${SWR_MAX}:1 — effectively an open or a short` };
  }
  return { ok: true, value: { ...m, deliveredW: forwardW - reflectedW } };
}
