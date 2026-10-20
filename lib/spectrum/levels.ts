// dB levels: turning wire bytes back into dB, tracking the noise floor, and the display
// window the contrast controls set.
//
// The bridge sends each row as bytes spread across that row's own floorDb..ceilingDb, and
// both ends move from row to row as the bridge tracks the band (lib/radio/spectrum.ts,
// lib/radio/panadapter.ts). Bytes from different rows are therefore not comparable, which
// is why the existing waterfalls cannot recolour their history consistently. Converting
// each row back to dB on arrival makes every row comparable, and the display window is
// then one floor and one range applied to all of it.
//
// Nothing below the bridge's floor survives the wire: those bins arrive as byte 0 and come
// back as exactly floorDb. A floor control set below zero shows that clipped noise as one
// flat colour, which is the truth about what was sent rather than detail being hidden.

/** Bytes 0..255 across floorDb..ceilingDb, back to dB. Writes `count` values into `out` at `offset`. */
export function bytesToDb(
  bytes: ArrayLike<number>,
  count: number,
  floorDb: number,
  ceilingDb: number,
  out: Float32Array,
  offset = 0,
): void {
  const step = (ceilingDb - floorDb) / 255;
  for (let i = 0; i < count; i++) out[offset + i] = floorDb + (bytes[i] as number) * step;
}

/** 0..1 position of `db` in the window, clamped. */
export function normaliseDb(db: number, loDb: number, rangeDb: number): number {
  if (!(rangeDb > 0)) return 0;
  const t = (db - loDb) / rangeDb;
  return t <= 0 ? 0 : t >= 1 ? 1 : t;
}

/** Narrowest range the control allows: below this the map is a threshold, not a ramp. */
export const MIN_RANGE_DB = 3;
export const MAX_RANGE_DB = 120;
/** Floor control limits, dB relative to the tracked floor. */
export const MIN_FLOOR_OFFSET_DB = -30;
export const MAX_FLOOR_OFFSET_DB = 40;

/** The audio display's span when nothing has been tracked yet — the bridge's own 40 dB. */
export const DEFAULT_RANGE_DB = 40;

export interface Contrast {
  /** dB above the tracked floor where the map starts. 0 reproduces the bridge's colouring. */
  floorOffsetDb: number;
  /** Height of the map in dB, or null to follow the bridge's own span ("auto"). */
  rangeDb: number | null;
}

export const DEFAULT_CONTRAST: Contrast = { floorOffsetDb: 0, rangeDb: null };

export interface DisplayWindow {
  loDb: number;
  rangeDb: number;
}

/** Where the map starts and how tall it is, from the tracked levels and the controls. */
export function displayWindow(
  trackedFloorDb: number | null,
  trackedSpanDb: number | null,
  contrast: Contrast,
): DisplayWindow {
  const floor = trackedFloorDb ?? -100;
  const range = contrast.rangeDb ?? trackedSpanDb ?? DEFAULT_RANGE_DB;
  return {
    loDb: floor + clamp(contrast.floorOffsetDb, MIN_FLOOR_OFFSET_DB, MAX_FLOOR_OFFSET_DB),
    rangeDb: clamp(range, MIN_RANGE_DB, MAX_RANGE_DB),
  };
}

/**
 * The floor and span the views colour against, tracked from the bridge's own per-row values.
 *
 * Smoothed again here because the history is recoloured from these on every draw: a floor
 * that moved a decibel with each row would make minutes of history pulse. Time-based rather
 * than per-row, so the audio feed (4 rows/s) and the panadapter (~9 rows/s) settle alike, and
 * a large step snaps — a band change or a gain change is a new scale, not a slow drift to it.
 */
export class LevelTracker {
  floorDb: number | null = null;
  spanDb: number | null = null;
  private lastAt: number | null = null;

  constructor(
    private readonly tauMs = 3_000,
    private readonly snapDb = 12,
  ) {}

  reset(): void {
    this.floorDb = null;
    this.spanDb = null;
    this.lastAt = null;
  }

  update(floorDb: number, ceilingDb: number, at: number): void {
    const span = ceilingDb - floorDb;
    if (!Number.isFinite(floorDb) || !Number.isFinite(span) || span <= 0 || floorDb < -250) return;
    const dt = this.lastAt === null ? 0 : Math.max(0, Math.min(10_000, at - this.lastAt));
    this.lastAt = at;
    if (this.floorDb === null || this.spanDb === null || Math.abs(floorDb - this.floorDb) > this.snapDb) {
      this.floorDb = floorDb;
      this.spanDb = span;
      return;
    }
    const a = 1 - Math.exp(-dt / this.tauMs);
    this.floorDb += (floorDb - this.floorDb) * a;
    this.spanDb += (span - this.spanDb) * a;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
