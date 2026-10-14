
import { prisma } from "@/lib/db/prisma";
import {
  parseActivityJson,
  parsePredictorHtml,
  type FeedEvent,
} from "@/lib/contest/ft8battle-feed";

export const ACTIVITY_URL = "https://ft8battle.com/data/activity.json";
export const PREDICTOR_URL = "https://ft8battle.com/steal-predictor.php";

export const POLL_ACTIVE_MS = 20_000;
export const POLL_IDLE_MS = 60_000;
export const KEEP_MS = 48 * 3_600_000;
const FETCH_TIMEOUT_MS = 10_000;

const USER_AGENT = "DigiShack";

async function fetchText(url: string): Promise<string> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
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
  brMode: () => Promise<boolean>;
  log: (line: string) => void;
}

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
