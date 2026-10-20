// Maidenhead geometry: the locator patterns, grid to lat/lon and back, great-circle
// distance and bearing. The one home for all of it.
//
// Pure, with no imports, so browser pages can use it. It lived in lib/propagation, which
// imports Prisma at module level, and the decode list and the log pulled that into the
// client bundle for a distance column. lib/propagation, lib/maps/geodesy and
// lib/ham/tools/grid re-export from here, so the log, the maps, the Tools page and the
// server-side propagation code run the same arithmetic and cannot disagree.

export interface LatLon {
  lat: number;
  lon: number;
}

/** Mean Earth radius, km. Every distance, path and circumference in the app uses it. */
export const EARTH_RADIUS_KM = 6371;

// ---------------------------------------------------------------------------
// Locator patterns
// ---------------------------------------------------------------------------
//
// Uppercase, anchored, and kept apart by length because the lengths mean different things:
// a decode carries exactly four characters, a cluster spot four or six, a logbook anything
// from the bare field to the eight-character extended square. Callers that accept lower
// case use the _ANY_CASE twin rather than uppercasing first, which is not quite the same
// test ("ß" uppercases to two letters).

/** Exactly a four-character square: "FN31". Note RR73 passes; it is a real square. */
export const GRID4_RE = /^[A-R]{2}\d{2}$/;
export const GRID4_ANY_CASE_RE = /^[A-R]{2}\d{2}$/i;

/** A four- or six-character locator: "FN31", "FN31PR". */
export const GRID4_OR_6_RE = /^[A-R]{2}\d{2}(?:[A-X]{2})?$/;
export const GRID4_OR_6_ANY_CASE_RE = /^[A-R]{2}\d{2}(?:[A-X]{2})?$/i;

/** Any ADIF locator: field, square, subsquare or extended square (2, 4, 6 or 8 characters). */
export const GRID_LOCATOR_RE = /^[A-R]{2}(?:\d{2}(?:[A-X]{2}(?:\d{2})?)?)?$/;

/** Starts with a four-character square, whatever follows: the lenient readers below. */
export const GRID4_PREFIX_RE = /^[A-R]{2}\d{2}/;

/** Is this exactly a four-character square, in upper case? */
export function isGrid4(s: string): boolean {
  return GRID4_RE.test(s);
}

// ---------------------------------------------------------------------------
// Grid to position
// ---------------------------------------------------------------------------

/**
 * Maidenhead to lat/lon, centre of the square.
 *
 * Lenient, for decodes and log rows: case-insensitive, reads the first four or six
 * characters and ignores anything after, so an eight-character locator gives the centre
 * of its six-character subsquare. The subsquare letters are not range-checked. The Tools
 * page wants a strict reading and the exact eight-character centre: that is gridSquare.
 */
export function gridToLatLon(grid: string): LatLon | null {
  const g = grid.trim().toUpperCase();
  if (!GRID4_PREFIX_RE.test(g)) return null;
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

export interface GridSquare {
  /** Normalised the way it is written on a QSL card: "FN31pr21". */
  grid: string;
  chars: 4 | 6 | 8;
  centre: LatLon;
  south: number;
  north: number;
  west: number;
  east: number;
}

const GRID_4_6_8_RE = /^[A-R]{2}\d{2}(?:[A-X]{2}(?:\d{2})?)?$/;

/**
 * A 4-, 6- or 8-character locator's edges and centre, or null if it is not exactly one.
 * Case-insensitive; surrounding space is ignored.
 */
export function gridSquare(text: string): GridSquare | null {
  const u = text.trim().toUpperCase();
  if (!GRID_4_6_8_RE.test(u)) return null;
  const A = 65;
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
    grid: u.slice(0, 4) + u.slice(4, 6).toLowerCase() + u.slice(6),
    chars,
    centre: { lat: south + h / 2, lon: west + w / 2 },
    south,
    north: south + h,
    west,
    east: west + w,
  };
}

/**
 * The locator containing a position.
 *
 * The north pole and the antimeridian sit on the far edge of the last field, so they are
 * pulled just inside it: 90° N, 180° E is RR99xx99, not a field "S" that does not exist.
 */
export function latLonToGrid(p: LatLon, chars: 4 | 6 | 8): string {
  const A = 65;
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

// ---------------------------------------------------------------------------
// Great circle
// ---------------------------------------------------------------------------

/**
 * Initial great-circle bearing from a to b, in degrees true.
 *
 * The number a beam is pointed at. Not the same as the bearing you would read off a flat
 * map: the great-circle path from Illinois to Japan leaves over the pole, and a plot that
 * used the flat-map angle would tell an operator to point their antenna at the wrong
 * quarter of the sky.
 */
export function bearingDeg(a: LatLon, b: LatLon): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const phi1 = toRad(a.lat);
  const phi2 = toRad(b.lat);
  const dLon = toRad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  const deg = (Math.atan2(y, x) * 180) / Math.PI;
  // atan2 gives -180..180; a compass bearing is 0..360.
  return (deg + 360) % 360;
}

/** Great-circle distance in km (haversine on the mean radius). */
export function distanceKm(a: LatLon, b: LatLon): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
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

/**
 * Short and long path between two points, for a readout that has to be honest at the
 * edges: no bearing is claimed for a point to itself or to its antipode.
 *
 * The long path is the rest of the same great circle: the distance is the circumference
 * less the short path, and the beam heading is the reciprocal of the short-path one. The
 * maps' paths() is the same without the null bearings, because a map always draws a line.
 */
export function greatCircle(a: LatLon, b: LatLon): GreatCirclePath {
  const km = distanceKm(a, b);
  const circumference = 2 * Math.PI * EARTH_RADIUS_KM;
  const antipodal = Math.abs(km - circumference / 2) < 0.5;
  const bearing = km >= 0.001 && !antipodal ? bearingDeg(a, b) : null;
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

/**
 * Great-circle distance between two Maidenhead grids, in km, or null if either is missing
 * or not a valid locator. A convenience over gridToLatLon + distanceKm for the log and the
 * decode list, where both sides are grid squares rather than lat/lon.
 */
export function gridDistanceKm(
  a: string | null | undefined,
  b: string | null | undefined,
): number | null {
  if (!a || !b) return null;
  const pa = gridToLatLon(a);
  const pb = gridToLatLon(b);
  if (!pa || !pb) return null;
  return distanceKm(pa, pb);
}

export type DistanceUnit = "km" | "mi";

/**
 * "1,234 mi" or "1,987 km", per the operator's unit preference. Pass km from gridDistanceKm.
 *
 * 0.621371 miles to the km, a hair under the Tools page's exact 1 / 1.609344. Left as it
 * is so the log's and the map's figures do not move; the two can differ by one mile where
 * a distance rounds on the half.
 */
export function formatDistance(km: number, unit: DistanceUnit): string {
  return unit === "km"
    ? `${Math.round(km).toLocaleString()} km`
    : `${Math.round(km * 0.621371).toLocaleString()} mi`;
}
