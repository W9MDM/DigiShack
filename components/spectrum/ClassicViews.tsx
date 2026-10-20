// Two more ways to look at the same recorded feed, drawn with Canvas2D:
//
//   Ridgeline — the last minute as stacked line traces, oldest at the back, each one filled
//   with the background so it hides the ones behind it (the "Unknown Pleasures" plot). Signal
//   shapes and their drift read at a glance in a way colour alone doesn't give you.
//
//   Persistence — a real-time-analyser "phosphor" display: x is frequency, y is level, and
//   each cell glows with how OFTEN the last 30 s landed there. A steady carrier is a bright
//   dot, noise is a dim smear at the floor, and a weak signal that keeps coming back stands
//   out from noise that only visits once.
//
// Both redraw at most five times a second, only while visible, and allocate nothing per draw
// beyond what a resize needs.

import { useEffect, useRef } from "react";

import { useNightMode } from "@/lib/client/use-theme";
import { frequencyTicks, formatFrequency, frequencyUnit } from "@/lib/spectrum/axis";
import { colormapChrome, colormapRgb, type ColormapId } from "@/lib/spectrum/colormaps";
import type { SpectrumFeed } from "@/lib/spectrum/feed";
import { displayWindow, normaliseDb, type Contrast } from "@/lib/spectrum/levels";
import { cn } from "@/lib/utils";

const MAX_DPR = 2;
const FRAME_MS = 200;
const AXIS_PX = 18;

type Painter = (g: CanvasRenderingContext2D, w: number, h: number, dpr: number) => void;

/** A canvas that fills its box, redraws on new frames (throttled) and pauses when hidden. */
export function useFeedCanvas(feed: SpectrumFeed, paint: Painter) {
  const ref = useRef<HTMLCanvasElement>(null);
  const paintRef = useRef(paint);
  paintRef.current = paint;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const g = canvas.getContext("2d");
    if (!g) return;
    let raf = 0;
    let last = 0;
    let visible = true;
    let dirty = true;
    const draw = (now: number) => {
      raf = 0;
      if (!visible || document.visibilityState === "hidden") return;
      if (now - last < FRAME_MS) {
        raf = requestAnimationFrame(draw);
        return;
      }
      last = now;
      dirty = false;
      const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      paintRef.current(g, w, h, dpr);
    };
    const request = () => {
      dirty = true;
      if (!raf) raf = requestAnimationFrame(draw);
    };
    const unsub = feed.subscribe(request);
    const ro = new ResizeObserver(request);
    ro.observe(canvas);
    const io = new IntersectionObserver((e) => {
      visible = e.some((x) => x.isIntersecting);
      if (visible && dirty) request();
    });
    io.observe(canvas);
    const onVis = () => document.visibilityState === "visible" && request();
    document.addEventListener("visibilitychange", onVis);
    request();
    return () => {
      unsub();
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [feed]);

  return ref;
}

/** The frequency span of the newest row, absolute Hz. */
export function newestSpan(feed: SpectrumFeed): { low: number; high: number } | null {
  const h = feed.history;
  if (h.size === 0) return null;
  const p = h.physical(h.size - 1);
  const low = h.lowHz[p]!;
  return { low, high: low + h.binHz[p]! * h.count[p]! };
}

export function rgba(c: readonly [number, number, number], a = 1): string {
  return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}

export function drawAxis(
  g: CanvasRenderingContext2D,
  w: number,
  h: number,
  dpr: number,
  low: number,
  high: number,
  text: string,
) {
  const ticks = frequencyTicks(low, high, Math.max(2, Math.floor(w / (90 * dpr))));
  const unit = frequencyUnit(high, ticks.step);
  g.fillStyle = text;
  g.font = `${11 * dpr}px ui-sans-serif, system-ui, sans-serif`;
  g.textBaseline = "bottom";
  for (const v of ticks.values) {
    const x = ((v - low) / (high - low)) * w;
    const label = formatFrequency(v, unit, ticks.step);
    const tw = g.measureText(label).width;
    g.fillText(label, Math.min(w - tw - 2, Math.max(2, x - tw / 2)), h - 2 * dpr);
  }
}

export interface ClassicViewProps {
  feed: SpectrumFeed;
  contrast: Contrast;
  colormap: ColormapId;
  /** CSS pixels, or a CSS length such as "100%". */
  height: number | string;
  className?: string;
}

/** Stacked traces of the last minute, newest at the front. */
export function Ridgeline({ feed, contrast, colormap, height, className }: ClassicViewProps) {
  const night = useNightMode();
  const lut = colormapRgb(colormap);
  const chrome = colormapChrome(colormap);
  const ref = useFeedCanvas(feed, (g, w, h, dpr) => {
    const bg = chrome.background;
    g.fillStyle = rgba(bg);
    g.fillRect(0, 0, w, h);
    const span = newestSpan(feed);
    const hist = feed.history;
    if (!span || hist.size < 2) return;
    const win = displayWindow(feed.levels.floorDb, feed.levels.spanDb, contrast);
    const plotH = h - AXIS_PX * dpr;
    const LINES = Math.min(36, hist.size);
    // Spread the lines over the last minute of rows (or whatever is held).
    const newestEnd = hist.endAt[hist.physical(hist.size - 1)]!;
    const spanMs = 60_000;
    const gap = plotH / (LINES + 5);
    const amp = gap * 5;
    const cols = Math.max(64, Math.min(w, 1024));
    const ys = new Float32Array(cols);
    let k = hist.size - 1;
    const rowsFor: number[] = [];
    for (let i = 0; i < LINES; i++) {
      const target = newestEnd - (i / Math.max(1, LINES - 1)) * spanMs;
      while (k > 0 && hist.endAt[hist.physical(k)]! > target) k--;
      rowsFor.push(hist.physical(k));
    }
    const fg = night ? [255, 140, 28] : [230, 230, 236];
    // Oldest (top, back) first so newer lines paint over them.
    for (let i = LINES - 1; i >= 0; i--) {
      const p = rowsFor[i]!;
      const base = plotH - (i + 1) * gap;
      const count = hist.count[p]!;
      const low = hist.lowHz[p]!;
      const bin = hist.binHz[p]!;
      const off = p * hist.width;
      ys.fill(0);
      for (let b = 0; b < count; b++) {
        const hz = low + (b + 0.5) * bin;
        const c = Math.floor(((hz - span.low) / (span.high - span.low)) * cols);
        if (c < 0 || c >= cols) continue;
        // Squared, so the noise floor stays flat and only real signals rise off the line.
        const n = normaliseDb(hist.data[off + b]!, win.loDb, win.rangeDb);
        const t = n * n;
        if (t > ys[c]!) ys[c] = t;
      }
      g.beginPath();
      g.moveTo(0, base);
      for (let c = 0; c < cols; c++) g.lineTo((c / (cols - 1)) * w, base - ys[c]! * amp);
      g.lineTo(w, base);
      g.closePath();
      g.fillStyle = rgba(bg);
      g.fill();
      // Front lines brighter, the back ones fading into the dark — depth without a camera.
      const depth = 1 - i / LINES;
      const peak = Math.max(...ys);
      const li = Math.min(255, Math.round(80 + peak * 175)) * 3;
      const col = peak > 0.75 ? [lut[li]!, lut[li + 1]!, lut[li + 2]!] : fg;
      g.strokeStyle = `rgba(${col[0]},${col[1]},${col[2]},${0.35 + 0.65 * depth})`;
      g.lineWidth = Math.max(1, dpr * (0.8 + 0.6 * depth));
      g.stroke();
    }
    const [gr, gg, gb, ga] = chrome.gridLine;
    drawAxis(g, w, h, dpr, span.low, span.high, `rgba(${gr},${gg},${gb},${Math.min(1, ga * 4)})`);
  });
  return (
    <canvas
      ref={ref}
      aria-label="Ridgeline plot of the last minute of spectrum"
      className={cn("block w-full", className)}
      style={{ height }}
    />
  );
}

/** Real-time-analyser persistence: how often each frequency × level cell was hit. */
export function Persistence({ feed, contrast, colormap, height, className }: ClassicViewProps) {
  const night = useNightMode();
  const lut = colormapRgb(colormap);
  const chrome = colormapChrome(colormap);
  const buf = useRef<{ hits: Float32Array; img: ImageData | null; cols: number; rows: number }>({
    hits: new Float32Array(0),
    img: null,
    cols: 0,
    rows: 0,
  });
  const ref = useFeedCanvas(feed, (g, w, h, dpr) => {
    const bg = chrome.background;
    g.fillStyle = rgba(bg);
    g.fillRect(0, 0, w, h);
    const span = newestSpan(feed);
    const hist = feed.history;
    if (!span || hist.size < 2) return;
    const win = displayWindow(feed.levels.floorDb, feed.levels.spanDb, contrast);
    const plotH = Math.max(8, h - AXIS_PX * dpr);
    // One cell per 2 device pixels: dense enough to look analogue, cheap to fill.
    const cols = Math.max(32, Math.floor(w / 2));
    const rows = Math.max(16, Math.floor(plotH / 2));
    const b = buf.current;
    if (b.cols !== cols || b.rows !== rows) {
      b.hits = new Float32Array(cols * rows);
      b.img = g.createImageData(cols, rows);
      b.cols = cols;
      b.rows = rows;
    }
    const hits = b.hits;
    hits.fill(0);
    const newestEnd = hist.endAt[hist.physical(hist.size - 1)]!;
    const windowMs = 30_000;
    let used = 0;
    for (let k = hist.size - 1; k >= 0; k--) {
      const p = hist.physical(k);
      if (newestEnd - hist.endAt[p]! > windowMs) break;
      used++;
      const count = hist.count[p]!;
      const low = hist.lowHz[p]!;
      const bin = hist.binHz[p]!;
      const off = p * hist.width;
      for (let i = 0; i < count; i++) {
        const c = Math.floor(((low + (i + 0.5) * bin - span.low) / (span.high - span.low)) * cols);
        if (c < 0 || c >= cols) continue;
        const t = normaliseDb(hist.data[off + i]!, win.loDb, win.rangeDb);
        const r = rows - 1 - Math.min(rows - 1, Math.floor(t * (rows - 1)));
        hits[r * cols + c]! += 1;
      }
    }
    if (used === 0 || !b.img) return;
    // Brightness from how much of the time a cell is occupied, not from the busiest cell: the
    // noise floor is hit every row and normalising to it left every real signal faint. A cell
    // occupied 4% of the time is full brightness; a single hit still shows.
    const binsPerCol = Math.max(1, hist.count[hist.physical(hist.size - 1)]! / cols);
    const occupancy = 1 / (used * binsPerCol);
    const px = b.img.data;
    for (let i = 0; i < hits.length; i++) {
      const v = hits[i]!;
      const j = i * 4;
      if (v <= 0) {
        px[j] = bg[0];
        px[j + 1] = bg[1];
        px[j + 2] = bg[2];
        px[j + 3] = 255;
        continue;
      }
      // FT8 signals wander in level, so their hits spread over many cells: a few in 30 s glow.
      const t = Math.min(1, Math.sqrt(v * occupancy * 24));
      const li = Math.round(70 + t * 185) * 3;
      px[j] = lut[li]!;
      px[j + 1] = lut[li + 1]!;
      px[j + 2] = lut[li + 2]!;
      px[j + 3] = 255;
    }
    // Scale the cell image up to the canvas without smoothing the cells into mush.
    const tmp = scratch(cols, rows);
    tmp.getContext("2d")!.putImageData(b.img, 0, 0);
    g.imageSmoothingEnabled = true;
    g.drawImage(tmp, 0, 0, w, plotH);
    // The newest row on top as a live trace, so "now" is never lost in the glow.
    const p = hist.physical(hist.size - 1);
    const count = hist.count[p]!;
    const low = hist.lowHz[p]!;
    const bin = hist.binHz[p]!;
    const off = p * hist.width;
    g.beginPath();
    for (let i = 0; i < count; i++) {
      const x = ((low + (i + 0.5) * bin - span.low) / (span.high - span.low)) * w;
      const y = plotH - normaliseDb(hist.data[off + i]!, win.loDb, win.rangeDb) * (plotH - 2);
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.strokeStyle = night ? "rgba(255,140,28,0.85)" : "rgba(235,235,240,0.75)";
    g.lineWidth = dpr;
    g.stroke();
    const [gr, gg, gb, ga] = chrome.gridLine;
    drawAxis(g, w, h, dpr, span.low, span.high, `rgba(${gr},${gg},${gb},${Math.min(1, ga * 4)})`);
  });
  return (
    <canvas
      ref={ref}
      aria-label="Persistence spectrum of the last 30 seconds"
      className={cn("block w-full", className)}
      style={{ height }}
    />
  );
}

let scratchCanvas: HTMLCanvasElement | null = null;
function scratch(w: number, h: number): HTMLCanvasElement {
  if (!scratchCanvas) scratchCanvas = document.createElement("canvas");
  if (scratchCanvas.width !== w) scratchCanvas.width = w;
  if (scratchCanvas.height !== h) scratchCanvas.height = h;
  return scratchCanvas;
}
