// Pan and zoom arithmetic for the grid map's view window.
//
// EXTRACTED BECAUSE IT CRASHED. The pan maths lived inside a `setView` updater on
// pages/gridmap.tsx, and the updater read a drag anchor out of a ref:
//
//     const onPointerMove = (e) => {
//       if (!drag.current) return;                 // guard runs NOW
//       setView((v) => ({ ...v,
//         x: Math.min(Math.max(drag.current!.vx - dx, 0), W - v.w),   // runs LATER
//       }));
//     };
//
// React invokes the updater when it processes the update, not when the handler returns.
// By then `onPointerUp` has run `drag.current = null`, and the page died with
// "TypeError: Cannot read properties of null (reading 'vx')" — a blank screen on /gridmap.
// The synchronous guard never protected the deferred closure, and the `!` told TypeScript
// to stop asking about precisely the line that was null.
//
// So the anchor is now a PARAMETER rather than something the maths reaches out to fetch.
// A pure function cannot read a ref that has since been cleared, which makes the bug
// unexpressible rather than merely fixed — and it makes the arithmetic assertable without
// a browser, which is what scripts/check-gridmap.ts now does.

/** The visible window in projected coordinates. */
export interface ViewWindow {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The full projected extent the window moves within. */
export interface ViewBounds {
  width: number;
  height: number;
}

/**
 * Where the drag started: the pointer position and the view origin at that moment.
 *
 * Captured once on pointer-down and passed by value from then on. `vx`/`vy` are the VIEW's
 * origin, not a velocity — the name is inherited from the original code and kept because
 * it is what the crash reports say.
 */
export interface DragAnchor {
  px: number;
  py: number;
  vx: number;
  vy: number;
}

/** Smallest window the zoom will produce, in projected units. */
export const MIN_VIEW_W = 40;

/** Hold a value inside a range. Named because it is the whole reason pan cannot escape. */
function clamp(value: number, min: number, max: number): number {
  // `max` before `min` matters when the window is WIDER than the bounds: `width - w` goes
  // negative, and clamping to a backwards range must land on 0 rather than the negative
  // limit, or the map jumps off-screen the moment it is fully zoomed out.
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * Pan the window so the point grabbed under the pointer stays under the pointer.
 *
 * `dx`/`dy` are in PROJECTED units and are the caller's job to convert from pixels, since
 * only the caller knows the element's rendered size.
 */
export function panView(
  anchor: DragAnchor,
  view: ViewWindow,
  dx: number,
  dy: number,
  bounds: ViewBounds,
): ViewWindow {
  return {
    ...view,
    x: clamp(anchor.vx - dx, 0, bounds.width - view.w),
    y: clamp(anchor.vy - dy, 0, bounds.height - view.h),
  };
}

/**
 * Convert a pointer movement in client pixels to projected units.
 *
 * Separate from `panView` because it needs the element's rectangle, which is a DOM fact
 * and not arithmetic. Guards a zero-sized rectangle: an element that has not been laid
 * out yet reports width 0, and dividing by it yields Infinity, which would clamp the view
 * to a corner rather than leaving it alone.
 */
export function dragDelta(
  anchor: DragAnchor,
  clientX: number,
  clientY: number,
  rect: { width: number; height: number },
  view: ViewWindow,
): { dx: number; dy: number } {
  if (!(rect.width > 0) || !(rect.height > 0)) return { dx: 0, dy: 0 };
  return {
    dx: ((clientX - anchor.px) / rect.width) * view.w,
    dy: ((clientY - anchor.py) / rect.height) * view.h,
  };
}

/** The window's own shape. A phone's map is taller than the world's 2:1, so it is not the bounds'. */
function aspectOf(view: ViewWindow, bounds: ViewBounds): number {
  return view.w > 0 && view.h > 0 ? view.w / view.h : bounds.width / bounds.height;
}

/** Widest window of this shape that still lies wholly on the map. */
function maxWidth(bounds: ViewBounds, aspect: number): number {
  return Math.min(bounds.width, bounds.height * aspect);
}

/**
 * Zoom about a fixed point, keeping the map coordinate under the cursor under the cursor.
 *
 * `at` is in projected coordinates — the caller has already un-projected the cursor.
 * The window keeps its own aspect ratio, so it never becomes a different shape from the
 * element showing it; zooming out stops when either edge reaches the map's.
 */
export function zoomView(
  view: ViewWindow,
  at: { x: number; y: number },
  factor: number,
  bounds: ViewBounds,
  minW = MIN_VIEW_W,
): ViewWindow {
  const aspect = aspectOf(view, bounds);
  const w = clamp(view.w * factor, Math.min(minW, maxWidth(bounds, aspect)), maxWidth(bounds, aspect));
  const h = w / aspect;
  // Dividing by the OLD window, which `MIN_VIEW_W` keeps off zero. Asserted, because a
  // zero here would produce NaN and NaN silently survives every clamp above.
  const fx = view.w > 0 ? (at.x - view.x) / view.w : 0;
  const fy = view.h > 0 ? (at.y - view.y) / view.h : 0;
  return {
    x: clamp(at.x - fx * w, 0, bounds.width - w),
    y: clamp(at.y - fy * h, 0, bounds.height - h),
    w,
    h,
  };
}

/** The most zoomed-out window of a given shape, centred on `centreX` where the map allows. */
export function fitView(bounds: ViewBounds, aspect: number, centreX = bounds.width / 2): ViewWindow {
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : bounds.width / bounds.height;
  const w = maxWidth(bounds, a);
  const h = w / a;
  return {
    x: clamp(centreX - w / 2, 0, bounds.width - w),
    y: clamp((bounds.height - h) / 2, 0, bounds.height - h),
    w,
    h,
  };
}

/**
 * Reshape the window for an element that changed size — a rotated phone, a resized
 * window — keeping its centre and its width where the map allows.
 */
export function resizeView(view: ViewWindow, aspect: number, bounds: ViewBounds): ViewWindow {
  if (!(aspect > 0) || !Number.isFinite(aspect)) return view;
  const w = Math.min(view.w, maxWidth(bounds, aspect));
  const h = w / aspect;
  const cx = view.x + view.w / 2;
  const cy = view.y + view.h / 2;
  return {
    x: clamp(cx - w / 2, 0, bounds.width - w),
    y: clamp(cy - h / 2, 0, bounds.height - h),
    w,
    h,
  };
}

/** A pointer position on the element, in client pixels. */
export interface ClientPoint {
  x: number;
  y: number;
}

/**
 * Two-finger pinch: scale by how far the fingers spread, and keep the map point that was
 * under their midpoint at the start under their midpoint now — which pans as well as zooms.
 *
 * Everything is measured from the gesture's START rather than accumulated per move, so
 * rounding cannot creep in over a long pinch.
 */
export function pinchView(
  start: ViewWindow,
  startMid: ClientPoint,
  startDist: number,
  mid: ClientPoint,
  dist: number,
  rect: { left: number; top: number; width: number; height: number },
  bounds: ViewBounds,
  minW = MIN_VIEW_W,
): ViewWindow {
  if (!(rect.width > 0) || !(rect.height > 0)) return start;
  const aspect = aspectOf(start, bounds);
  const ax = start.x + ((startMid.x - rect.left) / rect.width) * start.w;
  const ay = start.y + ((startMid.y - rect.top) / rect.height) * start.h;
  const scale = dist > 0 && startDist > 0 ? startDist / dist : 1;
  const w = clamp(start.w * scale, Math.min(minW, maxWidth(bounds, aspect)), maxWidth(bounds, aspect));
  const h = w / aspect;
  return {
    x: clamp(ax - ((mid.x - rect.left) / rect.width) * w, 0, bounds.width - w),
    y: clamp(ay - ((mid.y - rect.top) / rect.height) * h, 0, bounds.height - h),
    w,
    h,
  };
}
