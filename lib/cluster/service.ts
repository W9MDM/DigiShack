// The DX cluster, as the bridge runs it.
//
// Everything is here so the bridge's own hunk stays three lines: start this, broadcast what
// it hands back, serve its snapshot. It reads `cluster.*` every 15 seconds and reconnects
// when they change, so turning the cluster on or pointing it at another node needs no
// bridge restart.
//
// The settings cache in this process lives 30 seconds (lib/settings), and a plain re-read
// every poll would lag a change by up to 45. So each poll reads the `cluster.*` rows
// directly — one indexed query — and only when they differ from the last poll is the cache
// dropped and the values resolved properly, defaults and all.

import { prisma } from "@/lib/db/prisma";
import { SpotBook } from "@/lib/cluster/book";
import { ClusterClient } from "@/lib/cluster/client";
import { dxccDataMissing, entityForCall } from "@/lib/cluster/entity";
import { workedSlots } from "@/lib/cluster/needed";
import { isCallsign } from "@/lib/cluster/parse";
import type { ClusterLinkState, ClusterSnapshot, ClusterSpot } from "@/lib/cluster/types";
import {
  getBooleanSetting,
  getNumberSetting,
  getSetting,
  invalidateSettingsCache,
} from "@/lib/settings";

const CONFIG_POLL_MS = 15_000;
/**
 * Lines waiting on a DXCC lookup before new spots skip the lookup. A slow database must
 * not turn into an unbounded queue in the process that owns the radio.
 */
const MAX_PENDING = 200;
/** Only used when the registry somehow has no default. */
const FALLBACK_PORT = 7300;

export interface ClusterConfig {
  enabled: boolean;
  host: string;
  port: number;
  login: string | null;
}

/** "n0call-2" -> "N0CALL-2"; null for anything that is not a callsign with an optional SSID. */
export function normaliseLogin(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim().toUpperCase();
  const m = /^([A-Z0-9/]+)(-\d{1,2})?$/.exec(s);
  if (!m || !isCallsign(m[1]!)) return null;
  return s;
}

async function readConfig(): Promise<ClusterConfig> {
  const enabled = await getBooleanSetting("cluster.enabled", false);
  const host = ((await getSetting("cluster.host")) ?? "").trim();
  const rawPort = await getNumberSetting("cluster.port", FALLBACK_PORT);
  const port = Number.isInteger(rawPort) && rawPort > 0 && rawPort < 65_536 ? rawPort : FALLBACK_PORT;
  let login = normaliseLogin(await getSetting("cluster.login"));
  if (!login && enabled) {
    // The station, as everywhere else in the bridge: the first one created.
    const station = await prisma.station.findFirst({
      orderBy: { createdAt: "asc" },
      select: { callsign: true },
    });
    login = normaliseLogin(station?.callsign);
  }
  return { enabled, host, port, login };
}

export interface ClusterService {
  snapshot(): Promise<ClusterSnapshot>;
  stop(): Promise<void>;
}

export function startClusterService(opts: {
  onSpot: (spot: ClusterSpot) => void;
  log?: (line: string) => void;
}): ClusterService {
  const log = opts.log ?? ((line: string) => console.log(line));
  const book = new SpotBook({ entityFor: entityForCall, slots: workedSlots });
  let config: ClusterConfig | null = null;
  let client: ClusterClient | null = null;
  let fingerprint: string | null = null;
  let chain: Promise<void> = Promise.resolve();
  let pending = 0;
  let stopped = false;
  let lastPollError: string | null = null;

  const onLine = (line: string) => {
    pending++;
    const enrich = pending <= MAX_PENDING;
    // One at a time, so spots keep the node's order and a dupe always sees the spot it repeats.
    chain = chain.then(async () => {
      try {
        const spot = await book.ingest(line, { enrich });
        if (spot) opts.onSpot(spot);
      } catch (err) {
        log(`[cluster] spot dropped: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        pending--;
      }
    });
  };

  const apply = (next: ClusterConfig) => {
    const prev = config;
    config = next;
    const runnable = next.enabled && next.login !== null && next.host !== "";
    const same =
      prev !== null &&
      prev.enabled === next.enabled &&
      prev.host === next.host &&
      prev.port === next.port &&
      prev.login === next.login;
    if (same && (client !== null) === runnable) return;

    if (client) {
      const old = client;
      client = null;
      void old.stop();
      log(`[cluster] disconnected from ${old.status.host}:${old.status.port}`);
    }
    if (runnable) {
      client = new ClusterClient({ host: next.host, port: next.port, login: next.login!, onLine, log });
      client.start();
      log(`[cluster] connecting to ${next.host}:${next.port} as ${next.login}`);
    } else if (next.enabled && !next.login) {
      log("[cluster] enabled, but there is no callsign to log in with — set cluster.login or create a station");
    }
  };

  const poll = async () => {
    if (stopped) return;
    try {
      const rows = await prisma.setting.findMany({
        where: { key: { startsWith: "cluster." } },
        select: { key: true, value: true },
      });
      const fp = rows
        .map((r) => `${r.key}=${r.value}`)
        .sort()
        .join("\n");
      if (fingerprint !== null && fp !== fingerprint) invalidateSettingsCache();
      fingerprint = fp;
      apply(await readConfig());
      lastPollError = null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Once per distinct failure: a database outage would otherwise log every 15 s.
      if (msg !== lastPollError) log(`[cluster] could not read the cluster settings: ${msg}`);
      lastPollError = msg;
    }
  };

  void poll();
  const timer = setInterval(() => void poll(), CONFIG_POLL_MS);
  timer.unref?.();

  return {
    async snapshot(): Promise<ClusterSnapshot> {
      await book.refreshNeeded().catch(() => {});
      const st = client?.status ?? null;
      const enabled = config?.enabled ?? false;
      let state: ClusterLinkState = "off";
      if (enabled && !config?.login) state = "no-login";
      else if (enabled && st) {
        state =
          st.state === "connected" || st.state === "login" || st.state === "waiting"
            ? st.state
            : "connecting";
      }
      return {
        enabled,
        state,
        host: config?.host ?? "",
        port: config?.port ?? FALLBACK_PORT,
        login: config?.login ?? null,
        connectedAt: st?.connectedAt ?? null,
        lastLineAt: st?.lastRxAt ?? null,
        lastError: st?.lastError ?? lastPollError,
        nextRetryAt: st?.nextRetryAt ?? null,
        attempt: st?.attempt ?? 0,
        counts: { ...book.counts },
        dxccMissing: dxccDataMissing(),
        spots: book.list(),
      };
    },
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      const c = client;
      client = null;
      await c?.stop();
    },
  };
}
