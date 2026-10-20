import type { GetServerSidePropsContext } from "next";
import Link from "next/link";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import { BattleRoyaleAutoWarning, BattleRoyaleFeed } from "@/components/decodes/BattleRoyale";
import { BandModePicker } from "@/components/decodes/BandModePicker";
import { ClockBanner } from "@/components/decodes/ClockBanner";
import { ResizeHandle, ToggleButton } from "@/components/decodes/controls";
import { DecodeTable } from "@/components/decodes/DecodeTable";
import {
  CallFinishedToggle,
  DecodeToolbar,
  LinkHealth,
  type DecodeFilter,
} from "@/components/decodes/DecodeToolbar";
import { HeardBy } from "@/components/decodes/HeardBy";
import { OnAirStrip } from "@/components/decodes/OnAirStrip";
import { OperatePanel } from "@/components/decodes/OperatePanel";
import { RadioCard } from "@/components/decodes/RadioCard";
import type {
  AutoState,
  ClockSync,
  DecodeEvent,
  QsoState,
  RigStatus,
  SMeterReading,
  Telemetry,
} from "@/components/decodes/types";
import {
  useCompactLayout,
  useDecodeSize,
  useStoredFlag,
  useWaterfallHeight,
} from "@/components/decodes/view-prefs";
import { BandConditions } from "@/components/digital/BandConditions";
import { HellPanel, type HellMessage, type HellPanelHandle, type HellStats } from "@/components/digital/HellPanel";
import { Js8Panel } from "@/components/digital/Js8Panel";
import { SstvPanel, type SstvMessage, type SstvPanelHandle, type SstvStats } from "@/components/digital/SstvPanel";
import type { SstvTxState } from "@/components/digital/SstvSend";
import { StreamPanel, type StreamStats } from "@/components/digital/StreamPanel";
import { Waterfall, type WaterfallMarker, type WaterfallTag } from "@/components/digital/Waterfall";
import { Badge, Button, Card, EmptyState, ErrorBanner, PageHeader } from "@/components/ui/primitives";
import { withPageAuth } from "@/lib/auth/guard";
import { bridgeWsUrl } from "@/lib/bridge/ws-url";
import { ApiError, apiGet, apiPatch, apiPost, useApi } from "@/lib/client/api";
import { useCan } from "@/lib/client/session";
import { CONNECT_TIMEOUT_MS, FIRST_BACKOFF_MS, linkLabel, nextBackoff } from "@/lib/client/socket-retry";
import { useDistanceUnit } from "@/lib/client/use-distance-unit";
import { useReceiverAudio } from "@/lib/client/use-receiver-audio";
import { useVisibleInterval } from "@/lib/client/use-visible-interval";
import { rankByPoints, scoreContact } from "@/lib/contest/ft8battle";
import { bandKey, claimKey, stealEstimate, type Ft8brFeedResponse } from "@/lib/contest/ft8battle-feed";
import { callableFrom } from "@/lib/digital/callable";
import { assessClock } from "@/lib/digital/clock-offset";
import { parseMessage } from "@/lib/digital/qso";
import { occupiedFrom, pickClearSlot, type ClearSlot } from "@/lib/digital/slot";
import { formatFreqMHz } from "@/lib/ham/bands";
import { ituRegionFromGrid, type DigitalMode } from "@/lib/ham/digital-freqs";
import { gridFromMessage } from "@/lib/ham/grid-message";
import { NO_SEQUENCER_MODES } from "@/lib/radio/automation-gate";
import { decodeBase64Bins } from "@/lib/spectrum/wire";
import { cn } from "@/lib/utils";

/** Rolling RTTY text kept on the page, characters. */
const STREAM_TEXT_MAX = 8_000;
const MAX_ROWS = 500;

const DIGITAL_MODES: readonly DigitalMode[] = [
  "FT8",
  "FT4",
  "FT2",
  "WSPR",
  "RTTY",
  "CW",
  "JS8",
  "PSK31",
  "OLIVIA",
  "SSTV",
  "HELL",
  "JTTY",
];
/** Text modes: a terminal instead of the decode table. */
const STREAM_MODES = new Set(["RTTY", "CW", "PSK31", "OLIVIA", "JTTY"]);
/** Modes whose panel replaces the decode table, titled by the mode. */
const PANEL_TITLE: Record<string, string> = {
  RTTY: "RTTY",
  CW: "CW",
  PSK31: "PSK31",
  OLIVIA: "Olivia",
  JTTY: "JTTY",
  SSTV: "SSTV",
  HELL: "Feld Hell",
};

interface SpectrumMsg {
  kind: "spectrum";
  bins: string;
  binHz: number;
  maxHz: number;
  at: number;
  mode: string;
  periodMs: number;
}

interface Props extends Record<string, unknown> {
  wsUrl: string;
  bridgePort: number;
}

/**
 * A two-note ding for a logged QSO, synthesised on the spot. Browsers allow audio only
 * after a gesture, so the context is lazy and every failure is ignored.
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

export default function DigitalPage({ wsUrl }: Props) {
  const [status, setStatus] = useState<RigStatus | null>(null);
  const [unit] = useDistanceUnit();
  const [rows, setRows] = useState<DecodeEvent[]>([]);
  // Stream modes (RTTY): the rolling text and the once-a-second heartbeat with tone levels.
  const [streamText, setStreamText] = useState("");
  const [streamStats, setStreamStats] = useState<StreamStats | null>(null);
  const [rttyError, setRttyError] = useState<string | null>(null);
  /** The receiver in this browser, beside the waterfall it is the sound of. */
  const audio = useReceiverAudio(wsUrl);
  /** Where a JS8 message goes out, Hz audio: typed, or picked on the waterfall. */
  const [js8OffsetHz, setJs8OffsetHz] = useState(1500);
  /** The SSTV panel, handed picture rows straight from the socket rather than through state. */
  const sstvPanel = useRef<SstvPanelHandle | null>(null);
  const [sstvStats, setSstvStats] = useState<SstvStats | null>(null);
  /** The Hell panel, handed painted columns straight from the socket, as SSTV's is. */
  const hellPanel = useRef<HellPanelHandle | null>(null);
  const [hellStats, setHellStats] = useState<HellStats | null>(null);
  /** JTTY stations heard in the last few minutes, newest message each: tags on the waterfall. */
  const [jttyHeard, setJttyHeard] = useState<{ hz: number; snr: number; text: string; at: number }[]>([]);
  /** A picture going out, or how the last one ended. */
  const [sstvTx, setSstvTx] = useState<SstvTxState | null>(null);
  /** A JS8 station picked from the list, for the message line. See callFromRow. */
  const [js8Prefill, setJs8Prefill] = useState<{ call: string; n: number } | null>(null);
  const [js8Error, setJs8Error] = useState<string | null>(null);

  // Why each station is worth calling — the same scoring Auto Hunt ranks by, so the
  // badges an operator sees and the choices the software makes cannot disagree.
  const [worth, setWorth] = useState<Map<string, string[]>>(new Map());
  /**
   * Stations the dupe rule would refuse: worked on this band and mode inside
   * `auto.dupeWindowHours`, or today. From the server, which asks the transmit guard's boundary.
   */
  const [workedDupe, setWorkedDupe] = useState<Set<string>>(new Set());

  /**
   * FT8 Battle Royale: rank the list by what a contact is worth there, and send each logged
   * contact to the BR server. A VIEW plus a broadcast, never an operating mode — FT8BR bans
   * automated operation. Station state (`br.enabled`) since 1.182.0, because the bridge does
   * the sending; operators switch it, everyone sees it.
   */
  const [brMode, setBrMode] = useState(false);
  const [udpOn, setUdpOn] = useState(false);
  const [switchBusy, setSwitchBusy] = useState(false);
  const canSwitch = useCan("OPERATOR");
  const switchReasonId = useId();
  const loadSwitches = useCallback(
    () =>
      apiGet<{ br: boolean; udp: boolean }>("/api/digital/broadcast")
        .then((r) => {
          setBrMode(r.br);
          setUdpOn(r.udp);
        })
        .catch(() => {
          /* the buttons keep their last known state; the next poll corrects them */
        }),
    [],
  );
  useEffect(() => {
    void loadSwitches();
    // Polled, so a switch thrown on another screen shows here within half a minute.
    const t = setInterval(() => void loadSwitches(), 30_000);
    return () => clearInterval(t);
  }, [loadSwitches]);
  const setSwitch = useCallback(async (patch: { br?: boolean; udp?: boolean }) => {
    setSwitchBusy(true);
    try {
      const r = await apiPatch<{ br: boolean; udp: boolean }>("/api/digital/broadcast", patch);
      // The STORED values, so the button shows what the station will actually do.
      setBrMode(r.br);
      setUdpOn(r.udp);
    } catch {
      /* refused or offline: the next poll shows what the station is actually doing */
    } finally {
      setSwitchBusy(false);
    }
  }, []);
  const toggleBr = useCallback(() => void setSwitch({ br: !brMode }), [brMode, setSwitch]);
  const toggleUdp = useCallback(() => void setSwitch({ udp: !udpOn }), [udpOn, setSwitch]);

  /**
   * The Battle Royale feed the bridge keeps: two hours to show, the day's holdings to score
   * with. Polled only while BR mode is on; the bridge tracks it regardless.
   */
  const [brFeed, setBrFeed] = useState<Ft8brFeedResponse | null>(null);
  useEffect(() => {
    if (!brMode) {
      setBrFeed(null);
      return;
    }
    let cancelled = false;
    const load = () =>
      apiGet<Ft8brFeedResponse>("/api/contest/ft8battle?hours=2")
        .then((r) => {
          if (!cancelled) setBrFeed(r);
        })
        .catch(() => {
          /* keep the last answer; the next poll may do better */
        });
    void load();
    const t = setInterval(() => void load(), 20_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [brMode]);

  /**
   * Who on the Battle Royale panel is on the air RIGHT NOW: the latest decode per callsign
   * from the last two minutes. Upper-case keys, as the feed spells callsigns.
   */
  const heardNow = useMemo(() => {
    const out = new Map<string, DecodeEvent>();
    if (!brMode) return out;
    const cutoff = Date.now() - 120_000;
    for (const d of rows) {
      if (!d.callsign) continue;
      const t = new Date(d.timestamp).getTime();
      if (t < cutoff) continue;
      const call = d.callsign.toUpperCase();
      const prev = out.get(call);
      if (!prev || new Date(prev.timestamp).getTime() < t) out.set(call, d);
    }
    return out;
  }, [brMode, rows]);

  // Contacts today: one indexed COUNT, refreshed on every logged contact.
  const { data: todayStats, reload: reloadToday } = useApi<{
    today: number;
    lastAt: string | null;
    lastCallsign: string | null;
  }>("/api/stats/today");
  const [spectrum, setSpectrum] = useState<{ bins: Uint8Array; at: number } | null>(null);
  const [scale, setScale] = useState({ binHz: 5.86, maxHz: 3000, periodMs: 15000 });
  const [connected, setConnected] = useState(false);
  const [attempts, setAttempts] = useState(0);
  /** The Debug box on the Radio card: per viewer, off by default. */
  const [debug, toggleDebug] = useStoredFlag("digishack.debug");
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState<DecodeFilter>("all");
  /** Free-text search: "is W1AW on the air", which the filter cannot answer. */
  const [search, setSearch] = useState("");
  /** Decode row the operator clicked, i.e. the station to work. */
  const [target, setTarget] = useState<DecodeEvent | null>(null);
  /**
   * What the row's Call button answered, shown over the list only while still true: the
   * note names the contact it was written during, and goes when that contact ends.
   */
  const [rowCallNote, setRowCallNote] = useState<{
    text: string;
    whileWorking: string | null;
    error?: boolean;
  } | null>(null);

  /**
   * Stations whose contact completed this session, so their trailing RR73 and 73 read as
   * finished rather than as somebody still wanting working.
   */
  const [workedNow, setWorkedNow] = useState<Set<string>>(new Set());

  /**
   * Call the station in this row, now. The row itself only selects; the button labelled
   * Call does what it says, without a second press in the panel above.
   */
  const callFromRow = useCallback(
    async (d: DecodeEvent) => {
      if (!d.callsign) return;
      // JS8 has no exchange to run: a station is worked with directed messages, so picking
      // one starts that message on the JS8 line instead of asking the FT8 sequencer.
      if (status?.subMode === "JS8") {
        setRowCallNote(null);
        setJs8Prefill((p) => ({ call: d.callsign!.toUpperCase(), n: (p?.n ?? 0) + 1 }));
        return;
      }
      setTarget(d);
      setRowCallNote(null);
      try {
        const r = await apiPost<{
          queued?: boolean;
          reason?: string;
          qso?: { theirCall?: string | null };
        }>("/api/bridge/control", {
          action: "call",
          theirCall: d.callsign,
          theirGrid: gridFromMessage(d.message),
          theirSnr: d.snr,
          theirOffsetHz: d.freqOffset,
          theirWindowStart: new Date(d.timestamp).getTime(),
          message: d.message,
        });
        if (r?.queued && r.reason) {
          setRowCallNote({ text: r.reason, whileWorking: r.qso?.theirCall ?? null });
        }
      } catch (err) {
        setRowCallNote({
          text: err instanceof ApiError ? err.message : "Could not start the call",
          whileWorking: null,
          error: true,
        });
      }
    },
    [status?.subMode],
  );
  /** Stable, for the memoised table. */
  const callRow = useCallback((d: DecodeEvent) => void callFromRow(d), [callFromRow]);
  /** A row click: selects for a call, or on JS8 starts the message line (which never transmits). */
  const selectRow = useCallback(
    (d: DecodeEvent) => {
      if (status?.subMode === "JS8") void callFromRow(d);
      else setTarget(d);
    },
    [callFromRow, status?.subMode],
  );

  /** Where to transmit so as not to sit on somebody — evaluated when asked, as the band moves. */
  const suggestSlot = useCallback((): ClearSlot => pickClearSlot(occupiedFrom(rows, Date.now())), [rows]);

  const [gain, setGain] = useState(1);
  const [lastAt, setLastAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [smeter, setSmeter] = useState<SMeterReading | null>(null);
  const [qso, setQso] = useState<QsoState | null>(null);
  const [auto, setAuto] = useState<AutoState | null>(null);
  const [lastTx, setLastTx] = useState<string | null>(null);
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null);
  const [clockSync, setClockSync] = useState<ClockSync | null>(null);

  /** Phone/small-tablet layout. CSS handles everything it can. */
  const compact = useCompactLayout();
  const decodeSize = useDecodeSize();
  const waterfall = useWaterfallHeight(compact);

  /** What the Escape key just did, said out loud — the radio going quiet is not feedback. */
  const [haltNote, setHaltNote] = useState<string | null>(null);

  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  /** When we last saw the radio transmitting, so a decode gap can be attributed to it. */
  const txSeenRef = useRef(0);

  /**
   * When the socket last delivered ANYTHING, and what. A silent socket is a transport
   * stall; a fresh socket with stale rows is the page's own logic — only this page can tell
   * the two apart. A ref: written up to a dozen times a second, read on the 1 s tick.
   */
  const linkStats = useRef({
    msgAt: 0,
    counts: {} as Record<string, number>,
    parseErrors: 0,
    /** Last stall already written to the console, so a stall logs once, not per tick. */
    stallLoggedAt: 0,
  });

  // The tx-result line belongs to one QSO; a new target must not inherit the last one's.
  const qsoCall = qso?.theirCall ?? null;
  // The note described a contact in progress; once that contact is over it is stale.
  useEffect(() => {
    if (!rowCallNote?.whileWorking) return;
    if (rowCallNote.whileWorking !== qsoCall || !qso?.active) setRowCallNote(null);
  }, [qsoCall, qso?.active, rowCallNote]);
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
    // Or the Auto row says "Off" mid-hunt whenever the socket is slow to its first push.
    if (fallback.auto) setAuto((a) => a ?? fallback.auto ?? null);
    if (fallback.qso) setQso((q) => q ?? fallback.qso ?? null);
    if (fallback.recentDecodes?.length) {
      setRows((r) => (r.length === 0 ? [...fallback.recentDecodes].reverse() : r));
    }
  }, [fallback]);

  // Drives the cycle bar. Stopped while the tab is hidden: this ticks the largest
  // component in the application, which otherwise never lets a phone in a pocket idle.
  useVisibleInterval(() => setNow(Date.now()), 1000);

  const push = useCallback((event: DecodeEvent) => {
    if (pausedRef.current) return;
    setRows((prev) => {
      // A decode is identified by its window, offset and text. A bridge restart replaying
      // its backlog, or any second delivery path, must not reach the operator twice.
      const dup = prev.some(
        (r) => r.timestamp === event.timestamp && r.freqOffset === event.freqOffset && r.message === event.message,
      );
      if (dup) return prev;
      return [event, ...prev].slice(0, MAX_ROWS);
    });
    setLastAt(Date.now());
  }, []);

  // Reconnecting socket: the bridge restarts on its own, so a drop must not need a reload.
  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let backoff = FIRST_BACKOFF_MS;
    // Held outside connect() so the cleanup can close it. When it lived inside, every
    // effect re-run leaked a live socket and each decode arrived three times.
    let socket: WebSocket | null = null;
    let connectTimer: ReturnType<typeof setTimeout> | null = null;

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

      // A WebSocket has no connect timeout: behind a proxy whose origin is down it sits in
      // CONNECTING for ever and `onclose` never schedules the retry. Closing it does.
      if (connectTimer) clearTimeout(connectTimer);
      connectTimer = setTimeout(() => {
        if (ws.readyState === WebSocket.CONNECTING) {
          try {
            ws.close();
          } catch {
            /* already gone */
          }
        }
      }, CONNECT_TIMEOUT_MS);

      ws.onopen = () => {
        if (connectTimer) clearTimeout(connectTimer);
        connectTimer = null;
        setConnected(true);
        backoff = FIRST_BACKOFF_MS;
        // Reset, so "Reconnecting (n)" counts this outage rather than a lifetime total.
        setAttempts(0);
      };

      ws.onmessage = (ev) => {
        // Before the parse: "alive but unparseable" must not read as "silent".
        linkStats.current.msgAt = Date.now();
        try {
          const msg = JSON.parse(ev.data as string);
          const k = typeof msg.kind === "string" ? (msg.kind as string) : "?";
          linkStats.current.counts[k] = (linkStats.current.counts[k] ?? 0) + 1;
          if (msg.kind === "status") setStatus(msg.status);
          else if (msg.kind === "decode") push(msg as DecodeEvent);
          else if (msg.kind === "text" && typeof msg.text === "string") {
            const t = msg.text as string;
            setStreamText((prev) => (prev + t).slice(-STREAM_TEXT_MAX));
          } else if (msg.kind === "text-backlog" && typeof msg.text === "string") {
            setStreamText(msg.text as string);
          } else if (msg.kind === "stream" && msg.mode === "SSTV") setSstvStats(msg as unknown as SstvStats);
          else if (msg.kind === "stream" && msg.mode === "HELL") setHellStats(msg as unknown as HellStats);
          else if (msg.kind === "hell-cols" || msg.kind === "hell-backlog") hellPanel.current?.receive(msg as HellMessage);
          else if (msg.kind === "jtty-msg" && typeof msg.hz === "number") {
            const m = { hz: msg.hz as number, snr: Number(msg.snr), text: String(msg.text ?? ""), at: Number(msg.at) || Date.now() };
            setJttyHeard((prev) => [...prev.filter((p) => Math.abs(p.hz - m.hz) > 20 && Date.now() - p.at < 300_000), m].slice(-12));
          }
          else if (msg.kind === "stream") setStreamStats(msg as unknown as StreamStats);
          else if (msg.kind === "sstv-tx") setSstvTx(msg as unknown as SstvTxState);
          else if (msg.kind === "sstv-vis" || msg.kind === "sstv-start" || msg.kind === "sstv-rows" || msg.kind === "sstv-image") {
            sstvPanel.current?.receive(msg as SstvMessage);
          }
          else if (msg.kind === "spectrum") {
            const s = msg as SpectrumMsg;
            // The waterfall keeps running while paused: pausing is about the list.
            setSpectrum({ bins: decodeBase64Bins(s.bins), at: s.at });
            setScale({ binHz: s.binHz, maxHz: s.maxHz, periodMs: s.periodMs });
          } else if (msg.kind === "backlog" && Array.isArray(msg.decodes)) {
            // MERGED, not discarded: on a reconnect the bridge replays what the dropped
            // socket missed, and keeping it only for an empty list left a permanent hole.
            // Same identity as `push`, so a decode that came both ways appears once.
            if (!pausedRef.current) {
              const incoming = [...(msg.decodes as DecodeEvent[])];
              setRows((prev) => {
                if (prev.length === 0) return incoming.reverse().slice(0, MAX_ROWS);
                const seen = new Set(prev.map((r) => `${r.timestamp}|${r.freqOffset}|${r.message}`));
                const missing = incoming.filter((d) => !seen.has(`${d.timestamp}|${d.freqOffset}|${d.message}`));
                if (missing.length === 0) return prev;
                // Sorted, not prepended: a slow backlog can overlap the live rows.
                return [...missing, ...prev]
                  .sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0))
                  .slice(0, MAX_ROWS);
              });
            }
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
            const call = (msg.log as { theirCall?: string } | undefined)?.theirCall;
            if (call) {
              setWorkedNow((prev) => new Set(prev).add(call.toUpperCase()));
            }
          } else if (msg.kind === "qso-tx") {
            setLastTx(msg.sent ? (msg.message as string) : `refused: ${msg.reason}`);
          }
        } catch {
          /* skip a malformed frame rather than dropping the socket */
          linkStats.current.parseErrors++;
        }
      };

      ws.onclose = () => {
        if (connectTimer) clearTimeout(connectTimer);
        connectTimer = null;
        setConnected(false);
        if (closed) return;
        setAttempts((a) => a + 1);
        retry = setTimeout(connect, backoff);
        backoff = nextBackoff(backoff);
      };

      ws.onerror = () => ws.close();
    };

    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      if (connectTimer) clearTimeout(connectTimer);
      // Handlers off first, or onclose schedules a reconnect for a socket nobody hears.
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

  /**
   * What each row would be worth in FT8 Battle Royale, keyed by callsign. A range, sorted on
   * its floor, unless the feed says otherwise: somebody already worked them on this band (no
   * First Contact), or another player holds them (a steal). Our own holding is never a
   * steal — it is a duplicate, per `workedDupe`, which asks the transmit guard's boundary.
   */
  const brScores = useMemo(() => {
    const out = new Map<string, ReturnType<typeof scoreContact>>();
    if (!brMode) return out;
    const band = (status?.band ?? "").toUpperCase();
    const mode = (status?.subMode ?? status?.mode ?? "FT8").toUpperCase();
    const at = new Date();
    const claims = new Map((brFeed?.claims ?? []).map((c) => [claimKey(c.contact, c.band, c.mode), c] as const));
    const claimedBands = new Set(brFeed?.claimedBands ?? []);
    for (const d of rows) {
      const call = d.callsign?.toUpperCase();
      if (!call || out.has(call)) continue;
      const held = claims.get(claimKey(call, band, mode));
      const steal = held && held.holder !== myCall ? { from: held.holder, ...stealEstimate(held) } : undefined;
      out.set(
        call,
        scoreContact({
          band,
          mode,
          at,
          alreadyWorkedToday: workedDupe.has(call),
          claimedOnBand: claimedBands.has(bandKey(call, band)),
          steal,
        }),
      );
    }
    return out;
  }, [brMode, brFeed, rows, status?.band, status?.mode, status?.subMode, workedDupe, myCall]);

  const visible = useMemo(() => {
    // Search, then the category filter, ANDed. Matched against the whole message, which
    // names both stations, so a call finds people calling them too.
    const needle = search.trim().toUpperCase();
    const searched = needle
      ? rows.filter(
          (r) => r.message.toUpperCase().includes(needle) || (r.callsign ?? "").toUpperCase().includes(needle),
        )
      : rows;

    const filtered =
      filter === "all"
        ? searched
        : filter === "me"
          ? searched.filter((r) => mentionsMe(r.message))
          : // The auto operator's own ranking, so the filter and Auto Hunt cannot disagree.
            filter === "worth"
            ? searched.filter((r) => r.callsign && (worth.get(r.callsign)?.length ?? 0) > 0)
            : // The CQ filters read the modifier the PARSER extracted; a /CQ POTA/ regex
              // would also match a directed message that mentions it.
              searched.filter((r) => {
                const p = parseMessage(r.message);
                // The same function the hunt asks, so a station mid-exchange is refused here too.
                if (filter === "cq-free") {
                  return callableFrom(p, { myCall: myCall ?? "", treatClosingAsCallable: true }).callable;
                }
                if (p.kind !== "cq") return false;
                // POTA and DX stay CQ-only: a closing token carries no modifier.
                if (filter === "cq-pota") return p.modifier === "POTA";
                if (filter === "cq-dx") return p.modifier === "DX";
                return true;
              });

    // Battle Royale order, after the filters, so a search searches the same set either way.
    // Chronological stays the default. This was unreachable before the page was split — every filter
    // branch returned first — so BR mode added its column and never re-ordered the list.
    if (!brMode) return filtered;
    return rankByPoints(filtered, (d) => {
      const s = d.callsign ? brScores.get(d.callsign.toUpperCase()) : undefined;
      return s ?? { min: 0, max: 0, penalty: 0, multiplier: 1, reasons: [], steal: null };
    }).map((r) => r.item);
  }, [rows, filter, search, mentionsMe, worth, myCall, brMode, brScores]);

  /** Markers for the most recent cycle only — older ones aren't on screen. */
  const markers = useMemo<WaterfallMarker[]>(() => {
    // On the text modes the waterfall is a control: the markers are where the decoder listens.
    if (status?.subMode === "RTTY" && status.rtty) {
      return [
        { hz: status.rtty.markHz, label: "RTTY mark", emphasis: true },
        { hz: status.rtty.spaceHz, label: "RTTY space", emphasis: false },
      ];
    }
    if (status?.subMode === "CW" && status.cw) {
      return [{ hz: status.cw.pitchHz, label: "CW pitch", emphasis: true }];
    }
    if (status?.subMode === "PSK31" && status.psk) {
      return [{ hz: status.psk.centreHz, label: "PSK31 carrier", emphasis: true }];
    }
    if (status?.subMode === "OLIVIA" && status.olivia) {
      const half = status.olivia.bandwidth / 2;
      return [
        {
          hz: status.olivia.centreHz,
          label: `${status.olivia.code === "contestia" ? "Contestia" : "Olivia"} ${status.olivia.bandwidth}/${status.olivia.tones}`,
          emphasis: true,
        },
        { hz: status.olivia.centreHz - half, label: "edge", emphasis: false },
        { hz: status.olivia.centreHz + half, label: "edge", emphasis: false },
      ];
    }
    if (status?.subMode === "JTTY" && status.jtty) {
      // Where this station transmits: the lowest tone, and the top of its four (94 Hz up).
      return [
        { hz: status.jtty.txHz, label: "JTTY Tx", emphasis: true },
        { hz: status.jtty.txHz + 94, label: "edge", emphasis: false },
      ];
    }
    if (status?.subMode === "HELL" && status.hell) {
      // About 250 Hz wide at its strongest; a click inside the edges is close enough.
      return [
        { hz: status.hell.centreHz, label: "Hell carrier", emphasis: true },
        { hz: status.hell.centreHz - 125, label: "edge", emphasis: false },
        { hz: status.hell.centreHz + 125, label: "edge", emphasis: false },
      ];
    }
    if (rows.length === 0) return [];
    const newest = rows[0]!.timestamp;
    return rows
      .filter((r) => r.timestamp === newest)
      .map((r) => ({ hz: r.freqOffset, label: r.message, emphasis: mentionsMe(r.message) }));
  }, [rows, mentionsMe, status?.subMode, status?.rtty, status?.cw, status?.psk, status?.olivia, status?.hell, status?.jtty]);

  const cyclePct = ((now % scale.periodMs) / scale.periodMs) * 100;

  // Scored per cycle rather than per decode: the answer changes when a contact is logged,
  // not when the same station is heard again.
  useEffect(() => {
    const calls = [...new Set(rows.slice(0, 120).map((r) => r.callsign).filter(Boolean))];
    if (calls.length === 0) return;
    // Grids from the PARSER, not a regex: /[A-R]{2}\d{2}/ matches RR73, and every station
    // signing off earned a "new grid RR73" badge.
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
    void apiPost<{
      entries: { callsign: string; reasons: string[]; workedRecently?: boolean }[];
    }>("/api/digital/worth", {
      band: status?.band ?? null,
      // Mode too: the dupe rule is per band AND mode.
      mode: status?.subMode ?? status?.mode ?? null,
      calls,
      grids,
    })
      .then((r) => {
        if (cancelled) return;
        setWorth(new Map(r.entries.map((e) => [e.callsign, e.reasons])));
        setWorkedDupe(new Set(r.entries.filter((e) => e.workedRecently).map((e) => e.callsign)));
      })
      .catch(() => {
        /* scoring is an enhancement; the decode list works without it */
      });
    return () => {
      cancelled = true;
    };
    // Keyed on the newest decode rather than `rows`, or it fires a request per decode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows[0]?.timestamp, status?.band, status?.subMode, status?.mode]);

  // Median DT across recent decodes: other stations' errors cancel, leaving our own.
  const clock = useMemo(() => assessClock(rows.slice(0, 200).map((r) => r.deltaTime)), [rows]);

  /**
   * Decodes per transmit window, newest first. Bucketed by each decode's timestamp, not by
   * arrival: decodes land in a burst after the window closes and can straddle a boundary.
   */
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
  const staleSeconds = lastAt ? Math.floor((now - lastAt) / 1000) : null;

  // Seconds since the socket delivered anything. With `staleSeconds` these name the
  // failure: socket silent is the transport; socket fresh while rows age is the band, our
  // own TX windows, or this page.
  const msgAgeSeconds =
    linkStats.current.msgAt > 0 ? Math.floor((now - linkStats.current.msgAt) / 1000) : null;
  // A gap we caused is not one to investigate. Working someone in an automatic mode means
  // transmitting on alternate cycles, so decodes can be a minute apart and the list is right.
  if (status?.transmitting) txSeenRef.current = Date.now();
  const txAgeSeconds = txSeenRef.current > 0 ? Math.floor((now - txSeenRef.current) / 1000) : null;
  // Two periods of slack: the decode for the window before a transmission lands ~16 s in.
  const gapIsOurs =
    txAgeSeconds !== null &&
    staleSeconds !== null &&
    txAgeSeconds <= Math.max(45, Math.round((scale.periodMs * 2) / 1000));

  // Spectrum alone flows several times a second, so 8 s of silence is a real stall.
  const linkStalled = connected && msgAgeSeconds !== null && msgAgeSeconds >= 8;
  if (linkStalled && now - linkStats.current.stallLoggedAt > 30_000) {
    linkStats.current.stallLoggedAt = now;
    // The forensic record for the next report: what had arrived when it went quiet.
    console.warn(
      `[decodes] socket silent ${msgAgeSeconds}s while connected`,
      JSON.stringify(linkStats.current.counts),
      `parseErrors=${linkStats.current.parseErrors}`,
    );
  }
  /** Move the RTTY tone pair: the centre from a click on the waterfall or the ± buttons, the shift from its picker. */
  const tuneRtty = useCallback(async (centreHz?: number, shiftHz?: number, extra?: { reverse?: boolean; baud?: number }) => {
    try {
      await apiPost("/api/bridge/control", { action: "rtty", centreHz, shiftHz, reverse: extra?.reverse, baud: extra?.baud });
      setRttyError(null);
    } catch (err) {
      setRttyError(err instanceof ApiError ? err.message : "Could not move the RTTY tones");
    }
  }, []);
  /** Move the PSK31 carrier (a click on the waterfall or the ± buttons) or change the speed. */
  const tunePsk = useCallback(async (centreHz?: number, speed?: 31 | 63 | 125) => {
    try {
      await apiPost("/api/bridge/control", { action: "psk", centreHz, speed });
      setRttyError(null);
    } catch (err) {
      setRttyError(err instanceof ApiError ? err.message : "Could not move the PSK31 carrier");
    }
  }, []);
  /** Move where JTTY transmits: a click on the waterfall, a station's tag, or the ± buttons. */
  const tuneJtty = useCallback(async (txHz: number) => {
    try {
      await apiPost("/api/bridge/control", { action: "jtty", txHz });
      setRttyError(null);
    } catch (err) {
      setRttyError(err instanceof ApiError ? err.message : "Could not move the JTTY offset");
    }
  }, []);
  /** Move the Feld Hell carrier: a click on the waterfall or the ± buttons. */
  const tuneHell = useCallback(async (centreHz: number) => {
    try {
      await apiPost("/api/bridge/control", { action: "hell", centreHz });
      setRttyError(null);
    } catch (err) {
      setRttyError(err instanceof ApiError ? err.message : "Could not move the Hell carrier");
    }
  }, []);
  /** Move the Olivia tone set (a click on the waterfall or the ± buttons), change the size, or switch to Contestia. */
  const tuneOlivia = useCallback(async (centreHz?: number, size?: { tones: number; bandwidth: number }, code?: "olivia" | "contestia") => {
    try {
      await apiPost("/api/bridge/control", { action: "olivia", centreHz, tones: size?.tones, bandwidth: size?.bandwidth, code });
      setRttyError(null);
    } catch (err) {
      setRttyError(err instanceof ApiError ? err.message : "Could not move the Olivia tones");
    }
  }, []);
  /**
   * Where the decoder found the signal, as a tag on the waterfall: a click re-centres on it.
   * Only while the decoder is on a signal — Olivia's synchroniser over threshold, PSK31's
   * squelch open — because on noise the "found" offset is wherever the noise peaked.
   */
  const foundTags = useMemo<WaterfallTag[]>(() => {
    // JTTY: every station heard lately, by its first words; a click transmits on its frequency.
    if (status?.subMode === "JTTY") {
      if (!canSwitch) return [];
      return jttyHeard
        .filter((h) => Date.now() - h.at < 300_000)
        .map((h) => ({
          hz: h.hz,
          label: h.text.split(" ").slice(0, 3).join(" ").slice(0, 18),
          title: `${h.text} (${h.snr >= 0 ? "+" : ""}${h.snr} dB at ${h.hz} Hz) - click to transmit on this frequency`,
          onClick: () => void tuneJtty(h.hz),
        }));
    }
    if (!canSwitch || !streamStats) return [];
    if (status?.subMode === "OLIVIA" && status.olivia && streamStats.mode === "OLIVIA") {
      const off = streamStats.freqOffsetHz;
      if (streamStats.snr < 4 || Math.abs(off) < 8) return [];
      const hz = Math.round(status.olivia.centreHz + off);
      return [
        {
          hz,
          label: `found ${off > 0 ? "+" : ""}${Math.round(off)}`,
          title: `The Olivia signal is centred at ${hz} Hz - click to centre the decoder on it`,
          onClick: () => void tuneOlivia(hz),
        },
      ];
    }
    if (status?.subMode === "PSK31" && status.psk && streamStats.mode === "PSK31") {
      const off = streamStats.afcHz;
      if (!streamStats.open || Math.abs(off) < 2) return [];
      const hz = Math.round(status.psk.centreHz + off);
      return [
        {
          hz,
          label: `AFC ${off > 0 ? "+" : ""}${off.toFixed(0)}`,
          title: `The PSK31 carrier is at ${hz} Hz - click to put the decoder and the transmitter on it`,
          onClick: () => void tunePsk(hz),
        },
      ];
    }
    return [];
  }, [canSwitch, streamStats, status?.subMode, status?.olivia, status?.psk, tuneOlivia, tunePsk, jttyHeard, tuneJtty]);
  /** Send a line of RTTY. The bridge answers as soon as the radio is keyed; the line appears in the stream as [TX]. */
  const sendRtty = useCallback(async (text: string) => {
    try {
      await apiPost("/api/bridge/control", { action: "text-send", text });
      setRttyError(null);
    } catch (err) {
      setRttyError(err instanceof ApiError ? err.message : "Could not send");
    }
  }, []);
  /** Send a line of JS8: the bridge builds the frames and sends one per window from the next boundary. */
  const sendJs8 = useCallback(
    async (text: string) => {
      try {
        await apiPost("/api/bridge/control", { action: "js8-send", text, offsetHz: js8OffsetHz });
        setJs8Error(null);
      } catch (err) {
        setJs8Error(err instanceof ApiError ? err.message : "Could not send");
      }
    },
    [js8OffsetHz],
  );
  const setJs8Speed = useCallback(async (speed: "normal" | "fast" | "turbo" | "slow") => {
    try {
      await apiPost("/api/bridge/control", { action: "js8-speed", speedName: speed });
      setJs8Error(null);
    } catch (err) {
      setJs8Error(err instanceof ApiError ? err.message : "Could not change the JS8 speed");
    }
  }, []);
  const cancelJs8 = useCallback(async () => {
    try {
      await apiPost("/api/bridge/control", { action: "js8-cancel" });
    } catch (err) {
      setJs8Error(err instanceof ApiError ? err.message : "Could not cancel");
    }
  }, []);
  /** The CW sending speed, through the radio's keyer. */
  const setCwWpm = useCallback(async (wpm: number) => {
    try {
      await apiPost("/api/bridge/control", { action: "cw", wpm: Math.max(5, Math.min(60, wpm)) });
      setRttyError(null);
    } catch (err) {
      setRttyError(err instanceof ApiError ? err.message : "Could not set the CW speed");
    }
  }, []);
  const decodingAs = status?.subMode ?? status?.mode ?? "—";
  // The band buttons keep the operator on the mode being decoded; FT8 until the radio says.
  const tuneMode: DigitalMode = (DIGITAL_MODES as readonly string[]).includes(decodingAs)
    ? (decodingAs as DigitalMode)
    : "FT8";
  /** FT8, FT4 and FT2 have a sequencer; the bridge refuses calls and auto on the rest. */
  const sequencer = !NO_SEQUENCER_MODES.has(decodingAs);
  /** Modes with cycles and a decode table, as against a terminal or a picture. */
  const listMode = PANEL_TITLE[decodingAs] === undefined;

  /**
   * Anything to halt? Transmitting now, a contact in flight, or an automatic mode that will
   * key the radio next cycle. One `qso-halt` stops all three.
   */
  const haltable =
    (status?.transmitting ?? false) || (qso?.active ?? false) || (auto?.mode ?? "off") !== "off";

  // Latest values for the keydown handler, which is registered once.
  const keyStateRef = useRef({ haltable });
  keyStateRef.current = { haltable };

  /**
   * The keyboard: Escape halts the transmitter, `/` jumps to the decode search.
   *
   * Escape fires only when there is something to stop — it also closes the mobile nav
   * drawer, and dismissing a menu must not end a QSO. In a text field it blurs instead, so
   * two presses get you out of the search box and off the air. The typing guard is the
   * same as pages/rig.tsx's; a shared lib/client/keys.ts is the cleanup once both can move.
   */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (t?.isContentEditable ?? false);

      if (typing) {
        if (e.key === "Escape") t?.blur();
        return;
      }

      if (e.key === "Escape") {
        if (!keyStateRef.current.haltable) return;
        e.preventDefault();
        setHaltNote("HALT sent — stopping transmit and any automatic mode.");
        void apiPost("/api/bridge/control", { action: "qso-halt" }).catch((err) => {
          // A halt that failed is the one refusal that must never be silent.
          setHaltNote(
            err instanceof ApiError
              ? `HALT FAILED: ${err.message} — use the HALT TX button.`
              : "HALT FAILED — use the HALT TX button.",
          );
        });
        return;
      }

      if (e.key === "/") {
        // By id: `Input` does not forward a ref.
        const el = document.getElementById("decode-search");
        if (!(el instanceof HTMLInputElement)) return;
        e.preventDefault(); // or the "/" lands in the box we just focused
        el.focus();
        el.select();
      }
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The halt notice is an event, not a state: it goes away on its own.
  useEffect(() => {
    if (haltNote === null) return;
    const id = setTimeout(() => setHaltNote(null), 6_000);
    return () => clearTimeout(id);
  }, [haltNote]);

  const clearRows = useCallback(() => setRows([]), []);
  const clearStream = useCallback(() => setStreamText(""), []);
  const activeCall = qso?.active ? qso.theirCall : null;
  const transmitting = status?.transmitting ?? false;

  return (
    <>
      <PageHeader
        title="Digital"
        subtitle={
          status?.dialFrequency
            ? // The radio first: two can be configured, and the rest of the line depends on which.
              [status.radio?.model, `${formatFreqMHz(status.dialFrequency)} MHz`, status.band ?? "?", `decoding ${decodingAs}`]
                .filter(Boolean)
                .join(" · ")
            : "FT8 / FT4 band activity"
        }
        actions={
          <>
            {/* Band conditions from our own decode history, desktop only: below `lg` the
                strip wrapped the header to four rows, and it is reference material read once
                a session. `lg:contents` keeps it the direct flex child it always was. */}
            <span className="hidden lg:contents">
              <BandConditions currentBand={status?.band ?? null} mode={decodingAs} />
            </span>
            {/* Transmit ARMING is the header's control now; this says only that we are on the air. */}
            {transmitting && <Badge tone="danger">TX</Badge>}
            <Badge tone={connected ? "ok" : "warn"}>{linkLabel(connected, attempts)}</Badge>
            <ToggleButton
              pressed={brMode}
              onClick={toggleBr}
              loading={switchBusy}
              disabled={!canSwitch}
              aria-describedby={canSwitch ? undefined : switchReasonId}
              title={
                "BR mode: rank the list by FT8 Battle Royale points AND send each logged " +
                "contact to the Battle Royale server (Settings > Spotting & broadcast > " +
                "FT8 Battle Royale). A view plus a broadcast - it changes nothing about what the " +
                "station does on the air. FT8BR requires human-operated contacts, so stop " +
                "the auto operator before playing."
              }
            >
              BR mode
            </ToggleButton>
            <ToggleButton
              pressed={udpOn}
              onClick={toggleUdp}
              loading={switchBusy}
              disabled={!canSwitch}
              aria-describedby={canSwitch ? undefined : switchReasonId}
              title={
                "Broadcast each logged contact over UDP to the program set in Settings > " +
                "Spotting & broadcast > Broadcast logged contacts - GridTracker, Log4OM, JTAlert, N1MM. " +
                "Separate from BR mode, with its own destination."
              }
            >
              UDP
            </ToggleButton>
            {/* One reason for both, not the same sentence under each. */}
            {!canSwitch && (
              <span id={switchReasonId} className="text-xs text-fg-subtle">
                Operators switch these
              </span>
            )}
          </>
        }
      />

      {/* What Escape just did. role="alert": nobody is looking for this line, and a refused
          halt must interrupt rather than wait to be noticed. */}
      {haltNote && (
        <div
          role="alert"
          className={cn(
            "mb-4 rounded-sm border px-3 py-2 text-sm",
            haltNote.startsWith("HALT FAILED")
              ? "border-danger/60 bg-danger/15 text-danger"
              : "border-warn/50 bg-warn/10 text-warn",
          )}
        >
          {haltNote}
        </div>
      )}

      {fallback && !fallback.running && !connected && (
        <div className="mb-4">
          <ErrorBanner>{fallback.reason ?? "The bridge is not running."}</ErrorBanner>
        </div>
      )}

      {brMode && (auto?.mode ?? "off") !== "off" && <BattleRoyaleAutoWarning autoMode={auto?.mode ?? ""} />}

      <ClockBanner clock={clock} sync={clockSync} onSynced={setClockSync} />

      <OnAirStrip
        slotted={listMode}
        decodingAs={decodingAs}
        periodMs={scale.periodMs}
        cyclePct={cyclePct}
        latestCycleCount={latestCycleCount}
        staleSeconds={staleSeconds}
        qsosToday={todayStats?.today ?? null}
        recentCycles={recentCycles}
        picker={
          <BandModePicker
            currentBand={status?.band ?? null}
            decodingAs={tuneMode}
            region={ituRegionFromGrid(status?.deGrid)}
            onTuned={clearRows}
          />
        }
      />

      <OperatePanel
        sequencer={sequencer}
        auto={auto}
        qso={qso}
        schedule={status?.schedule ?? null}
        target={target}
        suggestSlot={suggestSlot}
        lastTx={lastTx}
        myCall={myCall}
        myGrid={status?.deGrid ?? null}
        onClose={() => {
          setTarget(null);
          setLastTx(null);
        }}
      />

      <div className="flex flex-col gap-4">
        {/* The waterfall goes last on a phone, after the decode list; `lg:order-none`
            restores source order on the desktop. */}
        <div className="order-last lg:order-none">
          <Waterfall
            row={spectrum}
            binHz={scale.binHz}
            maxHz={scale.maxHz}
            periodMs={scale.periodMs}
            markers={markers}
            tags={foundTags}
            onPickHz={
              decodingAs === "RTTY" && canSwitch
                ? (hz) => void tuneRtty(hz)
                : decodingAs === "JS8" && canSwitch
                  ? (hz) => setJs8OffsetHz(Math.round(hz))
                  : decodingAs === "PSK31" && canSwitch
                    ? (hz) => void tunePsk(Math.round(hz))
                    : decodingAs === "OLIVIA" && canSwitch
                      ? (hz) => void tuneOlivia(Math.round(hz))
                      : decodingAs === "HELL" && canSwitch
                        ? (hz) => void tuneHell(Math.round(hz))
                        : decodingAs === "JTTY" && canSwitch
                          ? (hz) => void tuneJtty(Math.round(hz))
                          : undefined
            }
            txHz={status?.txDF ?? null}
            gain={gain}
            // Per device, dragged from the handle below. History is kept as timed rows, so
            // resizing reveals or crops older rows without changing their time scale.
            height={waterfall.height}
          />
          <ResizeHandle
            onPointerDown={waterfall.onHandleDown}
            onDoubleClick={waterfall.reset}
            label="Drag to resize the waterfall. Double-click to reset."
            title={
              waterfall.custom
                ? `Waterfall ${waterfall.height}px — drag to resize, double-click to reset`
                : "Drag to resize the waterfall"
            }
          />
        </div>

        {/* The passband and "waiting" notes that were here are the waterfall's own ruler
            and overlay already. */}
        <div className="order-last lg:order-none flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-fg-subtle">
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
          <span className="flex items-center gap-2">
            <button
              type="button"
              onClick={audio.toggle}
              title={audio.listening ? "Stop listening" : "Listen to the receiver in this browser"}
              className={cn(
                "px-2 py-1 rounded-sm border",
                audio.listening
                  ? "border-accent text-accent-bright"
                  : "border-line text-fg-muted hover:text-fg hover:border-fg-muted",
              )}
            >
              {audio.listening ? "Listening" : "Listen"}
            </button>
            {audio.listening && (
              <label className="flex items-center gap-1.5">
                <span>vol</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={audio.volume}
                  onChange={(e) => audio.setVolume(Number(e.target.value))}
                  className="accent-accent w-24"
                  aria-label="Receiver volume"
                />
              </label>
            )}
            {audio.listening && audio.info && audio.info.packets === 0 && <span>waiting for audio…</span>}
            {audio.listening && audio.info && audio.info.context !== "running" && (
              <span className="text-accent-bright">audio {audio.info.context}</span>
            )}
            {audio.error && <span className="text-danger">{audio.error}</span>}
          </span>
          {status?.txDF !== null && status?.txDF !== undefined && (
            <span className="text-accent-bright tnum">TX offset {status.txDF} Hz</span>
          )}
          <Link
            href="/spectrum?source=audio"
            className="ml-auto text-accent-bright hover:underline"
            title="This waterfall as a spectrogram and 3D waterfall"
          >
            Open spectrum
          </Link>
        </div>

        {/* Radio and Heard-by are narrow fixed columns and the decode list takes the rest.
            Below `lg` it collapses to one column, and `order-*` puts the decode list first:
            in source order it was the seventh thing on a phone. */}
        <div className="grid gap-4 lg:grid-cols-[320px_260px_minmax(0,1fr)]">
          <RadioCard
            className="order-last lg:order-none"
            status={status}
            smeter={smeter}
            telemetry={telemetry}
            now={now}
            compact={compact}
            decodingAs={decodingAs}
            connected={connected}
            attempts={attempts}
            linkStats={linkStats.current}
            debug={debug}
            onDebug={toggleDebug}
          />

          <HeardBy className="order-last lg:order-none" />

          {/* order-1, not order-first, so something else can still claim the top. */}
          <div className="order-1 lg:order-none min-w-0 flex flex-col gap-4">
            {brMode && (
              <BattleRoyaleFeed
                feed={brFeed}
                myCall={myCall}
                heardNow={heardNow}
                workedDupe={workedDupe}
                scores={brScores}
                onCall={callRow}
              />
            )}
            <Card
              title={
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 min-w-0">
                  <h2 className="font-display text-base text-fg">
                    {listMode ? "Decodes" : PANEL_TITLE[decodingAs]}
                  </h2>
                  {listMode && (
                    <span className="text-sm text-fg-muted tnum">
                      {visible.length === rows.length ? rows.length : `${visible.length} of ${rows.length}`}
                    </span>
                  )}
                  {listMode && paused && (
                    <Badge tone="warn" size="sm">
                      Paused
                    </Badge>
                  )}
                  {sequencer && <CallFinishedToggle />}
                  <LinkHealth
                    connected={connected}
                    linkStalled={linkStalled}
                    msgAgeSeconds={msgAgeSeconds}
                    staleSeconds={staleSeconds}
                    gapIsOurs={gapIsOurs}
                    watchDecodes={listMode}
                  />
                </div>
              }
            >
              {listMode && (
                <DecodeToolbar
                  search={search}
                  onSearch={setSearch}
                  filter={filter}
                  onFilter={setFilter}
                  myCall={myCall}
                  size={decodeSize}
                  paused={paused}
                  onPause={() => setPaused((p) => !p)}
                />
              )}
              {rowCallNote && (
                <p className={cn("mb-2 text-xs", rowCallNote.error ? "text-danger" : "text-accent-bright")}>
                  {rowCallNote.text}
                </p>
              )}
              {decodingAs === "SSTV" ? (
                <SstvPanel ref={sstvPanel} stats={sstvStats} myCall={myCall} canSend={canSwitch} tx={sstvTx} />
              ) : decodingAs === "HELL" ? (
                <HellPanel
                  ref={hellPanel}
                  stats={hellStats}
                  hell={status?.hell ?? null}
                  text={streamText}
                  canTune={canSwitch}
                  canSend={canSwitch}
                  myCall={myCall}
                  transmitting={transmitting}
                  error={rttyError}
                  onTune={(hz) => void tuneHell(hz)}
                  onSend={(text) => void sendRtty(text)}
                  onClear={clearStream}
                />
              ) : STREAM_MODES.has(decodingAs) ? (
                <StreamPanel
                  mode={decodingAs}
                  text={streamText}
                  stats={streamStats}
                  rtty={status?.rtty ?? null}
                  cw={status?.cw ?? null}
                  psk={status?.psk ?? null}
                  olivia={status?.olivia ?? null}
                  jtty={status?.jtty ?? null}
                  onJttyTune={(hz) => void tuneJtty(hz)}
                  canTune={canSwitch}
                  canSend={canSwitch}
                  myCall={myCall}
                  transmitting={transmitting}
                  error={rttyError}
                  onTune={(centreHz, shiftHz, extra) => void tuneRtty(centreHz, shiftHz, extra)}
                  onCwWpm={(wpm) => void setCwWpm(wpm)}
                  onPskTune={(centreHz, speed) => void tunePsk(centreHz, speed)}
                  onOliviaTune={(centreHz, size, code) => void tuneOlivia(centreHz, size, code)}
                  onSend={(text) => void sendRtty(text)}
                  onClear={clearStream}
                />
              ) : (
                <>
                  {/* JS8: the frames are the rows below; the messages they join into sit above,
                      with the line to send — shown before the first frame decodes, too. */}
                  {decodingAs === "JS8" && (
                    <Js8Panel
                      prefill={js8Prefill}
                      speed={status?.js8Speed ?? "normal"}
                      onSpeed={(s) => void setJs8Speed(s)}
                      text={streamText}
                      myCall={myCall}
                      myGrid={status?.deGrid ?? null}
                      offsetHz={js8OffsetHz}
                      onOffsetHz={setJs8OffsetHz}
                      state={status?.js8 ?? null}
                      transmitting={transmitting}
                      canSend={canSwitch}
                      error={js8Error}
                      onSend={(text) => void sendJs8(text)}
                      onCancel={() => void cancelJs8()}
                      onClear={clearStream}
                    />
                  )}
                  {visible.length === 0 ? (
                    // "Nothing heard" and "nothing matched" are different problems, and the
                    // narrow filters are legitimately empty on a busy band.
                    rows.length > 0 ? (
                      <EmptyState
                        title="Nothing matches"
                        className="py-8"
                        action={
                          <span className="flex flex-wrap justify-center gap-x-4 gap-y-1">
                            {search && (
                              <Button variant="link" className="tap-inline" onClick={() => setSearch("")}>
                                Clear the search
                              </Button>
                            )}
                            {filter !== "all" && (
                              <Button variant="link" className="tap-inline" onClick={() => setFilter("all")}>
                                Show everything
                              </Button>
                            )}
                          </span>
                        }
                      >
                        {/* The search case is the one that means "that station is not on the air right now". */}
                        None of the {rows.length} decode{rows.length === 1 ? "" : "s"} heard
                        {search ? ` mention ${search}` : " match this filter"}
                        {search && filter !== "all" ? " within this filter" : ""}.
                      </EmptyState>
                    ) : (
                      <EmptyState title="No decodes yet" className="py-8">
                        FT8 reports every 15 seconds and FT4 every 7.5 — and nothing arrives while the
                        radio is transmitting.
                      </EmptyState>
                    )
                  ) : (
                    <DecodeTable
                      rows={visible}
                      fontPx={decodeSize.px}
                      brMode={brMode}
                      brScores={brScores}
                      worth={worth}
                      workedDupe={workedDupe}
                      workedNow={workedNow}
                      activeCall={activeCall}
                      mentionsMe={mentionsMe}
                      myGrid={status?.deGrid ?? null}
                      unit={unit}
                      callable={decodingAs !== "WSPR"}
                      js8={decodingAs === "JS8"}
                      onSelect={selectRow}
                      onCall={callRow}
                    />
                  )}
                </>
              )}
            </Card>
          </div>
        </div>
      </div>
    </>
  );
}

export const getServerSideProps = withPageAuth<Props>({
  inner: async (ctx: GetServerSidePropsContext) => {
    // See lib/bridge/ws-url.ts: two pages need this, and a second copy of the rule would drift.
    const { wsUrl, bridgePort } = await bridgeWsUrl(ctx.req.headers);
    return { props: { wsUrl, bridgePort } };
  },
});
