// Assertions on the grid map's placement arithmetic and its vendored coastlines.
//
// The map must never show a station somewhere it is not: the projection and the
// grid-centre math are the two places a sign error would do that silently, so both
// are pinned against hand-computed values.

import { readFileSync } from "node:fs";

import { LAND_RINGS } from "@/lib/geo/land";
import { TOKENS, TOKEN_VARS } from "@/lib/maps/palette";
import {
  dragDelta,
  fitView,
  panView,
  pinchView,
  resizeView,
  zoomView,
  MIN_VIEW_W,
  type DragAnchor,
  type ViewWindow,
} from "@/lib/geo/viewport";
import { gridFromMessage } from "@/lib/ham/grid-message";
import * as lib from "@/lib/maps/projection";
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

// The DEFINITIONS, written out here on purpose: asserting a function against itself proves
// nothing, so lib/maps/projection.ts — which the page runs — must match these.
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

console.log("\nthe page's projection module matches the definitions");
{
  eq(lib.WORLD_W, W, "the same world width");
  eq(lib.WORLD_H, H, "and height");
  let projOk = true;
  let roundTrip = true;
  for (let lat = -90; lat <= 90; lat += 7.5) {
    for (let lon = -180; lon <= 180; lon += 11.25) {
      const a = lib.project(lat, lon);
      const b = project(lat, lon);
      if (a.x !== b.x || a.y !== b.y) projOk = false;
      const back = lib.unproject(a.x, a.y);
      if (Math.abs(back.lat - lat) > 1e-9 || Math.abs(back.lon - lon) > 1e-9) roundTrip = false;
    }
  }
  eq(projOk, true, "project() agrees everywhere on a 7.5° × 11.25° sweep");
  eq(roundTrip, true, "and unproject() inverts it");
  let gridOk = true;
  let squareOk = true;
  for (let f1 = 0; f1 < 18; f1++) {
    for (let f2 = 0; f2 < 18; f2++) {
      for (const d of ["00", "37", "99", "61"]) {
        const g = String.fromCharCode(65 + f1) + String.fromCharCode(65 + f2) + d;
        if (JSON.stringify(lib.gridCentre(g)) !== JSON.stringify(gridCentre(g))) gridOk = false;
        const c = lib.gridCentre(g);
        if (c && lib.squareAt(c.lat, c.lon) !== g) squareOk = false;
      }
    }
  }
  eq(gridOk, true, "gridCentre() agrees on every field");
  eq(squareOk, true, "and squareAt() names the square a centre is in");
  eq(lib.gridCentre("RR73"), null, "the module refuses RR73 too");
  eq(lib.squareAt(90, 0), null, "the pole edge is off the map, not square AS");
  eq(lib.FIELD_LABELS.length, 324, "324 field labels");
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

console.log("\nTHE CRASH: a drag anchor read after the pointer let go");
{
  // THE FAULT, REPRODUCED rather than described. /gridmap died to a blank screen with
  // "TypeError: Cannot read properties of null (reading 'vx')" because the pan maths lived
  // inside a setView updater and reached out to a ref for its anchor:
  //
  //     if (!drag.current) return;                                    // guard runs NOW
  //     setView((v) => ({ ...v, x: ... drag.current!.vx - dx ... }))  // runs LATER
  //
  // React calls the updater when it processes the update, not when the handler returns, and
  // onPointerUp had nulled the ref in between. This asserts the SEQUENCE — capture, release,
  // then apply. The old code threw here; the fix cannot, because the anchor is a parameter
  // and a pure function has no ref to reach for.
  const BOUNDS = { width: W, height: H };
  const view: ViewWindow = { x: 200, y: 100, w: 720, h: 360 };

  // Exactly what the component does on pointer-down.
  const ref: { current: DragAnchor | null } = {
    current: { px: 500, py: 300, vx: view.x, vy: view.y },
  };
  const anchor = ref.current;
  if (!anchor) throw new Error("fixture is wrong");
  const { dx, dy } = dragDelta(anchor, 460, 280, { width: 1440, height: 720 }, view);

  // THE POINTER LETS GO before React reaches the updater. This is the whole bug.
  ref.current = null;

  let threw: string | null = null;
  let panned: ViewWindow | null = null;
  try {
    panned = panView(anchor, view, dx, dy, BOUNDS);
  } catch (e) {
    threw = (e as Error).message;
  }
  eq(threw, null, "panning after the pointer let go does not throw");
  eq(panned !== null, true, "and it still produces a view");
  // 40 px left on a 1440-wide element showing a 720-unit window is 20 projected units, and
  // the map follows the finger: the origin increases.
  close(panned?.x ?? -1, 220, 0.001, "the view moved the right way by the right amount");
  eq(panned?.y, 110, "and vertically too");

  // The other direction, so a sign error cannot pass by symmetry.
  const back = dragDelta(anchor, 540, 320, { width: 1440, height: 720 }, view);
  eq(panView(anchor, view, back.dx, back.dy, BOUNDS).x, 180, "dragging the other way moves back");
}

console.log("\npan cannot walk the map off its own edges");
{
  const BOUNDS = { width: W, height: H };
  const view: ViewWindow = { x: 0, y: 0, w: 720, h: 360 };
  const anchor: DragAnchor = { px: 0, py: 0, vx: 0, vy: 0 };

  eq(panView(anchor, view, 5_000, 5_000, BOUNDS).x, 0, "a huge drag stops at the left edge");
  eq(panView(anchor, view, 5_000, 5_000, BOUNDS).y, 0, "and at the top");
  const far: DragAnchor = { px: 0, py: 0, vx: W, vy: H };
  eq(panView(far, view, -5_000, -5_000, BOUNDS).x, W - view.w, "and at the right edge");
  eq(panView(far, view, -5_000, -5_000, BOUNDS).y, H - view.h, "and at the bottom");

  // FULLY ZOOMED OUT, where `width - w` is exactly zero.
  const whole: ViewWindow = { x: 0, y: 0, w: W, h: H };
  eq(panView(anchor, whole, 100, 100, BOUNDS).x, 0, "a full-extent view cannot be dragged");
  eq(panView(anchor, whole, -100, -100, BOUNDS).x, 0, "in either direction");

  // WIDER THAN THE BOUNDS, which makes the clamp range run backwards. The minimum must win,
  // or the map leaps off-screen at the moment it is most zoomed out.
  const wider: ViewWindow = { x: 0, y: 0, w: W + 200, h: H + 100 };
  eq(panView(anchor, wider, -500, -500, BOUNDS).x, 0, "a view wider than the map clamps to 0");
  eq(panView(anchor, wider, -500, -500, BOUNDS).y, 0, "not to a negative origin");

  // A zero-sized element reports width 0. Dividing by it gives Infinity, which would clamp
  // the view into a corner rather than leaving it alone.
  const d = dragDelta(anchor, 100, 100, { width: 0, height: 0 }, view);
  eq(d.dx, 0, "an unlaid-out element yields no movement, not Infinity");
  eq(Number.isFinite(panView(anchor, view, d.dx, d.dy, BOUNDS).x), true, "so the view stays finite");
}

console.log("\nzoom keeps the point under the cursor under the cursor");
{
  const BOUNDS = { width: W, height: H };
  const view: ViewWindow = { x: 0, y: 0, w: W, h: H };
  const at = { x: 720, y: 360 };

  const inOnce = zoomView(view, at, 0.8, BOUNDS);
  eq(inOnce.w, W * 0.8, "zooming in narrows the window");
  close(inOnce.w / inOnce.h, W / H, 1e-9, "and the aspect ratio is preserved");
  // The cursor was at the centre, so the centre must still be under it.
  close(inOnce.x + inOnce.w / 2, at.x, 0.001, "the grabbed point stays put horizontally");
  close(inOnce.y + inOnce.h / 2, at.y, 0.001, "and vertically");

  // The floor, and that repeated zooming does not breach it or go NaN on the way.
  let v = view;
  for (let i = 0; i < 40; i++) v = zoomView(v, at, 0.8, BOUNDS);
  eq(v.w, MIN_VIEW_W, `forty zooms in stops at the floor (${MIN_VIEW_W})`);
  eq(Number.isFinite(v.x) && Number.isFinite(v.y), true, "with a finite origin throughout");

  // And the ceiling.
  for (let i = 0; i < 60; i++) v = zoomView(v, at, 1.25, BOUNDS);
  eq(v.w, W, "and zooming out stops at the whole world");
  eq(v.x, 0, "flush to the left edge");
  eq(v.y, 0, "and the top");
}

console.log("\na phone's map is taller than the world, and keeps its own shape");
{
  const BOUNDS = { width: W, height: H };
  // 343 × 280 CSS px, the map at 375 px with its gutters: aspect 1.225.
  const aspect = 343 / 280;
  const fit = fitView(BOUNDS, aspect, lib.project(50, 10).x);
  close(fit.w / fit.h, aspect, 1e-9, "the fitted window has the element's shape");
  eq(fit.h, H, "and shows the whole height of the world");
  close(fit.x + fit.w / 2, lib.project(50, 10).x, 1e-9, "centred on the station's longitude");
  const edge = fitView(BOUNDS, aspect, 0);
  eq(edge.x, 0, "a centre near the edge clamps rather than showing off-map");

  let v = fit;
  for (let i = 0; i < 30; i++) v = zoomView(v, { x: v.x + v.w / 2, y: v.y + v.h / 2 }, 1.25, BOUNDS);
  close(v.w / v.h, aspect, 1e-9, "zooming out keeps the shape");
  eq(v.h, H, "and stops when the height reaches the world's — not the width");
  close(v.w, H * aspect, 1e-9, "so the window is never wider than the map can fill");

  const desk = fitView(BOUNDS, 2.6);
  eq(desk.w, W, "an extra-wide element shows the full width");
  close(desk.h, W / 2.6, 1e-9, "and crops latitude instead");

  const turned = resizeView({ x: 300, y: 100, w: 600, h: 300 }, 0.5, BOUNDS);
  close(turned.w / turned.h, 0.5, 1e-9, "a rotated phone gets a window of its new shape");
  close(turned.x + turned.w / 2, 600, 1e-9, "around the same centre");
}

console.log("\npinch zoom keeps the point between the fingers between the fingers");
{
  const BOUNDS = { width: W, height: H };
  const rect = { left: 0, top: 0, width: 720, height: 360 };
  const start: ViewWindow = { x: 360, y: 180, w: 720, h: 360 };
  const mid = { x: 360, y: 180 };
  const spread = pinchView(start, mid, 100, mid, 200, rect, BOUNDS);
  close(spread.w, 360, 1e-9, "fingers twice as far apart halve the window");
  close(spread.x + spread.w / 2, 720, 1e-9, "about the midpoint");
  close(spread.y + spread.h / 2, 360, 1e-9, "in both axes");
  const moved = pinchView(start, mid, 100, { x: 260, y: 180 }, 100, rect, BOUNDS);
  close(moved.x, 460, 1e-9, "moving both fingers left pans the map with them");
  const pinched = pinchView(start, mid, 100, mid, 1, rect, BOUNDS);
  eq(pinched.w, W, "pinching shut stops at the whole world");
  eq(pinchView(start, mid, 100, mid, 0, rect, BOUNDS).w, start.w, "a zero distance changes nothing rather than dividing by it");
  eq(pinchView(start, mid, 100, mid, 200, { left: 0, top: 0, width: 0, height: 0 }, BOUNDS), start, "an unlaid-out element is left alone");
}

console.log("\nthe canvas palette mirrors the design tokens");
{
  // A canvas cannot take a class, so lib/maps/palette.ts restates the tokens it needs. A
  // retuned token that the map did not follow would leave it a different grey from the page.
  const css = readFileSync("styles/globals.css", "utf8");
  for (const [name, cssVar] of Object.entries(TOKEN_VARS)) {
    const m = new RegExp(`${cssVar}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(css);
    eq(m?.[1]?.toLowerCase(), TOKENS[name as keyof typeof TOKENS], `${name} matches ${cssVar}`);
  }
}

console.log(failed === 0 ? "\nall grid map assertions passed" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
