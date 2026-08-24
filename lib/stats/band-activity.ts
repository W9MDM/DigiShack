// Band activity, derived from this station's own decode history.
//
// Not a propagation forecast and not a model. Every number here is something this
// receiver actually heard on this antenna — which is the one thing no website can
// tell you, and rather more useful than a global index when deciding where to point
// the radio next.
//
// The honesty constraint that shapes the whole thing: DigiShack listens to ONE band
// at a time. So "20 m is open" is never knowable in the present tense for a band we
// are not on. What IS knowable is when we last heard anything there and how much,
// and a display that admits the difference is worth more than one that implies live
// knowledge of nine bands from a single receiver.

import { prisma } from "@/lib/db/prisma";

/** Rows older than this are not worth reporting on. */
const HORIZON_MS = 24 * 3_600_000;

/** Heard within this long counts as live. */
const LIVE_MS = 20 * 60_000;

/** Heard within this long is recent enough to be worth a try. */
const RECENT_MS = 3 * 3_600_000;

export type BandState = "live" | "recent" | "stale" | "unheard";

export interface BandActivity {
  band: string;
  /** Decodes in the last 24 hours. */
  decodes: number;
  /** Distinct callsigns heard — a better measure of "busy" than raw decodes. */
  stations: number;
  /** Best SNR heard in the window, or null. */
  bestSnr: number | null;
  /** Minutes since the last decode, or null if never heard in the window. */
  minutesAgo: number | null;
  state: BandState;
}

export interface BandActivityReport {
  /** Bands we have heard something on, busiest first. */
  bands: BandActivity[];
  /** The band currently being decoded, if the radio is up. */
  current: string | null;
  /** Total decodes in the window, across all bands. */
  total: number;
  windowHours: number;
}

function classify(minutesAgo: number | null): BandState {
  if (minutesAgo === null) return "unheard";
  const ms = minutesAgo * 60_000;
  if (ms <= LIVE_MS) return "live";
  if (ms <= RECENT_MS) return "recent";
  return "stale";
}

/**
 * Summarise what has been heard per band in the last 24 hours.
 *
 * Distinct callsigns rather than decode count is the headline figure: one station
 * calling CQ into a dead band for an hour produces plenty of decodes and means the
 * band is empty, while ten stations in five minutes means it is open.
 */
export async function computeBandActivity(current: string | null): Promise<BandActivityReport> {
  const since = new Date(Date.now() - HORIZON_MS);

  const grouped = await prisma.digitalDecode.groupBy({
    by: ["band"],
    where: { timestamp: { gte: since } },
    _count: { _all: true },
    _max: { timestamp: true, snr: true },
  });

  // Callsign is not a column on DigitalDecode, so distinct stations come from the
  // messages — and the sample is taken PER BAND.
  //
  // A single capped query ordered by time looked cheaper and was wrong: the cap was
  // filled entirely by the busiest recent band, so quiet or older bands reported
  // "0 stations" next to a non-zero decode count. Visibly contradictory, and it
  // would read as a bug rather than as a sampling limit.
  const perBand = await Promise.all(
    grouped.map(async (g) => ({
      band: g.band,
      rows: await prisma.digitalDecode.findMany({
        where: { band: g.band, timestamp: { gte: since } },
        select: { band: true, message: true },
        orderBy: { timestamp: "desc" },
        take: 3_000,
      }),
    })),
  );
  const rows = perBand.flatMap((p) => p.rows);

  const callsPerBand = new Map<string, Set<string>>();
  for (const r of rows) {
    // The last token of a standard message is a grid or report; the callsigns are
    // the first two. Taking both covers "CQ K9XYZ EN52" and "K1ABC K9XYZ -12"
    // without needing the full parser here.
    const parts = r.message.trim().toUpperCase().split(/\s+/);
    const set = callsPerBand.get(r.band) ?? new Set<string>();
    for (const p of parts.slice(0, 2)) {
      if (/^[A-Z0-9/]{3,}$/.test(p) && p !== "CQ" && p !== "DE" && p !== "QRZ") set.add(p);
    }
    callsPerBand.set(r.band, set);
  }

  const now = Date.now();
  const bands: BandActivity[] = grouped.map((g) => {
    const last = g._max.timestamp?.getTime() ?? null;
    const minutesAgo = last === null ? null : Math.round((now - last) / 60_000);
    return {
      band: g.band,
      decodes: g._count._all,
      stations: callsPerBand.get(g.band)?.size ?? 0,
      bestSnr: g._max.snr ?? null,
      minutesAgo,
      state: classify(minutesAgo),
    };
  });

  // Live first, then by how many distinct stations were heard. A band we are on
  // right now belongs at the front regardless.
  const order: Record<BandState, number> = { live: 0, recent: 1, stale: 2, unheard: 3 };
  bands.sort((a, b) => {
    if (a.band === current) return -1;
    if (b.band === current) return 1;
    if (order[a.state] !== order[b.state]) return order[a.state] - order[b.state];
    return b.stations - a.stations;
  });

  return {
    bands,
    current,
    total: bands.reduce((a, b) => a + b.decodes, 0),
    windowHours: HORIZON_MS / 3_600_000,
  };
}
