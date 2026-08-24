// What the bridge needs from a radio, independent of which radio it is.
//
// `services/radio/index.ts` currently constructs `FlexClient`, `FlexDaxSource` and
// `FlexDaxTransmitter` by name. That was fine while there was one radio. Adding the
// IC-7300 mk2 means either a second copy of the bridge or a seam, and this is the seam.
//
// THE IMPORTANT OBSERVATION, and the reason this file is small:
//
// Almost nothing above the driver is radio-specific. The window scheduler, the FT8/FT4/
// FT2 decoders, the waveform generator, the auto-operator, the worked index, the award
// scoring — all of that operates on audio samples and messages, and neither has a
// vendor. What actually differs between a Flex and an Icom is:
//
//   - how you open a connection and authenticate
//   - the audio transport, and its sample format
//   - how you set frequency and mode, and how you key the transmitter
//
// That is the whole list. So the interface here describes a *transport*, not a radio:
// the decode pipeline stays in one place and gets fed by either driver. Modelling this
// as "RadioSource has a decode() method" would have duplicated the pipeline per vendor,
// which is the mistake this file exists to avoid.

import type { EventEmitter } from "node:events";

/** The digital modes the bridge can run. Not vendor-specific; listed here so drivers
 * can report what they support without importing the Flex module. */
export type DigitalMode = "FT8" | "FT4" | "FT2";

/**
 * Audio sample format as it arrives from a radio.
 *
 * Flex DAX receive is 24 kHz float32; Icom is 48 kHz signed 16-bit little-endian. Both
 * reduce to Float32Array at a known rate before anything else touches them, and the
 * rate is carried explicitly rather than assumed — the decoders want 12 kHz, and 24 and
 * 48 decimate to it by 2 and by 4 respectively. Both are exact, which is luck worth
 * not squandering by hard-coding either one.
 */
export interface AudioFormat {
  sampleRate: number;
  channels: 1 | 2;
}

/** Radio health, insofar as a given radio reports any of it. Every field is nullable
 * because no two radios expose the same set, and a missing reading must be
 * distinguishable from a reading of zero. */
export interface RadioTelemetry {
  paTempC: number | null;
  swr: number | null;
  voltsPa: number | null;
  fanRpm: number | null;
  reflectedDbm: number | null;
  at: number;
}

export interface RadioIdentity {
  /** Stable key for settings and logs: "flex", "icom". */
  vendor: string;
  /** What to show an operator: "FlexRadio 6400", "IC-7300 mk2". */
  model: string;
  /** Host or address this driver is talking to. */
  host: string;
}

/**
 * Events every source emits.
 *
 * Deliberately a subset of what `FlexDaxSource` emits today. A driver that cannot
 * produce spectrum or telemetry simply never emits those, and the UI already treats
 * both as optional — the panels are empty rather than broken when a radio is silent
 * about its fan speed.
 */
export type RadioSourceEvents = {
  /** A block of receive audio, already converted to float32 mono at `format`. */
  audio: [{ samples: Float32Array; at: number }];
  connected: [RadioIdentity];
  disconnected: [{ reason: string }];
  telemetry: [RadioTelemetry];
  smeter: [{ dbm: number; fwdDbm: number | null; at: number }];
  error: [Error];
};

/**
 * A radio that can supply receive audio and be tuned.
 *
 * Implementations: `FlexDaxSource` and `IcomSource`. The interface is what the bridge is
 * allowed to depend on; each driver may expose more, and both do.
 *
 * Generic over its event map because EventEmitter's generic is invariant: a driver that
 * emits `decodes` and `window` on top of the required set does not structurally satisfy
 * `EventEmitter<RadioSourceEvents>`, even though it emits strictly more. Writing
 * `implements RadioSource<IcomSourceEvents>` says "at least these events" and still
 * fails the build if a required one goes missing, which is the guarantee that matters.
 */
export interface RadioSource<
  E extends RadioSourceEvents & Record<string, unknown[]> = RadioSourceEvents,
> extends EventEmitter<E> {
  readonly identity: RadioIdentity;
  /** Format of the samples arriving on the `audio` event. */
  readonly audioFormat: AudioFormat;
  readonly connected: boolean;

  start(): Promise<void>;
  stop(): Promise<void>;

  /** Dial frequency in Hz, or null when the radio has not reported one yet. */
  getFrequencyHz(): number | null;
  setFrequencyHz(hz: number): Promise<void>;

  /**
   * Whether this radio will accept a transmit request at all.
   *
   * Separate from "is transmit enabled in settings". On a Flex this is false unless a
   * `client gui` registration succeeded, and discovering that at transmit time rather
   * than at connect time cost real debugging once — the radio accepts the audio and
   * silently sends nothing.
   */
  readonly canTransmit: boolean;
}

/**
 * Outcome of one transmission.
 *
 * The optional fields exist because the QSO controller logs them — "sent X (timing 2ms,
 * 2370 pkts)" — and that line is the main evidence an operator has that keying happened
 * when it was supposed to. A driver that cannot report one leaves it undefined rather
 * than inventing a number.
 */
export interface TransmitOutcome {
  sent: boolean;
  /**
   * Why not, when `sent` is false. Shown to the operator verbatim.
   *
   * `null` and `undefined` both mean "no reason" — the two drivers were written years
   * apart and use different conventions, and forcing one to change would be churn for
   * nothing when every consumer already treats both as falsy.
   */
  reason?: string | null;
  /** When keying actually happened, if it did. */
  startedAt?: number | null;
  /** Echoed back so a log line can quote what actually went out. */
  message?: string;
  /** How far keying missed the intended instant. FT8 tolerates roughly ±1.5 s. */
  timingErrorMs?: number;
  packetsSent?: number;
}

/**
 * What the QSO controller and auto-operator need from a transmitter.
 *
 * Deliberately narrower than either concrete class. Typing those layers against
 * `FlexDaxTransmitter` was what made them look Flex-specific when in fact they only ever
 * call `transmit` and `unkey`.
 */
export interface DigitalTransmitter {
  transmit(req: {
    message: string;
    mode: DigitalMode;
    offsetHz: number;
    startAt: number;
  }): Promise<TransmitOutcome>;
  unkey(): Promise<void>;
}

/**
 * What those layers need from a source: the T/R period, and events.
 *
 * Same reasoning. `source.periodMs` is the only member either of them reads.
 */
export interface DigitalSource {
  readonly periodMs: number;
  /**
   * The two events the operating layer listens to.
   *
   * Overloaded rather than a loose `(...args: never[])`, which typechecks but leaves
   * every handler parameter as `never` and forces `any` at the call sites — defeating
   * the point of typing the seam at all.
   */
  on(
    event: "decodes",
    listener: (d: {
      windowStart: Date;
      decodes: {
        message: string;
        snr: number;
        dt: number;
        freqOffset: number;
        mode: DigitalMode;
      }[];
      rms: number;
      decodeMs: number;
    }) => void,
  ): unknown;
  on(
    event: "window",
    listener: (w: {
      windowStart: Date;
      samples: number;
      rms: number;
      skipped: boolean;
    }) => void,
  ): unknown;
}

/**
 * A radio that can transmit a generated waveform.
 *
 * The waveform itself is generated once, vendor-neutrally, from the message and mode;
 * the transmitter's job is to get those samples on the air at the right instant and to
 * stop cleanly. Splitting it this way means the FT8 modulator is tested once, not once
 * per radio.
 */
export interface RadioTransmitter {
  readonly identity: RadioIdentity;

  /** Master switch, mirroring the operator's setting. */
  setAllowTransmit(allowed: boolean): void;
  readonly allowTransmit: boolean;

  /** True while audio is going out. */
  readonly transmitting: boolean;

  /**
   * Transmit `message` in `mode` at `offsetHz` within the passband.
   *
   * `startAt` is a T/R period BOUNDARY in UTC ms, not the instant to key. FT8 and FT4
   * begin 0.5 s after the boundary and FT2 begins on it; the driver applies that from
   * `lib/radio/timing.ts`, so no caller has to remember which mode is which. Omitting
   * it transmits immediately, which is only for bench testing — on the air it puts the
   * signal wherever the clock happens to be.
   */
  transmit(req: {
    message: string;
    mode: DigitalMode;
    offsetHz: number;
    startAt?: number;
  }): Promise<TransmitOutcome>;

  /** Stop immediately and drop carrier. Must be safe to call when idle. */
  unkey(): Promise<void>;
}

/**
 * A radio driver: a source, and optionally a transmitter.
 *
 * Receive-only is a real configuration — a second receiver, or an operator who has not
 * enabled transmit — so the transmitter is nullable rather than a transmitter that
 * always refuses.
 */
export interface RadioRig {
  readonly source: RadioSource;
  readonly transmitter: RadioTransmitter | null;
}

/**
 * Convert interleaved signed 16-bit little-endian PCM to float32 mono.
 *
 * This is the Icom receive path in one function. Little-endian means no byte swapping
 * on any machine this runs on, unlike the Flex transmit path which is big-endian and
 * has to be written out sample by sample.
 */
export function s16leToFloat32(buf: Buffer, channels: 1 | 2 = 1): Float32Array {
  const frames = Math.floor(buf.length / 2 / channels);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    if (channels === 1) {
      out[i] = buf.readInt16LE(i * 2) / 32768;
    } else {
      // Mix down rather than dropping a channel: a radio that puts the signal on one
      // side only would otherwise decode as silence half the time.
      const l = buf.readInt16LE(i * 4);
      const r = buf.readInt16LE(i * 4 + 2);
      out[i] = (l + r) / 2 / 32768;
    }
  }
  return out;
}
