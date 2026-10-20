import { colourFor } from "@/lib/ham/band-colours";
import { BAND_NAMES } from "@/lib/ham/bands";

/** Bands present in a set of points, in wavelength order, with their colour and count. */
export function bandsPresent(points: readonly { band: string }[]): { band: string; colour: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const p of points) {
    const b = p.band.toUpperCase();
    counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  // Unknown bands sort last rather than first.
  const rank = (b: string) => {
    const i = BAND_NAMES.indexOf(b);
    return i === -1 ? 999 : i;
  };
  return [...counts.entries()]
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([band, count]) => ({ band, colour: colourFor(band), count }));
}

/** "12 s ago", "4 min ago", "2 h ago". */
export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
}
