// Physical length of an electrical quarter and half wave of feedline.
//
// A signal travels slower in a line than in free space, by the line's velocity factor, so
// an electrical λ/4 stub or λ/2 repeater is physically shorter than the free-space
// fraction. The presets are TYPICAL figures and labelled so: they differ between
// manufacturers and between batches, and a stub that has to be right is cut long and
// trimmed against an analyser.

import { parseNumber, type Parsed } from "@/lib/ham/tools/number";
import { wavelengthM } from "@/lib/ham/tools/wave";

export interface VelocityPreset {
  id: string;
  label: string;
  vf: number;
}

export const VF_PRESETS: readonly VelocityPreset[] = [
  { id: "solid-pe", label: "Solid PE coax — 0.66 (typical)", vf: 0.66 },
  { id: "foam-pe", label: "Foam PE coax — ~0.80 (typical)", vf: 0.8 },
  { id: "lmr-400", label: "LMR-400 — 0.85 (typical)", vf: 0.85 },
  { id: "ladder", label: "Ladder line — ~0.90 (typical)", vf: 0.9 },
];

export interface LineLengths {
  freeSpaceM: number;
  quarterM: number;
  halfM: number;
}

export function lineLengths(mhz: number, vf: number): LineLengths {
  const lambda = wavelengthM(mhz);
  return { freeSpaceM: lambda, quarterM: (lambda / 4) * vf, halfM: (lambda / 2) * vf };
}

export function parseVelocityFactor(text: string): Parsed<number> {
  const r = parseNumber(text, { label: "Velocity factor", min: 0, exclusiveMin: true, max: 1 });
  if (!r.ok && r.error.includes("must be")) {
    return { ok: false, error: "Velocity factor is above 0 and at most 1 — 0.66 for solid PE coax" };
  }
  return r;
}
