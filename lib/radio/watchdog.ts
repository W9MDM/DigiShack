// Noticing that the bridge has stopped working while still appearing to run.
//
// WHY THIS EXISTS, precisely: on 2 August 2026 the bridge produced its last decode at
// 10:47 and was still reported `online` by PM2 at 15:48 — five hours of nothing, with a
// live process, an open port and no error in any log. PM2 watches whether the process
// exists. The process existed. It was simply not doing anything.
//
// That is the failure a process check cannot catch, and it is the common one: a hung
// event loop, a socket that stopped delivering, a radio that went away without closing
// the connection. What distinguishes it from healthy idleness is not "no contacts" or
// even "no decodes" — a quiet band legitimately produces neither — but the absence of
// the periodic work the pipeline does regardless of whether anything is on the air.
//
// So the heartbeat is the window event. It fires once per T/R period whether or not
// anything decoded, so it stops only when the machinery stops.

/**
 * What to do when the heartbeat stops.
 *
 * The bridge's answer is to exit, because PM2 restarts it and a fresh process is the
 * only reliable cure for a hung one. Injected rather than hardcoded so the behaviour is
 * testable without ending the test runner.
 */
export type OnDead = (info: { sinceMs: number; label: string }) => void;

export interface WatchdogOptions {
  /** How long without a beat before the watchdog fires. */
  timeoutMs: number;
  onDead: OnDead;
  /** Named in the log line, so a failure says which subsystem went quiet. */
  label?: string;
  /** How often to check. Fine-grained enough not to add much to the timeout. */
  checkIntervalMs?: number;
  /** Injectable for tests. */
  now?: () => number;
}

export class LivenessWatchdog {
  private lastBeat: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private fired = false;
  private readonly now: () => number;
  private timeoutMs: number;

  constructor(private readonly opts: WatchdogOptions) {
    this.now = opts.now ?? Date.now;
    this.timeoutMs = opts.timeoutMs;
  }

  /** The current timeout: the constructor's, or the last retime(). */
  get timeout(): number {
    return this.timeoutMs;
  }

  /**
   * Change the timeout while running, for a pipeline whose period changed under it.
   *
   * A WSPR window is two minutes long, so a watchdog armed on FT8's fifteen-second
   * period (two minutes, for eight of them) fires before the first WSPR window can
   * possibly arrive: on 14 October 2026 it restarted the bridge 136 s after the decoder
   * switched to WSPR, which put the radio back on FT8 and looked exactly like WSPR not
   * working. The last beat is kept - it was real work - and only the deadline moves; the
   * check interval is rebuilt because it is derived from the timeout.
   */
  retime(timeoutMs: number): void {
    if (timeoutMs === this.timeoutMs) return;
    this.timeoutMs = timeoutMs;
    if (this.timer) {
      this.stop();
      this.start();
    }
  }

  /**
   * Record that the thing being watched did its work.
   *
   * The first beat also arms the watchdog. Arming at construction instead would count
   * startup — radio discovery, the client handshake, the first slice — against the
   * timeout, and restart a bridge that was merely still connecting.
   */
  beat(): void {
    this.lastBeat = this.now();
  }

  get armed(): boolean {
    return this.lastBeat !== null && this.timer !== null;
  }

  /** Milliseconds since the last beat, or null before the first one. */
  get silentFor(): number | null {
    return this.lastBeat === null ? null : this.now() - this.lastBeat;
  }

  start(): void {
    if (this.timer) return;
    const every = this.opts.checkIntervalMs ?? Math.max(1_000, Math.floor(this.timeoutMs / 6));
    this.timer = setInterval(() => this.check(), every);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Exposed for tests; the timer calls it. */
  check(): void {
    // Never fired before the first beat: silence during startup is not a fault.
    if (this.lastBeat === null || this.fired) return;
    const since = this.now() - this.lastBeat;
    if (since < this.timeoutMs) return;

    // Latched. Without this the interval keeps firing while the process winds down,
    // and the log fills with the same line — which is how a clear diagnosis gets
    // buried in its own repetition.
    this.fired = true;
    this.stop();
    this.opts.onDead({ sinceMs: since, label: this.opts.label ?? "bridge" });
  }

  /** Clear the latch, for a caller that recovered without restarting. */
  reset(): void {
    this.fired = false;
    this.lastBeat = null;
  }
}

/**
 * A sensible timeout for a decode pipeline, given the mode's period.
 *
 * Windows arrive one per period, so the timeout has to be a multiple of it — and a
 * generous one. A decode at depth 3 can take 1.5 s, a band change resets the schedule,
 * and a single missed window is not a fault. Eight periods is 2 minutes on FT8 and 30
 * seconds on FT2, which is long enough never to fire on a working radio and short
 * enough that a hang is caught in minutes rather than the five hours it took here.
 */
export function windowTimeoutMs(periodMs: number, periods = 8): number {
  // `periods` counts FT8-length periods, which is what the setting has always meant on
  // the modes it was written for (eight of them: 2 minutes). A mode with a LONGER period
  // cannot use the same multiplier - eight WSPR windows is sixteen minutes of not
  // noticing - but it cannot share FT8's deadline either, because its first window after
  // a mode switch arrives up to one period plus the transmission length later, about
  // 232 s. Three of its own periods covers that with a window to spare.
  const ft8LengthPeriods = periods * Math.min(periodMs, 15_000);
  return Math.max(60_000, ft8LengthPeriods, 3 * periodMs);
}
