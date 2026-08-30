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

import { useVisibleInterval } from "@/lib/client/use-visible-interval";
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
  /** Why the gate is shut, when it is. "TX off" alone covered two different causes. */
  transmitOffReason?: string | null;
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
  /** The whole exchange so far, both directions. */
  transcript?: {
    at: number;
    dir: "tx" | "rx";
    message: string;
    snr?: number | null;
    offsetHz?: number | null;
    refused?: string | null;
  }[];
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

/**
 * True below Tailwind's `lg` — the phone and small-tablet layout.
 *
 * Everything else on this page that changes with width changes in CSS, which is the
 * right way to do it: no listener, no re-render, and one source of truth for where the
 * breakpoint is. Exactly two things on this page genuinely cannot be done that way, and
 * both are why this exists rather than a third responsive stylesheet:
 *
 *   1. The waterfall's height is a NUMBER handed to a <canvas>. The element's `height`
 *      attribute sizes the bitmap; a CSS height would stretch those pixels vertically
 *      instead of drawing fewer rows, which is a different picture, not a smaller one.
 *   2. A <details> has to be forced open on desktop. The UA hides a closed details'
 *      content from inside its own shadow tree, and `display: contents` on the element
 *      does not reach in there to stop it — so `lg:contents` alone would leave the
 *      Radio card's readouts collapsed on a 27" monitor.
 *
 * 1024px is `lg`, duplicated here because a breakpoint cannot be read back out of the
 * stylesheet at runtime. If the theme's `lg` moves, this moves with it.
 *
 * Starts `false` — the DESKTOP answer — so the server render and the first client
 * render agree and hydration stays clean. On a phone that costs one extra render
 * straight after mount: a flash of the wide layout, not a wrong layout. Initialising
 * from matchMedia in the useState initialiser would be one render shorter and would
 * mismatch on every server-rendered load.
 */
/**
 * A viewer preference kept on this device, read once on mount.
 *
 * `localStorage` is the right home for both of the settings below and the wrong home for
 * almost anything else: they are one operator's comfort on one screen, they must not
 * follow an account to a different monitor, and losing them costs nothing. A server
 * setting would sync a 27-inch operator's row height onto a phone.
 *
 * Every access is wrapped, including the accessor itself — Firefox throws on `getItem`
 * when site data is blocked, so a `try` around the read alone is not enough. A blocked
 * store degrades to "the default, every time", which is exactly right.
 */
function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode, blocked site data, or a full quota. Not worth telling anyone. */
  }
}

/**
 * How big the decode list is set, in px, and the controls to change it.
 *
 * Two reviewers wanted opposite things from this list and BOTH were right about their own
 * screen: a 74-year-old with age-related vision decline could not read 12px monospace at
 * all, and a DXer on a 27-inch monitor wanted more rows on screen than WSJT-X gives him.
 * There is no single number that serves both, so the number is the operator's.
 *
 * The steps are absolute px rather than a multiplier because the starting point — the old
 * hardcoded `text-xs` — is 12px, and an operator asking for "bigger" wants a size they can
 * read, not a ratio.
 */
const DECODE_SIZE_KEY = "digishack:decode-size:v1";
const DECODE_SIZES = [10, 11, 12, 13, 15, 17, 20] as const;
const DECODE_SIZE_DEFAULT = DECODE_SIZES.indexOf(12);

function useDecodeSize(): {
  px: number;
  bigger: () => void;
  smaller: () => void;
  canGrow: boolean;
  canShrink: boolean;
  reset: () => void;
  isDefault: boolean;
} {
  // Starts at the default so the server render and the first client render agree; the
  // stored value is applied in an effect. Getting this wrong is a hydration mismatch, not
  // a wrong size.
  const [i, setI] = useState(DECODE_SIZE_DEFAULT);

  useEffect(() => {
    const raw = readStored(DECODE_SIZE_KEY);
    const n = Number.parseInt(raw ?? "", 10);
    // Validated against the CURRENT step list rather than trusted: a stored index from a
    // build with a different list would otherwise read off the end and render NaN px.
    if (Number.isInteger(n) && n >= 0 && n < DECODE_SIZES.length) setI(n);
  }, []);

  const move = (delta: number): void => {
    setI((prev) => {
      const next = Math.min(DECODE_SIZES.length - 1, Math.max(0, prev + delta));
      writeStored(DECODE_SIZE_KEY, String(next));
      return next;
    });
  };

  return {
    px: DECODE_SIZES[i]!,
    bigger: () => move(1),
    smaller: () => move(-1),
    canGrow: i < DECODE_SIZES.length - 1,
    canShrink: i > 0,
    reset: () => {
      writeStored(DECODE_SIZE_KEY, String(DECODE_SIZE_DEFAULT));
      setI(DECODE_SIZE_DEFAULT);
    },
    isDefault: i === DECODE_SIZE_DEFAULT,
  };
}

/**
 * Waterfall height, in px, draggable by the handle beneath it.
 *
 * It was a constant, and no constant is right: 300px is a third of a phone screen showing
 * a display that cannot resolve two stations 40 Hz apart at that width, and on a 27-inch
 * monitor it is the thing standing between the operator and forty decode rows. One DXer
 * asked for it to be a resizable pane; a POTA operator wanted it small; on a desk it is
 * the nicest thing on the page.
 *
 * Stored per device and separately from the compact default, so shrinking it on a phone
 * does not shrink it in the shack.
 */
const WATERFALL_KEY = "digishack:waterfall-height:v1";
const WATERFALL_MIN = 60;
const WATERFALL_MAX = 640;

function useWaterfallHeight(compact: boolean): {
  height: number;
  onHandleDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  reset: () => void;
  custom: boolean;
} {
  const fallback = compact ? 120 : 300;
  const [stored, setStored] = useState<number | null>(null);

  useEffect(() => {
    const n = Number.parseInt(readStored(WATERFALL_KEY) ?? "", 10);
    if (Number.isFinite(n) && n >= WATERFALL_MIN && n <= WATERFALL_MAX) setStored(n);
  }, []);

  const height = stored ?? fallback;

  const onHandleDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    // Pointer capture, so a fast drag that leaves the 6px handle keeps resizing instead of
    // stopping dead — the whole point of a drag handle is that you stop aiming at it.
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);

    const move = (ev: PointerEvent): void => {
      const next = Math.min(WATERFALL_MAX, Math.max(WATERFALL_MIN, startH + (ev.clientY - startY)));
      setStored(next);
    };
    const up = (ev: PointerEvent): void => {
      el.releasePointerCapture(ev.pointerId);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      // Written on release, not on every frame: a drag is ~200 events and localStorage is
      // synchronous.
      setStored((h) => {
        if (h !== null) writeStored(WATERFALL_KEY, String(h));
        return h;
      });
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  return {
    height,
    onHandleDown,
    reset: () => {
      try {
        window.localStorage.removeItem(WATERFALL_KEY);
      } catch {
        /* nothing to do */
      }
      setStored(null);
    },
    custom: stored !== null,
  };
}

function useCompactLayout(): boolean {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 1023.98px)");
    const apply = () => setCompact(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  return compact;
}

/**
 * How loudly a "worth working" reason deserves to be said.
 *
 * THE FAULT: every one of these was rendered with the same class string —
 * `text-[10px] uppercase … text-ok` — and so was the "worked" badge on a station whose
 * contact had already been logged, character for character. *NEW DXCC: BOUVET* and
 * *worked him already, ignore* were the same 10-pixel green chip. CQ messages are green
 * too. So the one thing on this screen that is genuinely rare looked exactly like the
 * two things that are not, and lib/digital/worth.ts — which knows the difference, and
 * scores a new entity at 100 points against a grid band-slot at 3 — was throwing that
 * knowledge away at the last step.
 *
 * Five treatments now, and none of them share a colour:
 *
 *   entity   gold, 12px, full row  a new DXCC or a new continent. Unmissable on purpose.
 *   award    blue, 11px            a real slot: park, state, zone, entity-on-this-band.
 *   minor    grey, 10px            a new grid, or simply never worked before.
 *   CQ       green (unchanged)     "this station is callable", which is not the same claim.
 *   worked   dim grey (was green)  finished this session — the row the eye should skip.
 *
 * Gold rather than a brighter green because green is already spoken for twice over, and
 * because a new one IS the gold on this screen. `accent-bright` is spoken for as well —
 * it means "this message names me".
 */
type WorthTier = "entity" | "award" | "minor";

const WORTH_RANK: Record<WorthTier, number> = { minor: 0, award: 1, entity: 2 };

/**
 * Which tier a reason string belongs to.
 *
 * Matched against the exact strings lib/digital/worth.ts builds, which is a real
 * coupling and the deliberate one: the alternative is a second scoring model living on
 * the client, and a second model is how the badges an operator reads and the choices
 * Auto Hunt makes come to disagree. scripts/check-worth.ts asserts every literal below,
 * so changing the wording there fails a check rather than silently demoting a new
 * entity to a grey chip nobody looks at.
 */
function worthTier(reason: string): WorthTier {
  if (reason.startsWith("NEW DXCC:") || reason.startsWith("new continent ")) {
    return "entity";
  }
  // A GRID band-slot and an ENTITY band-slot both read "<thing> new on this band" and
  // are worth 3 points and 30 respectively. They are told apart by the shape of
  // <thing>: worth.ts upper-cases the grid, so it is always AA00, and no DXCC name or
  // two-letter state ever is. Checked before the general case for that reason.
  if (/^[A-R]{2}\d{2} new on this band$/.test(reason)) return "minor";
  if (/ new on this band$/.test(reason)) return "award";
  if (/^new (park|state|CQ zone) /.test(reason)) return "award";
  if (reason === "POTA activator") return "award";
  // "new grid EN61" and "never worked" — the latter fires across most of a busy band,
  // which is exactly why worth.ts does not count it as an award either.
  return "minor";
}

const WORTH_CHIP: Record<WorthTier, string> = {
  // Not `text-[10px] uppercase`: the entity NAME is the payload — "Bouvet", "Palestine"
  // — and it has to be readable as a word, at a size a glance can resolve, with its own
  // capitalisation intact.
  entity:
    "rounded-sm border border-warn/60 bg-warn/15 px-1.5 py-0.5 text-xs font-semibold text-warn align-middle",
  award:
    "rounded-sm border border-info/40 bg-info/12 px-1 py-0.5 text-[11px] uppercase tracking-wide text-info align-middle",
  minor:
    "rounded-sm border border-line-strong bg-surface-2 px-1 py-0.5 text-[10px] uppercase tracking-wide text-fg-muted align-middle",
};

/**
 * How many reasons to show on a row.
 *
 * Was ONE, with the rest hidden in a `title=` attribute — and `title` never fires on a
 * touch screen, so on a phone the other reasons did not exist. scoreCandidate routinely
 * returns three or four (a new entity is usually also a new zone, a new grid and never
 * worked), the message column has room to spare, and "new entity AND new zone" is a
 * different decision from "new entity". Three keeps the widest row inside the column.
 */
const MAX_REASONS_SHOWN = 3;

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
  /**
   * Feedback for a call started straight from a decode row.
   *
   * The panel at the top owns its own errors, but a row button that fires without going
   * through the panel needs somewhere to put a refusal — "transmit is off" arriving
   * nowhere is the same silent-button problem in a new place.
   */
  const [rowCallNote, setRowCallNote] = useState<string | null>(null);

  /**
   * Stations whose contact COMPLETED, so their later decodes read differently.
   *
   * A finished station keeps transmitting — the RR73 and 73 at the end of an exchange
   * arrive after the contact is logged, and on a busy band they sit in the list looking
   * exactly like somebody who still wants working. That was read as a dropped contact,
   * which is a fair reading of an interface that gives no sign either way.
   *
   * Session-scoped rather than the worked index: this answers "did I just work them",
   * which is a different and more immediate question than "have I ever worked them" —
   * the NEVER WORKED badge already covers that one.
   */
  const [workedNow, setWorkedNow] = useState<Set<string>>(new Set());

  /**
   * Call the station in this row, now.
   *
   * The button said "Call" and only SELECTED the station — the actual call needed a second
   * press in the panel above, which is two clicks and a label that lied about the first
   * one. Asked directly: "do i need to click call on the decode and at the top". Clicking
   * the ROW still just selects, which is the non-committal gesture; the button labelled
   * Call now does what it says.
   */
  const callFromRow = useCallback(
    async (d: DecodeEvent) => {
      if (!d.callsign) return;
      setTarget(d);
      setRowCallNote(null);
      try {
        const r = await apiPost<{ queued?: boolean; reason?: string }>(
          "/api/bridge/control",
          {
            action: "call",
            theirCall: d.callsign,
            theirGrid: gridFromMessage(d.message),
            theirSnr: d.snr,
            theirOffsetHz: d.freqOffset,
            theirWindowStart: new Date(d.timestamp).getTime(),
            message: d.message,
          },
        );
        if (r?.queued && r.reason) setRowCallNote(r.reason);
      } catch (err) {
        setRowCallNote(err instanceof ApiError ? err.message : "Could not start the call");
      }
    },
    [],
  );

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

  /** Phone/small-tablet layout. See useCompactLayout — CSS handles everything it can. */
  const compact = useCompactLayout();
  /** Per-device comfort settings. See useDecodeSize / useWaterfallHeight. */
  const decodeSize = useDecodeSize();
  const waterfall = useWaterfallHeight(compact);

  /**
   * What the Escape key just did, said out loud.
   *
   * A keyboard shortcut whose only feedback is the radio going quiet is a shortcut an
   * operator presses twice, then a third time, because nothing on screen changed within
   * the second it takes the bridge to answer and broadcast new state.
   */
  const [haltNote, setHaltNote] = useState<string | null>(null);

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
  //
  // Stopped while the tab is hidden. This ticks the largest component in the application
  // once a second, and the bar it drives has a 1s CSS transition, so between them they
  // never let the page idle — the single most expensive thing here for a phone in a
  // pocket. The catch-up on return means the bar is correct the instant it is looked at
  // rather than up to a second stale.
  useVisibleInterval(() => setNow(Date.now()), 1000);

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
            const call = (msg.log as { theirCall?: string } | undefined)?.theirCall;
            if (call) {
              setWorkedNow((prev) => new Set(prev).add(call.toUpperCase()));
            }
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

  /**
   * Is there anything to halt? Transmitting now, a contact in flight, or an automatic
   * mode that will key the radio on the next cycle whether or not it is keying it this
   * one. All three are stopped by the same `qso-halt`.
   */
  const haltable =
    (status?.transmitting ?? false) ||
    (qso?.active ?? false) ||
    (auto?.mode ?? "off") !== "off";

  // Latest values for the keydown handler, which is registered once and would otherwise
  // close over the first render's state forever. Same device as pages/rig.tsx.
  const keyStateRef = useRef({ haltable });
  keyStateRef.current = { haltable };

  /**
   * The keyboard. Escape halts the transmitter; `/` jumps to the decode search.
   *
   * THE FAULT: this page had no keyboard operation whatsoever. Grepping the whole
   * application for keydown found three Escape-to-close-a-drawer handlers and the
   * arrow-key VFO nudging on /rig, and nothing else — so the most safety-critical
   * control in the software, the one that stops an unattended transmitter mid-cycle,
   * could only be reached by locating a mouse and hitting a 90-pixel button.
   *
   * Escape fires ONLY when there is something to stop. That is not timidity about
   * sending a harmless no-op to the bridge: Escape is already taken on this page by the
   * mobile navigation drawer (components/layout/Shell.tsx), and an operator dismissing a
   * menu must not discover they have also ended a QSO. When the station IS transmitting,
   * stopping wins over dismissing and both happen — which is the right way round.
   *
   * Escape does not fire from inside a text field either; it blurs the field instead, so
   * two presses get you out of the search box and off the air. `/rig` simply ignores
   * keys while typing, and here that would leave the halt unreachable at exactly the
   * moment someone had a callsign half-entered.
   *
   * DUPLICATION, DELIBERATE, FOR NOW: the typing guard below is the same one as
   * pages/rig.tsx (the ArrowKey handler). It is copied rather than shared because this
   * change owns one file; a `lib/client/keys.ts` holding the guard and a small
   * registration helper is the obvious cleanup once both pages can be touched together.
   * If a third page grows a shortcut before that happens, do the extraction then.
   */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Leave browser and OS shortcuts alone.
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      const typing =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        (t?.isContentEditable ?? false);

      if (typing) {
        // One press leaves the field, the next one halts. Escape in a text input does
        // nothing useful in any browser, so borrowing it costs nothing and it is the
        // gesture everybody already makes to get out of a box.
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
        // `Input` does not forward a ref and components/ui/primitives.tsx belongs to
        // another change in flight; an id is the smaller coupling of the two and does
        // not need the primitive to grow an API for one call site.
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

  // The halt notice is an event, not a state: it says what a keypress just did, and it
  // has to go away on its own or it reads as a condition the station is still in.
  useEffect(() => {
    if (haltNote === null) return;
    const id = setTimeout(() => setHaltNote(null), 6_000);
    return () => clearTimeout(id);
  }, [haltNote]);

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
            {/* Desktop only, and `lg:contents` rather than `lg:block` so that above the
                breakpoint this span generates no box whatsoever: BandConditions stays
                the direct flex child of the actions row it has always been, and that row
                is unchanged to the pixel.

                Below it, the strip is a horizontally-scrolling rank of band tiles plus a
                three-line legend, and it was the biggest single contributor to a header
                that wrapped to FOUR rows at 390px — on a page where the decode list, the
                actual product, did not begin until roughly 1,900px of scrolling. Band
                conditions are reference material consulted once a session. This is the
                one class to delete if they should come back on a phone. */}
            <span className="hidden lg:contents">
              <BandConditions currentBand={status?.band ?? null} mode={decodingAs} />
            </span>
            {status?.transmitting && <Badge tone="danger">TX</Badge>}
            {/* The master transmit gate, which was visible nowhere.

                Bound to allowTransmit, NOT to txEnabled: the latter is WSJT-X's own
                flag and nothing sets it on the native Flex path, so a badge on it
                would read "off" permanently while the station transmitted. */}
            {status && (
              // WHY it is off, not just that it is.
              //
              // "TX off" covered two situations needing opposite responses: the operator's
              // own setting is off, or voice mode is holding the gate. The second survives
              // a restart and looks exactly like a setting that failed to persist, which
              // is how it was reported — "allow transmit doesn't seem to be persisting
              // through updates".
              //
              // The cause is in the label, not only the tooltip: a station that will not
              // key is not something to discover by hovering.
              <span
                title={
                  status.allowTransmit
                    ? "Transmit is armed."
                    : (status.transmitOffReason ?? "Transmit is off.")
                }
              >
                <Badge tone={status.allowTransmit ? "ok" : "warn"}>
                  {status.allowTransmit
                    ? "TX armed"
                    : /voice/i.test(status.transmitOffReason ?? "")
                      ? "TX off · voice"
                      : "TX off"}
                </Badge>
              </span>
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

      {/* What Escape just did.
          role="alert" because nobody is looking for this line when it appears, and a
          halt that was refused is the single refusal on this page that must interrupt
          rather than wait to be noticed. */}
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
        {/* flex-wrap, which was missing.
            This inner row is a flex ITEM of the wrapping row above it, so `min-width:
            auto` meant it could not shrink below its own min-content — five readouts and
            a sparkline, about 436px of them, inside a 390px viewport. A non-wrapping
            cluster inside a wrapping one is exactly the fault that once made every page
            on the site scroll sideways from one class missing on PageHeader; this is the
            same shape of it, unmeasured until now and now unmeasurable, because at
            desktop widths this row has never come close to wrapping.

            Numbers at text-xl, down from text-3xl. Thirty-pixel digits for four figures
            that are read once and then watched out of the corner of an eye, on a screen
            whose actual content could not fit one FT8 cycle. */}
        <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-fg-muted">
              This cycle
            </div>
            <div className="font-display text-xl leading-none tnum text-accent-bright">
              {latestCycleCount}
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-fg-muted">
              Total decodes
            </div>
            <div className="font-display text-xl leading-none tnum">
              {rows.length}
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-fg-muted">
              Last decode
            </div>
            <div className="font-display text-xl leading-none tnum">
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
                "font-display text-xl leading-none tnum",
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
              <div className="flex items-end gap-1 h-5">
                {/* Newest on the right, so it reads left-to-right in time order. */}
                {recentCycles
                  .slice()
                  .reverse()
                  .map((c) => (
                    <div
                      key={c.at}
                      className="w-2 bg-accent/50 rounded-sm"
                      style={{
                        height: `${Math.max(3, (c.count / cyclePeak) * 20)}px`,
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
        {/* THE WATERFALL GOES LAST ON A PHONE.
            This column is already a flex column, so `order-last` costs nothing and
            changes nothing above `lg`, where `order-none` restores source order exactly.
            Below it, 300px of waterfall plus its gain row stood between the operator and
            the decode list — and the waterfall was the fourth of seven blocks doing that.
            The wrapper div exists only to carry the class; Waterfall takes no className,
            and a bare div in a column flex adds no box of its own. */}
        <div className="order-last lg:order-none">
          <Waterfall
            row={spectrum}
            binHz={scale.binHz}
            maxHz={scale.maxHz}
            markers={markers}
            txHz={status?.txDF ?? null}
            gain={gain}
            // Was `compact ? 120 : 300`. Both numbers were defensible and neither was
            // right for everyone: 300px is a third of a phone screen for a display that
            // at 390px wide cannot resolve two stations 40 Hz apart, and on a 27-inch
            // monitor it is what stands between the operator and forty decode rows.
            // Those defaults survive as the starting point; the handle below overrides
            // them per device. See useWaterfallHeight.
            //
            // A number, not a CSS class, because the <canvas> height attribute sizes the
            // bitmap. Changing it reallocates the canvas and so wipes the scroll history,
            // which is correct — the rows would be the wrong height otherwise.
            height={waterfall.height}
          />
          {/* DRAG TO RESIZE. A 6px grab strip with a wider invisible hit area, because a
              6px target is a 6px target however tall the thing above it is. Double-click
              restores the default for this screen. */}
          <div
            onPointerDown={waterfall.onHandleDown}
            onDoubleClick={waterfall.reset}
            role="separator"
            aria-orientation="horizontal"
            aria-label="Drag to resize the waterfall. Double-click to reset."
            title={
              waterfall.custom
                ? `Waterfall ${waterfall.height}px — drag to resize, double-click to reset`
                : "Drag to resize the waterfall"
            }
            className="group relative h-1.5 cursor-ns-resize touch-none select-none"
          >
            {/* The visible grip: quiet until pointed at, so it does not compete with the
                spectrum immediately above it. */}
            <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-px bg-line group-hover:bg-line-strong" />
            <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 h-1 w-10 rounded-sm bg-line-strong opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
        </div>

        {/* flex-wrap added with the reorder: at 390px this row is a slider, a passband
            legend and a TX-offset readout on one unwrapping line, which is how a page
            comes to scroll sideways. It never wraps at desktop widths, so nothing above
            lg moves. */}
        <div className="order-last lg:order-none flex flex-wrap items-center gap-4 text-xs text-fg-subtle">
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
            waterfall blank while the decodes sat below the fold.

            THE DECODE LIST WAS THE SEVENTH THING ON A PHONE. Below `lg` this grid
            collapses to a single column in SOURCE ORDER, which put the Radio card — an
            S-meter, a power slider and ten rows of dial/band/mode/grid — and then the
            whole Heard-by panel between the operator and the decodes. Measured at
            roughly 1,900-2,200px of scrolling before the first decode row. Everything
            above it is reference material read once a session; the list is the product.

            Fixed with `order-*` and nothing else, so that above `lg` — where the grid has
            three explicit columns and order is meaningless anyway — `lg:order-none`
            restores the original DOM order and the desktop layout is byte-identical. */}
        <div className="grid gap-4 lg:grid-cols-[320px_260px_minmax(0,1fr)]">
          <Card title="Radio" className="order-last lg:order-none">
            <SMeter reading={smeter} now={now} />
            <PowerSlider current={status?.rfPower ?? null} />
            <RadioHealth telemetry={telemetry} transmitting={status?.transmitting ?? false} />
            {status ? (
              <>
                {/* Ten rows of dial, band, mode, call, grid and offset — every one of them
                    settled once and then true for the rest of the session — sat between a
                    phone and the decode list. Folded into a disclosure below `lg`.

                    `lg:contents` makes the <details> generate no box above the breakpoint,
                    so the <dl> is the Card's own child exactly as before. `open={!compact}`
                    is the other half and is not optional: a closed <details> hides its
                    content from inside the UA's shadow tree, which `display: contents` on
                    the element does not reach into — with the class alone these readouts
                    would be collapsed on a 27" monitor with no way to open them, because
                    the summary is hidden up there.

                    The status BADGES below are deliberately left outside it. "No rig
                    control" and "Transmitting" are not reference material; they are the
                    reason someone looks at this card at all, and a fact you have to expand
                    a panel to discover is a fact that goes undiscovered. */}
                <details className="lg:contents" open={!compact}>
                  <summary className="lg:hidden cursor-pointer select-none text-xs uppercase tracking-wide text-fg-muted">
                    Radio detail — dial, band, mode, grid
                  </summary>
                  <dl className="text-sm flex flex-col gap-1.5 mt-1.5 lg:mt-0">
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
                  </dl>
                </details>
                {/* Lifted out of the <dl> — which it was never valid content of anyway —
                    so it stays visible when the readouts above it are folded away. The
                    10px it used to inherit from the list's gap-1.5 plus its own mt-1 is
                    spelled out as mt-2.5 here, so nothing moves on desktop. */}
                <div className="flex gap-1.5 mt-2.5 flex-wrap">
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
              </>
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

          <HeardBy className="order-last lg:order-none" />

          {/* order-1, not order-first, so that if anything else in this grid ever needs
              to sit above the decodes it can take order-first without a fight. */}
          <div className="order-1 lg:order-none min-w-0">
            <Card
              title={`Decodes (${visible.length})`}
              actions={
                <div className="flex items-center gap-2">
                  {/* HOW BIG THE LIST IS, decided by whoever is reading it.
                      Two reviewers wanted opposite things and both were right about
                      their own screen: 12px monospace is unreadable with age-related
                      vision decline, and a DXer on a 27-inch monitor wants more rows
                      than WSJT-X shows him. There is no number that serves both.
                      Kept beside the search box rather than in Settings because the
                      right size depends on where you are sitting right now — reading
                      the log from the sofa is not the same as working a run. */}
                  <div
                    className="flex items-center rounded-sm border border-line-strong"
                    role="group"
                    aria-label="Decode text size"
                  >
                    <button
                      type="button"
                      onClick={decodeSize.smaller}
                      disabled={!decodeSize.canShrink}
                      aria-label="Smaller decode text"
                      title="Smaller — fits more rows on screen"
                      className="tap-inline px-2 py-1 text-sm leading-none text-fg-muted hover:text-fg disabled:opacity-40 disabled:hover:text-fg-muted"
                    >
                      −
                    </button>
                    {/* Double duty: it shows the current size, and clicking it puts the
                        size back. A reset nobody can find is a reset nobody has. */}
                    <button
                      type="button"
                      onClick={decodeSize.reset}
                      disabled={decodeSize.isDefault}
                      title={decodeSize.isDefault ? "Default size" : "Back to the default size"}
                      className="tap-inline px-1 py-1 text-[11px] leading-none tnum text-fg-subtle hover:text-fg disabled:hover:text-fg-subtle border-x border-line"
                    >
                      {decodeSize.px}
                    </button>
                    <button
                      type="button"
                      onClick={decodeSize.bigger}
                      disabled={!decodeSize.canGrow}
                      aria-label="Larger decode text"
                      title="Larger — easier to read across the room"
                      className="tap-inline px-2 py-1 text-sm leading-none text-fg-muted hover:text-fg disabled:opacity-40 disabled:hover:text-fg-muted"
                    >
                      +
                    </button>
                  </div>
                  {/* Type a callsign. Uppercased as you type because that is how every
                      decode is written, and a lowercase search matching nothing would
                      read as "they are not on the air". */}
                  <Input
                    // The `/` shortcut focuses this by id. See the keydown handler for
                    // why an id rather than a ref.
                    id="decode-search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value.toUpperCase())}
                    placeholder="Find a callsign…  (/)"
                    aria-label="Search decodes"
                    className="w-40 tnum"
                  />
                  {search !== "" && (
                    <button
                      type="button"
                      onClick={() => setSearch("")}
                      title="Clear the search"
                      // `tap-inline`: bare text sitting inline beside the search box.
                      // The coarse-pointer minimum would make it a 44px-tall word next
                      // to a control it is an adjunct of, pushing the card header onto
                      // a second row on the screen with the least of it.
                      className="tap-inline text-xs text-fg-muted hover:text-fg"
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
              {rowCallNote && (
                <p className="mb-2 text-xs text-accent-bright">{rowCallNote}</p>
              )}
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
                // was meant to remove. Raised from 42rem now that ~200px of chrome has
                // come off the top of the page: 52rem is about 43 rows at the tightened
                // row height, against 30 before, and a busy 20m FT8 cycle produces
                // 40-90 decodes. It does leave more empty column beside the Radio and
                // Heard-by cards on a short monitor; that is the trade, and it is the
                // right way round for a list that could not show one cycle.
                //
                // THE HEIGHT CAP AND THE INNER SCROLLER ARE DESKTOP-ONLY.
                // A 672px scroller inside a page that also scrolls is a trap on iOS: a
                // touch that begins over the table scrolls the table, one that begins a
                // few pixels outside it scrolls the page, and neither hands off to the
                // other at its end. On a phone the list is simply as long as it is and
                // the page scrolls, which is the behaviour a phone already has.
                //
                // `overflow-x-auto` stays at every width, and not only because a table
                // cannot be made to fit 360px: scripts/check-pwa.ts asserts that every
                // <table> in the tree has a horizontal scroll container within six lines
                // above it, because one unwrapped table sets the width of the whole
                // document and every page then scrolls sideways.
                <div className="-mx-4 overflow-x-auto lg:overflow-auto lg:max-h-[52rem]">
                  {/* The size is set HERE and inherited, so one number moves the header,
                      the rows and the row height together. Setting it per-cell would let
                      them drift apart at the extremes of the range. */}
                  <table
                    className="w-full border-collapse"
                    style={{ fontSize: `${decodeSize.px}px` }}
                  >
                    {/* Sticky only where there is an inner scroller to stick to. Below
                        `lg` this header was pinned to the top of a container that had
                        itself scrolled off the top of the screen, so the column labels
                        were reliably somewhere above the viewport. */}
                    <thead className="bg-surface-2 lg:sticky lg:top-0">
                      <tr className="text-left">
                        {["UTC", "dB", "Hz", "dt", "Mode", "Message"].map((h) => (
                          <th
                            key={h}
                            // `em`, not a fixed step: the header has to track the body
                            // or the two drift apart as the operator moves the size.
                            className="px-2.5 py-1 font-medium text-fg-muted text-[0.85em] uppercase tracking-wide"
                          >
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    {/* No `text-xs` — the size is inherited from the <table> above. */}
                    <tbody className="divide-y divide-line font-mono">
                      {visible.map((d) => {
                        const isCq = /^CQ\b/i.test(d.message);
                        const mine = mentionsMe(d.message);
                        const done =
                          d.callsign !== null && workedNow.has(d.callsign.toUpperCase());
                        const reasons = d.callsign ? (worth.get(d.callsign) ?? []) : [];
                        /**
                         * The loudest thing this station is worth — what the ROW is
                         * allowed to shout, as opposed to what its chips say.
                         *
                         * Null once the contact is logged this session. A station just
                         * worked is not a new entity any more; the scoring re-reads the
                         * log and will agree on its next pass, but until then a gold
                         * full-row NEW DXCC on a finished contact is exactly the "is
                         * this done or not" confusion the dimming exists to remove.
                         */
                        const tiers = reasons.map((r) => worthTier(r));
                        const tier: WorthTier | null =
                          done || tiers.length === 0
                            ? null
                            : tiers.reduce(
                                (best, t) =>
                                  WORTH_RANK[t] > WORTH_RANK[best] ? t : best,
                                "minor" as WorthTier,
                              );
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
                              // A NEW ENTITY GETS THE WHOLE ROW. It is the rarest thing
                              // that appears on this screen — a 47-year DXer may see one
                              // in a month — and it was a ten-pixel chip in the same
                              // green as "already worked, ignore".
                              tier === "entity" && "bg-warn/10",
                              // Ranked below the entity tint on purpose: a message that
                              // names this station is about to become a QSO, which
                              // outranks a station that merely could be one.
                              mine && "bg-accent/10",
                              // Worked and logged this session: dimmed, so the eye skips
                              // them. Applied AFTER `mine` so the tail of our own finished
                              // exchange reads as finished rather than as a station still
                              // calling us — which is the confusion this fixes.
                              done && "opacity-55",
                              // The station being worked right now outranks all of them.
                              qso?.active &&
                                d.callsign === qso.theirCall &&
                                "bg-ok/10 opacity-100",
                            )}
                          >
                            {/* The left edge carries the award tier, and every row
                                carries the border so the columns cannot shift by 2px
                                between a new entity and its neighbours. It lives on the
                                first <td> rather than the <tr> because a row border under
                                border-collapse is at the mercy of the cell borders it is
                                collapsing against; a cell border simply draws. */}
                            <td
                              className={cn(
                                "px-2.5 py-1.5 lg:py-0.5 tnum text-fg-subtle whitespace-nowrap border-l-2",
                                tier === "entity"
                                  ? "border-l-warn"
                                  : tier === "award"
                                    ? "border-l-info/60"
                                    : "border-l-transparent",
                              )}
                            >
                              {formatUtcTime(d.timestamp)}
                            </td>
                            <td
                              className={cn(
                                "px-2.5 py-1.5 lg:py-0.5 tnum text-right whitespace-nowrap",
                                d.snr >= 0
                                  ? "text-ok"
                                  : d.snr > -15
                                    ? "text-fg"
                                    : "text-fg-subtle",
                              )}
                            >
                              {d.snr > 0 ? `+${d.snr}` : d.snr}
                            </td>
                            <td className="px-2.5 py-1.5 lg:py-0.5 tnum text-right text-fg-muted">
                              {d.freqOffset}
                            </td>
                            <td className="px-2.5 py-1.5 lg:py-0.5 tnum text-right text-fg-subtle">
                              {d.deltaTime.toFixed(1)}
                            </td>
                            <td className="px-2.5 py-1.5 lg:py-0.5 text-fg-subtle">{d.mode}</td>
                            {/* py-1.5 below lg, py-0.5 above it.
                                Tighter on the desktop because ~989px of chrome above the
                                first row left twelve visible decodes where WSJT-X shows
                                45-60, and 4px a row is three more rows on screen. LOOSER
                                on a phone, not tighter: the row is itself a tap target —
                                tapping it selects the station — and a 20px row is not
                                one. */}
                            <td className="px-2.5 py-1.5 lg:py-0.5">
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
                              {/* Award value, from the same scoring the auto-operator
                                  uses. Thirty rows of identical-looking text is where
                                  a new entity hides; this is the whole reason the
                                  scoring existed and nobody could see it.

                                  UP TO THREE REASONS, each at its own weight. It was
                                  ONE, with the remainder in a `title=` — and `title`
                                  never fires on a touch screen, so on a phone the rest
                                  did not exist at all. scoreCandidate routinely returns
                                  three or four, and "new entity AND new zone" is a
                                  different decision from "new entity". The tooltip keeps
                                  the full list for the overflow case. */}
                              {reasons.slice(0, MAX_REASONS_SHOWN).map((r) => (
                                <span
                                  key={r}
                                  className={cn("ml-2", WORTH_CHIP[worthTier(r)])}
                                  title={reasons.join(" · ")}
                                >
                                  {r}
                                </span>
                              ))}
                              {reasons.length > MAX_REASONS_SHOWN && (
                                <span
                                  className="ml-1 align-middle text-[10px] text-fg-subtle"
                                  title={reasons.join(" · ")}
                                >
                                  +{reasons.length - MAX_REASONS_SHOWN}
                                </span>
                              )}
                              {/* Named, not only dimmed. Opacity alone is ambiguous — it
                                  could be any kind of de-emphasis — and this is a fact
                                  worth stating: the contact finished, so their RR73 and 73
                                  are the end of it rather than someone still calling.

                                  GREY, NOT GREEN. This chip and the needed-entity chip
                                  above it used to carry the same class string character
                                  for character, so "new one, call it" and "worked him,
                                  skip" were the same green rectangle. It is the one label
                                  here that means "nothing to do", and it now reads that
                                  way at a glance. */}
                              {done && (
                                <span
                                  className="ml-2 rounded-sm border border-line bg-surface-2 px-1 py-0.5 text-[10px] uppercase tracking-wide text-fg-subtle align-middle"
                                  title="Contact completed and logged this session."
                                >
                                  worked
                                </span>
                              )}
                              {/* The primary action of the whole application.

                                  It used to be a bare onClick on the <tr>: no
                                  affordance, no keyboard path, and on touch not even
                                  a tooltip, because `title` never fires there. The
                                  docs name this click as how you make your first
                                  contact and the interface never said so.

                                  stopPropagation because the row handler does the
                                  same thing — without it the click runs twice. */}
                              {d.callsign && (
                                <button
                                  type="button"
                                  title={`Call ${d.callsign} now. Click the row instead to select without transmitting.`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void callFromRow(d);
                                  }}
                                  className={cn(
                                    // `tap-inline` opts out of the 44px coarse-pointer
                                    // minimum from globals.css. The decode ROW is the
                                    // touch target here — tapping it selects the station
                                    // — so this is a secondary action inside an already
                                    // large target, and inflating it to 44px tall would
                                    // triple the row height on the device with the least
                                    // vertical space to spare.
                                    "tap-inline ml-2 rounded-sm border px-1.5 py-0.5 align-middle",
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
      // MEASURED AT ROUGHLY 170px of tutorial, permanently, at the top of an operating
      // screen — three lines of prose, a rule, two more lines and a five-control form,
      // all of it rendered in the state the station spends most of its time in. On a
      // 27" monitor there was ~989px of chrome above the first decode row and twelve
      // decode rows below it, against the 45-60 WSJT-X shows; a busy 20m FT8 cycle
      // produces 40-90 decodes, so the page could not display one cycle.
      //
      // COLLAPSED, NOT DELETED, and the split is the point. The sentence naming the
      // click stays on screen unconditionally — it exists because this panel used to
      // render NOTHING at all until after the click nobody knew to make, and hiding it
      // behind a disclosure would recreate that fault exactly. What goes away is the
      // manual-call form, which answers "work a station that has not decoded here": a
      // sked, a net, someone on the phone. That is a real need and a rare one, and it is
      // no part of anybody's first five minutes.
      <div className="mb-4 rounded-sm border border-dashed border-line-strong bg-surface px-3 py-1.5 text-sm text-fg-muted">
        <details>
          {/* The native disclosure triangle is kept deliberately. It is the only thing
              that says this line opens, and a sentence that reveals a form on click with
              no marker is the same mistake as a table row you had to know was clickable
              — which is a fault this file has already fixed once. */}
          <summary className="cursor-pointer select-none">
            Pick a station to work — press <span className="text-fg">Call</span> on any
            decode below, or click its row.
            <span className="ml-1.5 text-xs text-fg-subtle">
              Sked, or a station that has not decoded? Open this.
            </span>
          </summary>
          <div className="mt-2 border-t border-line pt-2">
            <p className="mb-1.5 text-xs text-fg-subtle">
              The exchange then runs itself: report, roger-report, RR73, logged. To call
              someone who has not decoded here — a sked, or a station you have been told
              is on — name them below. We transmit in the next cycle, so they answer in
              the one after.
            </p>
            {/* Still MOUNTED while collapsed, which matters: ManualCall picks a clear
                slot in its useState initialiser, so that pick happens at page load
                exactly as it did before this became a disclosure, and is exactly as
                liable to be stale by the time it is read. That is what "Find clear slot"
                is for, and it was already true. */}
            <ManualCall
              busy={busy}
              suggestSlot={suggestSlot}
              onCall={(c, hz) => void act("call", { theirCall: c, theirOffsetHz: hz })}
            />
          </div>
        </details>
        {/* Outside the <details>: everything inside a closed one is hidden, and a refused
            call must never be. The panel is open whenever this can fire today — but "is
            open today" is precisely how a button comes to fail silently tomorrow. */}
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
    // Two reasons reach this state now: nobody replied, or they answered somebody
    // else and we released the transmitter rather than call into their exchange.
    abandoned: "Call ended",
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
              {/* THE QUIETEST BUTTON ON THE PAGE, AND THE MOST IMPORTANT.
                  `variant="danger"` is a transparent outline — literally less
                  emphasised than "Log a QSO" — on the one control that stops an
                  unattended transmitter. `danger-solid` fills it, which is the only
                  filled red on the screen, and Escape now does the same thing without a
                  mouse at all. The take-over button a few lines up stays an outline
                  deliberately: two solid reds and neither is the emergency one. */}
              <Button
                variant="danger-solid"
                disabled={busy}
                onClick={() => void act("qso-halt")}
                title="Stop transmitting immediately — this QSO AND any automatic mode. Escape does the same."
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
        {/* THE WHOLE EXCHANGE, not just our last line.
            
            This was `sent: <one message>` — our side only, one message deep — so an
            operator watching a contact could see what we had just transmitted and nothing
            of what came back. The controller has recorded both directions all along; it
            was only written to the log at completion, which is the one moment it is no
            longer needed on screen.
            
            Laid out ACROSS rather than down: the messages are thirteen characters, the
            panel is the full width of the page, and a contact reads as a conversation
            left to right. It wraps when a long exchange needs it. */}
        {(qso?.transcript?.length ?? 0) > 0 ? (
          <div className="flex flex-wrap items-stretch gap-1.5">
            {qso!.transcript!.map((t, i) => (
              <div
                key={`${t.at}-${i}-${t.message}`}
                className={cn(
                  "rounded-sm border px-2 py-1 font-mono text-xs leading-tight",
                  t.refused
                    ? "border-danger/50 bg-danger/10 text-danger"
                    : t.dir === "tx"
                      ? "border-accent/40 bg-accent/10 text-accent-bright"
                      : "border-line text-fg",
                )}
                title={
                  (t.refused ? `REFUSED: ${t.refused}
` : "") +
                  `${new Date(t.at).toISOString().slice(11, 19)}Z` +
                  (t.snr != null ? ` · ${t.snr > 0 ? "+" : ""}${t.snr} dB` : "") +
                  (t.offsetHz != null ? ` · ${t.offsetHz} Hz` : "")
                }
              >
                <div className="flex items-center gap-1">
                  {/* Direction as a glyph rather than a word: at this size "tx"/"rx" is
                      the same width as the arrow and reads slower. */}
                  <span className={t.dir === "tx" ? "text-accent-bright" : "text-fg-subtle"}>
                    {t.dir === "tx" ? "▲" : "▼"}
                  </span>
                  <span>{t.message}</span>
                </div>
                <div className="text-[10px] text-fg-subtle tnum">
                  {new Date(t.at).toISOString().slice(14, 19)}
                  {t.snr != null && ` ${t.snr > 0 ? "+" : ""}${t.snr}`}
                  {t.refused && " refused"}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <>
            {qso?.lastSent && (
              <div className="font-mono text-xs text-accent-bright">sent: {qso.lastSent}</div>
            )}
            {lastTx && lastTx !== qso?.lastSent && (
              <div className="font-mono text-xs text-fg-subtle">tx: {lastTx}</div>
            )}
          </>
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
        // Solid, like the one in the Work station panel and for the same reason: this
        // is the control that stops an automatic mode keying the radio on its own, and
        // it was drawn as a transparent outline in a row of outlines.
        <Button
          variant="danger-solid"
          disabled={busy}
          onClick={() => void act({ action: "qso-halt" })}
          title="Stop everything — this contact and the automatic mode. Escape does the same."
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
// `className` reaches the Card so the caller can order this panel within the grid. It
// is passed rather than applied to a wrapper because the Card is the grid ITEM and
// stretches to the row height; a wrapper div would take that stretch and leave the card
// at its natural height, which is a visible desktop change for a mobile fix.
function HeardBy({ className }: { className?: string }) {
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
    /** Whether anything is actually asking PSKReporter. See the API for why. */
    collector?: {
      enabled: boolean;
      hasCallsign: boolean;
      lastQueryAt: string | null;
      running: boolean;
      detail: string;
    };
  }>("/api/psk-spots?minutes=60&limit=12");

  return (
    <Card title="Heard by" className={className}>
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
        /* AN EMPTY LIST IS NOT THE SAME CLAIM AS "NOBODY HEARD YOU".
           It also means: collection is switched off, no radio service is running to do
           the asking, or no callsign has been set. Only the first is about propagation,
           and it was the one being reported for all four — so an operator whose setting
           was wrong went and looked at their antenna. Reported by W9ABC, who had switched
           something on and seen nothing. */
        <div className="text-sm flex flex-col gap-2">
          {data?.collector?.detail ? (
            <>
              <p className="text-warn">{data.collector.detail}</p>
              <p className="text-fg-subtle text-xs">
                Until that is fixed this panel says nothing about whether anyone can hear
                you.
              </p>
            </>
          ) : (
            <>
              <p className="text-fg-subtle">
                Nobody yet, in the last hour. Reports come from PSKReporter a few minutes
                behind the transmission, and only when a receiver heard us and uploaded it.
              </p>
              {/* The two things that make this genuinely empty rather than broken, and
                  both are easy to forget: nobody can hear a station that has not
                  transmitted, and PSKReporter only knows what its receivers upload. */}
              <p className="text-fg-subtle text-xs">
                Asking every five minutes
                {data?.collector?.lastQueryAt
                  ? `, last at ${formatUtcTime(data.collector.lastQueryAt)}`
                  : ""}
                . Nobody can hear a station that has not transmitted — check the transmit
                gate if this stays empty while you are calling.
              </p>
            </>
          )}
        </div>
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
