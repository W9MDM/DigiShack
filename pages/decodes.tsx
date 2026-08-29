import type { GetServerSidePropsContext } from "next";
import { parseMessage } from "@/lib/digital/qso";
import { occupiedFrom, pickClearSlot, type ClearSlot } from "@/lib/digital/slot";
import { assessClock } from "@/lib/digital/clock-offset";
import { formatUtcTime } from "@/lib/time";
import { BandConditions } from "@/components/digital/BandConditions";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Waterfall, type WaterfallMarker } from "@/components/digital/Waterfall";
import {
  Badge,
  Button,
  Card,
  ErrorBanner,
  Input,
  PageHeader,
  Select,
} from "@/components/ui/primitives";
import { SourcePicker } from "@/components/radio/SourcePicker";
import { withPageAuth } from "@/lib/auth/guard";
import { bridgeWsUrl } from "@/lib/bridge/ws-url";
import { ApiError, apiPost, useApi } from "@/lib/client/api";
import { useCan } from "@/lib/client/session";
import { formatFreqMHz } from "@/lib/ham/bands";
import { gridFromMessage } from "@/lib/ham/grid-message";
import {
  DIGITAL_FREQUENCIES,
  frequenciesForRegion,
  ituRegionFromGrid,
  type DigitalMode,
} from "@/lib/ham/digital-freqs";
import { cn } from "@/lib/utils";

interface RigStatus {
  connected: boolean;
  dialFrequency: number | null;
  band: string | null;
  mode: string | null;
  subMode: string | null;
  deCall: string | null;
  deGrid: string | null;
  transmitting: boolean;
  decoding: boolean;
  txEnabled: boolean;
  /** flex.allowTransmit — the master gate. See services/radio/index.ts. */
  allowTransmit?: boolean;
  rxDF: number | null;
  txDF: number | null;
  rfPower: number | null;
  commandChannel: boolean;
  /** Which radio the bridge is driving, as the radio itself reports it. */
  radio?: { vendor: string; model: string; host: string } | null;
  /** Which source is SELECTED, connected or not. The picker reads this. */
  source?: "flex" | "icom" | "wsjtx";
  /**
   * Network transit to the radio, measured by the bridge. `oneWayMs` is what keying
   * and decode windows are being shifted by — non-zero means a VPN or a remote radio,
   * already compensated for. See lib/radio/link-latency.ts.
   */
  link?: { rttMs: number; oneWayMs: number } | null;
  /** The operating schedule's current decision. Null when no schedule is enabled. */
  schedule?: { mode: string; reason: string; suppressed: boolean } | null;
}

interface DecodeEvent {
  kind: "decode";
  timestamp: string;
  snr: number;
  deltaTime: number;
  freqOffset: number;
  mode: string;
  band: string | null;
  message: string;
  callsign: string | null;
  lowConfidence: boolean;
}

interface SpectrumMsg {
  kind: "spectrum";
  bins: string;
  binHz: number;
  maxHz: number;
  at: number;
  mode: string;
  periodMs: number;
}

/** What the bridge measured against a time server. See lib/time/clock.ts. */
interface ClockSync {
  /** Correction in force, milliseconds. Positive means the OS clock is slow. */
  offsetMs: number;
  /** What the last measurement said, applied or not. */
  measuredMs: number | null;
  delayMs: number | null;
  source: string | null;
  at: number | null;
  /** Why a measurement was not applied, when it was not. */
  refused: string | null;
}

interface Telemetry {
  paTempC: number | null;
  swr: number | null;
  voltsPa: number | null;
  fanRpm: number | null;
  reflectedDbm: number | null;
  at: number;
}

interface AutoState {
  mode: "off" | "cq" | "hunt" | "hunt-pota" | "pota-chase";
  cqParity: 0 | 1 | null;
  cqOffsetHz: number | null;
  warmup: number;
  pausedReason: string | null;
  lastAction: string | null;
  /** Stations that called us mid-QSO, oldest first — the call-back queue. */
  waiting?: string[];
}

interface QsoState {
  active: boolean;
  theirCall: string | null;
  state: string | null;
  lastSent: string | null;
  txParity: 0 | 1 | null;
  txOffsetHz: number | null;
  pausedReason: string | null;
}

interface Props extends Record<string, unknown> {
  wsUrl: string;
  bridgePort: number;
}

const MAX_ROWS = 500;

/**
 * A pleasant two-note ding for a logged QSO, synthesised on the spot — no audio
 * asset to ship. Browsers only allow audio after a user gesture, so the context
 * is created lazily and failures (autoplay policy, no speakers) are ignored:
 * a missed ding must never break anything.
 */
let dingCtx: AudioContext | null = null;
function playDing(): void {
  try {
    dingCtx ??= new AudioContext();
    const ctx = dingCtx;
    if (ctx.state === "suspended") void ctx.resume();
    const t0 = ctx.currentTime;
    for (const [freq, at] of [
      [880, 0],
      [1318.5, 0.12], // E6 over A5 — a major-third "task complete" chime
    ] as const) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.001, t0 + at);
      gain.gain.exponentialRampToValueAtTime(0.18, t0 + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + at + 0.6);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + at);
      osc.stop(t0 + at + 0.65);
    }
  } catch {
    /* no audio available — fine */
  }
}

/** base64 -> Uint8Array, without pulling in a dependency for it. */
function decodeBins(b64: string): Uint8Array {
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export default function DigitalPage({ wsUrl }: Props) {
  const [status, setStatus] = useState<RigStatus | null>(null);
  const [rows, setRows] = useState<DecodeEvent[]>([]);

  // Why each station is worth calling — the same scoring Auto Hunt ranks by, so the
  // badges an operator sees and the choices the software makes cannot disagree.
  const [worth, setWorth] = useState<Map<string, string[]>>(new Map());

  // Contacts today. A single indexed COUNT behind /api/stats/today, refreshed on
  // every logged contact and on a slow poll so the day rolls over at 00:00 UTC
  // without a page reload.
  const { data: todayStats, reload: reloadToday } = useApi<{
    today: number;
    lastAt: string | null;
    lastCallsign: string | null;
  }>("/api/stats/today");
  const [spectrum, setSpectrum] = useState<{ bins: Uint8Array; at: number } | null>(null);
  const [scale, setScale] = useState({ binHz: 5.86, maxHz: 3000, periodMs: 15000 });
  const [connected, setConnected] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState<
    "all" | "cq" | "cq-pota" | "cq-dx" | "worth" | "me"
  >("all");
  /**
   * Free-text search across the decode list.
   *
   * The six-way picker below answers "show me a KIND of station" and could not answer
   * "is W1AW on the air", which is the question an operator actually asks when someone
   * says they are calling. There was no way to ask it at all: 500 rows scrolling past at
   * one screenful per cycle, and Ctrl-F only ever finds what is currently mounted.
   */
  const [search, setSearch] = useState("");
  /**
   * Where to transmit so as not to sit on somebody.
   *
   * A closure rather than a value because it must be evaluated when the operator ASKS —
   * a band re-reads itself every cycle, and a suggestion computed on mount would be
   * stale by the time anyone pressed the button.
   */
  const suggestSlot = useCallback(
    (): ClearSlot => pickClearSlot(occupiedFrom(rows, Date.now())),
    [rows],
  );

  const [gain, setGain] = useState(1);
  const [lastAt, setLastAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [smeter, setSmeter] = useState<{
    dbm: number;
    fwdDbm: number | null;
    at: number;
  } | null>(null);
  /** Decode row the operator clicked, i.e. the station to work. */
  const [target, setTarget] = useState<DecodeEvent | null>(null);
  const [qso, setQso] = useState<QsoState | null>(null);
  const [auto, setAuto] = useState<AutoState | null>(null);
  const [lastTx, setLastTx] = useState<string | null>(null);
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null);
  const [clockSync, setClockSync] = useState<ClockSync | null>(null);
  const [syncing, setSyncing] = useState(false);

  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  // The tx-result line belongs to one QSO; a new target must not inherit the
  // previous one's last transmission.
  const qsoCall = qso?.theirCall ?? null;
  useEffect(() => {
    setLastTx(null);
  }, [qsoCall]);

  const { data: fallback } = useApi<{
    running: boolean;
    reason?: string;
    status: RigStatus | null;
    recentDecodes: DecodeEvent[];
    clock?: ClockSync | null;
    qso?: QsoState | null;
    auto?: AutoState | null;
  }>("/api/bridge/status");

  useEffect(() => {
    if (!fallback) return;
    if (fallback.status) setStatus((s) => s ?? fallback.status);
    if (fallback.clock) setClockSync((c) => c ?? fallback.clock ?? null);
    // The bridge's /status has always reported these; the page used to drop them,
    // which left the Auto operate row saying "Off" mid-hunt whenever the socket
    // was slow to deliver its first push.
    if (fallback.auto) setAuto((a) => a ?? fallback.auto ?? null);
    if (fallback.qso) setQso((q) => q ?? fallback.qso ?? null);
    if (fallback.recentDecodes?.length) {
      setRows((r) => (r.length === 0 ? [...fallback.recentDecodes].reverse() : r));
    }
  }, [fallback]);

  // Drives the cycle-progress bar. One second is enough — the bar shows where you
  // are in a 15s or 7.5s window, not a stopwatch.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const push = useCallback((event: DecodeEvent) => {
    if (pausedRef.current) return;
    setRows((prev) => {
      // Reject a decode already in the list.
      //
      // A decode is uniquely identified by its window, audio offset and text — the
      // same station cannot send two different things at one frequency in one
      // window. The leaked-socket bug above was one way to get duplicates; a bridge
      // restart replaying its backlog is another, and so is any future second
      // delivery path. Dedup here means none of them reach the operator, and the
      // capped list holds distinct stations rather than copies.
      const dup = prev.some(
        (r) =>
          r.timestamp === event.timestamp &&
          r.freqOffset === event.freqOffset &&
          r.message === event.message,
      );
      if (dup) return prev;
      return [event, ...prev].slice(0, MAX_ROWS);
    });
    setLastAt(Date.now());
  }, []);

  // Reconnecting socket: the bridge is a separate process that restarts on its
  // own, so a drop is routine and must not need a page reload.
  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let backoff = 1_000;
    // Held OUTSIDE connect() so the cleanup can actually close it.
    //
    // This used to be a `let ws` inside connect(), unreachable from the returned
    // cleanup, which therefore only set `closed = true` and cleared the retry timer
    // — it never closed the socket. Every re-run of this effect left the previous
    // socket open and still delivering, and React's development double-mount
    // guarantees at least one re-run. With three live sockets each decode arrived
    // three times and `push` appended it three times: exact triplicates, identical
    // in every column. It also silently tripled the load on the bridge and, because
    // the row list is capped, cut the number of DISTINCT stations visible to a
    // third.
    let socket: WebSocket | null = null;

    const connect = () => {
      if (closed) return;
      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl);
      } catch {
        retry = setTimeout(connect, backoff);
        return;
      }
      socket = ws;

      ws.onopen = () => {
        setConnected(true);
        backoff = 1_000;
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string);
          if (msg.kind === "status") setStatus(msg.status);
          else if (msg.kind === "decode") push(msg as DecodeEvent);
          else if (msg.kind === "spectrum") {
            const s = msg as SpectrumMsg;
            // The waterfall keeps running while paused: pausing is about the
            // decode list scrolling away from you, not about freezing the band.
            setSpectrum({ bins: decodeBins(s.bins), at: s.at });
            setScale({ binHz: s.binHz, maxHz: s.maxHz, periodMs: s.periodMs });
          } else if (msg.kind === "backlog" && Array.isArray(msg.decodes)) {
            setRows((prev) => (prev.length === 0 ? [...msg.decodes].reverse() : prev));
          } else if (msg.kind === "smeter") {
            setSmeter({
              dbm: msg.dbm as number,
              fwdDbm: (msg.fwdDbm as number | null) ?? null,
              at: msg.at as number,
            });
          } else if (msg.kind === "qso") {
            setQso(msg.qso as QsoState);
          } else if (msg.kind === "auto") {
            setAuto(msg.auto as AutoState);
          } else if (msg.kind === "telemetry") {
            setTelemetry(msg.telemetry as Telemetry);
          } else if (msg.kind === "clock") {
            setClockSync(msg.clock as ClockSync);
          } else if (msg.kind === "qso-logged") {
            playDing();
            void reloadToday();
          } else if (msg.kind === "qso-tx") {
            setLastTx(
              msg.sent ? (msg.message as string) : `refused: ${msg.reason}`,
            );
          }
        } catch {
          /* skip a malformed frame rather than dropping the socket */
        }
      };

      ws.onclose = () => {
        setConnected(false);
        if (closed) return;
        setAttempts((a) => a + 1);
        retry = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 15_000);
      };

      ws.onerror = () => ws.close();
    };

    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      // Drop the handlers before closing: onclose would otherwise fire during
      // teardown and schedule a reconnect for a socket nobody is listening to.
      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onclose = null;
        socket.onerror = null;
        try {
          socket.close();
        } catch {
          /* already closing */
        }
        socket = null;
      }
    };
  }, [wsUrl, push]);

  const myCall = status?.deCall?.toUpperCase() ?? null;

  const mentionsMe = useCallback(
    (msg: string) => myCall !== null && msg.toUpperCase().includes(myCall),
    [myCall],
  );

  const visible = useMemo(() => {
    // Search first, then the category filter, and the two AND together — a search that
    // silently widened the filter would be a different list from the one on screen.
    // Matched against the whole MESSAGE, not just the parsed callsign: a message names
    // both stations, so searching a call finds people calling them as well as their own
    // transmissions, and a grid or "POTA" finds those too.
    const needle = search.trim().toUpperCase();
    const searched = needle
      ? rows.filter(
          (r) =>
            r.message.toUpperCase().includes(needle) ||
            (r.callsign ?? "").toUpperCase().includes(needle),
        )
      : rows;

    if (filter === "all") return searched;
    if (filter === "me") return searched.filter((r) => mentionsMe(r.message));
    // "Worth working" is the auto-operator's own ranking, not a second opinion:
    // the same scoring behind the award badges on each row, so what the operator
    // filters to and what Auto Hunt would pick cannot disagree.
    if (filter === "worth") {
      return searched.filter((r) => r.callsign && (worth.get(r.callsign)?.length ?? 0) > 0);
    }
    // The CQ filters read the modifier the PARSER extracted rather than matching
    // text. "CQ POTA K9XYZ EN61" and "CQ K9XYZ EN61" differ by a token that
    // lib/digital/qso.ts already isolates, and a /CQ POTA/ regex would also match
    // a directed message that happens to mention it.
    return searched.filter((r) => {
      const p = parseMessage(r.message);
      if (p.kind !== "cq") return false;
      if (filter === "cq-pota") return p.modifier === "POTA";
      if (filter === "cq-dx") return p.modifier === "DX";
      return true;
    });
  }, [rows, filter, search, mentionsMe, worth]);

  /** Markers for the most recent cycle only — older ones aren't on screen. */
  const markers = useMemo<WaterfallMarker[]>(() => {
    if (rows.length === 0) return [];
    const newest = rows[0]!.timestamp;
    return rows
      .filter((r) => r.timestamp === newest)
      .map((r) => ({
        hz: r.freqOffset,
        label: r.message,
        emphasis: mentionsMe(r.message),
      }));
  }, [rows, mentionsMe]);

  const cyclePct = ((now % scale.periodMs) / scale.periodMs) * 100;

  /**
   * Decodes grouped into their transmit windows, newest first.
   *
   * Bucketed by the window a decode's timestamp falls in rather than by arrival:
   * decodes arrive in a burst after each window closes, so counting on arrival
   * would lump two windows together whenever a batch straddles the boundary.
   */
  // Median DT across the recent decodes. Propagation and other stations' own errors
  // are independent and cancel; what is left is our own offset.
  // Scored per cycle rather than per decode: the answer changes when a contact is
  // logged, not when the same station is heard again.
  useEffect(() => {
    const calls = [...new Set(rows.slice(0, 120).map((r) => r.callsign).filter(Boolean))];
    if (calls.length === 0) return;
    // Grids come from the message PARSER, not a regex.
    //
    // /[A-R]{2}\d{2}/ matches RR73 — R is inside A–R and 73 is two digits — so the FT8
    // sign-off reads as a grid square and every station finishing a QSO earns a
    // spurious "new grid RR73" badge. Caught by running the scoring against a live
    // band before shipping it: all seven stations it flagged were RR73.
    const grids: Record<string, string> = {};
    for (const r of rows.slice(0, 120)) {
      if (!r.callsign) continue;
      const parsed = parseMessage(r.message);
      const grid =
        parsed.kind === "cq"
          ? parsed.grid
          : parsed.kind === "directed" && parsed.payload.type === "grid"
            ? parsed.payload.grid
            : null;
      if (grid && !grids[r.callsign]) grids[r.callsign] = grid;
    }
    let cancelled = false;
    void apiPost<{ entries: { callsign: string; reasons: string[] }[] }>(
      "/api/digital/worth",
      { band: status?.band ?? null, calls, grids },
    )
      .then((r) => {
        if (cancelled) return;
        setWorth(new Map(r.entries.map((e) => [e.callsign, e.reasons])));
      })
      .catch(() => {
        /* scoring is an enhancement; the decode list works without it */
      });
    return () => {
      cancelled = true;
    };
    // Deliberately keyed on the newest decode rather than on `rows`: re-scoring on
    // every array change would fire a request per decode within a cycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows[0]?.timestamp, status?.band]);

  const clock = useMemo(() => assessClock(rows.slice(0, 200).map((r) => r.deltaTime)), [rows]);

  const recentCycles = useMemo(() => {
    const period = scale.periodMs;
    const buckets = new Map<number, number>();
    for (const r of rows) {
      const t = new Date(r.timestamp).getTime();
      if (Number.isNaN(t)) continue;
      const at = Math.floor(t / period) * period;
      buckets.set(at, (buckets.get(at) ?? 0) + 1);
    }
    return [...buckets.entries()]
      .map(([at, count]) => ({ at, count }))
      .sort((a, b) => b.at - a.at)
      .slice(0, 20);
  }, [rows, scale.periodMs]);

  const latestCycleCount = recentCycles[0]?.count ?? 0;
  // Scale the sparkline to its own peak; an absolute scale would flatten a quiet
  // band into nothing.
  const cyclePeak = Math.max(1, ...recentCycles.map((c) => c.count));
  const staleSeconds = lastAt ? Math.floor((now - lastAt) / 1000) : null;
  const decodingAs = status?.subMode ?? status?.mode ?? "—";

  // Which mode the band buttons retune to. All three have calling frequencies, so
  // the buttons keep the operator on the mode they are already decoding. FT8 is
  // the fallback when the radio has not reported a mode yet, being much the most
  // common watering hole.
  const tuneMode: DigitalMode =
    decodingAs === "FT4" ? "FT4" : decodingAs === "FT2" ? "FT2" : "FT8";

  return (
    <>
      <PageHeader
        title="Digital"
        subtitle={
          status?.dialFrequency
            ? // The radio comes first. Two are supported and both can be configured at
              // once, so "which one is this?" is the question the rest of the line
              // depends on — a frequency and a band mean something different depending
              // on which radio is sitting on them.
              [
                status.radio?.model,
                `${formatFreqMHz(status.dialFrequency)} MHz`,
                status.band ?? "?",
                `decoding ${decodingAs}`,
              ]
                .filter(Boolean)
                .join(" · ")
            : "FT8 / FT4 band activity"
        }
        actions={
          <>
            {/* Band conditions from our own decode history, in the empty header
                space. A prediction panel would need solar indices and a propagation
                model; this needs neither, and knows things a model cannot — that
                THIS antenna heard 302 stations on 40 m in the last day. */}
            <BandConditions currentBand={status?.band ?? null} mode={decodingAs} />
            {status?.transmitting && <Badge tone="danger">TX</Badge>}
            {/* The master transmit gate, which was visible nowhere.

                Bound to allowTransmit, NOT to txEnabled: the latter is WSJT-X's own
                flag and nothing sets it on the native Flex path, so a badge on it
                would read "off" permanently while the station transmitted. */}
            {status && (
              <Badge
                tone={status.allowTransmit ? "ok" : "warn"}
              >
                {status.allowTransmit ? "TX armed" : "TX off"}
              </Badge>
            )}
            {connected ? (
              <Badge tone="ok">Live</Badge>
            ) : (
              <Badge tone="warn">
                {attempts > 0 ? `Reconnecting (${attempts})` : "Connecting"}
              </Badge>
            )}
            <Button
              variant={paused ? "primary" : "secondary"}
              onClick={() => setPaused((p) => !p)}
            >
              {paused ? "Resume" : "Pause list"}
            </Button>
          </>
        }
      />

      {fallback && !fallback.running && !connected && (
        <div className="mb-4">
          <ErrorBanner>{fallback.reason ?? "The bridge is not running."}</ErrorBanner>
        </div>
      )}

      {/* The clock, judged from everyone else's DT.

          A clock drifting past a second or so produces a screen full of nothing,
          which looks exactly like a dead band, a wrong frequency or a broken audio
          path — and those are the three things an operator checks first, for an
          hour, before thinking of the clock. */}
      {/* Two different measurements of the same thing, kept separate on purpose.

          `clock` is the median DT across recent decodes: real, but it needs eight
          decodes before it will say anything, so on a quiet band it says nothing —
          and a station that cannot hear anybody is exactly the one wondering whether
          its clock is why. `clockSync` is an SNTP measurement, which answers in one
          round trip on a dead band. */}
      {(clock.message || clockSync?.refused || (clockSync && Math.abs(clockSync.offsetMs) > 0)) && (
        <div
          role="status"
          className={cn(
            "mb-4 rounded-sm border px-3 py-2 text-sm flex items-start gap-3",
            clock.verdict === "bad"
              ? "border-danger/40 bg-danger/10 text-danger"
              : clock.message || clockSync?.refused
                ? "border-warn/40 bg-warn/10 text-warn"
                : "border-line bg-surface-2 text-fg-muted",
          )}
        >
          <div className="flex-1">
            {clock.message}
            {clockSync && (
              <div className={clock.message ? "mt-1.5" : undefined}>
                <ClockSyncLine sync={clockSync} />
              </div>
            )}
          </div>
          <SyncNowButton
            busy={syncing}
            onSync={async () => {
              setSyncing(true);
              try {
                const r = await apiPost<{ clock?: ClockSync }>("/api/bridge/control", {
                  action: "time/sync",
                });
                if (r?.clock) setClockSync(r.clock);
              } catch {
                /* the banner keeps showing the last measurement, which is honest */
              } finally {
                setSyncing(false);
              }
            }}
          />
        </div>
      )}

      <WorkStationPanel
        target={target}
        qso={qso}
        auto={auto}
        suggestSlot={suggestSlot}
        lastTx={lastTx}
        myCall={myCall}
        myGrid={status?.deGrid ?? null}
        onClose={() => {
          setTarget(null);
          setLastTx(null);
        }}
      />

      <AutoPanel auto={auto} qso={qso} schedule={status?.schedule ?? null} />

      {/* Per-cycle decode count. The running total says how busy the session has
          been; the count for the cycle just finished is what tells you whether the
          band is open *now*, which is the number you actually watch. */}
      <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div className="flex items-end gap-6">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-fg-muted">
              This cycle
            </div>
            <div className="font-display text-3xl leading-none tnum text-accent-bright">
              {latestCycleCount}
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-fg-muted">
              Total decodes
            </div>
            <div className="font-display text-3xl leading-none tnum">
              {rows.length}
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-fg-muted">
              Last decode
            </div>
            <div className="font-display text-3xl leading-none tnum">
              {staleSeconds === null ? "—" : `${staleSeconds}s`}
            </div>
          </div>
          {/* Contacts, not decodes.
              Every other number here counts what was HEARD, which on a busy band
              climbs whether or not the station is achieving anything — four hours of
              chase mode produced 500 decodes an hour and no contacts, and nothing on
              this page distinguished that from a good session. This is the one figure
              that says whether the evening is working.

              From 00:00 UTC, the day the log runs on. */}
          <div title="Contacts logged since 00:00 UTC">
            <div className="text-[10px] uppercase tracking-wide text-fg-muted">
              QSOs today
            </div>
            <div
              className={cn(
                "font-display text-3xl leading-none tnum",
                (todayStats?.today ?? 0) > 0 ? "text-ok" : "text-fg-muted",
              )}
            >
              {todayStats?.today ?? "—"}
            </div>
          </div>
          {recentCycles.length > 1 && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-fg-muted">
                Recent cycles
              </div>
              <div className="flex items-end gap-1 h-[30px]">
                {/* Newest on the right, so it reads left-to-right in time order. */}
                {recentCycles
                  .slice()
                  .reverse()
                  .map((c) => (
                    <div
                      key={c.at}
                      className="w-2 bg-accent/50 rounded-sm"
                      style={{
                        height: `${Math.max(3, (c.count / cyclePeak) * 30)}px`,
                      }}
                      title={`${c.count} decode${c.count === 1 ? "" : "s"} at ${formatUtcTime(c.at)}`}
                    />
                  ))}
              </div>
            </div>
          )}
        </div>

        <BandButtons
          currentBand={status?.band ?? null}
          decodingAs={tuneMode}
          region={ituRegionFromGrid(status?.deGrid)}
          onTuned={() => setRows([])}
        />
      </div>

      {/* Cycle progress: FT8 transmits for 12.6s of every 15s, so knowing where you
          are in the window tells you whether to expect decodes imminently. */}
      <div className="mb-4">
        <div className="flex items-center justify-between text-xs text-fg-subtle mb-1">
          <span className="tnum">
            {decodingAs} cycle · {(scale.periodMs / 1000).toFixed(1)}s
          </span>
        </div>
        <div className="h-1 bg-surface-2 rounded-sm overflow-hidden">
          <div
            className="h-full bg-accent/60 transition-[width] duration-1000 ease-linear"
            style={{ width: `${cyclePct}%` }}
          />
        </div>
      </div>

      <div className="flex flex-col gap-4">
        <Waterfall
          row={spectrum}
          binHz={scale.binHz}
          maxHz={scale.maxHz}
          markers={markers}
          txHz={status?.txDF ?? null}
          gain={gain}
          height={300}
        />

        <div className="flex items-center gap-4 text-xs text-fg-subtle">
          <label className="flex items-center gap-2">
            Gain
            <input
              type="range"
              min={0.6}
              max={2}
              step={0.1}
              value={gain}
              onChange={(e) => setGain(Number(e.target.value))}
              className="accent-accent w-32"
            />
            <span className="tnum w-8">{gain.toFixed(1)}</span>
          </label>
          <span>0–{scale.maxHz} Hz audio passband</span>
          {status?.txDF !== null && status?.txDF !== undefined && (
            <span className="text-accent-bright">TX offset {status.txDF} Hz</span>
          )}
          {!spectrum && <span className="text-warn">waiting for spectrum…</span>}
        </div>

        {/* One row, not two: Radio and Heard-by are narrow fixed columns and the decode
            list takes everything else. As equal quarters of a lg:grid-cols-4 the decode
            card spanned 3 and wrapped to a second row, leaving half the width under the
            waterfall blank while the decodes sat below the fold. */}
        <div className="grid gap-4 lg:grid-cols-[320px_260px_minmax(0,1fr)]">
          <Card title="Radio">
            <SMeter reading={smeter} now={now} />
            <PowerSlider current={status?.rfPower ?? null} />
            <RadioHealth telemetry={telemetry} transmitting={status?.transmitting ?? false} />
            {status ? (
              <dl className="text-sm flex flex-col gap-1.5">
                {/* Which radio this actually is. Two are supported and both can be
                    configured at once, so "the radio" is not self-evident — and on a
                    remote station it is the first thing worth confirming. */}
                <Row
                  label="Radio"
                  value={
                    status.radio
                      ? `${status.radio.model} · ${status.radio.host}`
                      : status.source === "wsjtx"
                        ? "external decoder"
                        : "not connected"
                  }
                />
                <Row
                  label="Dial"
                  value={
                    status.dialFrequency
                      ? `${formatFreqMHz(status.dialFrequency)} MHz`
                      : "—"
                  }
                  tnum
                />
                <Row label="Band" value={status.band ?? "—"} />
                <Row label="Slice mode" value={status.mode ?? "—"} />
                <Row label="Decoding as" value={decodingAs} />
                <Row label="My call" value={status.deCall ?? "—"} />
                <Row label="Grid" value={status.deGrid ?? "—"} />
                <Row
                  label="RX offset"
                  value={status.rxDF !== null ? `${status.rxDF} Hz` : "—"}
                  tnum
                />
                {status.link && (
                  <Row
                    label="Radio link"
                    value={
                      status.link.oneWayMs > 0
                        ? `${status.link.rttMs} ms · corrected`
                        : `${status.link.rttMs} ms`
                    }
                    tnum
                  />
                )}
                <div className="flex gap-1.5 mt-1 flex-wrap">
                  {status.connected ? (
                    <Badge tone="ok">Radio up</Badge>
                  ) : (
                    <Badge tone="warn">No radio</Badge>
                  )}
                  {status.transmitting && <Badge tone="danger">Transmitting</Badge>}
                  {/* Audio is UDP and keeps flowing when the command channel
                      dies, so a dead channel has to be shown explicitly — it
                      cannot be inferred from decodes still arriving. */}
                  {status.connected && !status.commandChannel && (
                    <Badge tone="warn">No rig control</Badge>
                  )}
                </div>
              </dl>
            ) : (
              <p className="text-sm text-fg-subtle">Waiting for the bridge…</p>
            )}

            <SourcePicker source={status?.source ?? null} />

            <p className="mt-4 pt-3 border-t border-line text-xs text-fg-subtle">
              <Link href="/settings" className="text-accent-bright hover:underline">
                Decode source settings →
              </Link>
            </p>
          </Card>

          <HeardBy />

          <div className="min-w-0">
            <Card
              title={`Decodes (${visible.length})`}
              actions={
                <div className="flex items-center gap-2">
                  {/* Type a callsign. Uppercased as you type because that is how every
                      decode is written, and a lowercase search matching nothing would
                      read as "they are not on the air". */}
                  <Input
                    value={search}
                    onChange={(e) => setSearch(e.target.value.toUpperCase())}
                    placeholder="Find a callsign…"
                    aria-label="Search decodes"
                    className="w-40 tnum"
                  />
                  {search !== "" && (
                    <button
                      type="button"
                      onClick={() => setSearch("")}
                      title="Clear the search"
                      className="text-xs text-fg-muted hover:text-fg"
                    >
                      clear
                    </button>
                  )}
                <Select
                  value={filter}
                  onChange={(e) => setFilter(e.target.value as typeof filter)}
                  className="w-44"
                >
                  <option value="all">Everything</option>
                  <option value="cq">CQ only</option>
                  <option value="cq-pota">CQ POTA</option>
                  <option value="cq-dx">CQ DX</option>
                  <option value="worth">Worth working</option>
                  <option value="me" disabled={!myCall}>
                    {myCall ? `Mentions ${myCall}` : "Mentions me"}
                  </option>
                </Select>
                </div>
              }
            >
              {visible.length === 0 ? (
                // "Nothing heard" and "nothing MATCHED" are different problems, and
                // the narrow filters (CQ POTA especially) are legitimately empty on a
                // busy band. Saying "no decodes yet" under 200 live decodes would send
                // an operator looking for a fault in the receiver.
                rows.length > 0 ? (
                  <p className="text-sm text-fg-subtle">
                    {/* Three different nothings, and an operator needs to know which:
                        nothing heard at all, nothing matching the category, and nothing
                        matching what they typed. The last one is the one that means
                        "that station is not on the air right now". */}
                    None of the {rows.length} decode{rows.length === 1 ? "" : "s"} heard
                    {search ? ` mention ${search}` : " match this filter"}
                    {search && filter !== "all" ? " within this filter" : ""}.{" "}
                    {search && (
                      <button
                        type="button"
                        className="text-accent-bright hover:underline"
                        onClick={() => setSearch("")}
                      >
                        Clear the search
                      </button>
                    )}
                    {search && filter !== "all" ? " · " : ""}
                    {filter !== "all" && (
                      <button
                        type="button"
                        className="text-accent-bright hover:underline"
                        onClick={() => setFilter("all")}
                      >
                        Show everything
                      </button>
                    )}
                  </p>
                ) : (
                  <p className="text-sm text-fg-subtle">
                    No decodes yet. FT8 reports every 15 seconds and FT4 every 7.5 —
                    and nothing arrives while the radio is transmitting.
                  </p>
                )
              ) : (
                // Tall enough to fill the column it now shares with the Radio card —
                // at 26rem it left the same blank space below that moving it up here
                // was meant to remove.
                <div className="overflow-auto -mx-4 max-h-[42rem]">
                  <table className="w-full text-sm border-collapse">
                    <thead className="sticky top-0 bg-surface-2">
                      <tr className="text-left">
                        {["UTC", "dB", "Hz", "dt", "Mode", "Message"].map((h) => (
                          <th
                            key={h}
                            className="px-3 py-1.5 font-medium text-fg-muted text-xs uppercase tracking-wide"
                          >
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line font-mono text-xs">
                      {visible.map((d, i) => {
                        const isCq = /^CQ\b/i.test(d.message);
                        const mine = mentionsMe(d.message);
                        return (
                          <tr
                            key={`${d.timestamp}-${d.freqOffset}-${d.message}`}
                            onClick={() => d.callsign && setTarget(d)}
                            title={
                              d.callsign
                                ? `Call ${d.callsign}`
                                : "No callsign in this message"
                            }
                            className={cn(
                              "hover:bg-surface-2",
                              d.callsign && "cursor-pointer",
                              mine && "bg-accent/10",
                              qso?.active &&
                                d.callsign === qso.theirCall &&
                                "bg-ok/10",
                            )}
                          >
                            <td className="px-3 py-1 tnum text-fg-subtle whitespace-nowrap">
                              {formatUtcTime(d.timestamp)}
                            </td>
                            <td
                              className={cn(
                                "px-3 py-1 tnum text-right whitespace-nowrap",
                                d.snr >= 0
                                  ? "text-ok"
                                  : d.snr > -15
                                    ? "text-fg"
                                    : "text-fg-subtle",
                              )}
                            >
                              {d.snr > 0 ? `+${d.snr}` : d.snr}
                            </td>
                            <td className="px-3 py-1 tnum text-right text-fg-muted">
                              {d.freqOffset}
                            </td>
                            <td className="px-3 py-1 tnum text-right text-fg-subtle">
                              {d.deltaTime.toFixed(1)}
                            </td>
                            <td className="px-3 py-1 text-fg-subtle">{d.mode}</td>
                            <td className="px-3 py-1">
                              <span
                                className={cn(
                                  mine && "text-accent-bright font-semibold",
                                  isCq && !mine && "text-ok",
                                )}
                              >
                                {d.message}
                              </span>
                              {d.lowConfidence && (
                                <span className="ml-2 text-fg-subtle">(low conf)</span>
                              )}
                              {/* The primary action of the whole application.

                                  It used to be a bare onClick on the <tr>: no
                                  affordance, no keyboard path, and on touch not even
                                  a tooltip, because `title` never fires there. The
                                  docs name this click as how you make your first
                                  contact and the interface never said so.

                                  stopPropagation because the row handler does the
                                  same thing — without it the click runs twice. */}
                              {/* Award value, from the same scoring the auto-operator
                                  uses. Thirty rows of identical-looking text is where
                                  a new entity hides; this is the whole reason the
                                  scoring existed and nobody could see it. */}
                              {d.callsign &&
                                (worth.get(d.callsign)?.length ?? 0) > 0 && (
                                  <span
                                    className="ml-2 rounded-sm border border-ok/40 bg-ok/12 px-1 py-0.5 text-[10px] uppercase tracking-wide text-ok align-middle"
                                    title={worth.get(d.callsign)!.join(" · ")}
                                  >
                                    {worth.get(d.callsign)![0]}
                                  </span>
                                )}
                              {d.callsign && (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setTarget(d);
                                  }}
                                  className={cn(
                                    "ml-2 rounded-sm border px-1.5 py-0.5 align-middle",
                                    "text-[10px] uppercase tracking-wide transition-colors",
                                    "border-line-strong text-fg-muted",
                                    "hover:border-accent-bright hover:text-accent-bright",
                                    "focus-visible:outline-2 focus-visible:outline-accent-bright",
                                  )}
                                >
                                  Call
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * Call a station that is not on the decode list.
 *
 * Every other route into a QSO starts from a decode: click the row, press Call, and the
 * fields come off what was heard. That leaves no way to work a station an operator KNOWS
 * is on — a sked, a net, someone saying so on the phone — because nothing they have sent
 * has decoded here. The controls existed; there was simply no way to name a station the
 * receiver had not already named.
 *
 * The offset is asked for rather than assumed. Answering on the caller's own frequency is
 * the convention, and with nothing decoded there is no frequency to answer on — so 1500
 * is a starting point and the operator overrides it when they know better.
 */
function ManualCall({
  busy,
  onCall,
  suggestSlot,
}: {
  busy: boolean;
  onCall: (call: string, offsetHz: number) => void;
  suggestSlot: () => ClearSlot;
}) {
  const [call, setCall] = useState("");
  /**
   * Opened on a clear slot, not on 1500.
   *
   * 1500 Hz is the middle of the passband and therefore the most contested frequency on
   * the band — a default that put every manual call on top of somebody. Computed once
   * when the form mounts, and re-computable from the button below, because the band
   * moves.
   */
  const [slot, setSlot] = useState<ClearSlot>(() => suggestSlot());
  const [offset, setOffset] = useState(() => String(slot.hz));

  function findClear() {
    const next = suggestSlot();
    setSlot(next);
    setOffset(String(next.hz));
  }

  const trimmed = call.trim().toUpperCase();
  // Loose on purpose: portable and special-event calls are full of slashes and digits,
  // and a strict pattern here would refuse a legal callsign the encoder accepts. The
  // bridge and the FT8 encoder both validate properly; this only stops empty submits.
  const valid = /^[A-Z0-9/]{3,16}$/.test(trimmed);
  const offsetHz = Number(offset);
  const offsetOk = Number.isFinite(offsetHz) && offsetHz >= 200 && offsetHz <= 2900;

  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && offsetOk && !busy) onCall(trimmed, Math.round(offsetHz));
      }}
    >
      <Input
        value={call}
        onChange={(e) => setCall(e.target.value.toUpperCase())}
        placeholder="W1AW"
        aria-label="Callsign to call"
        className="w-32 tnum"
      />
      <label className="flex items-center gap-1 text-xs text-fg-subtle">
        at
        <Input
          value={offset}
          onChange={(e) => setOffset(e.target.value)}
          inputMode="numeric"
          aria-label="Audio offset in hertz"
          className="w-20 tnum"
        />
        Hz
      </label>
      <Button
        type="button"
        onClick={findClear}
        disabled={busy}
        title="Pick the middle of the widest gap between the stations heard in the last two minutes."
      >
        Find clear slot
      </Button>
      <Button type="submit" variant="primary" disabled={busy || !valid || !offsetOk}>
        {busy ? "…" : "Call"}
      </Button>
      {/* What the number MEANS, since a bare offset says nothing about whether it is a
          good one. A crowded band is reported rather than hidden: there is sometimes no
          clear slot, and a picker that returns the least-bad one while looking confident
          is worse than one that admits it. */}
      {String(slot.hz) === offset.trim() && (
        <span
          className={cn("text-xs", slot.crowded ? "text-warn" : "text-fg-subtle")}
          title={
            slot.crowded
              ? "Every gap is narrower than an FT8 signal — expect to share the frequency."
              : "Distance to the nearest station heard recently."
          }
        >
          {slot.crowded
            ? `band is full — only ${slot.clearanceHz} Hz clear`
            : `${slot.clearanceHz} Hz clear either side`}
        </span>
      )}
      {call !== "" && !valid && (
        <span className="text-xs text-danger">Not a callsign</span>
      )}
      {!offsetOk && (
        // 2900 rather than 3000: most radios will not place audio above about 2.9 kHz
        // whatever the receiver hears, which is the same limit the passband setting
        // warns about.
        <span className="text-xs text-danger">Offset must be 200–2900 Hz</span>
      )}
    </form>
  );
}

/**
 * The panel that runs one QSO: pick a station from the decode list, review the
 * standard messages, start calling, watch the exchange advance, halt any time.
 *
 * Modelled on the WSJT-X Tx1–Tx6 panel, but sequenced automatically — the radio
 * service's QsoController answers each of their transmissions with the right
 * next message on the right cycle.
 */
function WorkStationPanel({
  target,
  qso,
  auto,
  suggestSlot,
  lastTx,
  myCall,
  myGrid,
  onClose,
}: {
  target: DecodeEvent | null;
  qso: QsoState | null;
  /** Needed to know whether a queued call would ever actually be made. */
  auto: AutoState | null;
  /** Finds an unoccupied audio offset from what has been heard recently. */
  suggestSlot: () => ClearSlot;
  lastTx: string | null;
  myCall: string | null;
  myGrid: string | null;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** A successful-but-different outcome, e.g. "queued behind the current contact". */
  const [notice, setNotice] = useState<string | null>(null);

  const active = qso?.active ?? false;
  const autoRunning = (auto?.mode ?? "off") !== "off";
  /** Someone selected who is NOT the station currently being worked. */
  const other =
    target?.callsign && (!active || target.callsign !== qso?.theirCall)
      ? target.callsign
      : null;
  // Prefer the live QSO for display; fall back to the clicked target.
  const call = active ? qso!.theirCall : (target?.callsign ?? null);

  async function act(
    action: "call" | "qso-halt" | "qso-skip" | "rearm",
    /**
     * Fields for a call to someone who is NOT on the decode list.
     *
     * Everything the sequencer needs normally comes off the decode that was clicked.
     * A station an operator knows is on — because it was arranged on a net, or because
     * they are being told so on the phone — produces no decode, so there was nothing to
     * click and no way to call them at all.
     */
    manual?: { theirCall: string; theirOffsetHz: number },
    /** Halt the contact in flight and call this one immediately. */
    takeOver?: boolean,
  ) {
    setBusy(true);
    setError(null);
    try {
      const reply = await apiPost<{ queued?: boolean; reason?: string }>(
        "/api/bridge/control",
        {
        action,
        ...(takeOver ? { takeOver: true } : {}),
        ...(action === "call" && manual
          ? {
              theirCall: manual.theirCall,
              theirGrid: null,
              // Unheard, so there is no report to echo back. The sequencer sends a
              // grid-square first message anyway, and the report it eventually sends
              // is measured from THEIR reply, not from this.
              theirSnr: 0,
              theirOffsetHz: manual.theirOffsetHz,
              // NOT 0, which the bridge would otherwise default to.
              //
              // startCall derives the transmit cycle from this: `theirParity` is
              // floor(windowStart / period) % 2 and we take the opposite. A zero makes
              // that parity 0 every time, so every manual call would transmit on odd
              // windows — a coin flip, and when it lost we would be transmitting at the
              // same instant as the station we are calling and never hear them. `now`
              // makes it the CURRENT window's parity, so we answer in the next one,
              // which is what calling someone means.
              theirWindowStart: Date.now(),
            }
          : {}),
        ...(action === "call" && !manual && target
          ? {
              theirCall: target.callsign,
              theirGrid: gridFromMessage(target.message),
              theirSnr: target.snr,
              theirOffsetHz: target.freqOffset,
              theirWindowStart: new Date(target.timestamp).getTime(),
              // The decode itself, so the logged contact's transcript opens with
              // the message that prompted the call rather than with our reply.
              message: target.message,
            }
          : {}),
        },
      );
      // A queued call is a SUCCESS with a different outcome, and the operator has to be
      // told which they got — "queued behind KC1YTV" and "calling now" look identical
      // otherwise, which is the whole complaint that produced this.
      if (reply?.queued && reply.reason) setNotice(reply.reason);
      else setNotice(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Control request failed");
    } finally {
      setBusy(false);
    }
  }

  // Nothing selected yet: say how to select something.
  //
  // This returned null, so the panel that explains the entire flow appeared only
  // AFTER the click nobody knew to make. docs/getting-started.md names that click as
  // how you make your first contact; the interface said nothing at all.
  if (!target && !active && !qso?.pausedReason) {
    return (
      <div className="mb-4 rounded-sm border border-dashed border-line-strong bg-surface px-3 py-2 text-sm text-fg-muted">
        <p>
          Pick a station to work — press <span className="text-fg">Call</span> on any
          decode below, or click its row. The exchange then runs itself: report,
          roger-report, RR73, logged.
        </p>
        <div className="mt-2 border-t border-line pt-2">
          <p className="mb-1.5 text-xs text-fg-subtle">
            Or call someone who has not decoded here — a sked, or a station you have been
            told is on. We transmit in the next cycle, so they answer in the one after.
          </p>
          <ManualCall
            busy={busy}
            suggestSlot={suggestSlot}
            onCall={(c, hz) => void act("call", { theirCall: c, theirOffsetHz: hz })}
          />
        </div>
        {error && <p className="mt-2 text-xs text-danger">{error}</p>}
      </div>
    );
  }

  const stateLabel: Record<string, string> = {
    calling: "Calling — waiting for their report",
    "report-sent": "Report sent — waiting for R-report",
    "rreport-sent": "R-report sent — waiting for RR73",
    "rr73-sent": "RR73 sent — waiting for their 73",
    complete: "QSO complete — logged",
    abandoned: "Gave up (no reply)",
  };

  return (
    <Card
      title={
        <div className="flex items-center gap-2">
          <span className="font-display tracking-wide">Work station</span>
          {call && <Badge tone={active ? "ok" : "accent"}>{call}</Badge>}
          {active && <Badge tone="danger">ON AIR</Badge>}
        </div>
      }
      actions={
        // All the actions live in the header row. They used to be a second grid
        // column with an explanatory paragraph under them, which made a panel that
        // sits above the decode table twice as tall as its three lines of content —
        // and it is on screen for every QSO an auto mode runs.
        <div className="flex items-center gap-2">
          {!active && target?.callsign && (
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => void act("call")}
              title="Calls on their frequency, on the opposite cycle. The sequencer answers each reply and logs the QSO on completion."
            >
              {busy ? "…" : `Call ${target.callsign}`}
            </Button>
          )}
          {/* A station was picked while another contact is in flight.
              
              This is what pressing Call during an automatic mode used to do: nothing
              visible. The controller refuses a second QSO, and the refusal landed in a
              panel busy rendering the contact already running. Two honest answers, and
              the operator picks — queue them, or drop what is running and call now. */}
          {active && other && (
            <>
              {autoRunning ? (
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() => void act("call")}
                  title={`Work ${other} as soon as the contact with ${qso?.theirCall ?? "the current station"} finishes. Nothing on the air is disturbed.`}
                >
                  {busy ? "…" : `Queue ${other}`}
                </Button>
              ) : (
                // With auto off nothing drains the queue, so offering "queue" would be
                // a promise the station never keeps.
                <span
                  className="text-[11px] text-fg-subtle"
                  title="The call-back queue is worked by the automatic modes. With auto off, finish or halt this contact first."
                >
                  auto is off — no queue
                </span>
              )}
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => void act("call", undefined, true)}
                title={`Halt the contact with ${qso?.theirCall ?? "the current station"} and call ${other} immediately. They are mid-exchange, so this leaves them hanging.`}
              >
                {busy ? "…" : `Call ${other} now`}
              </Button>
            </>
          )}
          {active && (
            <>
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => void act("qso-halt")}
                title="Stop transmitting immediately — this QSO AND any automatic mode"
              >
                HALT TX
              </Button>
              <Button
                disabled={busy}
                onClick={() => void act("qso-skip")}
                title="Give up on this station and move on — any automatic mode keeps running"
              >
                Skip contact
              </Button>
            </>
          )}
          {qso?.pausedReason && (
            <Button disabled={busy} onClick={() => void act("rearm")}>
              Re-arm transmit
            </Button>
          )}
          <Button onClick={onClose} disabled={busy}>
            Close
          </Button>
        </div>
      }
      className="mb-4 border-accent/40"
    >
      <div className="text-sm flex flex-col gap-1">
        {target && !active && (
          <>
            <div className="font-mono text-xs text-fg-muted">
              heard: {target.message} ({target.snr} dB @ {target.freqOffset} Hz)
            </div>
            {myCall && myGrid && target.callsign && (
              // Preview of the exchange the sequencer will run — one line, since
              // the messages differ only in their tail.
              <div className="font-mono text-xs">
                <span className="text-fg">
                  → {target.callsign} {myCall} {myGrid.slice(0, 4)}
                </span>
                <span className="text-fg-subtle">
                  {"  ·  R"}
                  {target.snr < 0 ? target.snr : `+${target.snr}`}
                  {"  ·  73"}
                </span>
              </div>
            )}
          </>
        )}
        {qso?.state && (
          <div>
            <span className="text-xs uppercase tracking-wide text-fg-muted mr-2">
              State
            </span>
            {stateLabel[qso.state] ?? qso.state}
          </div>
        )}
        {qso?.lastSent && (
          <div className="font-mono text-xs text-accent-bright">sent: {qso.lastSent}</div>
        )}
        {lastTx && lastTx !== qso?.lastSent && (
          <div className="font-mono text-xs text-fg-subtle">tx: {lastTx}</div>
        )}
        {qso?.pausedReason && (
          <div className="text-warn text-xs">⚠ {qso.pausedReason}</div>
        )}
        {error && <div className="text-danger text-xs">{error}</div>}
        {notice && <div className="text-accent-bright text-xs">{notice}</div>}
        {/* Who is waiting, so a queued call is visible as a fact rather than only as a
            message that scrolls away. Includes stations that called US mid-QSO — the
            same queue, which is why an operator request goes to the front of it. */}
        {(auto?.waiting?.length ?? 0) > 0 && (
          <div className="text-xs text-fg-subtle">
            Waiting to be called:{" "}
            <span className="text-fg-muted tnum">{auto!.waiting!.join(", ")}</span>
          </div>
        )}
      </div>
    </Card>
  );
}

/**
 * The automated operating modes. One row: pick a mode, watch what it's doing,
 * stop everything with one click. Auto Call (working one chosen station) is the
 * click-to-call flow — click a decode row for that.
 */
function AutoPanel({
  auto,
  qso,
  schedule,
}: {
  auto: AutoState | null;
  qso: QsoState | null;
  schedule: NonNullable<RigStatus["schedule"]> | null;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mode = auto?.mode ?? "off";

  async function act(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      await apiPost("/api/bridge/control", body);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  const MODES: { id: AutoState["mode"]; label: string; hint: string }[] = [
    { id: "off", label: "Off", hint: "No automatic transmissions" },
    { id: "cq", label: "Auto CQ", hint: "Call CQ, work whoever answers, log, repeat" },
    { id: "hunt", label: "Auto Hunt", hint: "Answer callable CQs (skips dupes), one at a time" },
    { id: "hunt-pota", label: "Hunt POTA", hint: "Only stations calling CQ POTA" },
    {
      id: "pota-chase",
      label: "Chase POTA",
      hint: "Retune to spotted POTA activators and work them (uses the POTA spot feed)",
    },
  ];

  return (
    <div className="mb-4 flex flex-wrap items-center gap-3 rounded-sm border border-line bg-surface px-3 py-2">
      <span className="text-[10px] uppercase tracking-wide text-fg-muted">
        Auto operate
      </span>
      <div className="flex flex-wrap gap-1" role="group" aria-label="Automatic operating mode">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            disabled={busy || mode === m.id}
            onClick={() => void act({ action: "auto", autoMode: m.id })}
            title={m.hint}
            aria-pressed={mode === m.id}
            className={cn(
              "rounded-sm border px-3 py-1.5 text-xs transition-colors",
              mode === m.id
                ? m.id === "off"
                  ? "border-line-strong bg-surface-2 text-fg"
                  : "border-accent-bright bg-accent/20 text-accent-bright"
                : "border-line text-fg-muted hover:text-fg hover:border-line-strong",
            )}
          >
            {m.label}
          </button>
        ))}
      </div>

      <span className="text-[11px] text-fg-muted basis-full sm:basis-auto">
        {MODES.find((m) => m.id === mode)?.hint}
      </span>

      {(mode !== "off" || qso?.active) && (
        <Button
          variant="danger"
          disabled={busy}
          onClick={() => void act({ action: "qso-halt" })}
        >
          HALT
        </Button>
      )}
      <Button
        disabled={busy}
        onClick={() => void act({ action: "atu" })}
        title="Run the antenna tuner (keys a brief low-power carrier)"
      >
        Tune ATU
      </Button>

      <span className="text-xs text-fg-subtle flex-1 min-w-40">
        {error ? (
          <span className="text-danger">{error}</span>
        ) : auto?.pausedReason ? (
          <span className="text-warn">⚠ {auto.pausedReason}</span>
        ) : (
          (auto?.lastAction ?? "") +
          (auto && auto.warmup > 0 ? ` (listening, ${auto.warmup} more cycle${auto.warmup === 1 ? "" : "s"})` : "")
        )}
      </span>
      {auto?.pausedReason && (
        <Button disabled={busy} onClick={() => void act({ action: "rearm" })}>
          Re-arm
        </Button>
      )}
      {/* Tail-enders. Someone who called while we were busy is a contact already
          offered, and the operator should be able to see they will be answered
          rather than wonder whether they were missed. */}
      {(auto?.waiting?.length ?? 0) > 0 && (
        <span
          className="text-[11px] whitespace-nowrap rounded-sm border border-ok/40 bg-ok/10 px-1.5 py-0.5 text-ok"
          title={`Called us during a contact and will be worked next, in this order: ${auto!.waiting!.join(", ")}`}
        >
          ↩ {auto!.waiting!.length} waiting: {auto!.waiting!.slice(0, 3).join(", ")}
          {auto!.waiting!.length > 3 ? "…" : ""}
        </span>
      )}
      {schedule && (
        <span
          className={cn(
            "text-[11px] whitespace-nowrap",
            schedule.suppressed ? "text-warn" : "text-fg-muted",
          )}
          title="The operating schedule (Settings → Schedule) is driving the mode. A mode picked by hand holds until the next scheduled boundary."
        >
          ⏱ {schedule.reason}
        </span>
      )}
    </div>
  );
}

/**
 * Radio health from the meter stream: PA temperature, SWR, supply voltage.
 *
 * SWR is shown only while transmitting and briefly after — the meter reads
 * nothing meaningful on receive, and a stale figure invites misreading. These
 * two also feed the guards: past 3:1 or 75 °C, unattended transmission stops.
 */
function RadioHealth({
  telemetry,
  transmitting,
}: {
  telemetry: Telemetry | null;
  transmitting: boolean;
}) {
  if (!telemetry) return null;
  const swrFresh = transmitting || Date.now() - telemetry.at < 3_000;
  const swr = swrFresh ? telemetry.swr : null;

  const items: { label: string; value: string; tone?: string }[] = [];
  if (telemetry.paTempC !== null) {
    items.push({
      label: "PA",
      value: `${telemetry.paTempC.toFixed(0)}°C`,
      tone:
        telemetry.paTempC > 75
          ? "text-danger"
          : telemetry.paTempC > 60
            ? "text-warn"
            : undefined,
    });
  }
  if (swr !== null && swr > 0) {
    items.push({
      label: "SWR",
      value: `${swr.toFixed(1)}:1`,
      tone: swr > 3 ? "text-danger" : swr > 2 ? "text-warn" : "text-ok",
    });
  }
  if (telemetry.voltsPa !== null) {
    items.push({
      label: "V",
      value: `${telemetry.voltsPa.toFixed(1)}`,
      tone: telemetry.voltsPa < 12 ? "text-warn" : undefined,
    });
  }
  if (telemetry.fanRpm !== null && telemetry.fanRpm > 0) {
    items.push({ label: "Fan", value: `${telemetry.fanRpm}` });
  }
  if (items.length === 0) return null;

  return (
    <div className="mb-3 flex flex-wrap gap-x-3 gap-y-1 text-xs border-t border-line pt-2">
      {items.map((i) => (
        <span key={i.label} className="tnum">
          <span className="text-fg-subtle">{i.label} </span>
          <span className={i.tone ?? "text-fg"}>{i.value}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * RF power control. Sends on release, not on every drag step — each change is a
 * radio command, and a drag emits dozens.
 */
function PowerSlider({ current }: { current: number | null }) {
  const [value, setValue] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = value ?? current ?? 0;

  async function commit(v: number) {
    setBusy(true);
    try {
      await apiPost("/api/bridge/control", { action: "power", percent: v });
    } finally {
      // Either way, resync to what the radio actually reports: if it took, the
      // status broadcast confirms it; if the radio refused, the slider snapping
      // back is the truth, not a glitch.
      setValue(null);
      setBusy(false);
    }
  }

  return (
    <div className="mb-3">
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-[10px] uppercase tracking-wide text-fg-muted">
          RF power
        </span>
        <span className="font-display text-sm leading-none tnum">
          {current === null && value === null ? "—" : `${shown}%`}
        </span>
      </div>
      <input
        type="range"
        min={1}
        max={100}
        step={1}
        value={shown}
        disabled={busy || current === null}
        onChange={(e) => setValue(Number(e.target.value))}
        onMouseUp={() => value !== null && void commit(value)}
        onTouchEnd={() => value !== null && void commit(value)}
        className="w-full accent-accent"
      />
    </div>
  );
}


/**
 * Classic S-meter, driven by the slice LEVEL meter (dBm at the antenna).
 *
 * S9 is -73 dBm and each S-unit is 6 dB; above S9 the scale continues in dB over
 * S9, which is how every rig meter reads. The bar is segmented at the S-unit
 * boundaries rather than continuous so it reads like a meter, not a level gauge.
 */
function SMeter({
  reading,
  now,
}: {
  reading: { dbm: number; fwdDbm: number | null; at: number } | null;
  now: number;
}) {
  // A reading older than a few seconds is stale — the bridge stopped, the radio
  // went away, or the slice closed. Show empty rather than a frozen value.
  const live = reading !== null && now - reading.at < 5_000;
  const dbm = live ? reading.dbm : null;

  // While transmitting the interesting number is what's going OUT. Forward
  // power arrives on the same meter stream; above ~1 W it takes the display.
  const fwd = live ? reading.fwdDbm : null;
  if (fwd !== null && fwd > 30) {
    const watts = Math.pow(10, (fwd - 30) / 10);
    const pct = Math.min(100, (watts / 100) * 100);
    return (
      <div className="mb-3">
        <div className="flex items-baseline justify-between mb-1">
          <span className="text-[10px] uppercase tracking-wide text-fg-muted">
            TX power
          </span>
          <span className="font-display text-lg leading-none tnum text-accent-bright">
            {watts >= 10 ? watts.toFixed(0) : watts.toFixed(1)} W
          </span>
        </div>
        <div className="h-2.5 bg-surface-2 rounded-[1px] overflow-hidden">
          <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
        </div>
        <div className="flex justify-between text-[9px] text-fg-subtle mt-0.5 tnum">
          <span>0</span>
          <span>25</span>
          <span>50</span>
          <span>75</span>
          <span>100 W</span>
        </div>
      </div>
    );
  }

  const sFloat = dbm === null ? 0 : Math.max(0, Math.min(9, (dbm + 127) / 6));
  const overDb = dbm === null ? 0 : Math.max(0, Math.round(dbm + 73));

  let label = "—";
  if (dbm !== null) {
    label = overDb > 0 ? `S9+${overDb}` : `S${Math.floor(sFloat)}`;
  }

  const segments = [];
  for (let s = 1; s <= 9; s++) {
    const lit = dbm !== null && sFloat >= s;
    segments.push(
      <div
        key={s}
        className={cn(
          "h-2.5 flex-1 rounded-[1px]",
          lit
            ? s <= 6
              ? "bg-ok/80"
              : "bg-warn/90"
            : "bg-surface-2",
        )}
      />,
    );
  }
  // Three +dB segments past S9 (+10/+20/+30), red like every meter's top end.
  for (const step of [10, 20, 30]) {
    const lit = overDb >= step;
    segments.push(
      <div
        key={`p${step}`}
        className={cn("h-2.5 flex-1 rounded-[1px]", lit ? "bg-accent" : "bg-surface-2")}
      />,
    );
  }

  return (
    <div className="mb-3">
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-[10px] uppercase tracking-wide text-fg-muted">
          Signal
        </span>
        <span className="font-display text-lg leading-none tnum">
          {label}
          {dbm !== null && (
            <span className="text-[10px] text-fg-subtle ml-1.5">
              {dbm.toFixed(0)} dBm
            </span>
          )}
        </span>
      </div>
      <div className="flex gap-0.5">{segments}</div>
      <div className="flex justify-between text-[9px] text-fg-subtle mt-0.5 tnum">
        <span>S1</span>
        <span>S3</span>
        <span>S5</span>
        <span>S7</span>
        <span>S9</span>
        <span>+10</span>
        <span>+20</span>
        <span>+30</span>
      </div>
    </div>
  );
}

/**
 * One button per band, retuning the radio's transmit slice to that band's calling
 * frequency for whichever mode is currently being decoded.
 *
 * Deliberately limited to the listed FT8/FT4 frequencies. A free-form frequency box
 * would be easy to add and is a good way to end up transmitting outside a band edge
 * or on top of another mode.
 */
function BandButtons({
  currentBand,
  decodingAs,
  region,
  onTuned,
}: {
  currentBand: string | null;
  decodingAs: DigitalMode;
  /** ITU region from the station grid; bands that don't exist there are hidden. */
  region: 1 | 2 | 3 | null;
  onTuned: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Only bands that actually have a frequency for the current mode — FT4 has no
  // 60 m or 6 m allocation listed, and offering a button that 404s is worse than
  // not offering it.
  // Region-gated (a US operator gets no 4M button; only Region 2 sees 1.25M) and
  // deduped: 6 m has two listed FT8 frequencies (50.313 and 50.323), which
  // otherwise renders two identical 6M buttons.
  const bands = useMemo(
    () => [
      ...new Set(
        frequenciesForRegion(region)
          .filter((f) => f.mode === decodingAs)
          .map((f) => f.band),
      ),
    ],
    [decodingAs, region],
  );

  async function tune(band: string, mode: DigitalMode) {
    setBusy(`${band}/${mode}`);
    setError(null);
    try {
      // Through the bridge, which owns the radio and knows which one it is.
      // `/api/flex/tune` opens its own connection to a FlexRadio and cannot see
      // the Icom at all.
      await apiPost("/api/bridge/control", { action: "tune", band, mode });
      // Decodes on screen belong to the old band, so clear them rather than let
      // them sit above results from somewhere else.
      onTuned();
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Could not retune the radio",
      );
    } finally {
      setBusy(null);
    }
  }

  // The mode switch is a retune, not a UI preference: FT8 and FT4 live on
  // different frequencies, and the bridge follows the dial. Switching modes on
  // the current band moves the dial; everything else follows from that.
  // Which modes the current band can be retuned to, per mode rather than as a
  // binary flip, since there are three of them now. FT2's frequencies are marked
  // provisional in WSJT-X's own table, so a band may legitimately have no FT2
  // entry — that button is then disabled, exactly as it already was for a band
  // with no FT4 frequency.
  const bandFor = (m: DigitalMode): string | null =>
    currentBand !== null &&
    DIGITAL_FREQUENCIES.some((f) => f.mode === m && f.band === currentBand)
      ? currentBand
      : null;

  return (
    <div className="flex flex-col items-end gap-1">
      {/* One row: modes, then bands. The mode toggle is its own flex ITEM inside the
          wrapping row — it stays together and wraps as a unit, which was the reason
          it used to sit on a separate row (and made this block three rows tall next
          to a one-row stats block). */}
      <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
        <div className="flex gap-1" role="group" aria-label="Digital mode">
          {(["FT8", "FT4", "FT2"] as const).map((m) => {
          const active = decodingAs === m;
          const target = bandFor(m);
          const canSwitch = active || target !== null;
          return (
            <button
              key={m}
              type="button"
              disabled={busy !== null || active || !canSwitch}
              onClick={() => target && void tune(target, m)}
              className={cn(
                "px-3 py-1 text-xs tnum transition-colors",
                active
                  ? "bg-accent/20 text-accent-bright"
                  : canSwitch
                    ? "text-fg-muted hover:text-fg"
                    : "text-fg-subtle/50 cursor-not-allowed",
              )}
              title={
                active
                  ? `Decoding ${m}`
                  : canSwitch
                    ? `Retune ${target} to its ${m} frequency`
                    : `${currentBand ?? "This band"} has no listed ${m} frequency`
              }
            >
              {m}
            </button>
          );
          })}
        </div>

        <div className="flex flex-wrap gap-1 justify-end" role="group" aria-label="Band">
          {bands.map((band) => {
          const active = currentBand === band;
          return (
            <button
              key={band}
              type="button"
              disabled={busy !== null}
              onClick={() => void tune(band, decodingAs)}
              className={cn(
                "px-2 py-1 text-xs rounded-sm border tnum transition-colors",
                active
                  ? "border-accent bg-accent/15 text-accent-bright"
                  : "border-line text-fg-muted hover:text-fg hover:border-fg-muted",
                busy !== null && "opacity-50 cursor-not-allowed",
              )}
              title={`Tune to ${band} — moves the TX slice to the ${decodingAs} calling frequency`}
            >
              {busy === `${band}/${decodingAs}` ? "…" : band}
            </button>
          );
          })}
        </div>
      </div>
      {/* The what-this-does caption moved into each button's tooltip; only a
          failure earns a visible line. */}
      {error && <div className="text-[10px] text-danger">{error}</div>}
    </div>
  );
}


/**
 * What SNTP said, in words whose direction cannot be misread.
 *
 * "behind" and "ahead of" rather than a signed number: getting the sign backwards sends
 * an operator adjusting the wrong way, which is worse than saying nothing at all.
 */
function ClockSyncLine({ sync }: { sync: ClockSync }) {
  const measured = sync.measuredMs;
  if (measured === null) {
    return <span className="text-xs">Clock not measured yet.</span>;
  }

  const abs = Math.abs(measured);
  const magnitude = abs >= 1000 ? `${(abs / 1000).toFixed(2)} s` : `${Math.round(abs)} ms`;
  const direction = abs < 1 ? "exactly right" : `${magnitude} ${measured > 0 ? "behind" : "ahead of"} real time`;
  const applied = Math.abs(sync.offsetMs) > 0;

  return (
    <span className="text-xs">
      Clock is <span className="tnum font-medium">{direction}</span>
      {sync.source ? ` per ${sync.source}` : ""}
      {sync.delayMs !== null ? ` (${Math.round(sync.delayMs)} ms round trip)` : ""}.{" "}
      {applied
        ? `Compensating by ${sync.offsetMs} ms — transmit timing, decode windows and logged times all use the corrected clock.`
        : sync.refused
          ? sync.refused
          : "No correction needed."}
    </span>
  );
}

/**
 * Measure the clock now.
 *
 * Worth a button rather than only a timer: the question "is my clock why nothing is
 * decoding" is asked at a specific moment, by someone staring at an empty screen, and
 * "wait up to an hour" is not an answer.
 */
function SyncNowButton({ busy, onSync }: { busy: boolean; onSync: () => void | Promise<void> }) {
  const canOperate = useCan("OPERATOR");
  if (!canOperate) return null;
  return (
    <Button onClick={() => void onSync()} disabled={busy} className="shrink-0">
      {busy ? "Checking…" : "Sync now"}
    </Button>
  );
}

/**
 * Who has heard THIS station lately — the other direction from the decode list.
 *
 * The decode list answers "who can I hear", and an operator reads it as though it
 * answered both. It does not: a receiver with a better antenna hears a 30 W signal that
 * cannot hear it back, and a station transmitting into a disconnected feedline sees a
 * perfectly healthy decode list.
 *
 * Most of these reports belong to no contact — they are CQs nobody answered — which is
 * exactly why they are worth showing. A CQ heard 6,000 km away says the station is working
 * whether or not anybody came back.
 */
function HeardBy() {
  const { data, error, loading, reload } = useApi<{
    since: string;
    receivers: {
      receiverCall: string;
      receiverGrid: string | null;
      bestSnr: number | null;
      reports: number;
      km: number | null;
      band: string | null;
    }[];
    totalReceivers: number;
    totalReports: number;
    furthest: { receiverCall: string; km: number } | null;
    truncated: boolean;
  }>("/api/psk-spots?minutes=60&limit=12");

  return (
    <Card title="Heard by">
      {/* A PANEL THAT COULD NOT LOAD MUST NOT LOOK LIKE A QUIET BAND.
          These three states were one: `!data` rendered "Nobody yet, in the last hour"
          whether the answer was genuinely nobody or the request had failed — so a station
          being heard all over the world reported silence, confidently, because a fetch
          errored. That is the worst kind of wrong, because the false version is the one an
          operator acts on. It also hid the outage that produced it. */}
      {error ? (
        <div className="text-sm flex flex-col gap-2 items-start">
          <p className="text-danger">
            Could not load reception reports — {error.message}
          </p>
          <p className="text-fg-subtle text-xs">
            Retrying on its own. This says nothing about whether anyone can hear you.
          </p>
          <button
            type="button"
            onClick={() => void reload()}
            className="px-2 py-1 text-xs rounded-sm border border-line text-fg-muted hover:text-fg hover:border-fg-muted"
          >
            Retry now
          </button>
        </div>
      ) : !data && loading ? (
        <p className="text-sm text-fg-subtle">Loading reception reports…</p>
      ) : !data || data.totalReceivers === 0 ? (
        <p className="text-sm text-fg-subtle">
          Nobody yet, in the last hour. Reports come from PSKReporter a few minutes behind
          the transmission, and only when a receiver heard us and uploaded it.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <dl className="text-sm flex flex-col gap-1.5">
            <Row
              label="Receivers"
              value={`${data.totalReceivers} in the last hour`}
            />
            <Row label="Reports" value={data.totalReports.toLocaleString()} />
            {data.furthest && (
              <Row
                label="Furthest"
                value={`${data.furthest.receiverCall} · ${data.furthest.km.toLocaleString()} km`}
              />
            )}
          </dl>

          <ul className="flex flex-col divide-y divide-line -mx-4">
            {data.receivers.map((r) => (
              <li
                key={r.receiverCall}
                className="flex items-center gap-2 px-4 py-1 text-sm"
              >
                <span className="font-display tracking-wide">{r.receiverCall}</span>
                {r.km !== null && (
                  <span className="tnum text-xs text-fg-subtle">
                    {r.km.toLocaleString()} km
                  </span>
                )}
                <span className="tnum ml-auto text-fg-muted">
                  {/* Their best report of us. A missing one is shown as a gap rather than
                      as 0 dB, which is a strong signal. */}
                  {r.bestSnr === null
                    ? "—"
                    : `${r.bestSnr > 0 ? "+" : ""}${r.bestSnr} dB`}
                </span>
                {r.reports > 1 && (
                  <span className="tnum text-xs text-fg-subtle w-8 text-right">
                    x{r.reports}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {data.truncated && (
            <p className="text-xs text-fg-subtle">
              Strongest {data.receivers.length} of {data.totalReceivers}.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

function Row({
  label,
  value,
  tnum,
}: {
  label: string;
  value: string;
  tnum?: boolean;
}) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-fg-subtle">{label}</dt>
      <dd className={cn("text-fg-muted", tnum && "tnum")}>{value}</dd>
    </div>
  );
}

export const getServerSideProps = withPageAuth<Props>({
  inner: async (ctx: GetServerSidePropsContext) => {
    // See lib/bridge/ws-url.ts. Two pages need this now and the rule is subtle enough
    // that a second copy would drift.
    const { wsUrl, bridgePort } = await bridgeWsUrl(ctx.req.headers);
    return { props: { wsUrl, bridgePort } };
  },
});
