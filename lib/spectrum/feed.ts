// One live spectrum source — the audio passband or the RF panadapter — as the page holds it:
// its history, its tracked levels, its clock and its frame rate.
//
// Kept out of React state on purpose. Frames arrive four to fifteen times a second and the
// page may stay open for hours; routing each one through setState would re-render the whole
// page per frame. Renderers subscribe and schedule their own redraws instead.

import { SpectrumHistory, type HistoryOptions } from "@/lib/spectrum/history";
import { LevelTracker } from "@/lib/spectrum/levels";
import type { FeedKind, WireFrame } from "@/lib/spectrum/wire";

/**
 * The bridge's clock, as seen from this page.
 *
 * Row timestamps are the bridge's Date.now(); the page's own wall clock may be minutes off,
 * so "now" on the time axis is the bridge clock carried forward with performance.now().
 * The offset is the largest of the recent (row time - arrival time): the least-delayed
 * frame is the best evidence of the offset, and taking the maximum keeps network jitter
 * from shaking the whole picture back and forth.
 */
export class BridgeClock {
  private readonly offsets = new Float64Array(32);
  private n = 0;
  private w = 0;

  observe(at: number, receivedPerf: number): void {
    this.offsets[this.w] = at - receivedPerf;
    this.w = (this.w + 1) % this.offsets.length;
    if (this.n < this.offsets.length) this.n++;
  }

  /** Bridge-clock ms at `perfNow`, or null before the first frame. */
  now(perfNow: number): number | null {
    if (this.n === 0) return null;
    let best = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < this.n; i++) if (this.offsets[i]! > best) best = this.offsets[i]!;
    return perfNow + best;
  }

  reset(): void {
    this.n = 0;
    this.w = 0;
  }
}

/** Frames per second over the last few seconds of arrivals. */
export class RateMeter {
  private readonly marks = new Float64Array(128);
  private n = 0;
  private w = 0;
  private first = Number.NaN;

  constructor(private readonly windowMs = 5_000) {}

  mark(perf: number): void {
    if (Number.isNaN(this.first)) this.first = perf;
    this.marks[this.w] = perf;
    this.w = (this.w + 1) % this.marks.length;
    if (this.n < this.marks.length) this.n++;
  }

  fps(perfNow: number): number {
    if (this.n === 0) return 0;
    let count = 0;
    for (let i = 0; i < this.n; i++) if (perfNow - this.marks[i]! <= this.windowMs) count++;
    // Before a full window has passed, divide by the time actually observed.
    const span = Math.max(1_000, Math.min(this.windowMs, perfNow - this.first));
    return (count * 1_000) / span;
  }
}

export interface FeedInfo {
  kind: FeedKind;
  lowHz: number;
  highHz: number;
  binHz: number;
  bins: number;
  mode: string | null;
  periodMs: number | null;
  radio: string | null;
  calibrated: boolean;
  /** The frame's own floor and ceiling, as the bridge sent them. */
  floorDb: number;
  ceilingDb: number;
  at: number;
}

export class SpectrumFeed {
  readonly history: SpectrumHistory;
  readonly levels = new LevelTracker();
  readonly clock = new BridgeClock();
  readonly rate = new RateMeter();
  /** Latest frame's description. Mutated in place; read, do not keep. */
  readonly info: FeedInfo;
  frames = 0;
  /** performance.now() of the last stored frame. */
  lastReceived = Number.NEGATIVE_INFINITY;
  private readonly listeners = new Set<() => void>();

  constructor(
    readonly kind: FeedKind,
    opts: HistoryOptions = {},
  ) {
    this.history = new SpectrumHistory({ defaultIntervalMs: kind === "rf" ? 100 : 250, ...opts });
    this.info = {
      kind,
      lowHz: 0,
      highHz: 0,
      binHz: 0,
      bins: 0,
      mode: null,
      periodMs: null,
      radio: null,
      calibrated: true,
      floorDb: 0,
      ceilingDb: 0,
      at: 0,
    };
  }

  get hasData(): boolean {
    return this.frames > 0 && this.history.size > 0;
  }

  /** Store a decoded frame and wake subscribers. False when the history ignored it. */
  ingest(frame: WireFrame, receivedPerf: number): boolean {
    const epoch = this.history.epoch;
    const stored = this.history.push(frame);
    // A new timeline (bridge restart) invalidates the clock offset learned from the old one.
    if (this.history.epoch !== epoch) {
      this.clock.reset();
      if (!frame.calibrated) this.levels.reset();
    }
    if (!stored) return false;
    this.levels.update(frame.floorDb, frame.ceilingDb, frame.at);
    this.clock.observe(frame.at, receivedPerf);
    this.rate.mark(receivedPerf);
    this.frames++;
    this.lastReceived = receivedPerf;
    const i = this.info;
    i.lowHz = frame.lowHz;
    i.highHz = frame.lowHz + frame.binHz * frame.count;
    i.binHz = frame.binHz;
    i.bins = frame.count;
    i.mode = frame.mode;
    i.periodMs = frame.periodMs;
    i.radio = frame.radio;
    i.calibrated = frame.calibrated;
    i.floorDb = frame.floorDb;
    i.ceilingDb = frame.ceilingDb;
    i.at = frame.at;
    for (const fn of this.listeners) fn();
    return true;
  }

  /** Bridge-clock "now", or null before any frame. */
  now(perfNow: number): number | null {
    return this.clock.now(perfNow);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
}
