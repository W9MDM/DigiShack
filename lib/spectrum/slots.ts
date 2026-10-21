// The Slot view's arithmetic: the recorded feed folded on the mode's T/R period, so FT8's
// even and odd cycles each get a picture of their own, and the clearest place to transmit in
// the cycle we transmit in.
//
// A slot is one T/R period on the UTC grid, index floor(utc / period), even or odd by that
// index — the same rule the QSO controller keys by (services/radio/qso-controller.ts). Within
// a slot, each frequency cell (50 Hz, one FT8 signal wide) gets how far it stood above the
// noise, averaged over the slot's rows; rows taken on the air, or close to it, are left out so
// our own transmission never reads as a slot full of silence or of signals.
//
// Kept apart from the canvas so it can be checked without a browser
// (scripts/check-spectrum-view.ts). Display only: nothing here sets a transmit frequency.

import type { SpectrumHistory } from "@/lib/spectrum/history";
import { FLOOR_BUCKETS, nearTransmit, noiseFloorDb } from "@/lib/spectrum/rowmath";

/** One cell: an FT8 signal's eight tones 6.25 Hz apart. */
export const SLOT_CELL_HZ = 50;
/**
 * At most this many cells across the span. The audio passband is 60; an RF panadapter's
 * 200 kHz would be 4000, so there the cells double in width until they fit (the view is meant
 * for the audio feed, and on RF it only has to stay cheap).
 */
export const MAX_SLOT_CELLS = 256;
/** Where the clearest-frequency hint looks: the passband a transmitter can actually use. */
export const CLEAR_LOW_HZ = 200;
export const CLEAR_HIGH_HZ = 2800;
/** FT8's period, when the feed does not say. */
export const DEFAULT_PERIOD_MS = 15_000;
/**
 * A cell counts as occupied in a slot when its mean over the slot stands this far above that
 * slot's quiet cells. Averaging over a whole slot's rows takes most of the noise's spread out;
 * an FT8 signal that decodes stands well clear of 4 dB.
 */
export const OCCUPIED_DB = 4;
/**
 * A 100 Hz clear run is taken over a single clearer 50 Hz cell when it is no more than this
 * much busier (a fraction of the shown slots): one slot in ten.
 */
export const RUN_SLACK = 0.1;

export const SLOT_COUNT_CHOICES = [6, 10, 20] as const;
export const DEFAULT_SLOT_COUNT = 10;
export const SLOTS_KEY = "digishack.spectrum.slots.v1";

/** The T/R period to fold on: the feed's own, else by mode (FT4 7.5 s), else FT8's 15 s. */
export function slotPeriodMs(mode: string | null | undefined, periodMs: number | null | undefined): number {
  if (typeof periodMs === "number" && Number.isFinite(periodMs) && periodMs >= 1_000) return periodMs;
  const m = (mode ?? "").toUpperCase();
  if (m === "FT4") return 7_500;
  return DEFAULT_PERIOD_MS;
}

/** The slot a UTC instant falls in. A boundary instant starts the new slot. */
export function slotIndex(utcMs: number, periodMs: number): number {
  return Math.floor(utcMs / periodMs);
}

/** 0 for an even slot, 1 for an odd one (also for a negative index). */
export function slotParity(index: number): 0 | 1 {
  return (((index % 2) + 2) % 2) as 0 | 1;
}

/**
 * The slot a held row (physical index) belongs to, by its midpoint. A row covers
 * (startAt, endAt], so one ending exactly on a boundary is the earlier slot's; one straddling a
 * boundary goes where most of it is. `offsetMs` turns the bridge's row clock into UTC (the
 * bridge's own measured correction, lib/time/clock.ts).
 */
export function rowSlot(h: SpectrumHistory, p: number, periodMs: number, offsetMs = 0): number {
  return slotIndex((h.startAt[p]! + h.endAt[p]!) / 2 + offsetMs, periodMs);
}

/** The frequency cells across a span, on a grid of whole cells from 0 Hz. */
export interface CellGrid {
  lowHz: number;
  cellHz: number;
  cells: number;
}

export function cellGrid(spanLow: number, spanHigh: number, maxCells = MAX_SLOT_CELLS): CellGrid {
  let cellHz = SLOT_CELL_HZ;
  const width = Math.max(1, spanHigh - spanLow);
  while (width / cellHz > maxCells) cellHz *= 2;
  const lowHz = Math.floor(spanLow / cellHz) * cellHz;
  return { lowHz, cellHz, cells: Math.max(1, Math.ceil((spanHigh - lowHz) / cellHz)) };
}

/**
 * One held row (physical index p) on the cell grid: each cell's strongest bin, in dB above the
 * row's own noise floor (its 25th percentile, as Threshold reads it), into out[off..off+cells).
 * The strongest, not the mean: an FT8 signal has one tone of eight on at a time, and a mean over
 * the cell would bury it. NaN where none of the row's bins land.
 */
export function rowCells(h: SpectrumHistory, p: number, grid: CellGrid, out: Float32Array, off: number, buckets: Int32Array): void {
  out.fill(Number.NaN, off, off + grid.cells);
  const count = h.count[p]!;
  if (count <= 0) return;
  const base = p * h.width;
  const floor = noiseFloorDb(h.data, base, count, buckets);
  const low = h.lowHz[p]!;
  const bin = h.binHz[p]!;
  for (let b = 0; b < count; b++) {
    const c = Math.floor((low + (b + 0.5) * bin - grid.lowHz) / grid.cellHz);
    if (c < 0 || c >= grid.cells) continue;
    const v = h.data[base + b]! - floor;
    const j = off + c;
    // NaN fails every comparison, so the first bin in a cell always lands.
    if (!(v <= out[j]!)) out[j] = v;
  }
}

/** The history folded into slots: what the view draws. */
export interface SlotFold {
  grid: CellGrid;
  /** Slots shown per parity. */
  slots: number;
  periodMs: number;
  /** Slot index of the newest row, or NaN with nothing held. */
  newest: number;
  /** Slot index at [parity * slots + s], s = 0 the newest slot of that parity. */
  index: Float64Array;
  /** Rows that went into each slot (on-air rows left out). 0 = no data. */
  rows: Int32Array;
  /**
   * dB each cell stood above the slot's quiet cells (its 25th percentile), at
   * [(parity * slots + s) * cells + c]; never below 0. NaN where the slot has no data there.
   */
  level: Float32Array;
}

export interface FoldOptions {
  periodMs: number;
  slots: number;
  spanLow: number;
  spanHigh: number;
  /** Bridge clock to UTC, ms. */
  offsetMs?: number;
  /** For nearTransmit. */
  guardMs?: number;
}

/**
 * Folds a history into slots. Each row's cells are kept between calls (rows do not change once
 * written, except the newest absorbing a merged frame, which is caught by its end time), so a
 * call costs one pass over the rows in the shown slots, not a re-read of every bin.
 */
export class SlotFolder {
  readonly fold: SlotFold = {
    grid: { lowHz: 0, cellHz: SLOT_CELL_HZ, cells: 0 },
    slots: 0,
    periodMs: DEFAULT_PERIOD_MS,
    newest: Number.NaN,
    index: new Float64Array(0),
    rows: new Int32Array(0),
    level: new Float32Array(0),
  };
  private cache = new Float32Array(0);
  /** Row sequence number each cache line was computed for (-1 none), and its end time then. */
  private cacheSeq = new Float64Array(0);
  private cacheEnd = new Float64Array(0);
  private cacheKey = "";
  private sums = new Float64Array(0);
  private counts = new Int32Array(0);
  private quiet = new Float32Array(0);
  private readonly buckets = new Int32Array(FLOOR_BUCKETS);

  update(h: SpectrumHistory, o: FoldOptions): SlotFold {
    const f = this.fold;
    const slots = Math.max(1, Math.floor(o.slots));
    const grid = cellGrid(o.spanLow, o.spanHigh);
    const cells = grid.cells;
    f.grid = grid;
    f.slots = slots;
    f.periodMs = o.periodMs;
    const n = 2 * slots;
    if (f.index.length !== n) {
      f.index = new Float64Array(n);
      f.rows = new Int32Array(n);
    }
    if (f.level.length !== n * cells) {
      f.level = new Float32Array(n * cells);
      this.sums = new Float64Array(n * cells);
      this.counts = new Int32Array(n * cells);
    }
    if (this.quiet.length < cells) this.quiet = new Float32Array(cells);
    f.rows.fill(0);
    f.level.fill(Number.NaN);
    if (h.size === 0 || h.capacity === 0) {
      f.newest = Number.NaN;
      f.index.fill(Number.NaN);
      return f;
    }

    // A new timeline, ring or grid invalidates every cached row.
    const key = `${h.epoch}|${h.capacity}|${grid.lowHz}|${grid.cellHz}|${cells}`;
    if (key !== this.cacheKey) {
      this.cacheKey = key;
      if (this.cache.length !== h.capacity * cells) this.cache = new Float32Array(h.capacity * cells);
      if (this.cacheSeq.length !== h.capacity) {
        this.cacheSeq = new Float64Array(h.capacity);
        this.cacheEnd = new Float64Array(h.capacity);
      }
      this.cacheSeq.fill(-1);
    }

    const offset = o.offsetMs ?? 0;
    const period = o.periodMs;
    const newest = rowSlot(h, h.physical(h.size - 1), period, offset);
    f.newest = newest;
    // The newest slot of each parity: the current one, or the one just before it.
    const top0 = slotParity(newest) === 0 ? newest : newest - 1;
    const top1 = slotParity(newest) === 1 ? newest : newest - 1;
    for (let s = 0; s < slots; s++) {
      f.index[s] = top0 - 2 * s;
      f.index[slots + s] = top1 - 2 * s;
    }
    const oldest = Math.min(top0, top1) - 2 * (slots - 1);

    const sums = this.sums;
    const counts = this.counts;
    sums.fill(0);
    counts.fill(0);
    const firstSeq = h.seq - h.size;
    // Newest first; rows are in time order, so the first row older than the oldest slot ends it.
    for (let k = h.size - 1; k >= 0; k--) {
      const p = h.physical(k);
      const slot = rowSlot(h, p, period, offset);
      if (slot < oldest) break;
      if (h.tx[p] || nearTransmit(h, k, o.guardMs)) continue;
      const q = slotParity(slot);
      const s = ((q === 0 ? top0 : top1) - slot) / 2;
      if (s < 0 || s >= slots) continue;
      const line = p * cells;
      const seq = firstSeq + k;
      if (this.cacheSeq[p] !== seq || this.cacheEnd[p] !== h.endAt[p]) {
        rowCells(h, p, grid, this.cache, line, this.buckets);
        this.cacheSeq[p] = seq;
        this.cacheEnd[p] = h.endAt[p]!;
      }
      const at = (q * slots + s) * cells;
      for (let c = 0; c < cells; c++) {
        const v = this.cache[line + c]!;
        if (Number.isNaN(v)) continue;
        sums[at + c]! += v;
        counts[at + c]! += 1;
      }
      f.rows[q * slots + s]! += 1;
    }

    // Mean per cell, then measured from the slot's own quiet cells, so the noise's own lift
    // (the strongest of several noise bins sits a few dB over the floor) reads as zero.
    const quiet = this.quiet;
    for (let i = 0; i < n; i++) {
      if (f.rows[i] === 0) continue;
      const at = i * cells;
      let m = 0;
      for (let c = 0; c < cells; c++) {
        if (counts[at + c]! > 0) {
          const v = sums[at + c]! / counts[at + c]!;
          f.level[at + c] = v;
          quiet[m++] = v;
        }
      }
      if (m === 0) continue;
      const base = noiseFloorDb(quiet, 0, m, this.buckets);
      for (let c = 0; c < cells; c++) {
        const v = f.level[at + c]!;
        if (!Number.isNaN(v)) f.level[at + c] = Math.max(0, v - base);
      }
    }
    return f;
  }
}

/**
 * Per cell, the fraction of the shown slots of the given parities (those with data there) in
 * which it was occupied, into `occ`, and its mean level over them into `mean`. NaN where no
 * slot has data.
 */
export function occupancy(
  fold: SlotFold,
  parities: readonly (0 | 1)[],
  occ: Float32Array,
  mean: Float32Array,
  thresholdDb = OCCUPIED_DB,
): void {
  const { cells } = fold.grid;
  for (let c = 0; c < cells; c++) {
    let seen = 0;
    let hits = 0;
    let sum = 0;
    for (const q of parities) {
      for (let s = 0; s < fold.slots; s++) {
        const i = q * fold.slots + s;
        if (fold.rows[i] === 0) continue;
        const v = fold.level[i * cells + c]!;
        if (Number.isNaN(v)) continue;
        seen++;
        sum += v;
        if (v >= thresholdDb) hits++;
      }
    }
    occ[c] = seen > 0 ? hits / seen : Number.NaN;
    mean[c] = seen > 0 ? sum / seen : Number.NaN;
  }
}

export interface ClearGap {
  /** The clear stretch marked, Hz: 100 Hz when a run was found, one cell when not. */
  lowHz: number;
  highHz: number;
  /** The transmit offset (lowest tone, as WSJT-X sets it) that centres a signal in the gap. */
  offsetHz: number;
  /** Fraction of the shown slots its busier cell was occupied in. */
  occupancy: number;
}

/**
 * The clearest place within lowHz..highHz: the cells with the lowest occupancy, preferring two
 * side by side (100 Hz, room for a 50 Hz signal and its drift) unless that run is more than
 * RUN_SLACK busier than the clearest single cell. Among equally clear runs the longest wins
 * and its middle is marked, the most distance from both neighbours; then the quieter (by mean
 * level); then the lower. Only whole cells inside the edges count. Null with no data there.
 */
export function clearestGap(
  occ: Float32Array,
  mean: Float32Array | null,
  grid: CellGrid,
  opts: { lowHz?: number; highHz?: number; signalHz?: number } = {},
): ClearGap | null {
  const lo = opts.lowHz ?? CLEAR_LOW_HZ;
  const hi = opts.highHz ?? CLEAR_HIGH_HZ;
  const signal = opts.signalHz ?? SLOT_CELL_HZ;
  const usable = (c: number) => {
    if (c < 0 || c >= grid.cells) return false;
    const cl = grid.lowHz + c * grid.cellHz;
    return cl >= lo && cl + grid.cellHz <= hi && !Number.isNaN(occ[c]!);
  };
  let m1 = Number.POSITIVE_INFINITY;
  let m2 = Number.POSITIVE_INFINITY;
  for (let c = 0; c < grid.cells; c++) {
    if (!usable(c)) continue;
    m1 = Math.min(m1, occ[c]!);
    if (usable(c + 1)) m2 = Math.min(m2, Math.max(occ[c]!, occ[c + 1]!));
  }
  if (m1 === Number.POSITIVE_INFINITY) return null;
  const eps = 1e-6;

  // The best run of usable cells at or under `t`: longest, then quietest, then lowest.
  const bestRun = (t: number) => {
    let best = { start: -1, len: 0, quiet: Number.POSITIVE_INFINITY };
    let start = -1;
    let sum = 0;
    for (let c = 0; c <= grid.cells; c++) {
      const inRun = c < grid.cells && usable(c) && occ[c]! <= t + eps;
      if (inRun) {
        if (start < 0) {
          start = c;
          sum = 0;
        }
        sum += mean ? mean[c]! : 0;
        continue;
      }
      if (start >= 0) {
        const len = c - start;
        const q = sum / len;
        if (len > best.len || (len === best.len && q < best.quiet - eps)) best = { start, len, quiet: q };
        start = -1;
      }
    }
    return best;
  };

  let t = m1;
  let run = bestRun(t);
  if (run.len < 2 && m2 !== Number.POSITIVE_INFINITY && m2 - m1 <= RUN_SLACK + eps) {
    t = m2;
    run = bestRun(t);
  }
  if (run.len === 0) return null;
  const take = Math.min(2, run.len);
  const first = run.start + Math.floor((run.len - take) / 2);
  const lowHz = grid.lowHz + first * grid.cellHz;
  const highHz = lowHz + take * grid.cellHz;
  let occMax = 0;
  for (let c = first; c < first + take; c++) occMax = Math.max(occMax, occ[c]!);
  return {
    lowHz,
    highHz,
    offsetHz: Math.round(lowHz + Math.max(0, (highHz - lowHz - signal) / 2)),
    occupancy: occMax,
  };
}

/** A stored slot count, snapped to a choice; anything unreadable is the default. */
export function sanitizeSlotCount(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  return (SLOT_COUNT_CHOICES as readonly number[]).includes(n) ? n : DEFAULT_SLOT_COUNT;
}

export function loadSlotCount(storage: Pick<Storage, "getItem"> | null | undefined): number {
  try {
    return sanitizeSlotCount(storage?.getItem(SLOTS_KEY) ?? null);
  } catch {
    return DEFAULT_SLOT_COUNT;
  }
}

export function saveSlotCount(storage: Pick<Storage, "setItem"> | null | undefined, n: number): void {
  try {
    storage?.setItem(SLOTS_KEY, String(sanitizeSlotCount(n)));
  } catch {
    /* storage full or blocked: the choice still holds for this visit */
  }
}
