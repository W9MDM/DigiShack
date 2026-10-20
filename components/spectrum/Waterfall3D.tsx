import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Select } from "@/components/ui/primitives";
import { formatAgo, formatFrequency, frequencyTicks, frequencyUnit, timeLabelStep } from "@/lib/spectrum/axis";
import {
  DEFAULT_CAMERA,
  orbitBy,
  panBy,
  project,
  zoomBy,
  type OrbitCamera,
} from "@/lib/spectrum/camera";
import type { ColormapId } from "@/lib/spectrum/colormaps";
import type { SpectrumFeed } from "@/lib/spectrum/feed";
import { displayWindow, type Contrast } from "@/lib/spectrum/levels";
import { DEPTH_CHOICES_SEC, MAX_HEIGHT_SCALE, MIN_HEIGHT_SCALE } from "@/lib/spectrum/prefs";
import { cn } from "@/lib/utils";

import { createGl } from "./gl";
import { LabelPool, prefersReducedMotion, useDrawScheduler } from "./render-loop";
import { HALF_DEPTH, HALF_WIDTH, Waterfall3DGL } from "./waterfall3d-render";

// The 3D waterfall: the same history as the spectrogram, as a surface. Frequency across,
// time receding from the front edge (newest), level as height and colour.
//
// Drawn only when something changed — a frame, a camera move, a control — and not at all
// while hidden or scrolled away. It never rotates by itself. With reduced motion asked for,
// data redraws are held to one a second and a camera reset jumps instead of gliding.

export interface Waterfall3DProps {
  feed: SpectrumFeed;
  contrast: Contrast;
  colormap: ColormapId;
  /** How much history the surface covers; never more than the page's history length. */
  depthSec: number;
  historySec: number;
  heightScale: number;
  paused: boolean;
  onDepthChange: (sec: number) => void;
  onHeightScaleChange: (scale: number) => void;
  className?: string;
}

const MAX_DPR = 2;
const FREQ_LABELS = 16;
const TIME_LABELS = 12;

export function Waterfall3D({
  feed,
  contrast,
  colormap,
  depthSec,
  historySec,
  heightScale,
  paused,
  onDepthChange,
  onHeightScaleChange,
  className,
}: Waterfall3DProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<Waterfall3DGL | null>(null);
  const freqPool = useRef<LabelPool | null>(null);
  const timePool = useRef<LabelPool | null>(null);
  const camera = useRef<OrbitCamera>({ ...DEFAULT_CAMERA });
  const sizeRef = useRef({ cssW: 0, cssH: 0 });
  const timeTicks = useRef(new Float64Array(TIME_LABELS));
  const projected = useRef(new Float32Array(2));
  const frozenEnd = useRef<number | null>(null);
  const lastEnd = useRef<number | null>(null);
  const tickCache = useRef<{ lo: number; hi: number; max: number; ticks: ReturnType<typeof frequencyTicks> } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const effectiveDepth = Math.min(depthSec, historySec);
  const props = { feed, contrast, colormap, depthSec: effectiveDepth, heightScale, paused };
  const propsRef = useRef(props);
  propsRef.current = props;

  const draw = useCallback(() => {
    const r = rendererRef.current;
    if (!r) return;
    const p = propsRef.current;
    const f = p.feed;
    const end = (p.paused ? frozenEnd.current : null) ?? f.now(performance.now()) ?? f.history.newestEndAt() ?? 0;
    lastEnd.current = end;
    const i = f.info;
    const lo = i.highHz > i.lowHz ? i.lowHz : 0;
    const hi = i.highHz > i.lowHz ? i.highHz : 3000;
    const { cssW, cssH } = sizeRef.current;
    const maxTicks = Math.max(2, Math.min(10, Math.floor(cssW / 90)));
    const cache = tickCache.current;
    if (!cache || cache.lo !== lo || cache.hi !== hi || cache.max !== maxTicks) {
      tickCache.current = { lo, hi, max: maxTicks, ticks: frequencyTicks(lo, hi, maxTicks) };
    }
    const ft = tickCache.current!.ticks;
    const depthMs = p.depthSec * 1000;
    const step = timeLabelStep(depthMs, Math.max(60, cssH * 0.5), 26, f.kind === "audio" ? i.periodMs : null);
    const tt = timeTicks.current;
    let nt = 0;
    for (let ago = 0; ago <= depthMs + 1e-6 && nt < tt.length; ago += step) tt[nt++] = ago;
    const win = displayWindow(f.levels.floorDb, f.levels.spanDb, p.contrast);
    const mvp = r.draw({
      history: f.history,
      endAt: end,
      depthMs,
      viewLowHz: lo,
      viewHighHz: hi,
      loDb: win.loDb,
      rangeDb: win.rangeDb,
      colormap: p.colormap,
      heightScale: p.heightScale,
      camera: camera.current,
      freqTicks: ft.values,
      timeTicks: tt,
      timeTickCount: nt,
    });

    // Labels: projected from the grid's front and right edges into CSS pixels.
    const out = projected.current;
    const unit = frequencyUnit(hi, ft.step || 1);
    const fp = freqPool.current;
    if (fp) {
      fp.begin();
      for (const hz of ft.values) {
        const x = ((hz - lo) / (hi - lo)) * 2 * HALF_WIDTH - HALF_WIDTH;
        if (project(out, mvp, x, 0, HALF_DEPTH + 0.1, cssW, cssH)) {
          fp.place(formatFrequency(hz, unit, ft.step), out[0]!, out[1]!, 0.5, 0);
        }
      }
      fp.end();
    }
    const tp = timePool.current;
    if (tp) {
      tp.begin();
      for (let k = 0; k < nt; k++) {
        const ago = tt[k]!;
        const z = HALF_DEPTH - (ago / depthMs) * 2 * HALF_DEPTH;
        if (project(out, mvp, HALF_WIDTH + 0.09, 0, z, cssW, cssH)) {
          tp.place(formatAgo(ago), out[0]!, out[1]!, 0, 0.5);
        }
      }
      tp.end();
    }
  }, []);

  const request = useDrawScheduler(wrapRef, draw);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      sizeRef.current = { cssW: rect.width, cssH: rect.height };
      const dpr = Math.min(MAX_DPR, Math.max(1, window.devicePixelRatio || 1));
      rendererRef.current?.resize(
        Math.max(1, Math.min(4096, Math.round(rect.width * dpr))),
        Math.max(1, Math.min(4096, Math.round(rect.height * dpr))),
      );
    };
    const make = () => {
      try {
        const gl = createGl(canvas);
        if (!gl) throw new Error("This browser has WebGL2 turned off or unavailable.");
        rendererRef.current = new Waterfall3DGL(gl, canvas);
        setError(null);
        resize();
        request();
      } catch (err) {
        rendererRef.current = null;
        setError(err instanceof Error ? err.message : String(err));
      }
    };
    const lost = (e: Event) => {
      e.preventDefault();
      rendererRef.current = null;
    };
    canvas.addEventListener("webglcontextlost", lost);
    canvas.addEventListener("webglcontextrestored", make);
    make();
    const ro = new ResizeObserver(() => {
      resize();
      request();
    });
    ro.observe(wrap);
    return () => {
      ro.disconnect();
      canvas.removeEventListener("webglcontextlost", lost);
      canvas.removeEventListener("webglcontextrestored", make);
      rendererRef.current?.dispose();
      rendererRef.current = null;
    };
  }, [request]);

  useEffect(() => {
    const el = labelsRef.current;
    if (!el) return;
    const cls = "text-[11px] leading-none text-fg-muted tnum whitespace-nowrap";
    freqPool.current = new LabelPool(el, FREQ_LABELS, cls);
    timePool.current = new LabelPool(el, TIME_LABELS, cls);
    request();
    return () => {
      freqPool.current?.dispose();
      timePool.current?.dispose();
      freqPool.current = null;
      timePool.current = null;
    };
  }, [request]);

  // Data-driven redraws: every frame, or once a second under reduced motion.
  useEffect(() => {
    if (paused) {
      frozenEnd.current = lastEnd.current ?? feed.now(performance.now());
      request();
      return;
    }
    frozenEnd.current = null;
    const reduced = prefersReducedMotion();
    let dirty = false;
    const off = feed.subscribe(() => {
      if (reduced) dirty = true;
      else request();
    });
    const tick = setInterval(() => {
      if (!reduced || dirty) request();
      dirty = false;
    }, 1000);
    request();
    return () => {
      off();
      clearInterval(tick);
    };
  }, [feed, paused, request]);

  useEffect(() => {
    request();
  }, [contrast, colormap, effectiveDepth, heightScale, request]);

  // ---- camera interaction ----------------------------------------------------------------

  const animation = useRef<number | null>(null);
  const resetView = useCallback(() => {
    if (animation.current !== null) cancelAnimationFrame(animation.current);
    animation.current = null;
    const cam = camera.current;
    if (prefersReducedMotion()) {
      Object.assign(cam, DEFAULT_CAMERA);
      request();
      return;
    }
    const from = { ...cam };
    const t0 = performance.now();
    // Shortest way round for the yaw.
    const dYaw = Math.atan2(Math.sin(DEFAULT_CAMERA.yaw - from.yaw), Math.cos(DEFAULT_CAMERA.yaw - from.yaw));
    const step = () => {
      const u = Math.min(1, (performance.now() - t0) / 300);
      const e = 1 - (1 - u) ** 3;
      cam.yaw = from.yaw + dYaw * e;
      cam.pitch = from.pitch + (DEFAULT_CAMERA.pitch - from.pitch) * e;
      cam.distance = from.distance + (DEFAULT_CAMERA.distance - from.distance) * e;
      cam.tx = from.tx + (DEFAULT_CAMERA.tx - from.tx) * e;
      cam.ty = from.ty + (DEFAULT_CAMERA.ty - from.ty) * e;
      cam.tz = from.tz + (DEFAULT_CAMERA.tz - from.tz) * e;
      request();
      animation.current = u < 1 ? requestAnimationFrame(step) : null;
    };
    animation.current = requestAnimationFrame(step);
  }, [request]);

  useEffect(
    () => () => {
      if (animation.current !== null) cancelAnimationFrame(animation.current);
    },
    [],
  );

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomBy(camera.current, Math.exp(e.deltaY * 0.0015));
      request();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [request]);

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ dist: number; mx: number; my: number } | null>(null);
  const mode = useRef<"orbit" | "pan">("orbit");
  const lastTap = useRef(0);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0 && e.button !== 1 && e.button !== 2) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    mode.current = e.shiftKey || e.button === 1 || e.button === 2 ? "pan" : "orbit";
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current = {
        dist: Math.hypot(a!.x - b!.x, a!.y - b!.y),
        mx: (a!.x + b!.x) / 2,
        my: (a!.y + b!.y) / 2,
      };
    }
    if (e.pointerType !== "mouse" && pointers.current.size === 1) {
      const now = performance.now();
      if (now - lastTap.current < 300) resetView();
      lastTap.current = now;
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const cur = { x: e.clientX, y: e.clientY };
    pointers.current.set(e.pointerId, cur);
    const cam = camera.current;
    const h = sizeRef.current.cssH || 1;
    if (pointers.current.size >= 2 && gesture.current) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.max(10, Math.hypot(a!.x - b!.x, a!.y - b!.y));
      const mx = (a!.x + b!.x) / 2;
      const my = (a!.y + b!.y) / 2;
      zoomBy(cam, gesture.current.dist / dist);
      panBy(cam, mx - gesture.current.mx, my - gesture.current.my, h);
      gesture.current = { dist, mx, my };
    } else if (mode.current === "pan") {
      panBy(cam, cur.x - prev.x, cur.y - prev.y, h);
    } else {
      orbitBy(cam, -(cur.x - prev.x) * 0.006, (cur.y - prev.y) * 0.006);
    }
    request();
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) gesture.current = null;
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const cam = camera.current;
    if (e.key === "ArrowLeft") orbitBy(cam, 0.08, 0);
    else if (e.key === "ArrowRight") orbitBy(cam, -0.08, 0);
    else if (e.key === "ArrowUp") orbitBy(cam, 0, 0.06);
    else if (e.key === "ArrowDown") orbitBy(cam, 0, -0.06);
    else if (e.key === "+" || e.key === "=") zoomBy(cam, 0.88);
    else if (e.key === "-" || e.key === "_") zoomBy(cam, 1 / 0.88);
    else if (e.key === "0" || e.key === "Escape") resetView();
    else return;
    e.preventDefault();
    request();
  };

  const depthChoices = useMemo(() => {
    const allowed = DEPTH_CHOICES_SEC.filter((s) => s <= historySec);
    return allowed.length > 0 ? allowed : [DEPTH_CHOICES_SEC[0]];
  }, [historySec]);
  const depthLabel = (s: number) => (s < 60 ? `${s} s` : `${s / 60} min`);

  return (
    <div className={cn("flex flex-col min-h-0 border border-line rounded-sm bg-bg overflow-hidden", className)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-surface px-2 py-1 text-[11px] text-fg-muted">
        <label className="flex items-center gap-1.5">
          Height
          <input
            type="range"
            min={MIN_HEIGHT_SCALE}
            max={MAX_HEIGHT_SCALE}
            step={0.1}
            value={heightScale}
            onChange={(e) => onHeightScaleChange(Number(e.target.value))}
            className="w-20 accent-accent"
            aria-label="3D height scale"
          />
          <span className="w-8 tnum">{heightScale.toFixed(1)}×</span>
        </label>
        <label className="flex items-center gap-1.5">
          Depth
          <Select
            value={String(Math.min(depthSec, historySec))}
            onChange={(e) => onDepthChange(Number(e.target.value))}
            className="w-auto py-0.5 text-xs"
            aria-label="How much history the 3D surface covers"
          >
            {depthChoices.map((s) => (
              <option key={s} value={s}>
                {depthLabel(s)}
              </option>
            ))}
          </Select>
        </label>
        <button
          type="button"
          onClick={resetView}
          className="tap-inline ml-auto rounded-sm border border-line-strong px-1.5 py-0.5 text-fg-muted hover:text-fg"
        >
          Reset view
        </button>
      </div>
      <div
        ref={wrapRef}
        className="relative flex-1 min-h-0 cursor-grab touch-none select-none outline-none focus-visible:outline-2 focus-visible:outline-accent-bright active:cursor-grabbing"
        tabIndex={0}
        role="img"
        aria-label="3D waterfall: frequency across, newest at the front. Drag to orbit, shift-drag to pan, wheel to zoom, arrow keys to orbit, 0 to reset."
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={resetView}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={onKeyDown}
      >
        <canvas ref={canvasRef} className="absolute inset-0 block h-full w-full" />
        <div ref={labelsRef} className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true" />
        {error && (
          <div className="absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-fg-muted">
            <p>
              The 3D view needs WebGL2. {error} The spectrogram still works.
            </p>
          </div>
        )}
      </div>
      <div className="border-t border-line px-2 py-1 text-[11px] text-fg-subtle">
        Newest at the front · drag to orbit · shift- or right-drag, or two fingers, to pan · wheel or pinch
        to zoom · double-click to reset
      </div>
    </div>
  );
}
