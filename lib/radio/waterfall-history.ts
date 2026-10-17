/** A received display row, with the bridge's timestamp (milliseconds). */
export interface WaterfallRow {
  bins: Uint8Array;
  at: number;
}

/** Keep peaks when reducing bins; never average a narrow carrier out of the display. */
export function writeWaterfallRow(
  bins: Uint8Array,
  pixels: Uint8ClampedArray,
  width: number,
  gain: number,
  palette: Uint8Array,
): void {
  for (let x = 0; x < width; x++) {
    const from = Math.floor((x * bins.length) / width);
    const to = Math.max(from + 1, Math.floor(((x + 1) * bins.length) / width));
    let peak = 0;
    for (let b = from; b < to && b < bins.length; b++) peak = Math.max(peak, bins[b]!);
    const value = Math.max(0, Math.min(255, Math.round(peak * gain)));
    pixels[x * 4] = palette[value * 3]!;
    pixels[x * 4 + 1] = palette[value * 3 + 1]!;
    pixels[x * 4 + 2] = palette[value * 3 + 2]!;
    pixels[x * 4 + 3] = 255;
  }
}

/** Newest at the bottom. Tolerate timer jitter; leave sustained delivery gaps empty. */
export function waterfallSlots(
  rows: readonly WaterfallRow[],
  endAt: number,
  height: number,
  stepMs: number,
): (WaterfallRow | null)[] {
  const slots = Array<WaterfallRow | null>(height).fill(null);
  const end = Math.floor(endAt / stepMs);
  let index = 0;
  for (let y = 0; y < height; y++) {
    const at = (end - (height - 1 - y)) * stepMs;
    while (index + 1 < rows.length && rows[index + 1]!.at <= at) index++;
    const before = rows[index];
    const after = rows[index + 1];
    const nearest = after && (!before || Math.abs(after.at - at) < Math.abs(before.at - at)) ? after : before;
    // A strict timestamp bucket would draw black stripes when a 250ms timer alternates
    // between 249 and 251ms. Bound the tolerance so actual outages still appear blank.
    if (nearest && Math.abs(nearest.at - at) <= stepMs * 0.75) slots[y] = nearest;
  }
  return slots;
}

/** Width follows CSS pixels and screen density; vertical time resolution stays unchanged. */
export function waterfallWidth(cssWidth: number, pixelRatio: number): number {
  return Math.max(1, Math.min(4096, Math.round(cssWidth * Math.min(2, Math.max(1, pixelRatio)))));
}

/** Bounded raw rows let a resize or gain change redraw history without stretching time. */
export class WaterfallHistory {
  private rows: WaterfallRow[] = [];

  clear(): void { this.rows = []; }

  push(row: WaterfallRow): void {
    if (!Number.isFinite(row.at) || row.bins.length === 0) return;
    const last = this.rows[this.rows.length - 1];
    // A bridge restart / clock correction can move its clock backwards. Small out-of-order
    // arrivals are stale, while a large jump starts a new timeline.
    if (last && row.at < last.at - 2000) this.clear();
    else if (last && row.at <= last.at) return;
    this.rows.push(row);
    const cutoff = row.at - 600_000;
    while (this.rows.length > 4096 || (this.rows[0]?.at ?? row.at) < cutoff) this.rows.shift();
  }

  get entries(): readonly WaterfallRow[] { return this.rows; }
}
