// Spectrum history: a bounded ring of rows in dB, each with its own time span and axis.
//
// What the cleanup notes (WATERFALL-CLEANUP-FOR-CLAUDE.md) ask of a waterfall, and how each
// is met here rather than in a renderer:
//
//   * AN HONEST TIME AXIS. Every row records the bridge-clock interval it covers. Drawing is
//     a lookup from a pixel's time interval to the rows overlapping it (buildRowMap), so
//     the vertical scale is seconds, not "one pixel per message", and it is the same at any
//     canvas height or pixel density.
//   * VISIBLE GAPS. A row covers from the previous frame only when the frames are contiguous
//     (within GAP_FACTOR of the measured interval). After a longer silence the interval in
//     between belongs to no row, and the views draw it as "no data". Nothing is repeated to
//     fill it.
//   * BOUNDED MEMORY, at any frame rate. Capacity is fixed by a byte budget. When frames
//     arrive faster than capacity / history length allows, consecutive frames are merged
//     into one row by MAXIMUM, so a one-frame burst survives the merge instead of being
//     averaged out — the same rule as reducing bins to pixels.
//   * HISTORY THAT SURVIVES A RETUNE. Each row keeps its own frequency axis, so a panadapter
//     re-centre or span change leaves earlier rows exactly where their frequencies were, and
//     a band change leaves them outside the view rather than smeared across it.

import { bytesToDb } from "@/lib/spectrum/levels";

export interface HistoryRowInput {
  /** One byte per bin, 0..255 across floorDb..ceilingDb, as the bridge sends it. */
  bytes: ArrayLike<number>;
  count: number;
  floorDb: number;
  ceilingDb: number;
  /** Frequency of the low edge of bin 0, Hz. */
  lowHz: number;
  binHz: number;
  /** Bridge clock, ms. */
  at: number;
}

export interface HistoryOptions {
  /** Upper bound on row storage. 24 MB holds 1536 rows of a 4096-bin panadapter. */
  budgetBytes?: number;
  /** Upper bound on rows — also the texture height, so keep it within MAX_TEXTURE_SIZE. */
  maxRows?: number;
  /** Assumed frame interval until two frames have been seen. */
  defaultIntervalMs?: number;
}

export interface PeakSample {
  db: number;
  /** The row's floor at the time, for "dB above floor". */
  floorDb: number;
  /** End of the row the peak is in (bridge ms). */
  at: number;
  /** Centre of the bin the peak is in. */
  hz: number;
}

/** Frames further apart than this many intervals leave a visible gap between their rows. */
export const GAP_FACTOR = 1.6;
/** Extra history kept beyond the requested length, so a paused view erodes slowly. */
export const HISTORY_HEADROOM = 1.15;
/** A clock step backwards larger than this starts a new timeline (bridge restart). */
export const BACKWARDS_RESET_MS = 2_000;
/** Frequency offsets larger than this move the precision reference (see refHz). */
const REBASE_HZ = 1_000_000;

const NO_ROWS = new Float32Array(0);

export class SpectrumHistory {
  /** Bins per row of storage. Rows may use fewer; `count` says how many. */
  width = 0;
  capacity = 0;
  data: Float32Array = NO_ROWS;
  startAt = new Float64Array(0);
  endAt = new Float64Array(0);
  lowHz = new Float64Array(0);
  binHz = new Float64Array(0);
  count = new Int32Array(0);
  floorDb = new Float32Array(0);

  /** Rows started since the last reset; row s lives at physical index s % capacity. */
  seq = 0;
  /** Bumps on every stored or merged frame. */
  revision = 0;
  /** Bumps when storage is reallocated or cleared: everything must be re-read. */
  epoch = 0;
  /**
   * A frequency near the data, subtracted before anything goes to the GPU. Float32 has a
   * 24-bit mantissa: an absolute 14 MHz is good to ~1 Hz, 144 MHz only to ~16 Hz, while a
   * panadapter bin can be 1.2 Hz wide. Offsets from a nearby reference keep every band exact.
   */
  refHz = 0;
  /** Bumps when refHz moves: per-row frequency metadata must be re-read. */
  metaEpoch = 0;

  private readonly budgetBytes: number;
  private readonly maxRows: number;
  private readonly defaultIntervalMs: number;
  private historyMs = 120_000;
  /** Whether the newest row may still absorb frames (false after a gap or axis change). */
  private open = false;
  private lastFrameAt = Number.NEGATIVE_INFINITY;
  private readonly gaps = new Float64Array(16);
  private readonly gapSort = new Float64Array(16);
  private gapCount = 0;
  private gapWrite = 0;

  constructor(opts: HistoryOptions = {}) {
    this.budgetBytes = opts.budgetBytes ?? 24 * 1024 * 1024;
    this.maxRows = Math.max(16, Math.floor(opts.maxRows ?? 4096));
    this.defaultIntervalMs = opts.defaultIntervalMs ?? 250;
  }

  /** How long a view of this history spans. Longer histories merge fast frames sooner. */
  setHistoryMs(ms: number): void {
    if (Number.isFinite(ms) && ms > 0) this.historyMs = ms;
  }

  get historyLengthMs(): number {
    return this.historyMs;
  }

  /** Shortest a row may be: frames closer than this to the row's start are merged into it. */
  get minRowMs(): number {
    return this.capacity > 0 ? (this.historyMs * HISTORY_HEADROOM) / this.capacity : 0;
  }

  /** Rows currently held. */
  get size(): number {
    return Math.min(this.seq, this.capacity);
  }

  /** Median of recent frame spacings — robust to the odd dropped or late frame. */
  get intervalMs(): number {
    const n = this.gapCount;
    if (n === 0) return this.defaultIntervalMs;
    const s = this.gapSort;
    for (let i = 0; i < n; i++) {
      const v = this.gaps[i]!;
      let j = i - 1;
      while (j >= 0 && s[j]! > v) {
        s[j + 1] = s[j]!;
        j--;
      }
      s[j + 1] = v;
    }
    return s[n >> 1]!;
  }

  /** Physical index of the k-th held row, oldest first. */
  physical(k: number): number {
    return (this.seq - this.size + k) % this.capacity;
  }

  clear(): void {
    this.seq = 0;
    this.open = false;
    this.lastFrameAt = Number.NEGATIVE_INFINITY;
    this.epoch++;
    this.revision++;
  }

  newestEndAt(): number | null {
    return this.size > 0 ? this.endAt[this.physical(this.size - 1)]! : null;
  }

  oldestStartAt(): number | null {
    return this.size > 0 ? this.startAt[this.physical(0)]! : null;
  }

  /** Store one frame. False when it was ignored (late, duplicate, or malformed). */
  push(row: HistoryRowInput): boolean {
    const { count, at, binHz, lowHz, floorDb, ceilingDb } = row;
    if (!(count > 0) || !Number.isFinite(at) || !(binHz > 0) || !Number.isFinite(lowHz)) return false;
    if (!Number.isFinite(floorDb) || !Number.isFinite(ceilingDb)) return false;

    // A bridge restart or clock correction can step backwards: a new timeline, not a late row.
    if (this.seq > 0 && at < this.lastFrameAt - BACKWARDS_RESET_MS) this.clear();
    else if (at <= this.lastFrameAt) return false;

    if (count > this.width) this.allocate(count);

    const frameGap = at - this.lastFrameAt;
    const interval = this.intervalMs;
    const contiguous = this.seq > 0 && frameGap <= Math.max(interval * GAP_FACTOR, interval + 40);
    if (this.seq > 0 && frameGap > 0 && frameGap < 2_000) this.recordGap(frameGap);

    const newest = this.seq > 0 ? (this.seq - 1) % this.capacity : -1;
    if (
      this.open &&
      contiguous &&
      newest >= 0 &&
      this.count[newest] === count &&
      this.binHz[newest] === binHz &&
      Math.abs(this.lowHz[newest]! - lowHz) < binHz * 1e-3 &&
      at - this.startAt[newest]! < this.minRowMs
    ) {
      // Merge by maximum: a frame that is not given its own row must not lose its peaks.
      const base = newest * this.width;
      const step = (ceilingDb - floorDb) / 255;
      const d = this.data;
      for (let i = 0; i < count; i++) {
        const v = floorDb + (row.bytes[i] as number) * step;
        if (v > d[base + i]!) d[base + i] = v;
      }
      this.endAt[newest] = at;
      this.floorDb[newest] = floorDb;
    } else {
      const p = this.seq % this.capacity;
      // Contiguous frames tile time edge to edge; after a gap the row claims one interval.
      this.startAt[p] = contiguous ? this.lastFrameAt : at - Math.min(interval, 2_000);
      this.endAt[p] = at;
      this.lowHz[p] = lowHz;
      this.binHz[p] = binHz;
      this.count[p] = count;
      this.floorDb[p] = floorDb;
      bytesToDb(row.bytes, count, floorDb, ceilingDb, this.data, p * this.width);
      if (this.seq === 0 || Math.abs(lowHz - this.refHz) > REBASE_HZ) {
        this.refHz = lowHz;
        this.metaEpoch++;
      }
      this.seq++;
      this.open = true;
    }

    this.lastFrameAt = at;
    this.revision++;
    return true;
  }

  /**
   * For each of `slots` equal time slices ending at `endAt` (slot 0 newest), the run of rows
   * overlapping it: out[2i] = physical index of the oldest, out[2i + 1] = how many (0 = no
   * data). Returns the number of slots with data.
   */
  buildRowMap(endAt: number, spanMs: number, slots: number, out: Float32Array): number {
    const n = this.size;
    const dt = spanMs / slots;
    const cap = this.capacity;
    const base = this.seq - n;
    let k = n - 1;
    let filled = 0;
    for (let i = 0; i < slots; i++) {
      const s1 = endAt - i * dt;
      const s0 = s1 - dt;
      while (k >= 0 && this.startAt[(base + k) % cap]! >= s1) k--;
      let j = k;
      while (j >= 0 && this.endAt[(base + j) % cap]! > s0) j--;
      const rows = k - j;
      if (rows > 0) {
        out[2 * i] = (base + j + 1) % cap;
        out[2 * i + 1] = rows;
        filled++;
      } else {
        out[2 * i] = 0;
        out[2 * i + 1] = 0;
      }
    }
    return filled;
  }

  /**
   * The strongest bin within a time and frequency window — what a pixel covering that
   * window shows, so a readout and the picture under it agree.
   */
  peakIn(t0: number, t1: number, f0: number, f1: number): PeakSample | null {
    const n = this.size;
    if (n === 0) return null;
    // Rows cover (startAt, endAt]; a zero-length query becomes a 1 ms one.
    if (!(t1 > t0)) t1 = t0 + 1;
    const cap = this.capacity;
    const base = this.seq - n;
    // Newest row starting before t1 (rows are in time order).
    let lo = 0;
    let hi = n - 1;
    let k = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.startAt[(base + mid) % cap]! < t1) {
        k = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    let best: PeakSample | null = null;
    for (let scanned = 0; k >= 0 && scanned < 512; k--, scanned++) {
      const p = (base + k) % cap;
      if (this.endAt[p]! <= t0) break;
      const bh = this.binHz[p]!;
      const low = this.lowHz[p]!;
      const cnt = this.count[p]!;
      let b0 = Math.floor((f0 - low) / bh);
      let b1 = f1 > f0 ? Math.ceil((f1 - low) / bh) - 1 : b0;
      if (b1 < b0) b1 = b0;
      if (b0 < 0) b0 = 0;
      if (b1 > cnt - 1) b1 = cnt - 1;
      const o = p * this.width;
      for (let b = b0; b <= b1; b++) {
        const v = this.data[o + b]!;
        if (!best || v > best.db) {
          best = { db: v, floorDb: this.floorDb[p]!, at: this.endAt[p]!, hz: low + (b + 0.5) * bh };
        }
      }
    }
    return best;
  }

  private recordGap(ms: number): void {
    this.gaps[this.gapWrite] = ms;
    this.gapWrite = (this.gapWrite + 1) % this.gaps.length;
    if (this.gapCount < this.gaps.length) this.gapCount++;
  }

  private allocate(width: number): void {
    this.width = width;
    const byBudget = Math.floor(this.budgetBytes / (width * 4));
    this.capacity = Math.max(16, Math.min(this.maxRows, byBudget));
    this.data = new Float32Array(this.capacity * width);
    this.startAt = new Float64Array(this.capacity);
    this.endAt = new Float64Array(this.capacity);
    this.lowHz = new Float64Array(this.capacity);
    this.binHz = new Float64Array(this.capacity);
    this.count = new Int32Array(this.capacity);
    this.floorDb = new Float32Array(this.capacity);
    this.seq = 0;
    this.open = false;
    this.epoch++;
    this.metaEpoch++;
  }
}
