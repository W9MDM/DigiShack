// One station on one band is one spot, for a while.
//
// A busy DX station is spotted by a dozen people and fifty skimmers within minutes, and a list
// that shows each of those is a list of one station. Same call on the same band inside the
// window is a repeat — counted, not shown again.
//
// With one exception: a move of more than QSY_HZ on the same band is a NEW spot. Skimmers
// disagree with each other by a few hundred hertz, and FT8 spotters give either the dial or
// the signal (1-3 kHz apart), so the tolerance has to absorb that; but a station that has
// QSYed from 14.025 to 14.030 is somewhere else, and a deduper that hid the move would leave
// the band map pointing — and the tune button tuning — at an empty frequency.

export const DEDUPE_WINDOW_MS = 10 * 60_000;
export const QSY_HZ = 3_500;

export function spotKey(dx: string, band: string): string {
  return `${dx.toUpperCase()}|${band.toUpperCase()}`;
}

export class SpotDeduper {
  private readonly seen = new Map<string, { firstAt: number; freqHz: number }>();

  constructor(
    private readonly windowMs = DEDUPE_WINDOW_MS,
    private readonly qsyHz = QSY_HZ,
  ) {}

  /** True for a repeat of a spot passed inside the window. A false answer records this one. */
  isDupe(key: string, freqHz: number, now: number): boolean {
    const prev = this.seen.get(key);
    if (prev && now - prev.firstAt < this.windowMs && Math.abs(prev.freqHz - freqHz) <= this.qsyHz) {
      return true;
    }
    this.seen.set(key, { firstAt: now, freqHz });
    if (this.seen.size > 5_000) this.prune(now);
    return false;
  }

  prune(now: number): void {
    for (const [k, v] of this.seen) if (now - v.firstAt >= this.windowMs) this.seen.delete(k);
  }
}
