// Everything the Cluster page computes from a spot list, kept out of the page so the check
// can assert it. Browser-safe: no node:, no Prisma.

import { BANDS, getBand } from "@/lib/ham/bands";
import { formatUtcTime } from "@/lib/time";
import type { ClusterSpot, ModeCategory } from "@/lib/cluster/types";

export interface SpotFilter {
  band: string;
  category: ModeCategory | "ALL";
  neededOnly: boolean;
  maxAgeMin: number;
}

export const ALL_BANDS = "ALL";

export function isNeeded(s: ClusterSpot): boolean {
  return Boolean(s.needed && (s.needed.entity || s.needed.band || s.needed.mode));
}

/** Age is measured from the latest repeat, so a station still being spotted stays listed. */
export function filterSpots(spots: ClusterSpot[], f: SpotFilter, now: number): ClusterSpot[] {
  const oldest = now - f.maxAgeMin * 60_000;
  return spots.filter(
    (s) =>
      (f.band === ALL_BANDS || s.band === f.band) &&
      (f.category === "ALL" || s.modeCategory === f.category) &&
      (!f.neededOnly || isNeeded(s)) &&
      s.lastSeenAt >= oldest,
  );
}

/** Newest spot first; the arrival order breaks ties inside a minute. */
export function sortSpots(spots: ClusterSpot[]): ClusterSpot[] {
  return spots.slice().sort((a, b) => b.at - a.at || b.receivedAt - a.receivedAt);
}

/** Bands with spots on them, low to high, with how many. */
export function bandsInUse(spots: ClusterSpot[]): { band: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const s of spots) counts.set(s.band, (counts.get(s.band) ?? 0) + 1);
  return BANDS.filter((b) => counts.has(b.name)).map((b) => ({ band: b.name, count: counts.get(b.name)! }));
}

/** The spot's own time, as the cluster gives it — to the minute, so no invented seconds. */
export function spotClock(at: number): string {
  const t = formatUtcTime(at);
  return t === "—" ? t : `${t.slice(0, 5)}Z`;
}

/** kHz to the 100 Hz a cluster spot carries: "14025.3". */
export function formatKhz(hz: number): string {
  return (hz / 1000).toFixed(1);
}

/**
 * Add or replace one spot, the way the bridge's list does: one entry per call and band,
 * newest first, capped.
 */
export function upsertSpot(list: ClusterSpot[], spot: ClusterSpot, max = 500): ClusterSpot[] {
  return [spot, ...list.filter((s) => s.key !== spot.key && s.id !== spot.id)].slice(0, max);
}

/** Enough of a spot's shape to trust a WebSocket frame as one. */
export function isClusterSpot(x: unknown): x is ClusterSpot {
  if (!x || typeof x !== "object") return false;
  const s = x as Record<string, unknown>;
  return (
    typeof s.id === "string" &&
    typeof s.key === "string" &&
    typeof s.dx === "string" &&
    typeof s.band === "string" &&
    typeof s.freqHz === "number" &&
    typeof s.at === "number" &&
    typeof s.lastSeenAt === "number"
  );
}

/** What a click on a spot does, in words, for the button's title. */
export function tuneTitle(s: ClusterSpot, canTune: boolean): string {
  if (!canTune) return "Tuning the radio needs the Operator role";
  return `Tune the radio to ${formatKhz(s.freqHz)} kHz for ${s.dx}. This only moves the receiver: the mode is left as it is and nothing is transmitted.`;
}

// ---------------------------------------------------------------------------
// The band map
// ---------------------------------------------------------------------------

/** Wider than this, a band map of the whole band is mostly empty space: show the busy part. */
const CROP_ABOVE_HZ = 600_000;
const CROP_PAD_HZ = 25_000;
const MIN_CROPPED_SPAN_HZ = 100_000;

/**
 * The frequency range a band map shows.
 *
 * The whole band where that is readable. 10 m is 1.7 MHz and 6 m four; drawn whole, every
 * spot on them sits in the bottom tenth, so wide bands are cropped to the spots plus a margin
 * and the page says so.
 */
export function bandMapRange(
  band: string,
  spots: { freqHz: number }[],
): { lowHz: number; highHz: number; cropped: boolean } {
  const b = getBand(band);
  if (!b) {
    const fs = spots.map((s) => s.freqHz);
    const lo = fs.length ? Math.min(...fs) : 0;
    const hi = fs.length ? Math.max(...fs) : 1;
    return { lowHz: lo - CROP_PAD_HZ, highHz: hi + CROP_PAD_HZ, cropped: true };
  }
  if (b.highHz - b.lowHz <= CROP_ABOVE_HZ || spots.length === 0) {
    if (b.highHz - b.lowHz <= CROP_ABOVE_HZ) return { lowHz: b.lowHz, highHz: b.highHz, cropped: false };
    return { lowHz: b.lowHz, highHz: b.lowHz + CROP_ABOVE_HZ, cropped: true };
  }
  const fs = spots.map((s) => s.freqHz);
  let lo = Math.max(b.lowHz, Math.min(...fs) - CROP_PAD_HZ);
  let hi = Math.min(b.highHz, Math.max(...fs) + CROP_PAD_HZ);
  if (hi - lo < MIN_CROPPED_SPAN_HZ) {
    const grow = (MIN_CROPPED_SPAN_HZ - (hi - lo)) / 2;
    lo = Math.max(b.lowHz, lo - grow);
    hi = Math.min(b.highHz, hi + grow);
  }
  // Round outward to 5 kHz so the ruler starts on a number someone would write.
  lo = Math.max(b.lowHz, Math.floor(lo / 5_000) * 5_000);
  hi = Math.min(b.highHz, Math.ceil(hi / 5_000) * 5_000);
  return { lowHz: lo, highHz: hi, cropped: lo > b.lowHz || hi < b.highHz };
}

export interface PlacedSpot {
  id: string;
  /** Where the frequency is, px from the top. */
  y: number;
  /** Where its label goes, px from the top: as close to `y` as the labels around it allow. */
  labelY: number;
}

/**
 * Place a label for every spot without overlaps, low frequency at the top.
 *
 * The scale stretches when there are more labels than fit — a contest weekend puts forty
 * stations in 20 kHz — rather than dropping any: a band map that silently omits spots is a
 * band map that says a frequency is clear when it is not. Each label then sits as near its
 * frequency as the ones above and below allow (a forward pass pushes down, a backward pass
 * pulls back inside the bottom edge), and a leader line joins the two.
 */
export function bandMapLayout(
  spots: { id: string; freqHz: number }[],
  lowHz: number,
  highHz: number,
  baseHeightPx: number,
  labelPx: number,
): { height: number; placed: PlacedSpot[] } {
  const span = Math.max(1, highHz - lowHz);
  const height = Math.max(baseHeightPx, Math.ceil(spots.length * labelPx * 1.15));
  const sorted = spots
    .filter((s) => s.freqHz >= lowHz && s.freqHz <= highHz)
    .sort((a, b) => a.freqHz - b.freqHz || a.id.localeCompare(b.id));
  const placed: PlacedSpot[] = sorted.map((s) => {
    const y = ((s.freqHz - lowHz) / span) * height;
    return { id: s.id, y, labelY: y - labelPx / 2 };
  });
  let floor = 0;
  for (const p of placed) {
    p.labelY = Math.max(p.labelY, floor);
    floor = p.labelY + labelPx;
  }
  let ceiling = height - labelPx;
  for (let i = placed.length - 1; i >= 0; i--) {
    const p = placed[i]!;
    p.labelY = Math.max(0, Math.min(p.labelY, ceiling));
    ceiling = p.labelY - labelPx;
  }
  return { height, placed };
}

/** A ruler step that keeps ticks at least `minGapPx` apart: 1, 2, 5, 10, 20, 25, 50 … kHz. */
export function tickStepHz(spanHz: number, heightPx: number, minGapPx = 36): number {
  const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000].map((k) => k * 1000);
  const pxPerHz = heightPx / Math.max(1, spanHz);
  return steps.find((s) => s * pxPerHz >= minGapPx) ?? steps[steps.length - 1]!;
}

// ---------------------------------------------------------------------------
// For the Rig page's panadapter, when it takes cluster spots
// ---------------------------------------------------------------------------

/**
 * Cluster spots in the shape `PanadapterSpot` (components/digital/Panadapter.tsx) takes.
 * Keys are prefixed so they cannot collide with the POTA spots drawn alongside.
 */
export function toPanadapterSpots(
  spots: ClusterSpot[],
): { key: string; callsign: string; freqHz: number; mode: string | null; detail: string | null }[] {
  return spots.map((s) => ({
    key: `dx:${s.id}`,
    callsign: s.dx,
    freqHz: s.freqHz,
    mode: s.mode,
    detail:
      [s.entity?.name, s.comment, `de ${s.spotter} ${spotClock(s.at)}`].filter(Boolean).join(" · ") || null,
  }));
}
