// Assertions on the grid map's placement arithmetic and its vendored coastlines.
//
// The map must never show a station somewhere it is not: the projection and the
// grid-centre math are the two places a sign error would do that silently, so both
// are pinned against hand-computed values.

import { LAND_RINGS } from "@/lib/geo/land";
import { gridFromMessage } from "@/lib/ham/grid-message";
import { gridToLatLon } from "@/lib/propagation";

let failed = 0;
function eq(actual: unknown, expected: unknown, what: string): void {
  const ok = Object.is(actual, expected);
  if (!ok) failed++;
  console.log(`  ${ok ? "ok   " : "FAIL "} ${what}${ok ? "" : ` — expected ${expected}, got ${actual}`}`);
}
function close(actual: number, expected: number, tol: number, what: string): void {
  const ok = Math.abs(actual - expected) <= tol;
  if (!ok) failed++;
  console.log(`  ${ok ? "ok   " : "FAIL "} ${what}${ok ? "" : ` — expected ~${expected}, got ${actual}`}`);
}

// The page's own copies, duplicated here on purpose: asserting a function against
// itself proves nothing, so these are the DEFINITIONS and the page must match them.
const W = 1440;
const H = 720;
function project(lat: number, lon: number): { x: number; y: number } {
  return { x: ((lon + 180) / 360) * W, y: ((90 - lat) / 180) * H };
}
function gridCentre(grid: string): { lat: number; lon: number } | null {
  const g = grid.trim().toUpperCase();
  if (!/^[A-R]{2}\d{2}$/.test(g)) return null;
  if (g === "RR73") return null;
  const lon = (g.charCodeAt(0) - 65) * 20 - 180 + Number(g[2]) * 2 + 1;
  const lat = (g.charCodeAt(1) - 65) * 10 - 90 + Number(g[3]) * 1 + 0.5;
  return { lat, lon };
}

console.log("the projection puts places where they are");
{
  eq(project(0, 0).x, W / 2, "0°N 0°E lands dead centre in x");
  eq(project(0, 0).y, H / 2, "and in y");
  eq(project(90, -180).x, 0, "the north-west corner is the origin");
  eq(project(90, -180).y, 0, "in both axes");
  eq(project(-90, 180).x, W, "the south-east corner is the far corner");
  eq(project(-90, 180).y, H, "in both axes");
  // North must be UP: latitude increases, y decreases.
  eq(project(45, 0).y < project(0, 0).y, true, "north is up, not down");
}

console.log("\ngrid squares resolve to their centres");
{
  // EN61, this station's own field, by hand: E is lon field 4, N is lat field 13.
  // lon = -180 + 4·20 + 6·2 + 1 = -87.  lat = -90 + 13·10 + 1·1 + 0.5 = 41.5.
  // Northwest Indiana, which is where the antenna is.
  const en61 = gridCentre("EN61")!;
  close(en61.lon, -87, 0.01, "EN61 centre longitude (-87)");
  close(en61.lat, 41.5, 0.01, "EN61 centre latitude (41.5)");

  // The two conversions in this codebase must agree with each other about where a
  // square is, to within the half-square their precisions differ by.
  const lib = gridToLatLon("EN61")!;
  close(lib.lat, en61.lat, 1, "lib/propagation agrees on latitude");
  close(lib.lon, en61.lon, 2, "and longitude");

  eq(gridCentre("RR73"), null, "RR73 is refused here too — never place an acknowledgement");
  eq(gridCentre("XX99"), null, "letters past R are not a grid");
}

console.log("\nmessages give up their grids honestly");
{
  eq(gridFromMessage("CQ K9XYZ EN61"), "EN61", "a CQ's locator");
  eq(gridFromMessage("K1ABC K9XYZ EN61"), "EN61", "a reply's locator");
  eq(gridFromMessage("K1ABC K9XYZ -07"), null, "a report has none");
  eq(gridFromMessage("K1ABC K9XYZ RR73"), null, "RR73 is an acknowledgement, not a place");
}

console.log("\nthe vendored coastlines are actually there");
{
  eq(LAND_RINGS.length > 50, true, `enough rings to be a world (${LAND_RINGS.length})`);
  let points = 0;
  let inRange = true;
  for (const ring of LAND_RINGS) {
    points += ring.length;
    for (const [lon, lat] of ring) {
      if (lon < -180 || lon > 180 || lat < -90 || lat > 90) inRange = false;
    }
  }
  // 110m resolution quantized to 0.1° measures 4,930 — the floor is under that
  // with room for a future re-quantization, not a target to hit.
  eq(points > 4_000, true, `enough coastline to draw (${points} points)`);
  eq(inRange, true, "every coordinate is a real place on Earth");
}

console.log(failed === 0 ? "\nall grid map assertions passed" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
