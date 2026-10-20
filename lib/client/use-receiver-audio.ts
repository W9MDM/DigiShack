// Listening to the receiver in the browser, as a hook: the Rig page and the Decodes page
// both offer it, and two copies of this would drift the first time either was fixed.
// Lifted from pages/rig.tsx, where every comment below was earned.
//
// OWNERSHIP. A Listen is a SESSION: one player and the one socket feeding it, from the click
// to the stop, and the session object is the connection's generation. Only the current
// session may change what the page shows, and each one releases exactly what it owns. Before
// this (code review R17) the button had no starting state and `listening` turned true only
// when the socket opened, so a second click during startup built a second player and socket;
// the refs kept only the newest pair; and every socket's close handler stopped
// `playerRef.current` — the NEWEST player, not its own — so a late close from an old socket
// silenced a newer Listen. Leaving the page while the worklet loaded leaked the player,
// because it reached the ref the cleanup used only after that await.
//
// The logic is a plain class, so scripts/check-receiver-listen.ts can drive it with a fake
// socket and player and no browser; the hook at the bottom only binds it to a component.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { ReceiverAudio, type AudioPlayerState } from "@/lib/client/audio-player";
import { CONNECT_TIMEOUT_MS } from "@/lib/client/socket-retry";

/** idle → starting (click until the socket opens) → playing; error when a Listen fails or the stream drops. */
export type ReceiverAudioStatus = "idle" | "starting" | "playing" | "error";

export interface ReceiverAudioInfo {
  rate: number;
  packets: number;
  context: string;
  bufferedMs: number;
  underruns: number;
  /** The silence the dropouts added up to, ms. */
  starvedMs: number;
}

export interface UseReceiverAudio {
  status: ReceiverAudioStatus;
  /**
   * The stream is open and playing — what the button shows as pressed. Starting is `status`
   * alone: a click during it is ignored, so a double-click cannot build two players.
   */
  listening: boolean;
  volume: number;
  setVolume: (v: number) => void;
  /** What the player reports, once a second while listening: proof audio is arriving. */
  info: ReceiverAudioInfo | null;
  /** Why the last Listen failed, in words for the operator. Cleared by the next start or a stop. */
  error: string | null;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  toggle: () => void;
}

/** The player as the listener uses it: ReceiverAudio in the browser, a fake in the check. */
export type ListenerPlayer = Pick<
  ReceiverAudio,
  "start" | "stop" | "setVolume" | "setSampleRate" | "push" | "state"
>;

export interface ReceiverListenerOptions {
  /** The audio socket's URL, read at each start rather than when the listener is built. */
  url: () => string;
  createPlayer?: () => ListenerPlayer;
  openSocket?: (url: string) => WebSocket;
  /** From the click until the socket opens. */
  startTimeoutMs?: number;
  /** How often `info` is refreshed while playing. */
  pollMs?: number;
}

export interface ReceiverListenerSnapshot {
  status: ReceiverAudioStatus;
  volume: number;
  info: ReceiverAudioInfo | null;
  error: string | null;
}

/** `wsUrl` is the page's decodes socket URL; the audio socket sits beside it at /ws/audio. */
export function audioSocketUrl(wsUrl: string): string {
  return wsUrl.replace(/\/ws\/decodes$/, "/ws/audio");
}

/** WebSocket.CONNECTING, without reaching for a global the check may not have. */
const CONNECTING = 0;

/** One Listen, and everything it owns. */
interface Session {
  readonly generation: number;
  readonly url: string;
  readonly player: ListenerPlayer;
  socket: WebSocket | null;
  startTimer: ReturnType<typeof setTimeout> | null;
  opened: boolean;
  gotHello: boolean;
  /** An error event arrived; the close that follows it says which kind of failure it was. */
  socketError: boolean;
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class ReceiverListener {
  private snapshot: ReceiverListenerSnapshot = {
    status: "idle",
    volume: 0.8,
    info: null,
    error: null,
  };
  private readonly subscribers = new Set<() => void>();
  private session: Session | null = null;
  private generation = 0;
  private disposed = false;
  private poll: ReturnType<typeof setInterval> | null = null;
  private readonly createPlayer: () => ListenerPlayer;
  private readonly openSocket: (url: string) => WebSocket;
  private readonly startTimeoutMs: number;
  private readonly pollMs: number;

  constructor(private readonly opts: ReceiverListenerOptions) {
    this.createPlayer = opts.createPlayer ?? (() => new ReceiverAudio());
    this.openSocket = opts.openSocket ?? ((url) => new WebSocket(url));
    this.startTimeoutMs = opts.startTimeoutMs ?? CONNECT_TIMEOUT_MS;
    this.pollMs = opts.pollMs ?? 1_000;
  }

  /** For useSyncExternalStore. */
  readonly subscribe = (fn: () => void): (() => void) => {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  };

  readonly getSnapshot = (): ReceiverListenerSnapshot => this.snapshot;

  /**
   * Begin a Listen. Call it from the click: the player's AudioContext is created
   * synchronously inside this call. A no-op while a Listen is starting or playing.
   */
  readonly start = (): Promise<void> => {
    if (this.disposed || this.session) return Promise.resolve();
    const s: Session = {
      generation: ++this.generation,
      url: this.opts.url(),
      player: this.createPlayer(),
      socket: null,
      startTimer: null,
      opened: false,
      gotHello: false,
      socketError: false,
    };
    this.session = s;
    this.set({ status: "starting", error: null, info: null });

    // A BOUND ON STARTING, because a click during it is ignored and something must end it.
    // Covers the whole of it: a browser WebSocket left in CONNECTING — a proxy in front of a
    // dead origin — fires neither onopen nor onclose (see socket-retry.ts), and an audio
    // context whose resume never settles would hold the button the same way.
    s.startTimer = setTimeout(() => {
      s.startTimer = null;
      if (!this.owns(s) || s.opened) return;
      const seconds = Math.round(this.startTimeoutMs / 1000);
      this.fail(
        s,
        s.socket
          ? `The audio stream at ${s.url} did not answer within ${seconds} s.`
          : `The browser did not start audio within ${seconds} s. Click Listen again.`,
      );
    }, this.startTimeoutMs);

    return this.run(s);
  };

  /** End the Listen, whatever stage it reached. Idempotent. */
  readonly stop = async (): Promise<void> => {
    const s = this.session;
    // Forgotten FIRST, so nothing its socket does from here on — the close this causes, or a
    // late one long after a newer Listen has started — is this listener's business.
    const released = s ? this.release(s) : Promise.resolve();
    // A stopped listener has no diagnostics: a stale packet count implies audio still
    // arriving, and a stale error implies the stop failed.
    this.set({ status: "idle", error: null, info: null });
    await released;
  };

  /** Listen if idle (or failed), stop if playing; ignored while starting. */
  readonly toggle = (): void => {
    if (this.snapshot.status === "starting") return;
    void (this.session ? this.stop() : this.start());
  };

  readonly setVolume = (v: number): void => {
    const volume = Math.max(0, Math.min(1, v));
    this.session?.player.setVolume(volume);
    this.set({ volume });
  };

  /**
   * The component is going away: release everything — including a Listen still loading its
   * worklet, whose context is closed now rather than when the load settles — and accept
   * nothing more until attach().
   */
  dispose(): void {
    this.disposed = true;
    const s = this.session;
    if (s) void this.release(s);
    this.snapshot = { ...this.snapshot, status: "idle", info: null, error: null };
  }

  /** The component is in the page again. React's development double-mount disposes, then re-attaches. */
  attach(): void {
    this.disposed = false;
  }

  /** True while `s` is the Listen in progress: the one thing allowed to change state. */
  private owns(s: Session): boolean {
    return !this.disposed && this.session?.generation === s.generation;
  }

  private async run(s: Session): Promise<void> {
    // The AudioContext is created HERE, inside the click, before the socket is opened — and
    // before the first await on this path, which is what keeps it inside the gesture. Every
    // browser blocks audio started outside a user gesture, and the failure is silent: a
    // context created when the first message arrives exists, has packets scheduled on it,
    // and plays nothing.
    try {
      await s.player.start(this.snapshot.volume);
    } catch (err) {
      // Stopped or unmounted meanwhile: that path released this session, and the rejection
      // is the cancellation it caused rather than news.
      if (!this.owns(s)) return;
      this.fail(s, `The browser would not start audio (${reason(err)}). Click Listen again.`);
      return;
    }
    if (!this.owns(s)) return;

    let ws: WebSocket;
    try {
      ws = this.openSocket(s.url);
    } catch (err) {
      this.fail(s, `Could not open the audio connection to ${s.url} (${reason(err)}).`);
      return;
    }
    s.socket = ws;
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      if (!this.owns(s)) return;
      s.opened = true;
      if (s.startTimer) clearTimeout(s.startTimer);
      s.startTimer = null;
      this.set({ status: "playing" });
      this.startPolling(s);
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (!this.owns(s)) return;
      if (typeof ev.data === "string") this.onText(s, ev.data);
      else s.player.push(ev.data as ArrayBuffer);
    };
    ws.onerror = () => {
      if (this.owns(s)) s.socketError = true;
    };
    // A STALE SOCKET'S CLOSE IS A STRANGER'S. It arrives after its session was released —
    // possibly long after, with a newer Listen playing — and must touch nothing.
    ws.onclose = (ev: CloseEvent) => {
      if (!this.owns(s)) return;
      this.fail(s, this.closeMessage(s, ev));
    };
  }

  /**
   * A text frame: the format hello. First, and again mid-stream when the bridge switches
   * radios (code review R08) — the Icom streams 48 kHz and the FlexRadio 24, and the wrong
   * one sounds like fast forward or under water.
   */
  private onText(s: Session, text: string): void {
    let hello: { kind?: unknown; sampleRate?: unknown };
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== "object") throw new Error("not an object");
      hello = parsed as typeof hello;
    } catch {
      if (!s.gotHello) this.fail(s, "Could not read the audio stream's format.");
      return;
    }
    // Some other message from a newer bridge: not this version's business.
    if (hello.kind !== undefined && hello.kind !== "audio-hello") return;

    const rate =
      typeof hello.sampleRate === "number" && Number.isFinite(hello.sampleRate) ? hello.sampleRate : 0;
    if (rate <= 0) {
      this.fail(
        s,
        s.gotHello
          ? "The bridge switched to an external decoder, which has no radio audio to send."
          : "The bridge has no radio audio to send — the source is an external decoder.",
      );
      return;
    }
    s.gotHello = true;
    // The first hello or a new radio's: either way the stream starts afresh at this rate —
    // resampler rebuilt, the old radio's queued audio dropped. See setSampleRate.
    s.player.setSampleRate(rate);
    this.refreshInfo(s);
  }

  private closeMessage(s: Session, ev: { code?: number; reason?: string }): string {
    const said = ev.reason ? `: ${ev.reason}` : "";
    if (!s.opened) {
      return said
        ? `The audio stream at ${s.url} refused the connection${said}`
        : `Could not reach the audio stream at ${s.url}. The bridge listens on loopback only, ` +
            "so a browser on another machine needs bridge.wsUrl pointing at a proxy.";
    }
    // A socket that opens and closes again without a hello is a bridge that went away
    // mid-connect; without this the button flicks to Listening and back with nothing said.
    if (!s.gotHello) {
      return said
        ? `The audio stream at ${s.url} closed before sending anything${said}`
        : `The audio stream at ${s.url} closed before sending anything. The bridge is ` +
            "probably not running — start it with `npm run bridge`.";
    }
    return `The audio stream stopped${said || " — the bridge restarted or lost the radio"}. Click Listen to start again.`;
  }

  /** End the current Listen with something to tell the operator. */
  private fail(s: Session, error: string): void {
    if (!this.owns(s)) return;
    void this.release(s);
    this.set({ status: "error", error, info: null });
  }

  /** Release everything `s` owns — timer, socket, player — and forget it. */
  private release(s: Session): Promise<void> {
    if (this.session?.generation === s.generation) this.session = null;
    this.stopPolling();
    if (s.startTimer) clearTimeout(s.startTimer);
    s.startTimer = null;
    const ws = s.socket;
    s.socket = null;
    try {
      ws?.close();
    } catch {
      /* already closed */
    }
    return s.player.stop().catch(() => {});
  }

  /** A counter that proves audio is arriving, rather than a button that merely looks pressed. */
  private startPolling(s: Session): void {
    this.stopPolling();
    this.poll = setInterval(() => {
      if (this.owns(s)) this.refreshInfo(s);
    }, this.pollMs);
  }

  private stopPolling(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
  }

  private refreshInfo(s: Session): void {
    const st: AudioPlayerState = s.player.state;
    this.set({
      info: {
        rate: st.sampleRate,
        packets: st.packets,
        context: st.contextState,
        bufferedMs: st.bufferedMs,
        underruns: st.underruns,
        starvedMs: st.starvedMs,
      },
    });
  }

  private set(patch: Partial<ReceiverListenerSnapshot>): void {
    if (this.disposed) return;
    this.snapshot = { ...this.snapshot, ...patch };
    for (const fn of this.subscribers) fn();
  }
}

/** `wsUrl` is the page's decodes socket URL; the audio socket sits beside it at /ws/audio. */
export function useReceiverAudio(wsUrl: string): UseReceiverAudio {
  // Read at the click, so a URL that changes later is the one used by the next Listen.
  const url = useRef(wsUrl);
  useEffect(() => {
    url.current = wsUrl;
  }, [wsUrl]);

  // One listener for the life of the component. The player and its socket live inside it,
  // not in React state: the ring buffer inside the player must survive re-renders untouched,
  // and these pages re-render constantly from status and decode traffic. Nothing in it
  // touches the browser until start().
  const [listener] = useState(() => new ReceiverListener({ url: () => audioSocketUrl(url.current) }));

  // Stop on the way out, always — including on the way out while the worklet is still
  // loading. A page left for another one would otherwise keep an audio device open and a
  // socket pulling 96 kB/s from the bridge for as long as the tab lived.
  useEffect(() => {
    listener.attach();
    return () => listener.dispose();
  }, [listener]);

  const snap = useSyncExternalStore(listener.subscribe, listener.getSnapshot, listener.getSnapshot);

  return {
    status: snap.status,
    listening: snap.status === "playing",
    volume: snap.volume,
    setVolume: listener.setVolume,
    info: snap.info,
    error: snap.error,
    start: listener.start,
    stop: listener.stop,
    toggle: listener.toggle,
  };
}
