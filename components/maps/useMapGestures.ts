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

  const zoomAt = useCallback((factor: number, px?: number, py?: number) => {
    const { ref, getView, setView, bounds, minW } = opts.current;
    const r = ref.current?.getBoundingClientRect();
    const v = getView();
    if (!r || !(r.width > 0) || !(r.height > 0)) return;
    const at = {
      x: v.x + ((px ?? r.width / 2) / r.width) * v.w,
      y: v.y + ((py ?? r.height / 2) / r.height) * v.h,
    };
    setView(zoomView(v, at, factor, bounds, minW));
  }, []);

  // A non-passive listener: React registers onWheel as passive, so preventDefault() there
  // is ignored and the page scrolls while the map zooms — which both maps used to do.
  useEffect(() => {
    const el = o.ref.current;
    if (!el) return;
    const onWheel = (e: Event) => {
      const w = e as WheelEvent;
      w.preventDefault();
      const unit = w.deltaMode === 1 ? 16 : w.deltaMode === 2 ? 400 : 1;
      // Proportional, so a trackpad's stream of small deltas zooms smoothly instead of a
      // full step per event.
      const factor = Math.exp(Math.max(-1, Math.min(1, w.deltaY * unit * 0.0015)));
      const p = local(w);
      zoomAt(factor, p.x, p.y);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [o.ref, zoomAt]);

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
