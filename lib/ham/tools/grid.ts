// Maidenhead locators, positions, and the great-circle path between two of them, as the
// Tools page reads and prints them.
//
// The arithmetic is lib/ham/grid-geometry's, re-exported here so this page, the log, the
// maps and lib/propagation run one copy of it. What lives here is the page's own: a
// locator parser that says which character is wrong, coordinate entry, and the formatting.
// Not lib/propagation directly: it imports Prisma for its caches, and check:client-bundle
// refuses a page that would ship that to the browser.

import {
  EARTH_RADIUS_KM,
  gridSquare,
  type GridSquare,
} from "@/lib/ham/grid-geometry";
import type { Parsed } from "@/lib/ham/tools/number";

export {
  antipode,
  EARTH_RADIUS_KM,
  greatCircle,
  latLonToGrid,
  type GreatCirclePath,
  type GridSquare,
  type LatLon,
} from "@/lib/ham/grid-geometry";

export const KM_PER_MILE = 1.609344;

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

  // Every well-formed locator gets here. One that does not is text whose length changed
  // when it was uppercased ("ß" becomes "SS"), which the character checks above cannot see.
  const square = gridSquare(u);
  if (!square) return { ok: false, error: "That is not a Maidenhead locator" };
  return { ok: true, value: square };
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

const toRad = (d: number): number => (d * Math.PI) / 180;

export function kmToMiles(km: number): number {
  return km / KM_PER_MILE;
}

const POINTS = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
] as const;

/**
 * The sixteen-point compass name for a bearing: 47.7° is "NE".
 *
 * From the unrounded bearing, so 11.3° is NNE. The maps' formatBearing rounds to a whole
 * degree first and calls the same 11.3° N, matching the "11°" it prints beside it.
 */
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
