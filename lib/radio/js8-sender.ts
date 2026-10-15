// JS8 sending: a message's frames, one per fifteen-second window, in order.
//
// A JS8 message is one or more frames (lib/digital/js8-message.ts builds them: a heartbeat
// is one, a line of text is as many as it takes), and the receiving station joins them
// per frequency from the first to the last. So they go out in CONSECUTIVE windows at ONE
// offset: a gap, a retune or a missing tail leaves the far end holding a partial message
// for ninety seconds and then printing it with an ellipsis. This class owns that sequence
// and nothing else: it asks the transmitter for one frame per window, a little before each
// boundary, and stops at the first refusal rather than send a tail without its head.
//
// Pure scheduling: the clock and the timers are injectable, and scripts/check-js8-sender.ts
// drives it with a fake clock. The bridge supplies `send`, which is the framed transmitter
// with the frame riding on the request (lib/flex/tx.ts builds the waveform from it).

import type { Js8OutFrame } from "@/lib/digital/js8-message";
import { nextWindowStart, PERIOD_MS } from "@/lib/radio/timing";

export interface Js8SendResult {
  sent: boolean;
  reason?: string;
}

export interface Js8SenderState {
  sending: boolean;
  /** The line being sent, as typed. */
  text: string | null;
  frames: number;
  sent: number;
  /** The boundary of the next frame's window, UTC ms; null when idle. */
  nextWindow: number | null;
  /** Why the last message stopped short, or null when it finished or never ran. */
  stopped: string | null;
}

export interface Js8SenderDeps {
  /** Transmit one frame in the window that starts at `windowStart`; resolves once it has gone out or been refused. */
  send: (frame: Js8OutFrame, index: number, windowStart: number) => Promise<Js8SendResult>;
  onProgress?: (state: Js8SenderState) => void;
  /** Tests only: the clock and the timers. */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

/** The transmitter is asked this long before the boundary; it waits out the rest itself and keys 0.5 s after it. */
export const JS8_ARM_MS = 2_000;
/** A message asked for closer than this to a boundary starts at the one after: the transmitter needs its lead. */
export const JS8_LEAD_MS = 2_500;

const IDLE: Js8SenderState = { sending: false, text: null, frames: 0, sent: 0, nextWindow: null, stopped: null };

export class Js8Sender {
  private state: Js8SenderState = { ...IDLE };
  private timer: unknown = null;
  /** Bumped by every start and cancel, so a frame armed for an old message never fires. */
  private gen = 0;

  constructor(private readonly deps: Js8SenderDeps) {}

  get current(): Js8SenderState {
    return { ...this.state };
  }

  start(
    text: string,
    frames: readonly Js8OutFrame[],
  ): { ok: true; firstWindow: number; frames: number; durationMs: number } | { ok: false; reason: string } {
    if (frames.length === 0) return { ok: false, reason: "nothing to send" };
    if (this.state.sending) {
      return {
        ok: false,
        reason: `already sending "${this.state.text}" (${this.state.sent} of ${this.state.frames} frames out)`,
      };
    }
    const first = nextWindowStart("JS8", this.now() + JS8_LEAD_MS);
    const gen = ++this.gen;
    this.state = { sending: true, text, frames: frames.length, sent: 0, nextWindow: first, stopped: null };
    this.arm([...frames], 0, first, gen);
    this.deps.onProgress?.(this.current);
    return { ok: true, firstWindow: first, frames: frames.length, durationMs: frames.length * PERIOD_MS.JS8 };
  }

  /** Stop after the frame that is out now, if one is; the rest never go. */
  cancel(): boolean {
    if (!this.state.sending) return false;
    this.gen++;
    this.disarm();
    this.state = {
      ...this.state,
      sending: false,
      nextWindow: null,
      stopped: `cancelled after ${this.state.sent} of ${this.state.frames} frames`,
    };
    this.deps.onProgress?.(this.current);
    return true;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private disarm(): void {
    if (this.timer === null) return;
    const clear = this.deps.clearTimer ?? ((t: unknown) => clearTimeout(t as NodeJS.Timeout));
    clear(this.timer);
    this.timer = null;
  }

  private arm(frames: Js8OutFrame[], index: number, windowStart: number, gen: number): void {
    const delay = Math.max(0, windowStart - JS8_ARM_MS - this.now());
    const setTimer = this.deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    this.timer = setTimer(() => {
      this.timer = null;
      void this.fire(frames, index, windowStart, gen);
    }, delay);
  }

  private async fire(frames: Js8OutFrame[], index: number, windowStart: number, gen: number): Promise<void> {
    if (gen !== this.gen) return;
    let r: Js8SendResult;
    try {
      r = await this.deps.send(frames[index]!, index, windowStart);
    } catch (err) {
      r = { sent: false, reason: err instanceof Error ? err.message : String(err) };
    }
    // Cancelled, or replaced, while the frame was out: that message's state is already told.
    if (gen !== this.gen) return;
    if (!r.sent) {
      this.state = {
        ...this.state,
        sending: false,
        nextWindow: null,
        stopped: `frame ${index + 1} of ${frames.length} refused: ${r.reason ?? "no reason given"}`,
      };
      this.deps.onProgress?.(this.current);
      return;
    }
    const sent = index + 1;
    if (sent >= frames.length) {
      this.state = { ...this.state, sent, sending: false, nextWindow: null, stopped: null };
      this.deps.onProgress?.(this.current);
      return;
    }
    const next = windowStart + PERIOD_MS.JS8;
    this.state = { ...this.state, sent, nextWindow: next };
    this.deps.onProgress?.(this.current);
    this.arm(frames, sent, next, gen);
  }
}
