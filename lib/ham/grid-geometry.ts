// Maidenhead geometry: grid to lat/lon, great-circle distance and bearing.
//
// Pure, with no imports, so browser pages can use it. It lived in lib/propagation, which
// imports Prisma at module level, and the decode list and the log pulled that into the
// client bundle for a distance column. lib/propagation re-exports all of this unchanged.

/** Maidenhead to lat/lon, centre of the square. */
export function gridToLatLon(grid: string): { lat: number; lon: number } | null {
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

/**
 * Initial great-circle bearing from a to b, in degrees true.
 *
 * The number a beam is pointed at. Not the same as the bearing you would read off a flat
 * map: the great-circle path from Illinois to Japan leaves over the pole, and a plot that
 * used the flat-map angle would tell an operator to point their antenna at the wrong
 * quarter of the sky.
 */
export function bearingDeg(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
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

/** Great-circle distance in km. */
export function distanceKm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
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

/** "1,234 mi" or "1,987 km", per the operator's unit preference. Pass km from gridDistanceKm. */
export function formatDistance(km: number, unit: DistanceUnit): string {
  return unit === "km"
    ? `${Math.round(km).toLocaleString()} km`
    : `${Math.round(km * 0.621371).toLocaleString()} mi`;
}
