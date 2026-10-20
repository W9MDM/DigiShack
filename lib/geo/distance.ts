// Grid-square distance for the browser.
//
// lib/propagation/index.ts has the same maths but imports Prisma at module level, so any
// page that value-imports it ships @prisma/client to the client and dies on load
// (scripts/check-client-bundle.ts). This module has no imports at all and must stay that way.

export type DistanceUnit = "km" | "mi";

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

/** Distance between two grids in km, or null if either is missing or not a locator. */
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

/** "1,234 mi" or "1,987 km". */
export function formatDistance(km: number, unit: DistanceUnit): string {
  return unit === "km"
    ? `${Math.round(km).toLocaleString()} km`
    : `${Math.round(km * 0.621371).toLocaleString()} mi`;
}
