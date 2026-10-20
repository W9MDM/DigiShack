// Great-circle arithmetic for the map pages.
//
// gridToLatLon, bearingDeg, distanceKm and formatDistance are the same formulae as
// lib/propagation, restated rather than imported because that module imports Prisma: a page
// that called them at render time would pull @prisma/client into the browser bundle, which
// is the fault scripts/check-client-bundle.ts exists to catch. scripts/check-greyline.ts
// asserts the two copies agree, so they cannot drift apart silently.

import type { DistanceUnit } from "@/lib/propagation";

import type { LatLon } from "./projection";

export type { DistanceUnit };

export const EARTH_RADIUS_KM = 6371;
/** Half the circumference: the longest a short path can be. */
export const HALF_CIRCUMFERENCE_KM = Math.PI * EARTH_RADIUS_KM;

const RAD = Math.PI / 180;

/** Maidenhead to lat/lon, centre of the square (4 or 6 characters). */
export function gridToLatLon(grid: string): LatLon | null {
  const g = grid.trim().toUpperCase();
  if (!/^[A-R]{2}[0-9]{2}([A-X]{2})?/.test(g)) return null;
  const A = 65;
  let lon = (g.charCodeAt(0) - A) * 20 - 180;
  let lat = (g.charCodeAt(1) - A) * 10 - 90;
  lon += Number(g[2]) * 2;
  lat += Number(g[3]) * 1;
  if (g.length >= 6) {
    lon += (g.charCodeAt(4) - A) * (2 / 24) + 1 / 24;
    lat += (g.charCodeAt(5) - A) * (1 / 24) + 0.5 / 24;
  } else {
    lon += 1;
    lat += 0.5;
  }
  return { lat, lon };
}

/** Initial great-circle bearing from a to b, degrees true, 0–360. */
// Written exactly as lib/propagation writes them, rounding included, so the check can
// demand identical results rather than "close enough".
const toRad = (d: number) => (d * Math.PI) / 180;

export function bearingDeg(a: LatLon, b: LatLon): number {
  const phi1 = toRad(a.lat);
  const phi2 = toRad(b.lat);
  const dLon = toRad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  const deg = (Math.atan2(y, x) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/** Great-circle distance in km. */
export function distanceKm(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** "1,234 mi" or "1,987 km", per the operator's unit preference. */
export function formatDistance(km: number, unit: DistanceUnit): string {
  return unit === "km"
    ? `${Math.round(km).toLocaleString()} km`
    : `${Math.round(km * 0.621371).toLocaleString()} mi`;
}

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
