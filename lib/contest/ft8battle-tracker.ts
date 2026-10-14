// Keeping the FT8 Battle Royale feed, so BR mode can see further back than fifty events.
//
// WHY A TABLE AND NOT MEMORY. activity.json holds the last fifty events - about an hour -
// and the predictor list about two. The bridge restarts several times a day (the audio
// watchdog, deploys), and a tracker that forgot the morning on every restart would show BR
// mode an empty "last two hours" exactly when the operator had just turned it on. Rows go
// in Ft8brActivity and come out through /api/contest/ft8battle; a day of them is kept,
// because FT8BR scores by UTC day and a holding from 02:00 still matters at 22:00.
//
// CADENCE. Their ticker overlay polls every 10 s per viewer. This polls every 20 s while BR
// mode is on and every 60 s while it is off - off, the point is only that the last couple
// of hours exist when the switch is thrown - and reads the 120 kB predictor page once, at
// start, to seed the window. One identified client, a few requests a minute, read-only.
//
// FIRE AND FORGET, like the UDP broadcast: this runs beside the radio and must never take
// it down. Every failure is caught; the first is logged and the rest are quiet until it
// recovers, so a site outage costs one line, not one per poll.

import { prisma } from "@/lib/db/prisma";
import {
  parseActivityJson,
  parsePredictorHtml,
  type FeedEvent,
} from "@/lib/contest/ft8battle-feed";

export const ACTIVITY_URL = "https://ft8battle.com/data/activity.json";
export const PREDICTOR_URL = "https://ft8battle.com/steal-predictor.php";

/** While BR mode is on / off. */
export const POLL_ACTIVE_MS = 20_000;
export const POLL_IDLE_MS = 60_000;
/** How much history to keep. A UTC day is what their scoring sees; this covers it twice. */
export const KEEP_MS = 48 * 3_600_000;
const FETCH_TIMEOUT_MS = 10_000;

const USER_AGENT = "DigiShack";

async function fetchText(url: string): Promise<string> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    // A cache-buster, as their own page sends one: the file is rewritten in place and a
    // proxy between here and there would otherwise be free to answer with the last one.
    const sep = url.includes("?") ? "&" : "?";
    const res = await fetch(`${url}${sep}t=${Date.now()}`, {
      headers: { "user-agent": USER_AGENT, accept: "application/json, text/html" },
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

const whereKey = (e: FeedEvent) => ({
  at: e.at,
  station: e.station,
  contact: e.contact,
  band: e.band,
  mode: e.mode,
});

/**
 * Store feed events. The feed knows points; a row the predictor seeded does not, so a feed
 * row REPLACES a predictor row for the same moment rather than being skipped as a duplicate.
 */
export async function recordActivity(events: FeedEvent[]): Promise<number> {
  let added = 0;
  for (const e of events) {
    const existing = await prisma.ft8brActivity.findUnique({
      where: { at_station_contact_band_mode: whereKey(e) },
      select: { id: true, source: true },
    });
    if (existing && existing.source === "activity") continue;
    if (existing) {
      await prisma.ft8brActivity.update({
        where: { id: existing.id },
        data: {
          type: e.type,
          points: e.points,
          victim: e.victim,
          stolen: e.stolen,
          first: e.first,
          source: "activity",
        },
      });
    } else {
      await prisma.ft8brActivity.create({ data: { ...e } });
    }
    added++;
  }
  return added;
}

/** Store predictor holdings. Never overwrites: anything already known is better. */
export async function recordPredictor(events: FeedEvent[]): Promise<number> {
  if (events.length === 0) return 0;
  const r = await prisma.ft8brActivity.createMany({
    data: events.map((e) => ({ ...e })),
    skipDuplicates: true,
  });
  return r.count;
}

export async function pollActivity(): Promise<{ seen: number; added: number }> {
  const events = parseActivityJson(await fetchText(ACTIVITY_URL));
  return { seen: events.length, added: await recordActivity(events) };
}

export async function seedFromPredictor(): Promise<{ seen: number; added: number }> {
  const events = parsePredictorHtml(await fetchText(PREDICTOR_URL));
  return { seen: events.length, added: await recordPredictor(events) };
}

export async function pruneActivity(now = new Date()): Promise<number> {
  const r = await prisma.ft8brActivity.deleteMany({
    where: { at: { lt: new Date(now.getTime() - KEEP_MS) } },
  });
  return r.count;
}

export interface TrackerOptions {
  /** Is BR mode on? Read each tick, through the settings cache. */
  brMode: () => Promise<boolean>;
  log: (line: string) => void;
}

/**
 * Start polling. Returns a handle; `stop()` on teardown.
 *
 * A timeout chain rather than an interval, so the cadence can follow BR mode and a slow
 * fetch cannot overlap the next one.
 */
export function startFt8brTracker(o: TrackerOptions): { stop(): void } {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let failing = false;
  let seeded = false;
  let polls = 0;

  const tick = async () => {
    if (stopped) return;
    let delay = POLL_IDLE_MS;
    try {
      const on = await o.brMode();
      delay = on ? POLL_ACTIVE_MS : POLL_IDLE_MS;
      if (!seeded) {
        seeded = true;
        try {
          const s = await seedFromPredictor();
          o.log(`[ft8br] seeded ${s.added} holding(s) from the steal predictor (${s.seen} listed)`);
        } catch (err) {
          // The predictor page is a rendered HTML page with a JS literal in it, which is a
          // less stable thing to read than a JSON file. Losing it costs the first two hours
          // after a restart, nothing more, so it is one line and on with the feed.
          o.log(`[ft8br] could not seed from the steal predictor: ${err instanceof Error ? err.message : err}`);
        }
      }
      const r = await pollActivity();
      polls++;
      if (failing) {
        failing = false;
        o.log(`[ft8br] feed is back (${r.added} new of ${r.seen})`);
      } else if (polls === 1) {
        o.log(`[ft8br] tracking the Battle Royale feed: ${r.added} new of ${r.seen}, every ${delay / 1000} s`);
      }
      if (polls % 30 === 0) await pruneActivity();
    } catch (err) {
      if (!failing) {
        failing = true;
        o.log(`[ft8br] feed failed: ${err instanceof Error ? err.message : err} - will keep trying quietly`);
      }
    }
    if (!stopped) timer = setTimeout(() => void tick(), delay);
  };

  timer = setTimeout(() => void tick(), 5_000);
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
