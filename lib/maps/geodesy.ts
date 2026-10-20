// Great-circle arithmetic for the map pages.
//
// gridToLatLon, bearingDeg, distanceKm and formatDistance come from lib/ham/grid-geometry,
// the one browser-safe home for them (no imports, so no Prisma in the client bundle).
// lib/propagation re-exports the same module, so the map, the log's distance column and the
// server-side propagation code cannot disagree. This file used to restate all four.

import {
  bearingDeg,
  distanceKm,
  formatDistance,
  gridToLatLon,
  type DistanceUnit,
} from "@/lib/ham/grid-geometry";

import type { LatLon } from "./projection";

export { bearingDeg, distanceKm, formatDistance, gridToLatLon };
export type { DistanceUnit };

export const EARTH_RADIUS_KM = 6371;
/** Half the circumference: the longest a short path can be. */
export const HALF_CIRCUMFERENCE_KM = Math.PI * EARTH_RADIUS_KM;

const RAD = Math.PI / 180;

const POINTS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

/** "47° NE" — the number a rotator wants and the word a person says. */
export function formatBearing(deg: number): string {
  const d = ((Math.round(deg) % 360) + 360) % 360;
  return `${d}° ${POINTS[Math.round(d / 22.5) % 16]}`;
}

/** Short and long path from a to b. The long path leaves the other way round the world. */
export function paths(a: LatLon, b: LatLon): {
  short: { bearing: number; km: number };
  long: { bearing: number; km: number };
} {
  const km = distanceKm(a, b);
  const bearing = bearingDeg(a, b);
  return {
    short: { bearing, km },
    long: { bearing: (bearing + 180) % 360, km: 2 * HALF_CIRCUMFERENCE_KM - km },
  };
}

/** Wrap a longitude into [-180, 180). */
function wrapLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/**
 * The great-circle path from a to b as [lon, lat] polylines, split where it crosses the
 * antimeridian so an equirectangular map never draws a line straight across the world.
 *
 * Stepped by destination point along the initial bearing rather than by slerp, so it stays
 * defined for antipodal pairs (where every great circle is a shortest path) and leaves home
 * on exactly the bearing the readout prints.
 */
export function greatCirclePath(a: LatLon, b: LatLon, maxStepDeg = 1): [number, number][][] {
  const delta = distanceKm(a, b) / EARTH_RADIUS_KM;
  if (!(delta > 1e-9)) return [[[a.lon, a.lat], [b.lon, b.lat]]];
  const theta = bearingDeg(a, b) * RAD;
  const phi1 = a.lat * RAD;
  const lambda1 = a.lon * RAD;
  const n = Math.max(2, Math.ceil(delta / RAD / maxStepDeg));
  const pts: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    if (i === n) {
      pts.push([wrapLon(b.lon), b.lat]);
      break;
    }
    const d = (delta * i) / n;
    const phi2 = Math.asin(
      Math.sin(phi1) * Math.cos(d) + Math.cos(phi1) * Math.sin(d) * Math.cos(theta),
    );
    const lambda2 =
      lambda1 +
      Math.atan2(
        Math.sin(theta) * Math.sin(d) * Math.cos(phi1),
        Math.cos(d) - Math.sin(phi1) * Math.sin(phi2),
      );
    pts.push([wrapLon(lambda2 / RAD), phi2 / RAD]);
  }
  return splitAtAntimeridian(pts);
}

/** Break a [lon, lat] polyline wherever consecutive points jump more than half the world. */
export function splitAtAntimeridian(pts: [number, number][]): [number, number][][] {
  const first = pts[0];
  if (!first) return [];
  const segs: [number, number][][] = [[first]];
  for (let i = 1; i < pts.length; i++) {
    const prev = pts[i - 1]!;
    const cur = pts[i]!;
    const seg = segs[segs.length - 1]!;
    if (Math.abs(cur[0] - prev[0]) <= 180) {
      seg.push(cur);
      continue;
    }
    const curLon = cur[0] + (cur[0] < prev[0] ? 360 : -360);
    const edge = curLon > prev[0] ? 180 : -180;
    const t = (edge - prev[0]) / (curLon - prev[0]);
    const lat = prev[1] + t * (cur[1] - prev[1]);
    seg.push([edge, lat]);
    segs.push([[-edge, lat], cur]);
  }
  return segs;
}
