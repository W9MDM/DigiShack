// Two waterfalls that hide what is not news, after the Delta and Threshold tabs of a bench
// spectrum analyser. Same recorded feed and frequency axis as every other view, newest row at
// the top:
//
//   Delta — each pixel is how much that frequency CHANGED against the few rows before it, not
//   how strong it is. Steady carriers, birdies and the noise floor go dark; a signal keying up
//   lights in the colour map, and one ending shows as a quieter tint so it is visible without
//   competing. On FT8 every slot boundary flashes that slot's new transmitters.
//
//   Threshold — everything less than T dB above the row's own noise floor is drawn flat, so
//   only real signals show, with a live count of them.
//
// The arithmetic is in lib/spectrum/rowmath.ts. Both views paint only the rows that are new
// since the last draw and shift the rest down in place, so a draw costs a few rows of work,
// not the whole picture; the image and every scratch buffer are reused.

import { useEffect, useRef, useState } from "react";

import { drawAxis, newestSpan, rgba, useFeedCanvas, type ClassicViewProps } from "@/components/spectrum/ClassicViews";
import { useNightMode } from "@/lib/client/use-theme";
import { colormapChrome, colormapRgb } from "@/lib/spectrum/colormaps";
import type { SpectrumFeed } from "@/lib/spectrum/feed";
import { displayWindow } from "@/lib/spectrum/levels";
import {
  columnsMax,
  columnsSigned,
  countSignals,
  DEFAULT_THRESHOLD_DB,
  DELTA_DEPTH,
  DELTA_DROP_MAX,
  DELTA_DROP_MIN,
  DELTA_DROP_TINT,
  DELTA_RISE_MIN_INDEX,
  FLOOR_BUCKETS,
  loadThresholdDb,
  MAX_THRESHOLD_DB,
  MIN_THRESHOLD_DB,
  noiseFloorDb,
  rowDelta,
  saveThresholdDb,
  TX_GUARD_MS,
} from "@/lib/spectrum/rowmath";
import { cn } from "@/lib/utils";

const AXIS_PX = 18;
/**
 * At night no blue is allowed, and a red would sit inside Night red's own range, so a drop is
 * a dim red on alternate pixels: the texture, not the hue, reads as "gone". By day the tint is
 * per colour map (DELTA_DROP_TINT), clear of every colour a rise can take.
 */
const DROP_NIGHT: readonly [number, number, number] = [200, 40, 0];
/** Threshold: the lowest colour-map entry a bin above the line gets, so it never reads as background. */
const ABOVE_MIN_INDEX = 64;

type Rgb = readonly [number, number, number];
type Span = { low: number; high: number };

/** The waterfall image and where it stopped, kept across draws. */
interface RowImage {
  img: ImageData | null;
  scratch: HTMLCanvasElement | null;
  cols: number;
  rows: number;
  seq: number;
  epoch: number;
  key: string;
  low: number;
  high: number;
  /** One row reduced to columns. */
  colBuf: Float32Array;
}

function newRowImage(): RowImage {
  return {
    img: null,
    scratch: null,
    cols: 0,
    rows: 0,
    seq: 0,
    epoch: -1,
    key: "",
    low: 0,
    high: 0,
    colBuf: new Float32Array(0),
  };
}

function fillRow(px: Uint8ClampedArray, r: number, cols: number, c: Rgb) {
  for (let i = r * cols * 4, end = i + cols * 4; i < end; i += 4) {
    px[i] = c[0];
    px[i + 1] = c[1];
    px[i + 2] = c[2];
    px[i + 3] = 255;
  }
}

/**
 * One image row per held row, newest at the top. Only the rows new since the last draw are
 * painted, plus the `refresh` newest ones (the newest row may have absorbed merged frames, and
 * Delta's rows next to a transmission can change their mind); the rest are moved down. A new
 * size, axis, timeline or `key` (the settings the pixels depend on) repaints everything.
 */
function paintWaterfall(
  g: CanvasRenderingContext2D,
  w: number,
  h: number,
  dpr: number,
  feed: SpectrumFeed,
  st: RowImage,
  key: string,
  bg: Rgb,
  text: string,
  refresh: number,
  paintRow: (k: number, px: Uint8ClampedArray, r: number, cols: number, span: Span) => void,
): void {
  g.fillStyle = rgba(bg);
  g.fillRect(0, 0, w, h);
  const span = newestSpan(feed);
  const hist = feed.history;
  if (!span || hist.size === 0) return;
  const plotH = Math.max(8, h - AXIS_PX * dpr);
  // No more columns than the newest row has bins: an empty column would be a dark stripe.
  const bins = hist.count[hist.physical(hist.size - 1)]!;
  const cols = Math.max(16, Math.min(2048, Math.floor(w), bins));
  const rows = Math.max(8, Math.floor(plotH / dpr));
  const fresh = hist.seq - st.seq;
  const full =
    !st.img ||
    st.cols !== cols ||
    st.rows !== rows ||
    st.epoch !== hist.epoch ||
    st.key !== key ||
    st.low !== span.low ||
    st.high !== span.high ||
    fresh < 0 ||
    fresh >= rows;
  if (!st.img || st.cols !== cols || st.rows !== rows) {
    st.img = g.createImageData(cols, rows);
    st.cols = cols;
    st.rows = rows;
  }
  if (st.colBuf.length < cols) st.colBuf = new Float32Array(cols);
  const px = st.img.data;
  let redo = rows;
  if (!full) {
    if (fresh > 0) px.copyWithin(fresh * cols * 4, 0, (rows - fresh) * cols * 4);
    redo = Math.min(rows, fresh + refresh);
  }
  for (let r = 0; r < redo; r++) {
    const k = hist.size - 1 - r;
    if (k < 0) fillRow(px, r, cols, bg);
    else paintRow(k, px, r, cols, span);
  }
  st.seq = hist.seq;
  st.epoch = hist.epoch;
  st.key = key;
  st.low = span.low;
  st.high = span.high;

  if (!st.scratch) st.scratch = document.createElement("canvas");
  const sc = st.scratch;
  if (sc.width !== cols) sc.width = cols;
  if (sc.height !== rows) sc.height = rows;
  sc.getContext("2d")!.putImageData(st.img, 0, 0);
  g.imageSmoothingEnabled = false;
  g.drawImage(sc, 0, 0, w, plotH);
  drawAxis(g, w, h, dpr, span.low, span.high, text);
}

/** What changed since the last few rows: rises in the colour map, drops as a dim tint. */
export function Delta({ feed, contrast, colormap, height, className }: ClassicViewProps) {
  const night = useNightMode();
  const lut = colormapRgb(colormap);
  const chrome = colormapChrome(colormap);
  const state = useRef({
    image: newRowImage(),
    delta: new Float32Array(0),
    refs: new Int32Array(DELTA_DEPTH),
    buckets: new Int32Array(FLOOR_BUCKETS),
  });
  // The settings the pixels depend on: a change repaints at once, even with the feed stalled.
  const key = `${colormap}|${night}|${contrast.floorOffsetDb}|${contrast.rangeDb}`;
  const ref = useFeedCanvas(feed, (g, w, h, dpr) => {
    const st = state.current;
    const hist = feed.history;
    const bg = chrome.background;
    const [gr, gg, gb, ga] = chrome.gridLine;
    const text = `rgba(${gr},${gg},${gb},${Math.min(1, ga * 4)})`;
    if (st.delta.length < hist.width) st.delta = new Float32Array(hist.width);
    const win = displayWindow(feed.levels.floorDb, feed.levels.spanDb, contrast);
    // Half the contrast range of change reaches the top of the map: a signal keying up 20 dB
    // out of the noise is full brightness at the default 40 dB window.
    const fullScale = Math.max(6, Math.min(40, win.rangeDb / 2));
    const drop = night ? DROP_NIGHT : DELTA_DROP_TINT[colormap];
    // A row arriving on the air flattens the rows just before it, so repaint that far back.
    let refresh = 1;
    if (hist.size > 0) {
      const newestStart = hist.startAt[hist.physical(hist.size - 1)]!;
      for (let k = hist.size - 2; k >= 0 && refresh < 64; k--) {
        if (newestStart - hist.endAt[hist.physical(k)]! > TX_GUARD_MS) break;
        refresh++;
      }
    }
    paintWaterfall(g, w, h, dpr, feed, st.image, key, bg, text, refresh, (k, px, r, cols, span) => {
      // The contrast floor gates what may light: a change wholly below it is noise.
      if (!rowDelta(hist, k, st.delta, st.refs, { gateDb: win.loDb, buckets: st.buckets })) {
        fillRow(px, r, cols, bg);
        return;
      }
      const p = hist.physical(k);
      const col = st.image.colBuf;
      columnsSigned(st.delta, hist.count[p]!, hist.lowHz[p]!, hist.binHz[p]!, span.low, span.high, cols, col);
      // The hatch follows the history row, not the image row: older rows are moved down without
      // being repainted, and a phase tied to the image row would turn the hatch into stripes.
      const phase = hist.seq - hist.size + k;
      for (let c = 0; c < cols; c++) {
        const v = col[c]!;
        const j = (r * cols + c) * 4;
        if (v > 0) {
          const t = Math.min(1, v / fullScale);
          const li = (DELTA_RISE_MIN_INDEX + Math.round(t * (255 - DELTA_RISE_MIN_INDEX))) * 3;
          px[j] = lut[li]!;
          px[j + 1] = lut[li + 1]!;
          px[j + 2] = lut[li + 2]!;
        } else if (v < 0 && !(night && (phase + c) & 1)) {
          const m = DELTA_DROP_MIN + Math.min(1, -v / fullScale) * (DELTA_DROP_MAX - DELTA_DROP_MIN);
          px[j] = bg[0] + (drop[0] - bg[0]) * m;
          px[j + 1] = bg[1] + (drop[1] - bg[1]) * m;
          px[j + 2] = bg[2] + (drop[2] - bg[2]) * m;
        } else {
          px[j] = bg[0];
          px[j + 1] = bg[1];
          px[j + 2] = bg[2];
        }
        px[j + 3] = 255;
      }
    });
  }, key);
  return (
    <canvas
      ref={ref}
      aria-label="Delta waterfall: how much each frequency changed against the last few rows"
      className={cn("block w-full", className)}
      style={{ height }}
    />
  );
}

/** Only what stands more than T dB above each row's noise floor, with a count of signals. */
export function Threshold({ feed, contrast, colormap, height, className }: ClassicViewProps) {
  const night = useNightMode();
  const lut = colormapRgb(colormap);
  const chrome = colormapChrome(colormap);
  const [thresholdDb, setThresholdDb] = useState(DEFAULT_THRESHOLD_DB);
  useEffect(() => {
    try {
      setThresholdDb(loadThresholdDb(window.localStorage));
    } catch {
      /* storage blocked: the default it is */
    }
  }, []);
  const choose = (db: number) => {
    setThresholdDb(db);
    try {
      saveThresholdDb(window.localStorage, db);
    } catch {
      /* remembered for this page view only */
    }
  };

  // Written straight into the DOM from the draw: a count that changes five times a second
  // is not worth re-rendering the toolbar for.
  const countRef = useRef<HTMLSpanElement>(null);
  const state = useRef({
    image: newRowImage(),
    buckets: new Int32Array(FLOOR_BUCKETS),
    mean: new Float32Array(0),
    shown: "",
  });
  // The settings the pixels depend on: moving the slider repaints at once, even with the feed
  // stalled, so the picture and the count never disagree with the label.
  const key = `${colormap}|${night}|${thresholdDb}|${contrast.rangeDb}`;
  const ref = useFeedCanvas(feed, (g, w, h, dpr) => {
    const st = state.current;
    const hist = feed.history;
    const bg = chrome.background;
    const [gr, gg, gb, ga] = chrome.gridLine;
    const text = `rgba(${gr},${gg},${gb},${Math.min(1, ga * 4)})`;
    // Above the line, the contrast range sets how many dB reach the top of the map.
    const range = displayWindow(feed.levels.floorDb, feed.levels.spanDb, contrast).rangeDb;
    paintWaterfall(g, w, h, dpr, feed, st.image, key, bg, text, 1, (k, px, r, cols, span) => {
      const p = hist.physical(k);
      const off = p * hist.width;
      const count = hist.count[p]!;
      const line = noiseFloorDb(hist.data, off, count, st.buckets) + thresholdDb;
      const col = st.image.colBuf;
      columnsMax(hist.data, off, count, hist.lowHz[p]!, hist.binHz[p]!, span.low, span.high, cols, col);
      for (let c = 0; c < cols; c++) {
        const v = col[c]!;
        const j = (r * cols + c) * 4;
        if (v > line) {
          const t = Math.min(1, (v - line) / range);
          const li = (ABOVE_MIN_INDEX + Math.round(t * (255 - ABOVE_MIN_INDEX))) * 3;
          px[j] = lut[li]!;
          px[j + 1] = lut[li + 1]!;
          px[j + 2] = lut[li + 2]!;
        } else {
          px[j] = bg[0];
          px[j + 1] = bg[1];
          px[j + 2] = bg[2];
        }
        px[j + 3] = 255;
      }
    });
    if (st.mean.length < hist.width) st.mean = new Float32Array(hist.width);
    const n = hist.size > 0 ? countSignals(hist, thresholdDb, st.mean, st.buckets) : null;
    const label = n === null ? "—" : `${n} signal${n === 1 ? "" : "s"}`;
    if (label !== st.shown && countRef.current) {
      countRef.current.textContent = label;
      st.shown = label;
    }
  }, key);
  return (
    <div className={cn("flex flex-col", className)} style={{ height }}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line px-2 py-1 text-xs text-fg-muted">
        <label className="inline-flex items-center gap-1.5">
          <span className="tnum">Threshold {thresholdDb} dB</span>
          <input
            type="range"
            min={MIN_THRESHOLD_DB}
            max={MAX_THRESHOLD_DB}
            step={1}
            value={thresholdDb}
            onChange={(e) => choose(Number(e.target.value))}
            className="w-28 accent-accent"
            aria-label="How many dB above the noise floor a signal must be to be drawn"
          />
        </label>
        <span ref={countRef} className="ml-auto tnum text-fg" title="Signals above the threshold over the last second or so" />
      </div>
      <canvas
        ref={ref}
        aria-label="Threshold waterfall: only signals above the set level over the noise floor"
        className="block min-h-0 w-full flex-1"
      />
    </div>
  );
}
