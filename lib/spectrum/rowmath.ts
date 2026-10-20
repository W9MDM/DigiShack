// Per-row arithmetic for the Delta and Threshold views: what changed since the last few rows,
// where the noise floor of a row sits, and how many signals stand clear of it.
//
// Kept apart from the canvases so it can be checked without a browser
// (scripts/check-spectrum-view.ts). Nothing here allocates: callers pass the scratch buffers,
// because these run for every new row, several times a second, for as long as a page is open.

import type { ColormapId } from "@/lib/spectrum/colormaps";
import type { SpectrumHistory } from "@/lib/spectrum/history";

/** How many earlier rows a row is compared with. One is too twitchy; more lags a keying signal. */
export const DELTA_DEPTH = 3;
/**
 * The least change drawn as a change. An unaveraged FFT bin of pure noise wanders by several
 * dB from row to row, so the dead-band actually used follows each row's own spread (below);
 * this is the floor it never goes under, which is what a smooth feed like the panadapter gets.
 */
export const DELTA_DEADBAND_DB = 4;
/**
 * The dead-band is this many times the row's median change, between DELTA_DEADBAND_DB and
 * DELTA_DEADBAND_MAX_DB. On the audio feed (one 85 ms FFT per row, about 10 dB of
 * frame-to-frame spread) that lands near 8 dB and keeps about 1% of pure-noise bins lit,
 * against a quarter of them at a fixed 4 dB; a signal keying up 12 dB out of it still lights.
 * The median ignores the bins that really changed as long as they are under half the row.
 */
export const DELTA_SPREAD_FACTOR = 3.5;
/** However busy a row, a change this big always shows. */
export const DELTA_DEADBAND_MAX_DB = 12;
/**
 * Rows this close to an on-air row are drawn flat. Both pages take TX from the bridge's status
 * message on the socket, sent on every change, which can land a frame or two either side of
 * the audio actually going quiet. A caller whose TX flag can lag further must pass a longer
 * `guardMs`, at least its own latency, or the rows before the flag show the whole band dropping.
 */
export const TX_GUARD_MS = 1_000;

/**
 * Delta draws a rise from this colour-map entry up, never dimmer, so a weak rise does not share
 * the dim range a drop's tint lives in.
 */
export const DELTA_RISE_MIN_INDEX = 40;
/** A drop is mixed this far from the background towards its tint: least, and most. */
export const DELTA_DROP_MIN = 0.2;
export const DELTA_DROP_MAX = 0.5;
/**
 * A falling signal by day, per colour map, chosen so every mix between DELTA_DROP_MIN and
 * DELTA_DROP_MAX stays clear of every entry a rise can be drawn in (check:spectrum-view
 * measures it). A light neutral grey ("gone") works for every map with a hue; Grayscale has
 * no hue, so its drops are a blue. At night drops are a dim red hatch instead (no blue then).
 */
export const DELTA_DROP_TINT: Readonly<Record<ColormapId, readonly [number, number, number]>> = {
  digishack: [230, 230, 230],
  viridis: [230, 230, 230],
  inferno: [230, 230, 230],
  magma: [230, 230, 230],
  turbo: [230, 230, 230],
  grayscale: [0, 30, 255],
  night: [230, 230, 230],
};

export const MIN_THRESHOLD_DB = 3;
export const MAX_THRESHOLD_DB = 30;
/**
 * Measured from the row's 25th percentile, which sits a few dB under the noise's median: 12 dB
 * over it keeps about 1% of unaveraged noise bins above the line.
 */
export const DEFAULT_THRESHOLD_DB = 12;
/**
 * Where in a row its noise floor is read: the 25th percentile, as the bridge does for its own
 * floor (lib/radio/spectrum.ts). A median would climb to the signals once they fill half the
 * row, which a busy 20 m FT8 passband does, and then hide most of them.
 */
export const FLOOR_FRACTION = 0.25;
export const THRESHOLD_KEY = "digishack.spectrum.threshold.v1";
/** Rows averaged for the signal count, so noise that pokes above the line once is not counted. */
export const SIGNAL_ROWS = 4;
/** A run of fewer bins than this is a speck, not a signal. */
export const MIN_SIGNAL_BINS = 2;
/** Bucket count for the floor estimate: the wire carries one byte per bin, so 256 is exact. */
export const FLOOR_BUCKETS = 256;

/** Two held rows (physical indices) cover the same bins at the same frequencies. */
export function sameSpan(h: SpectrumHistory, p: number, q: number): boolean {
  return (
    h.count[p] === h.count[q] &&
    h.binHz[p] === h.binHz[q] &&
    Math.abs(h.lowHz[p]! - h.lowHz[q]!) < h.binHz[p]! * 1e-3
  );
}

/** Held row k (oldest first) was taken on the air, or within `guardMs` of a row that was. */
export function nearTransmit(h: SpectrumHistory, k: number, guardMs = TX_GUARD_MS): boolean {
  const p = h.physical(k);
  if (h.tx[p]) return true;
  // Bounded scans: at the panadapter's ten rows a second, a second is ten rows each way.
  for (let j = k - 1, n = 0; j >= 0 && n < 64; j--, n++) {
    const q = h.physical(j);
    if (h.startAt[p]! - h.endAt[q]! > guardMs) break;
    if (h.tx[q]) return true;
  }
  for (let j = k + 1, n = 0; j < h.size && n < 64; j++, n++) {
    const q = h.physical(j);
    if (h.startAt[q]! - h.endAt[p]! > guardMs) break;
    if (h.tx[q]) return true;
  }
  return false;
}

/**
 * The rows held row k may be compared with: up to `depth` rows immediately before it, newest
 * first, as physical indices in `out`. The run stops at the first row that is on another span
 * (a retune), not edge to edge in time (an outage) or on the air, because comparing across any
 * of those lights the whole width for a reason that is not a signal. Returns how many.
 */
export function deltaReferences(h: SpectrumHistory, k: number, depth: number, out: Int32Array): number {
  const p = h.physical(k);
  let later = p;
  let n = 0;
  for (let j = k - 1; j >= 0 && n < depth && n < out.length; j--) {
    const q = h.physical(j);
    if (h.tx[q] || !sameSpan(h, p, q) || h.startAt[later]! - h.endAt[q]! > 1) break;
    out[n++] = q;
    later = q;
  }
  return n;
}

export interface DeltaOptions {
  depth?: number;
  /** A fixed dead-band; by default it follows the row's own spread (see DELTA_SPREAD_FACTOR). */
  deadbandDb?: number;
  /** FLOOR_BUCKETS entries of scratch for the spread estimate; a shared one if not given. */
  buckets?: Int32Array;
  /** A rise counts only if the bin now sits above this, a drop only if it used to. */
  gateDb?: number;
  guardMs?: number;
}

const sharedBuckets = new Int32Array(FLOOR_BUCKETS);

/**
 * How much each bin of held row k changed against the mean (in dB) of the rows before it, with
 * the dead-band taken off: out[b] > 0 rose that many dB beyond it, < 0 fell, 0 held steady.
 * False when the row has nothing fair to be compared with (the first row after a retune, an
 * outage or a transmission, or a row near one): the caller draws that row flat, and `out` is
 * left as it was.
 */
export function rowDelta(
  h: SpectrumHistory,
  k: number,
  out: Float32Array,
  refs: Int32Array,
  opts: DeltaOptions = {},
): boolean {
  const gate = opts.gateDb ?? Number.NEGATIVE_INFINITY;
  if (k < 0 || k >= h.size || nearTransmit(h, k, opts.guardMs ?? TX_GUARD_MS)) return false;
  const n = deltaReferences(h, k, opts.depth ?? DELTA_DEPTH, refs);
  if (n === 0) return false;
  const p = h.physical(k);
  const count = Math.min(h.count[p]!, out.length);
  const w = h.width;
  const d = h.data;
  const cur = p * w;
  // First the raw change of every bin, then the dead-band from how much the row as a whole moved.
  for (let b = 0; b < count; b++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += d[refs[i]! * w + b]!;
    out[b] = d[cur + b]! - sum / n;
  }
  const deadband =
    opts.deadbandDb ??
    Math.max(
      DELTA_DEADBAND_DB,
      Math.min(DELTA_DEADBAND_MAX_DB, DELTA_SPREAD_FACTOR * quantileOf(out, 0, count, opts.buckets ?? sharedBuckets, 0.5, true)),
    );
  for (let b = 0; b < count; b++) {
    const change = out[b]!;
    const now = d[cur + b]!;
    const mean = now - change;
    if (change > deadband && now > gate) out[b] = change - deadband;
    else if (change < -deadband && mean > gate) out[b] = change + deadband;
    else out[b] = 0;
  }
  return true;
}

/**
 * The level `fraction` of the way up `count` values (of their magnitudes when `abs`). Found
 * with a histogram rather than a sort so a 4096-bin row costs two passes; the second returns
 * the lowest value in the chosen bucket, which is exact for 8-bit wire data.
 */
function quantileOf(
  vals: Float32Array,
  offset: number,
  count: number,
  scratch: Int32Array,
  fraction: number,
  abs: boolean,
): number {
  if (count <= 0) return Number.NaN;
  let mn = Number.POSITIVE_INFINITY;
  let mx = Number.NEGATIVE_INFINITY;
  for (let b = 0; b < count; b++) {
    const v = abs ? Math.abs(vals[offset + b]!) : vals[offset + b]!;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  if (!(mx > mn)) return mn;
  const scale = (FLOOR_BUCKETS - 1) / (mx - mn);
  scratch.fill(0, 0, FLOOR_BUCKETS);
  for (let b = 0; b < count; b++) {
    const v = abs ? Math.abs(vals[offset + b]!) : vals[offset + b]!;
    scratch[Math.floor((v - mn) * scale)]! += 1;
  }
  const rank = Math.floor(Math.max(0, Math.min(1, fraction)) * (count - 1));
  let bucket = 0;
  for (let seen = 0; bucket < FLOOR_BUCKETS; bucket++) {
    seen += scratch[bucket]!;
    if (seen > rank) break;
  }
  let lowest = mx;
  for (let b = 0; b < count; b++) {
    const v = abs ? Math.abs(vals[offset + b]!) : vals[offset + b]!;
    if (Math.floor((v - mn) * scale) === bucket && v < lowest) lowest = v;
  }
  return lowest;
}

/**
 * The noise floor of `count` values: the level `fraction` of the way up them, the 25th
 * percentile by default (FLOOR_FRACTION), which stays on the noise until signals fill three
 * quarters of the span. `scratch` needs FLOOR_BUCKETS entries.
 */
export function noiseFloorDb(
  vals: Float32Array,
  offset: number,
  count: number,
  scratch: Int32Array,
  fraction = FLOOR_FRACTION,
): number {
  return quantileOf(vals, offset, count, scratch, fraction, false);
}

/**
 * Signals in a row: runs of bins above `thresholdDb`. A one-bin dip inside a run does not split
 * it (an FT8 signal's tones do not all show in every row), and a run with fewer than `minBins`
 * bins above the line is a speck of noise.
 */
export function countRuns(
  vals: Float32Array,
  offset: number,
  count: number,
  thresholdDb: number,
  minBins = MIN_SIGNAL_BINS,
  bridgeBins = 1,
): number {
  let runs = 0;
  let above = 0;
  let last = Number.NEGATIVE_INFINITY;
  for (let b = 0; b < count; b++) {
    if (!(vals[offset + b]! > thresholdDb)) continue;
    if (b - last - 1 > bridgeBins) {
      if (above >= minBins) runs++;
      above = 0;
    }
    above++;
    last = b;
  }
  if (above >= minBins) runs++;
  return runs;
}

/**
 * The mean (in dB) of the newest `rows` rows that share the newest received row's span, into
 * `out`. Rows taken on the air are skipped: they would drag every bin down to the silence of
 * our own transmission. Returns the number of bins written, 0 when there is nothing to average.
 */
export function recentMean(h: SpectrumHistory, rows: number, out: Float32Array): number {
  let base = -1;
  let used = 0;
  let count = 0;
  for (let k = h.size - 1, scanned = 0; k >= 0 && used < rows && scanned < rows * 8; k--, scanned++) {
    const p = h.physical(k);
    if (h.tx[p]) continue;
    if (base < 0) {
      base = p;
      count = Math.min(h.count[p]!, out.length);
      out.fill(0, 0, count);
    } else if (!sameSpan(h, base, p)) break;
    const o = p * h.width;
    for (let b = 0; b < count; b++) out[b]! += h.data[o + b]!;
    used++;
  }
  if (used === 0) return 0;
  for (let b = 0; b < count; b++) out[b] = out[b]! / used;
  return count;
}

/**
 * How many signals stand more than `thresholdDb` above the noise in the last few rows, or null
 * before there is a row to look at. `mean` needs h.width entries, `buckets` FLOOR_BUCKETS.
 */
export function countSignals(
  h: SpectrumHistory,
  thresholdDb: number,
  mean: Float32Array,
  buckets: Int32Array,
): number | null {
  const n = recentMean(h, SIGNAL_ROWS, mean);
  if (n === 0) return null;
  return countRuns(mean, 0, n, noiseFloorDb(mean, 0, n, buckets) + thresholdDb);
}

/**
 * One row's bins reduced to `cols` columns across spanLow..spanHigh, keeping each column's
 * strongest bin so a narrow carrier survives (-Infinity where no bin lands).
 */
export function columnsMax(
  vals: Float32Array,
  offset: number,
  count: number,
  lowHz: number,
  binHz: number,
  spanLow: number,
  spanHigh: number,
  cols: number,
  out: Float32Array,
): void {
  out.fill(Number.NEGATIVE_INFINITY, 0, cols);
  const scale = cols / (spanHigh - spanLow);
  for (let b = 0; b < count; b++) {
    const c = Math.floor((lowHz + (b + 0.5) * binHz - spanLow) * scale);
    if (c < 0 || c >= cols) continue;
    const v = vals[offset + b]!;
    if (v > out[c]!) out[c] = v;
  }
}

/**
 * Signed changes reduced to columns. A rise anywhere in a column wins over a drop (the new
 * signal is the news); with no rise, the deepest drop shows. 0 where nothing changed.
 */
export function columnsSigned(
  vals: Float32Array,
  count: number,
  lowHz: number,
  binHz: number,
  spanLow: number,
  spanHigh: number,
  cols: number,
  out: Float32Array,
): void {
  out.fill(0, 0, cols);
  const scale = cols / (spanHigh - spanLow);
  for (let b = 0; b < count; b++) {
    const c = Math.floor((lowHz + (b + 0.5) * binHz - spanLow) * scale);
    if (c < 0 || c >= cols) continue;
    const v = vals[b]!;
    const cur = out[c]!;
    if (v > 0 ? v > cur : cur <= 0 && v < cur) out[c] = v;
  }
}

/** A stored or typed threshold, clamped to the slider; anything unreadable is the default. */
export function sanitizeThresholdDb(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  if (!Number.isFinite(n)) return DEFAULT_THRESHOLD_DB;
  return Math.max(MIN_THRESHOLD_DB, Math.min(MAX_THRESHOLD_DB, Math.round(n)));
}

/** Read from storage; blocked or missing storage gives the default. */
export function loadThresholdDb(storage: Pick<Storage, "getItem"> | null | undefined): number {
  try {
    return sanitizeThresholdDb(storage?.getItem(THRESHOLD_KEY) ?? null);
  } catch {
    return DEFAULT_THRESHOLD_DB;
  }
}

export function saveThresholdDb(storage: Pick<Storage, "setItem"> | null | undefined, db: number): void {
  try {
    storage?.setItem(THRESHOLD_KEY, String(sanitizeThresholdDb(db)));
  } catch {
    /* storage full or blocked: the slider still works for this visit */
  }
}
