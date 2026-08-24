// POTA (Parks on the Air) activator spots.
//
// The public feed at api.pota.app needs no key and no registration. It returns
// currently-active spots only — an activator drops off the list when they stop
// being spotted, so this is "who is on the air right now", not a history.
//
// Verified against the live API: 28 spots, 8 of them FT8/FT4, each carrying the
// park reference, a 4- and 6-character grid, frequency in kHz as a STRING, and
// an `expire` countdown in seconds.

import { freqToBand } from "@/lib/ham/bands";

const SPOT_URL = "https://api.pota.app/spot/activator";

/** The fields we use. The API sends more; the rest are ignored deliberately. */
interface RawSpot {
  spotId: number;
  activator: string;
  /** kHz, as a string — "7041", occasionally with decimals. */
  frequency: string;
  mode: string | null;
  reference: string;
  name: string | null;
  locationDesc: string | null;
  grid4: string | null;
  grid6: string | null;
  spotTime: string;
  comments: string | null;
  /** Set when the spot has been flagged bad. */
  invalid: unknown;
  /** Seconds until the spot ages out. */
  expire: number;
}

export interface PotaSpot {
  spotId: number;
  activator: string;
  freqHz: number;
  band: string | null;
  mode: string;
  reference: string;
  parkName: string | null;
  /** e.g. "US-TX" — the POTA location, useful for state chasing. */
  location: string | null;
  grid: string | null;
  spottedAt: Date;
  comments: string | null;
  expiresInSec: number;
}

export interface FetchSpotsOptions {
  /** Only these modes (upper-case). Default: FT8 and FT4. */
  modes?: string[];
  /** Only these bands. Default: all. */
  bands?: string[];
  timeoutMs?: number;
}

/**
 * Parse a POTA frequency string (kHz) into Hz.
 *
 * Returns null rather than guessing on anything unparseable: a wrong frequency
 * here would retune the radio somewhere it should not be.
 */
export function potaFreqToHz(freq: string | null | undefined): number | null {
  if (!freq) return null;
  const khz = Number(String(freq).trim());
  if (!Number.isFinite(khz) || khz <= 0) return null;
  const hz = Math.round(khz * 1000);
  // Sanity: 1.8 MHz to 1.3 GHz covers every amateur allocation POTA uses.
  if (hz < 1_800_000 || hz > 1_300_000_000) return null;
  return hz;
}

/** Fetch current activator spots, filtered and normalised. */
export async function fetchPotaSpots(
  opts: FetchSpotsOptions = {},
): Promise<PotaSpot[]> {
  const modes = (opts.modes ?? ["FT8", "FT4"]).map((m) => m.toUpperCase());

  const res = await fetch(SPOT_URL, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  });
  if (!res.ok) throw new Error(`POTA spots returned HTTP ${res.status}`);

  const raw = (await res.json()) as RawSpot[];
  if (!Array.isArray(raw)) throw new Error("POTA spots: unexpected response shape");

  const out: PotaSpot[] = [];
  for (const s of raw) {
    if (s.invalid) continue;
    const mode = (s.mode ?? "").toUpperCase();
    if (modes.length > 0 && !modes.includes(mode)) continue;

    const freqHz = potaFreqToHz(s.frequency);
    if (freqHz === null) continue;

    const band = freqToBand(freqHz);
    if (opts.bands && opts.bands.length > 0 && (!band || !opts.bands.includes(band))) {
      continue;
    }

    out.push({
      spotId: s.spotId,
      activator: s.activator.toUpperCase(),
      freqHz,
      band,
      mode,
      reference: s.reference,
      parkName: s.name,
      location: s.locationDesc,
      grid: s.grid4 ?? s.grid6?.slice(0, 4) ?? null,
      // The API sends naive UTC timestamps with no zone marker.
      spottedAt: new Date(`${s.spotTime}Z`),
      comments: s.comments,
      expiresInSec: s.expire,
    });
  }

  // Freshest first — an activator spotted a minute ago is likelier to still be
  // there than one spotted twenty minutes ago.
  out.sort((a, b) => b.spottedAt.getTime() - a.spottedAt.getTime());
  return out;
}

/**
 * Current spots, memoised for a minute, keyed by nothing — the full digital list.
 *
 * The decode page asks "which of these 120 stations is worth calling" on every
 * cycle, and the answer needs the park reference for anyone currently activating.
 * Fetching POTA per cycle would be several requests a minute from one station
 * against a volunteer-run service; /api/pota/spots already keeps its own 60 s cache
 * for the same reason, and this is the same bargain for the scoring path.
 *
 * Never throws. A station whose park lookup failed is scored on its other axes,
 * which is what the auto-operator does when the feed is down.
 */
let spotMemo: { at: number; spots: PotaSpot[] } | null = null;
const SPOT_MEMO_MS = 60_000;

export async function cachedPotaSpots(): Promise<PotaSpot[]> {
  if (spotMemo && Date.now() - spotMemo.at < SPOT_MEMO_MS) return spotMemo.spots;
  try {
    const spots = await fetchPotaSpots({});
    spotMemo = { at: Date.now(), spots };
    return spots;
  } catch {
    // Serve a stale list rather than nothing: a ten-minute-old park reference is
    // still very likely correct, and losing the badge entirely is the worse answer.
    return spotMemo?.spots ?? [];
  }
}
