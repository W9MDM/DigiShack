// Transmitting through a networked Icom.
//
// THIS PUTS RF ON THE AIR. Same posture as the FlexRadio transmitter, for the same
// reason: the dangerous failure is not "no signal", it is "transmitter left keyed" —
// that jams the band, can cook the PA, and is a licence problem. So:
//
//   * `allowTransmit` must be explicitly on; it defaults to off.
//   * The waveform is generated BEFORE keying. A message that fails to encode can
//     never leave the radio keyed with nothing to send.
//   * A watchdog unkeys unconditionally, independent of the send loop, and fires even
//     if that loop throws or the socket dies.
//   * unkey() is idempotent and runs on error, on stop and on process exit.
//   * Transmissions refuse to overlap.
//
// The Icom-specific hazard on top of that: PTT is a CI-V command on a *different UDP
// socket* from the audio. If the serial stream dies mid-transmission the audio keeps
// flowing to a radio that will never be told to stop. The watchdog is therefore not a
// nicety here, it is the only thing standing between a dropped packet and a stuck
// transmitter.

import { nowMs } from "@/lib/time/clock";
import { setPtt, setModeWithData } from "@/lib/icom/civ";
import { float32ToS16le, type IcomAudioStream } from "@/lib/icom/audio-stream";
import type { IcomSerialStream } from "@/lib/icom/serial-stream";
import { transmitStartAt } from "@/lib/radio/timing";
import {
  buildWaveform,
  MAX_TRANSMIT_MS,
  type TxMode,
} from "@/lib/radio/waveform";
import type { RadioIdentity, RadioTransmitter, TransmitOutcome } from "@/lib/radio/types";

const ICOM_TX_RATE = 48_000;

/** 20 ms of audio per send, matching the chunk the audio stream splits into packets. */
const CHUNK_MS = 20;
const CHUNK_SAMPLES = (ICOM_TX_RATE * CHUNK_MS) / 1000;

/** Slack before the watchdog fires, allowing for scheduling jitter. */
const WATCHDOG_MARGIN_MS = 2_000;

export interface IcomTransmitterOptions {
  serial: IcomSerialStream;
  audio: IcomAudioStream;
  /** CI-V address of the radio. */
  address: number;
  identity: RadioIdentity;
  allowTransmit: boolean;
  /**
   * Re-read the master gate at transmit time.
   *
   * The constructor argument is a snapshot. Without this, flipping the setting does
   * nothing until the service restarts, while the setting's help text promises that
   * off means nothing can key the radio.
   */
  isTransmitAllowed?: () => Promise<boolean>;
  /**
   * One-way transit to the radio, ms, asked fresh at each transmission.
   *
   * Same contract as the Flex transmitter's option: PTT and the audio both cross the
   * network before any RF exists, so keying is brought forward by this much. Usually
   * near zero for an Icom on the shack LAN — the point is that a remote one is not a
   * different code path. See lib/radio/link-latency.ts.
   */
  linkOneWayMs?: () => number;
}

export class IcomTransmitter implements RadioTransmitter {
  private allowed: boolean;
  private keyed = false;
  private busy = false;
  private watchdog: NodeJS.Timeout | null = null;
  private cancelled = false;

  constructor(private readonly opts: IcomTransmitterOptions) {
    this.allowed = opts.allowTransmit;
  }

  get identity(): RadioIdentity {
    return this.opts.identity;
  }

  get allowTransmit(): boolean {
    return this.allowed;
  }

  setAllowTransmit(allowed: boolean): void {
    this.allowed = allowed;
    // Turning the gate off mid-transmission must stop the current one, not just the
    // next. An operator reaching for that switch wants the radio to stop now.
    if (!allowed && this.keyed) void this.unkey();
  }

  get transmitting(): boolean {
    return this.keyed;
  }

  async transmit(req: {
    message: string;
    mode: TxMode;
    offsetHz: number;
    /** A period boundary in UTC ms. The mode's start offset is applied here. */
    startAt?: number;
  }): Promise<TransmitOutcome> {
    const refuse = (reason: string): TransmitOutcome => ({
      sent: false,
      reason,
      startedAt: null,
    });

    // The LIVE setting decides, not the snapshot taken when this was constructed.
    //
    // The snapshot was checked first and refused on its own, so the re-read below it
    // was unreachable whenever it mattered: a transmitter that attached while the gate
    // was off could never be armed again without restarting the bridge. Which is
    // exactly what happened — FT-0 disabled transmit, the radio reconnected a few
    // seconds later and snapshotted `false`, and turning "Allow transmit" back on in
    // Settings changed nothing at all. The setting's own help text promises that off
    // means nothing can key the radio; the converse has to hold too.
    //
    // Snapshot kept in step so `allowTransmit` reports what is actually in force, and
    // still used verbatim when no reader was supplied — the bench tests construct it
    // that way.
    const armed = this.opts.isTransmitAllowed
      ? await this.opts.isTransmitAllowed()
      : this.allowed;
    this.allowed = armed;
    if (!armed) return refuse("Transmit is disabled in settings");
    if (this.busy) return refuse("Already transmitting");
    if (this.opts.serial.state !== "open") {
      // Refusing here rather than keying and hoping: without CI-V there is no way to
      // unkey, so a transmission started now could not be stopped.
      return refuse("The CI-V stream is not open, so the radio could not be unkeyed");
    }
    if (this.opts.audio.state !== "open") return refuse("The audio stream is not open");

    // Generate first. A message that fails to encode must never leave the radio keyed.
    let wave: Float32Array;
    try {
      wave = buildWaveform(req.message, req.mode, req.offsetHz, ICOM_TX_RATE);
    } catch (err) {
      return refuse(err instanceof Error ? err.message : "Could not build the waveform");
    }

    const durationMs = (wave.length / ICOM_TX_RATE) * 1000;
    if (durationMs > MAX_TRANSMIT_MS) {
      return refuse(`Waveform is ${(durationMs / 1000).toFixed(1)}s, over the cap`);
    }

    this.busy = true;
    this.cancelled = false;
    // Declared out here so the catch below can report it. Stays null if we never got
    // as far as keying, which is the honest answer for a refusal during the wait.
    let startedAt: number | null = null;
    let dueAt: number | null = null;
    // Kept out here so the timing report below can add it back — keying is
    // deliberately this early, and reporting the raw difference would show every
    // compensated transmission as early by exactly the compensation.
    let linkLagMs = 0;

    try {
      // Wait for the mode's actual start instant. `startAt` is a boundary; FT8 and
      // FT4 begin 0.5 s after it, FT2 on it. Keying on the boundary for all three is
      // what put the Flex path 0.5 s early on every FT8 and FT4 transmission.
      if (req.startAt !== undefined) {
        const audioStartAt = transmitStartAt(req.mode, req.startAt);
        dueAt = audioStartAt;
        // Key early by the one-way transit to the radio, so the RF starts on time
        // rather than the network packets — see the option's own comment.
        linkLagMs = this.opts.linkOneWayMs?.() ?? 0;
        // Corrected: the instant to key is real time, so the wait has to be measured
        // against the same clock. See lib/time/clock.ts.
        const waitMs = audioStartAt - linkLagMs - nowMs();
        if (waitMs < -1_500) {
          this.busy = false;
          return {
            sent: false,
            reason: `Missed the window by ${Math.abs(Math.round(waitMs))}ms — not transmitting late`,
            startedAt: null,
          };
        }
        if (waitMs > 60_000) {
          this.busy = false;
          return { sent: false, reason: "Start time is more than a minute away", startedAt: null };
        }
        if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
      }

      startedAt = nowMs();
      // USB with data mode on. In plain USB the transmit audio comes from the
      // microphone and the radio keys and sends nothing.
      this.opts.serial.write(setModeWithData(this.opts.address, "USB", true, 1));

      this.armWatchdog(durationMs);
      this.opts.serial.write(setPtt(this.opts.address, true));
      this.keyed = true;

      // Whether the whole waveform went out has to be captured here, BEFORE unkeying:
      // `unkey()` sets `cancelled` as its way of stopping the send loop, so reading
      // that flag afterwards reports every successful transmission as a failure.
      const { complete, packets } = await this.streamAudio(wave);

      await this.unkey();
      return {
        sent: complete,
        reason: complete ? null : "Stopped before the whole waveform went out",
        startedAt,
        message: req.message,
        // Against the instant audio was due, so the number means the same thing it does
        // on the Flex path — in on-air terms, since keying ran linkLagMs early.
        timingErrorMs: dueAt === null ? undefined : startedAt + linkLagMs - dueAt,
        packetsSent: packets,
      };
    } catch (err) {
      await this.unkey();
      return {
        sent: false,
        reason: err instanceof Error ? err.message : "Transmission failed",
        startedAt,
      };
    } finally {
      this.busy = false;
    }
  }

  /**
   * Push the waveform out in real time.
   *
   * Paced against a fixed origin rather than by sleeping a chunk's worth each time.
   * Accumulating `setTimeout(20)` drifts — each one overshoots slightly and the errors
   * add up across the ~630 chunks of an FT8 transmission, which is enough to run past
   * the end of the window.
   *
   * Returns whether the whole waveform went out, and how many chunks were sent.
   */
  private async streamAudio(
    wave: Float32Array,
  ): Promise<{ complete: boolean; packets: number }> {
    const started = Date.now();
    let chunkIndex = 0;

    for (let off = 0; off < wave.length; off += CHUNK_SAMPLES) {
      if (this.cancelled || !this.keyed) return { complete: false, packets: chunkIndex };

      const slice = wave.subarray(off, off + CHUNK_SAMPLES);
      this.opts.audio.writeAudio(float32ToS16le(slice));
      chunkIndex++;

      // Where this chunk *should* have gone out, measured from the start.
      const dueAt = started + chunkIndex * CHUNK_MS;
      const wait = dueAt - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    // Two UDP packets per chunk — the audio stream splits each 20 ms block.
    return { complete: true, packets: chunkIndex * 2 };
  }

  /**
   * Stop transmitting. Safe to call when idle, and safe to call twice.
   *
   * Sends the unkey even if we believe we are not keyed. Believing wrongly is exactly
   * the state where an extra unkey matters, and an unnecessary one costs nothing.
   */
  async unkey(): Promise<void> {
    this.cancelled = true;
    this.clearWatchdog();
    this.keyed = false;
    try {
      if (this.opts.serial.state === "open") {
        this.opts.serial.write(setPtt(this.opts.address, false));
      }
    } catch {
      // Nothing useful to do. The watchdog has already been cleared and the radio's
      // own transmit timeout is the last line of defence.
    }
  }

  private armWatchdog(durationMs: number): void {
    this.clearWatchdog();
    this.watchdog = setTimeout(
      () => {
        void this.unkey();
      },
      durationMs + WATCHDOG_MARGIN_MS,
    );
    // Deliberately NOT unref'd. A watchdog that lets the process exit while the radio
    // is keyed is not a watchdog.
  }

  private clearWatchdog(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
  }
}
