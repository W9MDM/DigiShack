// Maidenhead locators, positions, and the great-circle path between two of them.
//
// NOT lib/propagation, though that module has gridToLatLon, bearingDeg and distanceKm: it
// also imports Prisma for its caches, so a page that imports it puts @prisma/client in the
// browser bundle — check:client-bundle refuses exactly that. This module is pure. It agrees
// with lib/propagation for 4- and 6-character locators (check:ham-tools asserts it) and adds
// what the Tools page needs on top: the 8-character extended square, position to locator,
// the long path and the antipode.

import type { Parsed } from "@/lib/ham/tools/number";

export interface LatLon {
  lat: number;
  lon: number;
}

export interface GridSquare {
  /** Normalised the way it is written on a QSL card: "EN61aa45". */
  grid: string;
  chars: 4 | 6 | 8;
  centre: LatLon;
  south: number;
  north: number;
  west: number;
  east: number;
}

/** Mean Earth radius, km — the same figure lib/propagation uses, so the two agree. */
export const EARTH_RADIUS_KM = 6371;
export const KM_PER_MILE = 1.609344;

const A = 65;

/** A locator, or which character is wrong with it. Case-insensitive. */
export function parseGrid(text: string): Parsed<GridSquare> {
  const g = text.trim();
  if (g === "") return { ok: false, error: "Enter a locator such as EN61 or EN61aa" };
  if (g.length !== 4 && g.length !== 6 && g.length !== 8) {
    return {
      ok: false,
      error: `A locator has 4, 6 or 8 characters (EN61, EN61aa, EN61aa45); that has ${g.length}`,
    };
  }
  const u = g.toUpperCase();
  if (!/^[A-R]{2}/.test(u)) return { ok: false, error: "The first two characters are letters from A to R" };
  if (!/^.{2}\d{2}/.test(u)) return { ok: false, error: "Characters 3 and 4 are digits" };
  if (u.length >= 6 && !/^.{4}[A-X]{2}/.test(u)) {
    return { ok: false, error: "Characters 5 and 6 are letters from A to X" };
  }
  if (u.length === 8 && !/^.{6}\d{2}$/.test(u)) return { ok: false, error: "Characters 7 and 8 are digits" };

  const chars = u.length as 4 | 6 | 8;
  let west = (u.charCodeAt(0) - A) * 20 - 180 + (u.charCodeAt(2) - 48) * 2;
  let south = (u.charCodeAt(1) - A) * 10 - 90 + (u.charCodeAt(3) - 48);
  let w = 2;
  let h = 1;
  if (chars >= 6) {
    w = 2 / 24;
    h = 1 / 24;
    west += (u.charCodeAt(4) - A) * w;
    south += (u.charCodeAt(5) - A) * h;
  }
  if (chars === 8) {
    w = 2 / 240;
    h = 1 / 240;
    west += (u.charCodeAt(6) - 48) * w;
    south += (u.charCodeAt(7) - 48) * h;
  }
  return {
    ok: true,
    value: {
      grid: normaliseGrid(u),
      chars,
      centre: { lat: south + h / 2, lon: west + w / 2 },
      south,
      north: south + h,
      west,
      east: west + w,
    },
  };
}

function normaliseGrid(u: string): string {
  return u.slice(0, 4) + u.slice(4, 6).toLowerCase() + u.slice(6);
}

/**
 * The locator containing a position.
 *
 * The north pole and the antimeridian sit on the far edge of the last field, so they are
 * pulled just inside it: 90° N, 180° E is RR99xx99, not a field "S" that does not exist.
 */
export function latLonToGrid(p: LatLon, chars: 4 | 6 | 8): string {
  let lon = Math.min(Math.max(p.lon, -180), 180) + 180;
  let lat = Math.min(Math.max(p.lat, -90), 90) + 90;
  const step = (value: number, size: number, count: number): number =>
    Math.min(Math.max(Math.floor(value / size), 0), count - 1);

  const f1 = step(lon, 20, 18);
  const f2 = step(lat, 10, 18);
  lon -= f1 * 20;
  lat -= f2 * 10;
  const s1 = step(lon, 2, 10);
  const s2 = step(lat, 1, 10);
  lon -= s1 * 2;
  lat -= s2;
  let out = String.fromCharCode(A + f1, A + f2) + s1 + s2;
  if (chars === 4) return out;

  const x1 = step(lon, 2 / 24, 24);
  const x2 = step(lat, 1 / 24, 24);
  lon -= x1 * (2 / 24);
  lat -= x2 * (1 / 24);
  out += String.fromCharCode(97 + x1, 97 + x2);
  if (chars === 6) return out;

  return out + step(lon, 2 / 240, 10) + step(lat, 1 / 240, 10);
}

const COORD = /^([NSEW])?\s*([+-]?(?:\d+\.?\d*|\.\d+))\s*°?\s*([NSEW])?$/i;

/**
 * Decimal degrees, with a sign or a hemisphere letter: "41.71", "-87.2", "41.71 N", "87.2W".
 */
function parseCoordinate(text: string, axis: "lat" | "lon"): Parsed<number> {
  const label = axis === "lat" ? "Latitude" : "Longitude";
  const t = text.trim();
  if (t === "") return { ok: false, error: `Enter a ${label.toLowerCase()}` };
  const m = COORD.exec(t);
  if (!m || (m[1] && m[3])) {
    return {
      ok: false,
      error: `${label} is decimal degrees, e.g. ${axis === "lat" ? "41.71 or 41.71 N" : "-72.73 or 72.73 W"}`,
    };
  }
  const hemi = (m[1] ?? m[3] ?? "").toUpperCase();
  let n = Number(m[2]);
  if (hemi) {
    const allowed = axis === "lat" ? "NS" : "EW";
    if (!allowed.includes(hemi)) {
      return { ok: false, error: `${label} takes ${axis === "lat" ? "N or S" : "E or W"}, not ${hemi}` };
    }
    if (n < 0) return { ok: false, error: `Use a minus sign or ${axis === "lat" ? "S" : "W"}, not both` };
    if (hemi === "S" || hemi === "W") n = -n;
  }
  const limit = axis === "lat" ? 90 : 180;
  if (!Number.isFinite(n) || Math.abs(n) > limit) {
    return { ok: false, error: `${label} must be between -${limit} and ${limit} degrees` };
  }
  return { ok: true, value: n };
}

export function parseLatitude(text: string): Parsed<number> {
  return parseCoordinate(text, "lat");
}

export function parseLongitude(text: string): Parsed<number> {
  return parseCoordinate(text, "lon");
}

export interface GreatCirclePath {
  km: number;
  /** Initial bearing, degrees true. Null when the two points coincide or are antipodal. */
  bearing: number | null;
  longKm: number;
  longBearing: number | null;
  /** Every direction is a great circle to the antipode, so no bearing is THE bearing. */
  antipodal: boolean;
}

const toRad = (d: number): number => (d * Math.PI) / 180;
const toDeg = (r: number): number => (r * 180) / Math.PI;

/**
 * Short and long path between two points on a sphere.
 *
 * The long path is the rest of the same great circle: the distance is the circumference
 * less the short path, and the beam heading is the reciprocal of the short-path one.
 */
export function greatCircle(a: LatLon, b: LatLon): GreatCirclePath {
  const phi1 = toRad(a.lat);
  const phi2 = toRad(b.lat);
  const dPhi = phi2 - phi1;
  const dLambda = toRad(b.lon - a.lon);
  const h =
    Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  const km = 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
  const circumference = 2 * Math.PI * EARTH_RADIUS_KM;
  const antipodal = Math.abs(km - circumference / 2) < 0.5;

  let bearing: number | null = null;
  if (km >= 0.001 && !antipodal) {
    const y = Math.sin(dLambda) * Math.cos(phi2);
    const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
    bearing = (toDeg(Math.atan2(y, x)) + 360) % 360;
  }
  return {
    km,
    bearing,
    longKm: circumference - km,
    longBearing: bearing === null ? null : (bearing + 180) % 360,
    antipodal,
  };
}

/** The point on the opposite side of the Earth. */
export function antipode(p: LatLon): LatLon {
  return { lat: -p.lat, lon: p.lon > 0 ? p.lon - 180 : p.lon + 180 };
}

export function kmToMiles(km: number): number {
  return km / KM_PER_MILE;
}

const POINTS = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
] as const;

/** The sixteen-point compass name for a bearing: 47.7° is "NE". */
export function compassPoint(deg: number): string {
  if (!Number.isFinite(deg)) return "—";
  return POINTS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16] ?? "—";
}

/** "41.3958° N" — four decimals is about ten metres, finer than any locator here. */
export function formatLat(lat: number): string {
  return `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? "N" : "S"}`;
}

export function formatLon(lon: number): string {
  return `${Math.abs(lon).toFixed(4)}° ${lon >= 0 ? "E" : "W"}`;
}

/** Degrees, minutes and seconds, for a paper map: 41°23′45″ N. */
export function formatDms(deg: number, axis: "lat" | "lon"): string {
  const hemi = axis === "lat" ? (deg >= 0 ? "N" : "S") : deg >= 0 ? "E" : "W";
  let total = Math.round(Math.abs(deg) * 3600);
  const d = Math.floor(total / 3600);
  total -= d * 3600;
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${d}°${String(m).padStart(2, "0")}′${String(s).padStart(2, "0")}″ ${hemi}`;
}

/** Rough width and height of a square in km, at its own latitude. */
export function squareSizeKm(sq: GridSquare): { widthKm: number; heightKm: number } {
  const kmPerDeg = (Math.PI * EARTH_RADIUS_KM) / 180;
  return {
    widthKm: (sq.east - sq.west) * kmPerDeg * Math.cos(toRad(sq.centre.lat)),
    heightKm: (sq.north - sq.south) * kmPerDeg,
  };
}
