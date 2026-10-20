import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  formatAgo,
  formatFrequency,
  formatReadoutFrequency,
  formatSpan,
  formatUtcClock,
  fillTimeTicks,
  frequencyTicks,
  frequencyUnit,
  timeLabelStep,
} from "@/lib/spectrum/axis";
import type { ColormapId } from "@/lib/spectrum/colormaps";
import type { SpectrumFeed } from "@/lib/spectrum/feed";
import { displayWindow, type Contrast } from "@/lib/spectrum/levels";
import { cn } from "@/lib/utils";

import { createGl } from "./gl";
import { LabelPool, useDrawScheduler } from "./render-loop";
import { Spectrogram2D, SpectrogramGL, type SpectrogramRenderer } from "./spectrogram-render";

// The spectrogram: frequency across, time down (newest at the bottom, as on the Decodes
// page), history recoloured live from dB values held on the GPU.
//
// React renders the frame around the canvas — ruler, gridlines, the dial marker — which
// changes only on a zoom, a resize or a retune. Everything that moves with every frame (the
// picture, the time labels, the hover readout) is drawn by the render loop directly, so a
// frame never re-renders the component.

export interface SpectrogramProps {
  feed: SpectrumFeed;
  contrast: Contrast;
  colormap: ColormapId;
  historySec: number;
  paused: boolean;
  timeLabels: "utc" | "ago";
  onTimeLabelsChange: (mode: "utc" | "ago") => void;
  /** RF only: where the receiver is tuned, drawn as a marker. */
  dialHz?: number | null;
  className?: string;
}

interface Range {
  lo: number;
  hi: number;
}

const MAX_DPR = 2;
const MAX_WIDTH_PX = 4096;
const MAX_HEIGHT_PX = 2048;
const TIME_LABELS = 24;

export function Spectrogram({
  feed,
  contrast,
  colormap,
  historySec,
  paused,
  timeLabels,
  onTimeLabelsChange,
  dialHz = null,
  className,
}: SpectrogramProps) {
  const rf = feed.kind === "rf";
  const plotRef = useRef<HTMLDivElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const crossRef = useRef<HTMLDivElement>(null);
  const readoutRef = useRef<HTMLDivElement>(null);
  const noteRef = useRef<HTMLDivElement>(null);
  const bandRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<SpectrogramRenderer | null>(null);
  const poolRef = useRef<LabelPool | null>(null);
  const ticksRef = useRef(new Float64Array(TIME_LABELS));
  const sizeRef = useRef({ cssW: 0, cssH: 0 });
  const hoverRef = useRef<{ x: number; y: number } | null>(null);
  const frozenEnd = useRef<number | null>(null);
  const lastEnd = useRef<number | null>(null);

  // A WebGL2 failure (no context, or a shader the driver rejects) remounts the canvas for 2D:
  // a canvas that has handed out one context type can never give another.
  const [mode, setMode] = useState<"gl" | "2d">("gl");
  const [renderKind, setRenderKind] = useState<"webgl2" | "canvas2d" | null>(null);
  const [glError, setGlError] = useState<string | null>(null);
  const [zoom, setZoom] = useState<Range | null>(null);
  const [axis, setAxis] = useState<Range>({ lo: 0, hi: 3000 });
  const [rulerWidth, setRulerWidth] = useState(600);

  const props = { feed, contrast, colormap, historySec, paused, timeLabels, zoom };
  const propsRef = useRef(props);
  propsRef.current = props;
  const axisRef = useRef(axis);
  axisRef.current = axis;

  /** The data's own frequency span: the newest frame's axis. */
  const dataAxis = useCallback((): Range => {
    const i = propsRef.current.feed.info;
    return i.highHz > i.lowHz ? { lo: i.lowHz, hi: i.highHz } : { lo: 0, hi: 3000 };
  }, []);

  /** The visible window: the zoom if it still overlaps the data, else all of it. */
  const viewOf = useCallback((): Range => {
    const a = dataAxis();
    const z = propsRef.current.zoom;
    if (!z || z.hi <= a.lo || z.lo >= a.hi) return a;
    return { lo: Math.max(a.lo, z.lo), hi: Math.min(a.hi, z.hi) };
  }, [dataAxis]);

  const draw = useCallback(() => {
    const r = rendererRef.current;
    if (!r) return;
    const p = propsRef.current;
    const f = p.feed;
    const now = performance.now();
    const live = f.now(now);
    const end = (p.paused ? frozenEnd.current : null) ?? live ?? f.history.newestEndAt() ?? 0;
    lastEnd.current = end;
    const spanMs = p.historySec * 1000;
    const view = viewOf();
    const win = displayWindow(f.levels.floorDb, f.levels.spanDb, p.contrast);
    r.draw({
      history: f.history,
      endAt: end,
      spanMs,
      viewLowHz: view.lo,
      viewHighHz: view.hi,
      loDb: win.loDb,
      rangeDb: win.rangeDb,
      colormap: p.colormap,
      periodMs: f.kind === "audio" ? f.info.periodMs : null,
    });

    // The ruler is React's; tell it only when the window actually moved.
    const a = axisRef.current;
    if (Math.abs(a.lo - view.lo) > 1e-6 || Math.abs(a.hi - view.hi) > 1e-6) setAxis(view);

    const { cssW, cssH } = sizeRef.current;
    const pool = poolRef.current;
    if (pool && cssH > 0) {
      const step = timeLabelStep(spanMs, cssH, 30, f.kind === "audio" ? f.info.periodMs : null);
      const n = fillTimeTicks(ticksRef.current, end, spanMs, step, p.timeLabels);
      pool.begin();
      for (let i = 0; i < n; i++) {
        const t = ticksRef.current[i]!;
        const top = cssH - ((end - t) / spanMs) * cssH;
        if (top < 6 || top > cssH - 2) continue;
        pool.place(p.timeLabels === "utc" ? formatUtcClock(t) : formatAgo(end - t), 4, top, 0, 0.5);
      }
      pool.end();
    }

    const note = noteRef.current;
    if (note) {
      let text = "";
      const oldest = f.history.oldestStartAt();
      if (p.paused) text = "Paused — still recording";
      else if (f.hasData && now - f.lastReceived > 3000) {
        text = `No new frames for ${Math.round((now - f.lastReceived) / 1000)} s`;
      } else if (f.hasData && oldest !== null && oldest > end - spanMs) {
        text = `Collecting history… ${formatSpan(end - oldest)} of ${formatSpan(spanMs)}`;
      }
      if (note.textContent !== text) note.textContent = text;
      note.style.display = text ? "" : "none";
    }

    const hover = hoverRef.current;
    const cross = crossRef.current;
    const readout = readoutRef.current;
    if (cross && readout) {
      if (!hover || cssW <= 0 || cssH <= 0 || !f.hasData) {
        cross.style.display = "none";
        readout.style.display = "none";
      } else {
        const hzPerPx = (view.hi - view.lo) / cssW;
        const f0 = view.lo + hover.x * hzPerPx;
        const t1 = end - ((cssH - hover.y) / cssH) * spanMs;
        const t0 = t1 - spanMs / cssH;
        const s = f.history.peakIn(t0, t1, f0, f0 + hzPerPx);
        cross.style.display = "";
        cross.style.transform = `translate(${hover.x.toFixed(1)}px, 0)`;
        const unit = rf ? "dBm uncal." : f.info.calibrated ? "dBFS" : "dB rel.";
        const lines = [
          formatReadoutFrequency(s ? s.hz : f0 + hzPerPx / 2, rf),
          `${formatUtcClock(s ? s.at : t1)}Z · ${formatAgo(end - (s ? s.at : t1))}`,
          s
            ? `${s.db.toFixed(1)} ${unit} · ${(s.db - s.floorDb) >= 0 ? "+" : ""}${(s.db - s.floorDb).toFixed(1)} dB over floor`
            : "no data here",
        ].join("\n");
        if (readout.textContent !== lines) readout.textContent = lines;
        readout.style.display = "";
        // Keep the readout on the side away from the cursor.
        readout.style.left = hover.x > cssW / 2 ? "0.5rem" : "";
        readout.style.right = hover.x > cssW / 2 ? "" : "0.5rem";
      }
    }
  }, [viewOf, rf]);

  const request = useDrawScheduler(plotRef, draw);

  // Renderer lifetime, including WebGL context loss and restore.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const make = (): void => {
      try {
        if (mode === "gl") {
          const gl = createGl(canvas);
          if (!gl) throw new Error("WebGL2 is not available in this browser");
          rendererRef.current = new SpectrogramGL(gl, canvas);
        } else {
          const ctx = canvas.getContext("2d", { alpha: false });
          if (!ctx) throw new Error("no 2D canvas either");
          rendererRef.current = new Spectrogram2D(ctx, canvas);
        }
        setRenderKind(rendererRef.current.kind);
        resize();
        request();
      } catch (err) {
        rendererRef.current = null;
        if (mode === "gl") {
          setGlError(err instanceof Error ? err.message : String(err));
          setMode("2d");
        }
      }
    };
    const resize = (): void => {
      const plot = plotRef.current;
      const r = rendererRef.current;
      if (!plot || !r) return;
      const rect = plot.getBoundingClientRect();
      sizeRef.current = { cssW: rect.width, cssH: rect.height };
      const dpr = r.kind === "webgl2" ? Math.min(MAX_DPR, Math.max(1, window.devicePixelRatio || 1)) : 1;
      r.resize(
        Math.max(1, Math.min(MAX_WIDTH_PX, Math.round(rect.width * dpr))),
        Math.max(1, Math.min(MAX_HEIGHT_PX, Math.round(rect.height * dpr))),
      );
    };
    const lost = (e: Event) => {
      e.preventDefault();
      rendererRef.current = null;
    };
    const restored = () => make();
    canvas.addEventListener("webglcontextlost", lost);
    canvas.addEventListener("webglcontextrestored", restored);
    make();
    const ro = new ResizeObserver(() => {
      resize();
      const w = plotRef.current?.getBoundingClientRect().width;
      if (w) setRulerWidth(w);
      request();
    });
    if (plotRef.current) ro.observe(plotRef.current);
    return () => {
      ro.disconnect();
      canvas.removeEventListener("webglcontextlost", lost);
      canvas.removeEventListener("webglcontextrestored", restored);
      rendererRef.current?.dispose();
      rendererRef.current = null;
    };
  }, [mode, request]);

  useEffect(() => {
    const gutter = gutterRef.current;
    if (!gutter) return;
    const pool = new LabelPool(gutter, TIME_LABELS, "text-[11px] leading-none text-fg-muted tnum whitespace-nowrap");
    poolRef.current = pool;
    request();
    return () => {
      pool.dispose();
      poolRef.current = null;
    };
  }, [request]);

  // Live: redraw on every frame, and once a second regardless so an outage grows as a gap.
  useEffect(() => {
    if (paused) {
      frozenEnd.current = lastEnd.current ?? feed.now(performance.now());
      request();
      return;
    }
    frozenEnd.current = null;
    request();
    const off = feed.subscribe(request);
    const tick = setInterval(request, 1000);
    return () => {
      off();
      clearInterval(tick);
    };
  }, [feed, paused, request]);

  useEffect(() => {
    feed.history.setHistoryMs(historySec * 1000);
  }, [feed, historySec]);

  useEffect(() => {
    request();
  }, [contrast, colormap, historySec, timeLabels, zoom, request]);

  // A different source is a different axis: drop the zoom.
  useEffect(() => setZoom(null), [feed]);

  // ---- interaction --------------------------------------------------------------------

  const hzAt = useCallback(
    (x: number): number => {
      const v = viewOf();
      const w = sizeRef.current.cssW || 1;
      return v.lo + (x / w) * (v.hi - v.lo);
    },
    [viewOf],
  );

  const zoomTo = useCallback(
    (lo: number, hi: number) => {
      const a = dataAxis();
      const minSpan = Math.max(8 * (propsRef.current.feed.info.binHz || 1), 10);
      let l = Math.min(lo, hi);
      let h = Math.max(lo, hi);
      if (h - l < minSpan) {
        const c = (l + h) / 2;
        l = c - minSpan / 2;
        h = c + minSpan / 2;
      }
      const span = Math.min(h - l, a.hi - a.lo);
      if (l < a.lo) l = a.lo;
      if (l + span > a.hi) l = a.hi - span;
      h = l + span;
      setZoom(span >= a.hi - a.lo - 1e-6 ? null : { lo: l, hi: h });
    },
    [dataAxis],
  );

  const zoomAround = useCallback(
    (hz: number, factor: number) => {
      const v = viewOf();
      zoomTo(hz - (hz - v.lo) * factor, hz + (v.hi - hz) * factor);
    },
    [viewOf, zoomTo],
  );

  const panBy = useCallback(
    (fraction: number) => {
      const v = viewOf();
      const d = (v.hi - v.lo) * fraction;
      zoomTo(v.lo + d, v.hi + d);
    },
    [viewOf, zoomTo],
  );

  // Wheel needs a non-passive listener to keep the page from scrolling under the zoom.
  useEffect(() => {
    const el = plotRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const horizontal = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY);
      if (horizontal) panBy(((e.shiftKey ? e.deltaY : e.deltaX) / Math.max(1, rect.width)) * 1.5);
      else zoomAround(hzAt(e.clientX - rect.left), Math.exp(e.deltaY * 0.0015));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [hzAt, panBy, zoomAround]);

  const drag = useRef<{ x0: number; x: number; id: number } | null>(null);
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; mid: number } | null>(null);

  const local = (e: React.PointerEvent): { x: number; y: number } => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const showBand = (x0: number | null, x1 = 0) => {
    const band = bandRef.current;
    if (!band) return;
    if (x0 === null) {
      band.style.display = "none";
      return;
    }
    band.style.display = "";
    band.style.left = `${Math.min(x0, x1)}px`;
    band.style.width = `${Math.abs(x1 - x0)}px`;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const pt = local(e);
    if (e.pointerType === "mouse") {
      if (e.button !== 0) return;
      drag.current = { x0: pt.x, x: pt.x, id: e.pointerId };
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    touches.current.set(e.pointerId, pt);
    if (touches.current.size === 2) {
      const [a, b] = [...touches.current.values()];
      pinch.current = { dist: Math.abs(a!.x - b!.x), mid: (a!.x + b!.x) / 2 };
    }
    hoverRef.current = pt;
    request();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const pt = local(e);
    if (e.pointerType === "mouse") {
      hoverRef.current = pt;
      if (drag.current) {
        drag.current.x = pt.x;
        showBand(drag.current.x0, pt.x);
      }
      request();
      return;
    }
    const prev = touches.current.get(e.pointerId);
    if (!prev) return;
    touches.current.set(e.pointerId, pt);
    if (touches.current.size === 2 && pinch.current) {
      const [a, b] = [...touches.current.values()];
      const dist = Math.max(8, Math.abs(a!.x - b!.x));
      const mid = (a!.x + b!.x) / 2;
      const w = sizeRef.current.cssW || 1;
      const v = viewOf();
      const factor = pinch.current.dist / dist;
      const hz = hzAt(pinch.current.mid);
      const shift = ((pinch.current.mid - mid) / w) * (v.hi - v.lo);
      zoomTo(hz - (hz - v.lo) * factor + shift, hz + (v.hi - hz) * factor + shift);
      pinch.current = { dist, mid };
    } else if (touches.current.size === 1 && propsRef.current.zoom) {
      panBy((prev.x - pt.x) / (sizeRef.current.cssW || 1));
    }
    hoverRef.current = pt;
    request();
  };

  const endPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse") {
      const d = drag.current;
      drag.current = null;
      showBand(null);
      if (d && Math.abs(d.x - d.x0) > 6) zoomTo(hzAt(d.x0), hzAt(d.x));
      return;
    }
    touches.current.delete(e.pointerId);
    if (touches.current.size < 2) pinch.current = null;
  };

  const lastTap = useRef(0);
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    endPointer(e);
    if (e.pointerType !== "mouse") {
      const now = performance.now();
      if (now - lastTap.current < 300) setZoom(null);
      lastTap.current = now;
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const v = viewOf();
    const mid = (v.lo + v.hi) / 2;
    if (e.key === "+" || e.key === "=") zoomAround(mid, 0.7);
    else if (e.key === "-" || e.key === "_") zoomAround(mid, 1 / 0.7);
    else if (e.key === "ArrowLeft") panBy(-0.15);
    else if (e.key === "ArrowRight") panBy(0.15);
    else if (e.key === "0" || e.key === "Escape") setZoom(null);
    else return;
    e.preventDefault();
  };

  // ---- the frame around the canvas ----------------------------------------------------

  const ticks = useMemo(
    () => frequencyTicks(axis.lo, axis.hi, Math.max(2, Math.floor(rulerWidth / 72))),
    [axis.lo, axis.hi, rulerWidth],
  );
  const unit = frequencyUnit(axis.hi, ticks.step || 1);
  const pct = (hz: number) => ((hz - axis.lo) / (axis.hi - axis.lo || 1)) * 100;
  const info = feed.info;
  const sourceLabel = rf ? `RF panadapter${info.radio ? ` · ${info.radio}` : ""}` : "Receive audio";

  return (
    <div className={cn("flex flex-col min-h-0 border border-line rounded-sm bg-bg overflow-hidden", className)}>
      <div className="flex h-7 shrink-0 items-stretch border-b border-line bg-surface text-[11px] text-fg-muted tnum">
        <button
          type="button"
          onClick={() => onTimeLabelsChange(timeLabels === "utc" ? "ago" : "utc")}
          className="tap-inline w-16 shrink-0 border-r border-line px-1 text-left hover:text-fg"
          title="Switch the time labels between UTC and seconds ago"
        >
          {timeLabels === "utc" ? "UTC" : "ago"} · {unit}
        </button>
        <div className="relative flex-1 min-w-0 overflow-hidden select-none">
          {ticks.values.map((hz) => {
            const left = pct(hz);
            if (left < 0 || left > 100) return null;
            return (
              <span
                key={hz}
                className={cn(
                  "absolute top-1.5 whitespace-nowrap",
                  left < 4 ? "" : left > 96 ? "-translate-x-full" : "-translate-x-1/2",
                )}
                style={{ left: `${left}%` }}
              >
                {formatFrequency(hz, unit, ticks.step)}
              </span>
            );
          })}
        </div>
      </div>

      <div className="relative flex flex-1 min-h-0">
        <div
          ref={gutterRef}
          className="relative w-16 shrink-0 overflow-hidden border-r border-line bg-surface"
          aria-hidden="true"
        />
        <div
          ref={plotRef}
          className="relative flex-1 min-w-0 overflow-hidden cursor-crosshair touch-pan-y outline-none focus-visible:outline-2 focus-visible:outline-accent-bright"
          tabIndex={0}
          role="img"
          aria-label={`${sourceLabel} spectrogram, newest at the bottom. Drag or use the mouse wheel to zoom frequency, plus and minus keys to zoom, arrow keys to pan, 0 to reset.`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={endPointer}
          onPointerLeave={(e) => {
            if (e.pointerType === "mouse" && !drag.current) {
              hoverRef.current = null;
              request();
            }
          }}
          onDoubleClick={() => setZoom(null)}
          onKeyDown={onKeyDown}
        >
          <canvas
            key={mode}
            ref={canvasRef}
            className="absolute inset-0 block h-full w-full"
            style={renderKind === "canvas2d" ? { imageRendering: "pixelated" } : undefined}
          />
          <div className="pointer-events-none absolute inset-0">
            {ticks.values.map((hz) => (
              <div key={hz} className="absolute inset-y-0 border-l border-white/10" style={{ left: `${pct(hz)}%` }} />
            ))}
            {rf && dialHz !== null && dialHz > axis.lo && dialHz < axis.hi && (
              <div className="absolute inset-y-0 border-l-2 border-accent" style={{ left: `${pct(dialHz)}%` }}>
                <span className="absolute left-1 top-1 rounded-sm bg-bg/80 px-1 text-[11px] text-accent-bright tnum">
                  dial
                </span>
              </div>
            )}
            <div ref={bandRef} className="absolute inset-y-0 border-x border-info bg-info/15" style={{ display: "none" }} />
            <div ref={crossRef} className="absolute inset-y-0 left-0 border-l border-white/50" style={{ display: "none" }} />
            <div
              ref={readoutRef}
              className="absolute top-2 whitespace-pre rounded-sm border border-line bg-bg/85 px-2 py-1 text-[11px] leading-snug text-fg tnum"
              style={{ display: "none" }}
            />
            <div
              ref={noteRef}
              className="absolute bottom-2 left-2 rounded-sm bg-bg/85 px-2 py-0.5 text-[11px] text-warn"
              style={{ display: "none" }}
            />
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-line px-2 py-1 text-[11px] text-fg-subtle tnum">
        <span>
          {sourceLabel}
          {info.binHz > 0 && (
            <>
              {" · "}
              {rf ? `${(info.binHz >= 1000 ? info.binHz / 1000 : info.binHz).toFixed(1)} ${info.binHz >= 1000 ? "kHz" : "Hz"}/bin` : `${info.binHz.toFixed(1)} Hz/bin`}
            </>
          )}
          {" · newest at bottom · "}
          {formatSpan(historySec * 1000)}
          {renderKind === "canvas2d" && " · basic renderer"}
        </span>
        <span className="flex items-center gap-2">
          {zoom ? (
            <button
              type="button"
              onClick={() => setZoom(null)}
              className="tap-inline rounded-sm border border-line-strong px-1.5 text-fg-muted hover:text-fg"
            >
              Reset zoom
            </button>
          ) : (
            <span className="hidden sm:inline">Drag or wheel to zoom · double-click resets</span>
          )}
        </span>
      </div>
      {glError && renderKind === "canvas2d" && (
        <p className="border-t border-line px-2 py-1 text-[11px] text-fg-subtle" title={glError}>
          WebGL2 unavailable — using the basic renderer, which redraws less detail.
        </p>
      )}
    </div>
  );
}
