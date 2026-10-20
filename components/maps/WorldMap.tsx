import { useCallback, useEffect, useRef, useState } from "react";

import { fitView, resizeView, type ViewBounds, type ViewWindow } from "@/lib/geo/viewport";
import { useActiveTheme } from "@/lib/client/use-theme";
import { MapPainter, hitTest, type MapScene, type Marker, type Viewport } from "@/lib/maps/draw";
import { WORLD_H, WORLD_W, project } from "@/lib/maps/projection";
import { cn } from "@/lib/utils";

import { ZoomControls } from "./ZoomControls";
import { useMapGestures } from "./useMapGestures";

const BOUNDS: ViewBounds = { width: WORLD_W, height: WORLD_H };

/**
 * The world map: a canvas that pans by drag, zooms by wheel, pinch, double-click, the
 * buttons or the keyboard, and reports what was tapped or hovered.
 *
 * The view lives in a ref, not in React state: a pan repaints the canvas and re-renders
 * nothing. Only "is it zoomed" reaches state, for the Reset button.
 */
export function WorldMap({
  scene,
  centreLon,
  onPick,
  onHover,
  label,
}: {
  scene: MapScene;
  /** Where to centre the first view on a map narrower than the world — the station. */
  centreLon: number | null;
  onPick: (m: Marker | null) => void;
  onHover: (m: Marker | null) => void;
  label: string;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const painter = useRef<MapPainter | null>(null);
  const sceneRef = useRef(scene);
  const vpRef = useRef<Viewport>({ view: { x: 0, y: 0, w: WORLD_W, h: WORLD_H }, cssW: 0, cssH: 0, dpr: 1 });
  const fitted = useRef(false);
  const touched = useRef(false);
  const frame = useRef<number | null>(null);
  const hoverKey = useRef<string | null>(null);
  const [zoomed, setZoomed] = useState(false);
  // Whether the view already shows the map's whole height, so a vertical drag could not
  // move it: the browser may then have vertical swipes for the page (see the canvas).
  const [fullHeight, setFullHeight] = useState(true);
  // The night theme draws the map in its own reds; read at paint time, like the scene.
  const theme = useActiveTheme();
  const themeRef = useRef(theme);

  const paint = useCallback(() => {
    frame.current = null;
    const ctx = canvasRef.current?.getContext("2d");
    const vp = vpRef.current;
    if (!ctx || vp.cssW <= 0 || vp.cssH <= 0) return;
    painter.current ??= new MapPainter();
    painter.current.draw(ctx, sceneRef.current, vp, themeRef.current);
  }, []);

  const requestPaint = useCallback(() => {
    if (frame.current === null) frame.current = requestAnimationFrame(paint);
  }, [paint]);

  const applyView = useCallback(
    (view: ViewWindow) => {
      const vp = vpRef.current;
      vpRef.current = { ...vp, view };
      setZoomed(view.w < fitView(BOUNDS, vp.cssW / Math.max(1, vp.cssH)).w - 0.5);
      setFullHeight(view.h >= WORLD_H - 0.5);
      requestPaint();
    },
    [requestPaint],
  );

  const fit = useCallback(() => {
    const vp = vpRef.current;
    if (vp.cssW <= 0 || vp.cssH <= 0) return;
    applyView(fitView(BOUNDS, vp.cssW / vp.cssH, centreLon === null ? undefined : project(0, centreLon).x));
  }, [centreLon, applyView]);

  const reset = useCallback(() => {
    touched.current = false;
    fit();
  }, [fit]);

  useEffect(() => {
    sceneRef.current = scene;
    requestPaint();
  }, [scene, requestPaint]);

  useEffect(() => {
    themeRef.current = theme;
    requestPaint();
  }, [theme, requestPaint]);

  // Centre on the station once its grid arrives, unless the operator has already moved.
  useEffect(() => {
    if (!touched.current && fitted.current) fit();
  }, [fit]);

  // Size the backing store to the element, at the device's pixel density.
  useEffect(() => {
    const box = boxRef.current;
    const canvas = canvasRef.current;
    if (!box || !canvas) return;
    const measure = () => {
      const r = box.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      const prev = vpRef.current;
      vpRef.current = { ...prev, cssW: r.width, cssH: r.height, dpr };
      if (!fitted.current) {
        fitted.current = true;
        fit();
      } else {
        applyView(resizeView(prev.view, r.width / r.height, BOUNDS));
      }
      paint();
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    return () => ro.disconnect();
    // `fit` changes with the station's longitude, which the effect above handles; re-running
    // this one would refit a map the operator has moved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paint, applyView]);

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  const hover = (m: Marker | null) => {
    const key = m?.key ?? null;
    if (key === hoverKey.current) return;
    hoverKey.current = key;
    onHover(m);
  };

  const g = useMapGestures({
    ref: canvasRef,
    getView: () => vpRef.current.view,
    setView: (v) => {
      touched.current = true;
      applyView(v);
      if (canvasRef.current && g.active()) canvasRef.current.style.cursor = "grabbing";
    },
    reset,
    bounds: BOUNDS,
    onTap: (x, y, type) => {
      if (canvasRef.current) canvasRef.current.style.cursor = "";
      onPick(hitTest(sceneRef.current, vpRef.current, x, y, type === "mouse" ? 10 : 22));
    },
    onHover: (x, y) => {
      const m = hitTest(sceneRef.current, vpRef.current, x, y, 10);
      if (canvasRef.current) canvasRef.current.style.cursor = m ? "pointer" : "";
      hover(m);
    },
    onHoverEnd: () => hover(null),
    onEscape: () => onPick(null),
  });

  return (
    <div className="flex flex-col">
      <ZoomControls
        zoomed={zoomed}
        onZoom={(f) => {
          touched.current = true;
          g.zoomAt(f);
        }}
        onReset={reset}
        hint="Drag to pan · scroll or double-click to zoom"
        touchHint="Drag to pan · pinch to zoom · tap a station"
      />
      {/* 2:1 is the whole world at desktop width. At phone width 2:1 is about 185px tall —
          a strip — so the floor is raised there, up to 60% of the screen; the view fits the
          taller box by showing less longitude, centred on the station. */}
      <div
        ref={boxRef}
        className="relative w-full aspect-[2/1] min-h-[min(340px,60vh)] sm:min-h-[260px] max-h-[75vh] overflow-hidden"
      >
        {/* THE MAP THAT ATE THE PAGE. `touch-none` gave every swipe that started on the map
            to the map, and edge to edge on a phone that was nearly every swipe: what sits
            below it could not be reached. While the whole height is in view a vertical drag
            has nothing to move, so it goes to the page (`touch-pan-y`); a sideways drag
            still pans, and a pinch is still the map's. Once zoomed in, every drag is the
            map's again — the operator is working the map on purpose. */}
        <canvas
          ref={canvasRef}
          tabIndex={0}
          role="img"
          aria-label={`${label}. Arrow keys pan, plus and minus zoom, 0 resets.`}
          className={cn(
            "absolute inset-0 h-full w-full select-none cursor-grab focus-visible:outline-offset-[-2px]",
            fullHeight ? "touch-pan-y" : "touch-none",
          )}
          {...g.handlers}
          onPointerUp={(e) => {
            g.handlers.onPointerUp(e);
            e.currentTarget.style.cursor = "";
          }}
        />
      </div>
    </div>
  );
}
