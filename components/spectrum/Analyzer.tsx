// A spectrum-analyser view: the live trace and a max-hold trace on a real dB scale, markers,
// and a waterfall underneath on the same frequency axis — the layout of an SDR spectrum
// analyser rather than a band scope. Same recorded feed as every other view.
//
// The live trace is the average of the last N rows (trace averaging), in dB. Max-hold keeps the
// highest value each column has reached since it was last reset (or the band moved). Both are
// per pixel column, peak-preserving within a row, so a narrow carrier never averages away
// sideways.

import { useRef, useState } from "react";

import { drawAxis, newestSpan, rgba, useFeedCanvas } from "@/components/spectrum/ClassicViews";
import { useNightMode } from "@/lib/client/use-theme";
import { ANALYZER_Y_AXIS_PX, analyzerLayout, formatReadoutFrequency } from "@/lib/spectrum/axis";
import { colormapChrome, colormapRgb, type ColormapId } from "@/lib/spectrum/colormaps";
import type { SpectrumFeed } from "@/lib/spectrum/feed";
import { displayWindow, normaliseDb, type Contrast } from "@/lib/spectrum/levels";
import { cn } from "@/lib/utils";

const AVERAGING = [1, 3, 5, 10] as const;
const MAX_MARKERS = 4;
const Y_AXIS_PX = ANALYZER_Y_AXIS_PX;
const X_AXIS_PX = 18;

interface Marker {
  hz: number;
}

export function Analyzer({
  feed,
  contrast,
  colormap,
  height,
  className,
}: {
  feed: SpectrumFeed;
  contrast: Contrast;
  colormap: ColormapId;
  /** CSS pixels, or a CSS length such as "100%". */
  height: number | string;
  className?: string;
}) {
  const night = useNightMode();
  const lut = colormapRgb(colormap);
  const chrome = colormapChrome(colormap);
  const [showMax, setShowMax] = useState(true);
  const [showLive, setShowLive] = useState(true);
  const [showMarkers, setShowMarkers] = useState(true);
  const [autoscale, setAutoscale] = useState(false);
  const [avgN, setAvgN] = useState<(typeof AVERAGING)[number]>(5);
  const [markers, setMarkers] = useState<Marker[]>([]);

  // Max-hold and the waterfall image survive across draws; resized or retuned, they restart.
  const state = useRef({
    cols: 0,
    low: 0,
    high: 0,
    maxHold: new Float32Array(0),
    live: new Float32Array(0),
    lastEnd: Number.NEGATIVE_INFINITY,
    img: null as ImageData | null,
    imgW: 0,
    imgH: 0,
    scratch: null as HTMLCanvasElement | null,
    /** Plot geometry from the last draw, for click-to-mark. */
    plotX: 0,
    plotW: 1,
    dpr: 1,
  });
  const resetMax = () => {
    state.current.maxHold.fill(Number.NEGATIVE_INFINITY);
    state.current.lastEnd = Number.NEGATIVE_INFINITY;
  };

  const ref = useFeedCanvas(feed, (g, w, h, dpr) => {
    const st = state.current;
    const bg = chrome.background;
    g.fillStyle = rgba(bg);
    g.fillRect(0, 0, w, h);
    const span = newestSpan(feed);
    const hist = feed.history;
    if (!span || hist.size < 1) return;

    // A phone-width canvas gets more trace and a shorter waterfall strip (see analyzerLayout).
    const layout = analyzerLayout(w / dpr);
    const plotX = Y_AXIS_PX * dpr;
    const plotW = Math.max(16, w - plotX - 4 * dpr);
    const specH = Math.round(h * layout.traceShare);
    const specPlotH = specH - X_AXIS_PX * dpr;
    const wfTop = specH + 2 * dpr;
    const wfH = Math.max(8, h - wfTop - X_AXIS_PX * dpr);
    st.plotX = plotX;
    st.plotW = plotW;
    st.dpr = dpr;

    const cols = Math.max(64, Math.min(2048, Math.floor(plotW)));
    if (st.cols !== cols || Math.abs(st.low - span.low) > 1 || Math.abs(st.high - span.high) > 1) {
      st.cols = cols;
      st.low = span.low;
      st.high = span.high;
      st.maxHold = new Float32Array(cols).fill(Number.NEGATIVE_INFINITY);
      st.live = new Float32Array(cols);
      st.lastEnd = Number.NEGATIVE_INFINITY;
    }
    const colOf = (hz: number) => Math.floor(((hz - span.low) / (span.high - span.low)) * cols);

    // One row reduced to columns, peak-preserving, into `out` (-Infinity where empty).
    const rowInto = (p: number, out: Float32Array) => {
      out.fill(Number.NEGATIVE_INFINITY);
      const count = hist.count[p]!;
      const low = hist.lowHz[p]!;
      const bin = hist.binHz[p]!;
      const off = p * hist.width;
      for (let b = 0; b < count; b++) {
        const c = colOf(low + (b + 0.5) * bin);
        if (c < 0 || c >= cols) continue;
        const v = hist.data[off + b]!;
        if (v > out[c]!) out[c] = v;
      }
    };

    // Live trace: the mean (in dB) of the last N rows.
    const row = new Float32Array(cols);
    st.live.fill(0);
    const n = Math.min(avgN, hist.size);
    for (let k = 0; k < n; k++) {
      rowInto(hist.physical(hist.size - 1 - k), row);
      for (let c = 0; c < cols; c++) st.live[c]! += Number.isFinite(row[c]!) ? row[c]! : (feed.levels.floorDb ?? -120);
    }
    for (let c = 0; c < cols; c++) st.live[c] = st.live[c]! / n;

    // Max-hold: every row newer than the last one folded in.
    for (let k = hist.size - 1; k >= 0; k--) {
      const p = hist.physical(k);
      if (hist.endAt[p]! <= st.lastEnd) break;
      rowInto(p, row);
      for (let c = 0; c < cols; c++) if (row[c]! > st.maxHold[c]!) st.maxHold[c] = row[c]!;
    }
    st.lastEnd = hist.endAt[hist.physical(hist.size - 1)]!;

    // The dB scale: the contrast window, or fitted to what is on screen.
    let lo: number;
    let hi: number;
    const win = displayWindow(feed.levels.floorDb, feed.levels.spanDb, contrast);
    if (autoscale) {
      let mn = Infinity;
      let mx = -Infinity;
      for (let c = 0; c < cols; c++) {
        const v = st.live[c]!;
        if (v < mn) mn = v;
        const m = Math.max(v, st.maxHold[c]!);
        if (m > mx) mx = m;
      }
      lo = Math.floor((mn - 5) / 5) * 5;
      hi = Math.ceil((mx + 5) / 5) * 5;
      if (!(hi > lo)) hi = lo + 10;
    } else {
      lo = win.loDb;
      hi = win.loDb + win.rangeDb;
    }
    const yOf = (db: number) => specPlotH - ((db - lo) / (hi - lo)) * specPlotH;

    // Grid and dB labels.
    const [gr, gg, gb, ga] = chrome.gridLine;
    const grid = `rgba(${gr},${gg},${gb},${ga})`;
    const text = `rgba(${gr},${gg},${gb},${Math.min(1, ga * 4)})`;
    g.strokeStyle = grid;
    g.lineWidth = 1;
    g.fillStyle = text;
    g.font = `${11 * dpr}px ui-sans-serif, system-ui, sans-serif`;
    g.textBaseline = "middle";
    const stepDb = niceDbStep(hi - lo);
    // Narrow: the labels sit against the plot, right-aligned, leaving the gutter's left edge
    // to the rotated unit title. Left-aligned at 4px they ran under it ("dB-55").
    g.textAlign = layout.tickAlign;
    for (let d = Math.ceil(lo / stepDb) * stepDb; d <= hi; d += stepDb) {
      const y = Math.round(yOf(d)) + 0.5;
      g.beginPath();
      g.moveTo(plotX, y);
      g.lineTo(plotX + plotW, y);
      g.stroke();
      g.fillText(`${Math.round(d)}`, layout.tickX * dpr, y);
    }
    // drawAxis and the marker labels measure from the left edge.
    g.textAlign = "left";
    g.save();
    g.translate(layout.titleX * dpr, specPlotH / 2);
    g.rotate(-Math.PI / 2);
    g.textAlign = "center";
    g.fillText(feed.kind === "rf" && feed.info.calibrated ? "dBm" : "dB", 0, -2 * dpr);
    g.restore();

    const trace = (vals: Float32Array, color: string, width: number) => {
      g.beginPath();
      let started = false;
      for (let c = 0; c < cols; c++) {
        const v = vals[c]!;
        if (!Number.isFinite(v)) continue;
        const x = plotX + ((c + 0.5) / cols) * plotW;
        const y = Math.max(0, Math.min(specPlotH, yOf(v)));
        if (!started) {
          g.moveTo(x, y);
          started = true;
        } else g.lineTo(x, y);
      }
      g.strokeStyle = color;
      g.lineWidth = width;
      g.stroke();
    };
    g.save();
    g.beginPath();
    g.rect(plotX, 0, plotW, specPlotH);
    g.clip();
    if (showMax) trace(st.maxHold, night ? "rgba(255,40,0,0.9)" : "rgba(235,60,50,0.9)", dpr);
    if (showLive) trace(st.live, night ? "rgba(255,150,30,0.95)" : "rgba(70,200,90,0.95)", dpr * 1.2);

    // Markers on the live trace.
    if (showMarkers) {
      g.textBaseline = "bottom";
      for (const [i, m] of markers.entries()) {
        const c = colOf(m.hz);
        if (c < 0 || c >= cols) continue;
        const x = plotX + ((c + 0.5) / cols) * plotW;
        const v = st.live[c]!;
        const y = yOf(v);
        g.fillStyle = night ? "rgb(255,170,0)" : "rgb(255,190,40)";
        g.beginPath();
        g.arc(x, y, 3.5 * dpr, 0, Math.PI * 2);
        g.fill();
        const label = `M${i + 1} ${formatReadoutFrequency(m.hz, feed.kind === "rf")} · ${v.toFixed(1)}`;
        const tw = g.measureText(label).width;
        g.fillText(label, Math.min(plotX + plotW - tw - 2, Math.max(plotX + 2, x - tw / 2)), Math.max(12 * dpr, y - 6 * dpr));
      }
    }
    g.restore();
    g.save();
    g.translate(plotX, 0);
    drawAxis(g, plotW, specH, dpr, span.low, span.high, text);
    g.restore();

    // The waterfall, newest at the top, one image row per held row (most recent wfRows).
    const wfRows = Math.max(8, Math.floor(wfH / dpr));
    if (!st.img || st.imgW !== cols || st.imgH !== wfRows) {
      st.img = g.createImageData(cols, wfRows);
      st.imgW = cols;
      st.imgH = wfRows;
    }
    const px = st.img.data;
    for (let r = 0; r < wfRows; r++) {
      const k = hist.size - 1 - r;
      if (k < 0) {
        for (let c = 0; c < cols; c++) {
          const j = (r * cols + c) * 4;
          px[j] = bg[0];
          px[j + 1] = bg[1];
          px[j + 2] = bg[2];
          px[j + 3] = 255;
        }
        continue;
      }
      rowInto(hist.physical(k), row);
      for (let c = 0; c < cols; c++) {
        const v = row[c]!;
        const t = Number.isFinite(v) ? normaliseDb(v, win.loDb, win.rangeDb) : 0;
        const li = Math.round(t * 255) * 3;
        const j = (r * cols + c) * 4;
        px[j] = lut[li]!;
        px[j + 1] = lut[li + 1]!;
        px[j + 2] = lut[li + 2]!;
        px[j + 3] = 255;
      }
    }
    if (!st.scratch) st.scratch = document.createElement("canvas");
    const sc = st.scratch;
    if (sc.width !== cols) sc.width = cols;
    if (sc.height !== wfRows) sc.height = wfRows;
    sc.getContext("2d")!.putImageData(st.img, 0, 0);
    g.imageSmoothingEnabled = false;
    g.drawImage(sc, plotX, wfTop, plotW, wfH);
    g.save();
    g.translate(plotX, 0);
    drawAxis(g, plotW, wfTop + wfH + X_AXIS_PX * dpr, dpr, span.low, span.high, text);
    g.restore();
  });

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const st = state.current;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) * st.dpr;
    const frac = (x - st.plotX) / st.plotW;
    if (frac < 0 || frac > 1 || st.high <= st.low) return;
    const hz = st.low + frac * (st.high - st.low);
    setMarkers((m) => [...m, { hz }].slice(-MAX_MARKERS));
    setShowMarkers(true);
  };

  const box = "inline-flex items-center gap-1.5 cursor-pointer select-none";
  // Below sm the two buttons can't join the Autoscale / Averaging row (it is too narrow for
  // all four), so they take a row of their own, full width and split evenly, instead of
  // wrapping alone against the right edge.
  const action = "rounded-sm border border-line px-2 py-0.5 hover:bg-surface-2 hover:text-fg max-sm:min-h-9 max-sm:flex-1 max-sm:px-3";
  return (
    <div className={cn("flex flex-col", className)} style={{ height }}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line px-2 py-1 text-xs text-fg-muted max-sm:gap-y-2">
        <label className={box}>
          <input type="checkbox" checked={showMax} onChange={(e) => setShowMax(e.target.checked)} className="accent-accent" />
          <span className="text-danger">Max trace</span>
        </label>
        <label className={box}>
          <input type="checkbox" checked={showLive} onChange={(e) => setShowLive(e.target.checked)} className="accent-accent" />
          <span className={night ? "text-warn" : "text-ok"}>Live trace</span>
        </label>
        <label className={box}>
          <input type="checkbox" checked={showMarkers} onChange={(e) => setShowMarkers(e.target.checked)} className="accent-accent" />
          Markers
        </label>
        <label className={box}>
          <input type="checkbox" checked={autoscale} onChange={(e) => setAutoscale(e.target.checked)} className="accent-accent" />
          Autoscale
        </label>
        <label className="inline-flex items-center gap-1.5">
          Averaging
          <select
            value={avgN}
            onChange={(e) => setAvgN(Number(e.target.value) as (typeof AVERAGING)[number])}
            className="rounded-sm border border-line bg-surface px-1 py-0.5 text-xs text-fg max-sm:min-h-9 max-sm:px-2"
          >
            {AVERAGING.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <span className="ml-auto flex items-center gap-2 max-sm:ml-0 max-sm:w-full">
          <button type="button" onClick={resetMax} className={action}>
            Reset max
          </button>
          <button
            type="button"
            onClick={() => setMarkers([])}
            disabled={markers.length === 0}
            className={cn(action, "disabled:opacity-40")}
          >
            Clear markers
          </button>
        </span>
      </div>
      <canvas
        ref={ref}
        onClick={onClick}
        title="Click to drop a marker"
        aria-label="Spectrum analyser: live and max-hold traces with a waterfall"
        className="block min-h-0 w-full flex-1 cursor-crosshair"
      />
    </div>
  );
}

function niceDbStep(range: number): number {
  for (const s of [5, 10, 20]) if (range / s <= 8) return s;
  return 20;
}
