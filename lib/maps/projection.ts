// The grid map's projection and Maidenhead placement.
//
// Plate carrée: x is longitude, y is latitude, both linear. Distances lie toward the
// poles, but nobody measures distance off this map — the polar Coverage plot answers
// that — and it makes every maidenhead square an axis-aligned rectangle.
//
// Moved out of pages/gridmap.tsx so scripts/check-gridmap.ts can assert the code the page
// actually runs; it used to restate these and could only prove its own copies right.

import { GRID4_RE, gridToLatLon, type LatLon } from "@/lib/ham/grid-geometry";

export type { LatLon };

/** The projected world, in map units. 4 units per degree. */
export const WORLD_W = 1440;
export const WORLD_H = 720;

export function project(lat: number, lon: number): { x: number; y: number } {
  return { x: ((lon + 180) / 360) * WORLD_W, y: ((90 - lat) / 180) * WORLD_H };
}

export function unproject(x: number, y: number): LatLon {
  return { lon: (x / WORLD_W) * 360 - 180, lat: 90 - (y / WORLD_H) * 180 };
}

/** Centre of a 4-character grid square. */
export function gridCentre(grid: string): LatLon | null {
  const g = grid.trim().toUpperCase();
  if (!GRID4_RE.test(g)) return null;
  // RR73 is a real square in the Arctic Ocean that nobody calls from — which is why the
  // protocol uses it as an acknowledgement. gridFromMessage refuses it upstream, but this
  // refuses too: whatever caller arrives here, an RR73 must never become a dot on the map.
  if (g === "RR73") return null;
  return gridToLatLon(g);
}

/** South-west corner of a 4-character square, for shading it as a rectangle. */
export function squareSW(grid: string): LatLon | null {
  const g = grid.trim().toUpperCase();
  if (!GRID4_RE.test(g)) return null;
  return {
    lon: (g.charCodeAt(0) - 65) * 20 - 180 + Number(g[2]) * 2,
    lat: (g.charCodeAt(1) - 65) * 10 - 90 + Number(g[3]) * 1,
  };
}

/** The 4-character square a point falls in, or null off the map. */
export function squareAt(lat: number, lon: number): string | null {
  if (!(lat >= -90 && lat < 90 && lon >= -180 && lon < 180)) return null;
  const x = lon + 180;
  const y = lat + 90;
  return (
    String.fromCharCode(65 + Math.floor(x / 20)) +
    String.fromCharCode(65 + Math.floor(y / 10)) +
    String(Math.floor((x % 20) / 2)) +
    String(Math.floor(y % 10))
  );
}

/** One square is 2° of longitude by 1° of latitude: 8 × 4 units at world scale. */
export const SQUARE_W = (2 / 360) * WORLD_W;
export const SQUARE_H = (1 / 180) * WORLD_H;
/** One field is 20° × 10°. */
export const FIELD_W = SQUARE_W * 10;
export const FIELD_H = SQUARE_H * 10;

/** Field labels (AA…RR) at each field's centre, in map units. */
export const FIELD_LABELS: readonly { x: number; y: number; text: string }[] = (() => {
  const out: { x: number; y: number; text: string }[] = [];
  for (let fx = 0; fx < 18; fx++) {
    for (let fy = 0; fy < 18; fy++) {
      const p = project(fy * 10 - 90 + 5, fx * 20 - 180 + 10);
      out.push({ x: p.x, y: p.y, text: String.fromCharCode(65 + fx) + String.fromCharCode(65 + fy) });
    }
  }
  return out;
})();
