// Ticks and labels for the spectrum views' axes.
//
// Frequency ticks come from a 1-2-2.5-5 ladder sized to the space available, because one
// display covers anything from a 3 kHz audio passband to megahertz of band. Time ticks are
// aligned to UTC multiples of the step — so FT8's 15 s cycle boundaries land on :00, :15,
// :30 and :45, the same origin the decode page's cycle indicator uses — and are taken from
// the mode's own period where one is known, so FT4 gets 7.5 s and WSPR 2 min.

/** Smallest "nice" step at least `rough`: 1, 2, 2.5 or 5 times a power of ten. */
export function niceStep(rough: number): number {
  if (!(rough > 0) || !Number.isFinite(rough)) return 1;
  const pow = 10 ** Math.floor(Math.log10(rough));
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (rough <= pow * m * (1 + 1e-9)) return pow * m;
  }
  return pow * 10;
}

export interface FrequencyTicks {
  step: number;
  values: number[];
}

/** Tick positions inside [lowHz, highHz] with at most about `maxTicks` of them. */
export function frequencyTicks(lowHz: number, highHz: number, maxTicks: number): FrequencyTicks {
  const span = highHz - lowHz;
  if (!(span > 0) || !(maxTicks >= 1)) return { step: 0, values: [] };
  const step = niceStep(span / Math.max(1, maxTicks));
  const values: number[] = [];
  const first = Math.ceil(lowHz / step - 1e-9) * step;
  for (let v = first, i = 0; v <= highHz + step * 1e-9 && i < 1000; i++, v = first + i * step) {
    values.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  }
  return { step, values };
}

export type FrequencyUnit = "Hz" | "kHz" | "MHz";

/** The unit a ruler should label in: MHz for RF, Hz for the audio passband. */
export function frequencyUnit(highHz: number, step: number): FrequencyUnit {
  if (highHz >= 1_000_000) return "MHz";
  if (step >= 1_000 && highHz >= 10_000) return "kHz";
  return "Hz";
}

const UNIT_SCALE: Record<FrequencyUnit, number> = { Hz: 1, kHz: 1e3, MHz: 1e6 };

/** Decimal places needed to write `x` exactly (a 2.5-step needs one more than its magnitude suggests). */
function decimalsFor(x: number): number {
  for (let d = 0; d <= 6; d++) {
    const v = x * 10 ** d;
    if (Math.abs(v - Math.round(v)) < 1e-6 * Math.max(1, Math.abs(v))) return d;
  }
  return 6;
}

/** A tick label: just enough decimals that adjacent ticks differ. */
export function formatFrequency(hz: number, unit: FrequencyUnit, step: number): string {
  const scale = UNIT_SCALE[unit];
  return (hz / scale).toFixed(decimalsFor(step / scale));
}

/** A readout value: Hz for audio, MHz to 10 Hz for RF. */
export function formatReadoutFrequency(hz: number, rf: boolean): string {
  if (!Number.isFinite(hz)) return "—";
  return rf ? `${(hz / 1e6).toFixed(5)} MHz` : `${Math.round(hz)} Hz`;
}

/** Candidate time-label steps, ms. */
const TIME_STEPS_MS = [
  1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000,
];

/**
 * A label step that keeps labels at least `minGapPx` apart. With a cycle period, the step is
 * a whole number of cycles so every label sits on a cycle boundary.
 */
export function timeLabelStep(
  spanMs: number,
  heightPx: number,
  minGapPx: number,
  periodMs: number | null = null,
): number {
  if (!(spanMs > 0) || !(heightPx > 0)) return 60_000;
  const minMs = (spanMs * minGapPx) / heightPx;
  if (periodMs && periodMs >= 1_000) {
    for (const k of [1, 2, 4, 8, 16, 32, 64, 128]) {
      if (periodMs * k >= minMs) return periodMs * k;
    }
  }
  for (const s of TIME_STEPS_MS) if (s >= minMs) return s;
  return TIME_STEPS_MS[TIME_STEPS_MS.length - 1]!;
}

/** Start of the cycle containing `atMs`, on the UTC grid. */
export function cycleStart(atMs: number, periodMs: number): number {
  return Math.floor(atMs / periodMs) * periodMs;
}

/**
 * Tick times for a time axis ending at `endAt`, newest first, written into `out`.
 * "utc": multiples of `stepMs` on the UTC grid. "ago": endAt, endAt - step, ...
 * Returns how many were written.
 */
export function fillTimeTicks(
  out: Float64Array,
  endAt: number,
  spanMs: number,
  stepMs: number,
  mode: "utc" | "ago",
): number {
  if (!(stepMs > 0)) return 0;
  let t = mode === "utc" ? cycleStart(endAt, stepMs) : endAt;
  let n = 0;
  while (t >= endAt - spanMs - 1e-6 && n < out.length) {
    out[n++] = t;
    t -= stepMs;
  }
  return n;
}

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));

/** "14:03:15" — UTC, no suffix (the axis header says UTC). */
export function formatUtcClock(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

/** "now", "−15 s", "−2 min", "−1 min 30 s". */
export function formatAgo(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s <= 0) return "now";
  if (s < 60) return `−${s} s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r === 0 ? `−${m} min` : `−${m} min ${r} s`;
}

/** "45 s", "2 min", "1 h". */
export function formatSpan(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = s / 60;
  if (m < 60) return Number.isInteger(m) ? `${m} min` : `${m.toFixed(1)} min`;
  const h = m / 60;
  return Number.isInteger(h) ? `${h} h` : `${h.toFixed(1)} h`;
}
