// Geometry of the Coverage plot: bearing and distance from home, drawn as a polar plot.

import type { DistanceUnit } from "./geodesy";

/** The plot's side, in SVG units. */
export const PLOT_SIZE = 560;
/** The outer edge. A little past half the circumference, so the antipode is on the plot. */
export const MAX_KM = 20_000;
const KM_PER_MI = 1.609344;

/** Radius on a square-root scale, so the near-in contacts are not a single blob. */
export function radiusFor(km: number, size = PLOT_SIZE): number {
  const capped = Math.min(Math.max(km, 0), MAX_KM);
  return (Math.sqrt(capped / MAX_KM) * size) / 2;
}

/**
 * Where a contact sits on the plot. Bearing 0 is north, which is UP, and bearings increase
 * clockwise — straight trigonometry puts 0 to the right and runs the other way.
 */
export function polarXY(bearing: number, km: number, size = PLOT_SIZE): { x: number; y: number } {
  const rad = ((bearing - 90) * Math.PI) / 180;
  const r = radiusFor(km, size);
  return { x: size / 2 + r * Math.cos(rad), y: size / 2 + r * Math.sin(rad) };
}

/**
 * Distance rings in the operator's unit, at round numbers in that unit: 1,500 mi is a ring
 * worth labelling and 1,553 mi (2,500 km converted) is not.
 */
export function ringsFor(unit: DistanceUnit): { km: number; label: string }[] {
  const steps = unit === "km" ? [2_500, 5_000, 10_000, 20_000] : [1_500, 3_000, 6_000, 12_000];
  return steps.map((n) => ({
    km: unit === "km" ? n : n * KM_PER_MI,
    label: `${n.toLocaleString()} ${unit}`,
  }));
}

/** An SVG path for the wedge between two bearings, out to the plot's edge. */
export function wedgePath(fromDeg: number, toDeg: number, size = PLOT_SIZE): string {
  const c = size / 2;
  const r = size / 2;
  const at = (deg: number) => {
    const rad = ((deg - 90) * Math.PI) / 180;
    return `${(c + r * Math.cos(rad)).toFixed(2)},${(c + r * Math.sin(rad)).toFixed(2)}`;
  };
  return `M${c},${c}L${at(fromDeg)}A${r},${r} 0 0 1 ${at(toDeg)}Z`;
}
