import { useCallback, useEffect, useRef } from "react";

import {
  dragDelta,
  panView,
  pinchView,
  zoomView,
  type DragAnchor,
  type ViewBounds,
  type ViewWindow,
} from "@/lib/geo/viewport";

/** Movement under this many CSS px is a tap, not a drag. */
const TAP_SLOP = 6;

type Gesture =
  | { kind: "pan"; anchor: DragAnchor; startX: number; startY: number; tap: boolean; type: string }
  | { kind: "pinch"; start: ViewWindow; mid: { x: number; y: number }; dist: number };

export interface GestureOptions<E extends Element> {
  /** The element the gestures land on. */
  ref: React.RefObject<E | null>;
  /** The current view, read at the moment it is needed — never a stale render's copy. */
  getView: () => ViewWindow;
  setView: (v: ViewWindow) => void;
  /** Back to the starting view. */
  reset: () => void;
  bounds: ViewBounds;
  minW?: number;
  /** A tap or click that did not become a drag, in CSS px on the element. */
  onTap: (x: number, y: number, pointerType: string) => void;
  /** Mouse hover in CSS px, or null when it leaves or a drag starts. */
  onHover: (x: number, y: number) => void;
  onHoverEnd: () => void;
  /** Escape. */
  onEscape?: () => void;
}

/**
 * Drag to pan, wheel / pinch / double-click / keys to zoom, and taps that stay taps.
 *
 * THE CLICK THAT WAS A DRAG. Both maps used to capture the pointer on whatever element was
 * under it — often a dot — so a drag that started on a dot ended with that dot receiving a
 * click, and the Coverage plot navigated away mid-pan. Here a press is a tap only until it
 * moves `TAP_SLOP` px, and only a tap picks.
 */
export function useMapGestures<E extends Element>(o: GestureOptions<E>) {
  const opts = useRef(o);
  opts.current = o;
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<Gesture | null>(null);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = opts.current.ref.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };

  /** Zoom about a point; false when the view was already at that limit and nothing moved. */
  const zoomAt = useCallback((factor: number, px?: number, py?: number): boolean => {
    const { ref, getView, setView, bounds, minW } = opts.current;
    const r = ref.current?.getBoundingClientRect();
    const v = getView();
    if (!r || !(r.width > 0) || !(r.height > 0)) return false;
    const at = {
      x: v.x + ((px ?? r.width / 2) / r.width) * v.w,
      y: v.y + ((py ?? r.height / 2) / r.height) * v.h,
    };
    const next = zoomView(v, at, factor, bounds, minW);
    const moved =
      Math.abs(next.w - v.w) > 1e-6 || Math.abs(next.x - v.x) > 1e-6 || Math.abs(next.y - v.y) > 1e-6;
    if (moved) setView(next);
    return moved;
  }, []);

  /** When the wheel last zoomed the map, so the tail of that same stream does not scroll the page. */
  const lastWheelZoom = useRef(0);
  /** When anything on the page last scrolled, so a scroll already under way is not hijacked. */
  const lastPageScroll = useRef(0);

  // Scroll does not bubble, so this listens in the capture phase: it hears the window and
  // any scrolling container the app shell uses.
  useEffect(() => {
    const onScroll = () => {
      lastPageScroll.current = performance.now();
    };
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => document.removeEventListener("scroll", onScroll, { capture: true });
  }, []);

  // A non-passive listener: React registers onWheel as passive, so preventDefault() there
  // is ignored and the page scrolls while the map zooms — which both maps used to do.
  //
  // THE WHEEL THAT WENT NOWHERE. Taking every wheel event made the map a dead zone: at full
  // extent a wheel-down asks for more zoom-out than there is, nothing moves, and the page
  // under it does not scroll either. With the map edge to edge on a phone that was most of
  // the screen. Two rules now:
  //  - A page scroll already under way carries on over the map: scrolling down a page and
  //    passing the map under a still cursor is not a request to zoom. Rest the cursor on
  //    the map for a moment and the wheel zooms, as before.
  //  - A wheel that cannot move the map falls through to the page, unless it is the tail of
  //    a stream that was zooming a moment ago (a trackpad's momentum would otherwise zoom
  //    out and then lurch the page) or it is a pinch (ctrl+wheel), which must never become
  //    the browser's own page zoom.
  useEffect(() => {
    const el = o.ref.current;
    if (!el) return;
    const onWheel = (e: Event) => {
      const w = e as WheelEvent;
      const now = performance.now();
      const zoomedLately = now - lastWheelZoom.current < 300;
      if (!w.ctrlKey && !zoomedLately && now - lastPageScroll.current < 300) return;
      const unit = w.deltaMode === 1 ? 16 : w.deltaMode === 2 ? 400 : 1;
      // Proportional, so a trackpad's stream of small deltas zooms smoothly instead of a
      // full step per event.
      const factor = Math.exp(Math.max(-1, Math.min(1, w.deltaY * unit * 0.0015)));
      const p = local(w);
      if (zoomAt(factor, p.x, p.y)) {
        lastWheelZoom.current = now;
        w.preventDefault();
      } else if (w.ctrlKey || zoomedLately) {
        w.preventDefault();
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [o.ref, zoomAt]);

  // A second finger is always the map's. With `touch-pan-y` on an unzoomed map (the
  // canvas and the plot set it while the whole height is in view), the browser is otherwise
  // free to treat a two-finger pinch that drifts vertically as a page scroll and cancel it;
  // claiming multi-touch moves keeps pinch-zoom. The claim lasts until every finger is up,
  // so lifting one finger mid-pinch carries on panning the map rather than scrolling the
  // page out from under it.
  useEffect(() => {
    const el = o.ref.current;
    if (!el) return;
    let multi = false;
    const onTouchMove = (e: Event) => {
      const t = e as TouchEvent;
      if (t.touches.length > 1) multi = true;
      if (multi && t.cancelable) t.preventDefault();
    };
    const onTouchEnd = (e: Event) => {
      if ((e as TouchEvent).touches.length === 0) multi = false;
    };
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    el.addEventListener("touchcancel", onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [o.ref]);

  const startPan = (x: number, y: number, type: string, tap: boolean) => {
    const v = opts.current.getView();
    gesture.current = { kind: "pan", anchor: { px: x, py: y, vx: v.x, vy: v.y }, startX: x, startY: y, tap, type };
  };

  const onPointerDown = (e: React.PointerEvent<E>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* a pointer the browser no longer considers active; the drag still works uncaptured */
    }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) startPan(e.clientX, e.clientY, e.pointerType, true);
    else if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      if (!a || !b) return;
      opts.current.onHoverEnd();
      gesture.current = {
        kind: "pinch",
        start: opts.current.getView(),
        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        dist: Math.hypot(a.x - b.x, a.y - b.y),
      };
    }
  };

  const onPointerMove = (e: React.PointerEvent<E>) => {
    const g = gesture.current;
    if (!g || !pointers.current.has(e.pointerId)) {
      if (e.pointerType === "mouse") {
        const p = local(e);
        opts.current.onHover(p.x, p.y);
      }
      return;
    }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const rect = e.currentTarget.getBoundingClientRect();
    const { setView, getView, bounds, minW } = opts.current;
    if (g.kind === "pinch") {
      const [a, b] = [...pointers.current.values()];
      if (!a || !b) return;
      setView(pinchView(g.start, g.mid, g.dist, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, Math.hypot(a.x - b.x, a.y - b.y), rect, bounds, minW));
      return;
    }
    if (g.tap) {
      if (Math.hypot(e.clientX - g.startX, e.clientY - g.startY) < TAP_SLOP) return;
      g.tap = false;
      opts.current.onHoverEnd();
    }
    const view = getView();
    const { dx, dy } = dragDelta(g.anchor, e.clientX, e.clientY, rect, view);
    setView(panView(g.anchor, view, dx, dy, bounds));
  };

  const end = (e: React.PointerEvent<E>, cancelled: boolean) => {
    if (!pointers.current.delete(e.pointerId)) return;
    const g = gesture.current;
    if (pointers.current.size === 0) {
      gesture.current = null;
      if (!cancelled && g?.kind === "pan" && g.tap) {
        const p = local(e);
        opts.current.onTap(p.x, p.y, g.type);
      }
      return;
    }
    // One finger lifted from a pinch: carry on as a pan from the other one, so the map does
    // not jump to where it is.
    const rest = [...pointers.current.values()][0];
    if (rest) startPan(rest.x, rest.y, "touch", false);
  };

  const onKeyDown = (e: React.KeyboardEvent<E>) => {
    const { getView, setView, bounds, reset, onEscape } = opts.current;
    const v = getView();
    const step = (fx: number, fy: number) =>
      setView(panView({ px: 0, py: 0, vx: v.x, vy: v.y }, v, -fx * v.w, -fy * v.h, bounds));
    const keys: Record<string, () => void> = {
      ArrowLeft: () => step(-0.15, 0),
      ArrowRight: () => step(0.15, 0),
      ArrowUp: () => step(0, -0.15),
      ArrowDown: () => step(0, 0.15),
      "+": () => zoomAt(0.7),
      "=": () => zoomAt(0.7),
      "-": () => zoomAt(1 / 0.7),
      "0": reset,
      Escape: () => onEscape?.(),
    };
    const act = keys[e.key];
    if (act) {
      e.preventDefault();
      act();
    }
  };

  return {
    zoomAt,
    /** Whether a drag or pinch is under way, for the cursor. */
    active: () => gesture.current !== null && !(gesture.current.kind === "pan" && gesture.current.tap),
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: (e: React.PointerEvent<E>) => end(e, false),
      onPointerCancel: (e: React.PointerEvent<E>) => end(e, true),
      onLostPointerCapture: (e: React.PointerEvent<E>) => end(e, true),
      onPointerLeave: (e: React.PointerEvent<E>) => {
        if (e.pointerType === "mouse" && !gesture.current) opts.current.onHoverEnd();
      },
      onDoubleClick: (e: React.MouseEvent<E>) => {
        const p = local(e);
        zoomAt(0.5, p.x, p.y);
      },
      onKeyDown,
    },
  };
}
