// An IC-7300 (or any RS-BA1 radio) as a RadioSource.
//
// This is where the three streams stop being protocol and start being a radio. The
// control stream authenticates and tells us which ports the other two are on; the
// serial stream carries CI-V for frequency, mode and the meters; the audio stream
// carries receive audio, which comes out of here as float32 and goes into the same
// decode pipeline the FlexRadio feeds.
//
// Nothing above this file knows which radio it is talking to. That was the point of
// lib/radio/types.ts, and it is what makes the Icom work additive rather than a second
// copy of the bridge.

import { EventEmitter } from "node:events";

import { IcomAudioStream } from "@/lib/icom/audio-stream";
import {
  atuStateFrom,
  atuTune,
  type AtuState,
  CIV_CONTROLLER,
  CIV_DEFAULT_ADDRESS,
  type CivFrame,
  CivCommand,
  CivReply,
  decodeBcd2,
  decodeFrequency,
  FunctionSub,
  LevelSub,
  MeterSub,
  modeWithDataFrom,
  poMeterToWatts,
  wattsToDbm,
  pttFrom,
  readAtu,
  readFrequency,
  readMeter,
  readModeWithData,
  readPtt,
  readAgc,
  readFunction,
  readLevel,
  readRfPower,
  rfPowerPercentFrom,
  agcFrom,
  functionStateFrom,
  setAgc,
  setFrequency,
  setFunction,
  setLevel,
  setModeWithData,
  setRfPower,
  sMeterToDbm,
  swrFromRaw,
  ScopeSub,
  type ScopeSpanHz,
  readScopeDataOutput,
  readScopeSpan,
  setScopeDataOutput,
  setScopeMode,
  setScopeOn,
  setScopeSpan,
} from "@/lib/icom/civ";
import { IcomControlStream, type StreamsReady } from "@/lib/icom/control-stream";
import { type LinkState } from "@/lib/radio/link-latency";
import { fromCivMode, toCivMode } from "@/lib/radio/modes";
import { IcomPorts } from "@/lib/icom/control-packets";
import { IcomSerialStream } from "@/lib/icom/serial-stream";
import { type Decode, DecodePipeline } from "@/lib/radio/decode-pipeline";
import { UNREAD_RECEIVER, type ReceiverControls } from "@/lib/radio/receiver-controls";
import {
  SPECTRUM_INTERVAL_MS,
  type SpectrumProfile,
  spectrumIntervalFor,
  SpectrumAnalyser,
  type SpectrumRow,
} from "@/lib/radio/spectrum";
import type {
  AudioFormat,
  DigitalMode,
  RadioIdentity,
  RadioSource,
  RadioTelemetry,
} from "@/lib/radio/types";

/**
 * Everything this source emits.
 *
 * Spelled out rather than intersected with `RadioSourceEvents`: that is an interface,
 * and TypeScript interfaces have no implicit index signature, so an intersection does
 * not satisfy the `Record<string, unknown[]>` an EventEmitter generic wants. Listing the
 * members is the cheap way out, and it keeps the decode events visible here rather than
 * hidden behind a `&`.
 */
export type IcomSourceEvents = {
  audio: [{ samples: Float32Array; at: number }];
  connected: [RadioIdentity];
  disconnected: [{ reason: string }];
  telemetry: [RadioTelemetry];
  smeter: [{ dbm: number; fwdDbm: number | null; at: number }];
  /**
   * The radio's MODULATION changed — USB, LSB-D, CW.
   *
   * Not the digital mode. Emitted from the mode poll, so it fires for a change made on the
   * radio's own front panel as well as for one we asked for.
   */
  /** AGC, noise blanker or noise reduction changed, from the radio's own report. */
  receiverControls: [ReceiverControls];
  radioMode: [string];
  error: [Error];
  /**
   * The radio said what it is, before the data streams are up.
   *
   * Worth surfacing separately from `connected`: it is the first proof the credentials
   * were accepted, and when the serial or audio stream then fails to open it is the
   * difference between "wrong password" and "wrong port".
   */
  identified: [{ radioName: string; audioName: string }];
  /** From the shared pipeline, identical in shape to the FlexRadio path's. */
  decodes: [{ windowStart: Date; decodes: Decode[]; rms: number; decodeMs: number }];
  window: [
    {
      windowStart: Date;
      samples: number;
      rms: number;
      skipped: boolean;
      /** See DecodePipelineEvents.window — "short" is packet loss, "silent" is our own TX. */
      reason?: "silent" | "short" | "transmit";
      minSamples?: number;
    },
  ];
  /**
   * The waterfall, from the same shared analyser the FlexRadio uses.
   *
   * Nearly written off as a feature the Icom would not get. It is an FFT over received
   * audio and nothing else, so it was portable all along — the only radio-dependent
   * part is how many bins cover the 3 kHz passband at this sample rate.
   */
  spectrum: [SpectrumRow];
  /**
   * One raw spectrum-scope frame, 0x27 0x00, exactly as it arrived.
   *
   * Raw rather than parsed, and counted rather than assembled, because the first
   * question about this is not what it says but what it COSTS — these arrive
   * continuously on the same stream as the frequency poll and the meters. See
   * `civStats` and docs/panadapter.md.
   */
  scopeFrame: [CivFrame];
};

/**
 * How often to ask the radio where it is tuned and how it is hearing.
 *
 * The radio also broadcasts frequency changes unprompted (CI-V "transceive"), so this
 * is a backstop rather than the primary path — transceive can be switched off in the
 * menu, and a radio with it off would otherwise appear stuck on whatever frequency it
 * happened to be on at connect.
 */
const POLL_INTERVAL_MS = 2_000;

/**
 * Minimum gap between CI-V commands.
 *
 * 70 ms is comfortably longer than the round trip on a local network or a VPN, and four
 * poll commands still finish inside a quarter of a second — well within the two-second
 * poll interval. Icom's CI-V reference asks for a reply before the next command; this is
 * the cheap approximation of that, and it fixed meters that had never once reported.
 */
const CIV_GAP_MS = 70;

/** Ceiling on the outgoing queue, so a radio that stops answering cannot grow it. */
const CIV_QUEUE_MAX = 16;

export interface IcomSourceOptions {
  host: string;
  /** Network username and password set in the radio's menu. Not your callsign. */
  username: string;
  password: string;
  controlPort?: number;
  serialPort?: number;
  audioPort?: number;
  /** Overrides the model default. Operators can change this in the radio's menu. */
  civAddress?: number;
  bindAddress?: string;
  /**
   * Send silence on the audio socket while idle. Default true.
   *
   * Exists so the keepalive's own justification can be MEASURED rather than assumed. See
   * IcomAudioStream.keepalive: the audio still stops with it running, and the radio answers
   * at about the rate we send.
   */
  audioKeepalive?: boolean;
  /** Which digital mode to decode. */
  mode?: DigitalMode;
  depth?: number;
  /**
   * Silence threshold, applied to the raw 48 kHz window before normalisation.
   *
   * Lower than the FlexRadio's equivalent on purpose. Icom audio needs two decimation
   * passes to reach 12 kHz against the Flex's one, and the filter has 0.80 gain per
   * pass, so the same signal is about 20% quieter at the point this is measured.
   */
  silenceRms?: number;
  /**
   * Top of the audio passband, Hz: what the decoder searches AND what the waterfall
   * draws. One number for both, so the display can never disagree with the decoder.
   */
  passbandHz?: number;
}

/**
 * Commands the radio volunteers, which match no pending read by design.
 *
 * 0x00 and 0x01 are the dial and mode broadcasts; 0x15 meters arrive as replies to the
 * poll but land after their waiter has gone when a poll overlaps a read.
 */
const UNSOLICITED = new Set([0x00, 0x01, 0x03, 0x15]);

/**
 * Commands whose reply has no sub-command byte.
 *
 * The byte after the command is the first byte of DATA for these, so it must not be
 * used to identify the reply. For 0x03 that byte is the low pair of BCD digits of the
 * dial frequency, which changes every time the operator turns the knob.
 */
const COMMANDS_WITHOUT_SUB = new Set<number>([
  CivCommand.transceiveFrequency,
  CivCommand.transceiveMode,
  CivCommand.readFrequency,
  CivCommand.readMode,
]);

export class IcomSource
  extends EventEmitter<IcomSourceEvents>
  implements RadioSource<IcomSourceEvents>
{
  private control: IcomControlStream | null = null;
  private readonly pipeline: DecodePipeline;
  /** Which spectrum trade is in force. Switched by voice mode; see setSpectrumProfile. */
  private spectrumProfile: SpectrumProfile = "digital";
  private spectrum: SpectrumAnalyser;
  private spectrumTimer: NodeJS.Timeout | null = null;
  private serial: IcomSerialStream | null = null;
  private audio: IcomAudioStream | null = null;
  private linkTimer: NodeJS.Timeout | null = null;

  private pollTimer: NodeJS.Timeout | null = null;
  private frequencyHz: number | null = null;
  private radioName = "";
  private civAddress: number;
  private isConnected = false;
  private stopping = false;

  private telemetryState: RadioTelemetry = {
    paTempC: null,
    swr: null,
    voltsPa: null,
    fanRpm: null,
    reflectedDbm: null,
    at: 0,
  };

  constructor(private readonly opts: IcomSourceOptions) {
    super();
    this.civAddress = opts.civAddress ?? 0x94;

    // The decode half is shared with the FlexRadio path — same windowing, same
    // decoders, same everything above the audio. Only the sample rate differs.
    this.pipeline = new DecodePipeline({
      mode: opts.mode ?? "FT8",
      inputSampleRate: 48_000,
      depth: opts.depth,
      silenceRms: opts.silenceRms ?? 0.0008,
      maxHz: opts.passbandHz,
    });
    // Built from the pipeline's CLAMPED value rather than the raw option, so the
    // waterfall shows exactly the range the decoder searches even when the setting is
    // out of range. The two disagreeing is what made "is the waterfall cutting some
    // off?" a reasonable question to have to ask.
    this.spectrum = new SpectrumAnalyser(48_000, this.pipeline.maxHz, this.spectrumProfile);
    this.pipeline.on("decodes", (d) => this.emit("decodes", d));
    this.pipeline.on("window", (w) => this.emit("window", w));
    this.pipeline.on("error", (e) => this.emit("error", e));
  }

  get mode(): DigitalMode {
    return this.pipeline.currentMode;
  }

  setMode(mode: DigitalMode): boolean {
    return this.pipeline.setMode(mode);
  }

  get periodMs(): number {
    return this.pipeline.periodMs;
  }

  /**
   * Stop feeding the decoder until `untilMs`, because we are transmitting.
   *
   * The Icom streams receive audio straight through a transmission, unlike DAX which goes
   * silent — so the decoder hears us and reports our own transmission as a decode. See
   * DecodePipeline.muteUntil for what that broke.
   *
   * The spectrum analyser is deliberately NOT muted: seeing your own transmission on the
   * waterfall is useful, and it is the only feedback that anything went out at all.
   */
  muteReceiveUntil(untilMs: number): void {
    this.pipeline.muteUntil(untilMs);
  }

  get identity(): RadioIdentity {
    return {
      vendor: "icom",
      model: this.radioName || "Icom",
      host: this.opts.host,
    };
  }

  /** 48 kHz mono, which is exactly four times the decoders' 12 kHz. */
  get audioFormat(): AudioFormat {
    return { sampleRate: 48_000, channels: 1 };
  }

  get connected(): boolean {
    return this.isConnected;
  }

  /**
   * Transmit needs the serial stream, because PTT is a CI-V command.
   *
   * Audio alone is not enough: without CI-V the radio never leaves receive and the
   * transmit audio goes nowhere. Reporting that here rather than at transmit time is
   * the lesson from the Flex path, where a missing `client gui` registration meant the
   * radio accepted audio and silently sent nothing.
   */
  get canTransmit(): boolean {
    return this.isConnected && this.serial?.state === "open" && this.audio?.state === "open";
  }

  get telemetry(): RadioTelemetry {
    return this.telemetryState;
  }

  /**
   * One-way transit to the radio, ms, for transmit keying and the status page.
   *
   * Read from the AUDIO stream's keepalive pings — that socket carries the samples the
   * decode windows are cut from and the waveform a transmission sends, so it is the
   * path whose delay actually matters. The serial stream shares the host and would
   * read the same, but measuring one path and compensating another is a habit that
   * bites the day they differ.
   */
  linkOneWayMs(): number {
    return this.audio?.link.oneWayMs() ?? 0;
  }

  /** The measurement behind linkOneWayMs, for status reporting. */
  linkState(): LinkState | null {
    return this.audio?.link.state() ?? null;
  }


  /**
   * Switch the waterfall between the FT8 trade and the speech trade.
   *
   * Rebuilds the analyser and re-arms the row timer, because the two profiles differ in both
   * FFT size and cadence and changing only one of them gives the worst of each: a short window
   * drawn four times a second stutters, and a long window drawn twenty times a second is the
   * same syllable smeared over twenty rows.
   *
   * Called when voice mode is turned on or off. Cheap enough to do on a click — one FFT plan
   * and one interval — and it takes effect on the next row.
   */
  setSpectrumProfile(profile: SpectrumProfile): void {
    if (profile === this.spectrumProfile) return;
    this.spectrumProfile = profile;
    this.spectrum = new SpectrumAnalyser(48_000, this.pipeline.maxHz, profile);
    if (this.spectrumTimer) {
      clearInterval(this.spectrumTimer);
      this.spectrumTimer = setInterval(() => {
        const row = this.spectrum.compute();
        if (row) this.emit("spectrum", row);
      }, spectrumIntervalFor(profile));
      this.spectrumTimer.unref?.();
    }
  }

  async start(): Promise<void> {
    if (this.control) throw new Error("Already started");
    this.stopping = false;

    const control = new IcomControlStream({
      host: this.opts.host,
      port: this.opts.controlPort ?? IcomPorts.control,
      username: this.opts.username,
      password: this.opts.password,
      serialPort: this.opts.serialPort ?? IcomPorts.serial,
      audioPort: this.opts.audioPort ?? IcomPorts.audio,
      bindAddress: this.opts.bindAddress,
    });
    this.control = control;

    control.on("error", (err) => this.emit("error", err));
    control.on("closed", ({ reason }) => {
      if (!this.stopping) this.handleDisconnect(reason);
    });
    control.on("identified", (i) => this.emit("identified", i));
    control.on("ready", (ready) => {
      void this.openDataStreams(ready);
    });

    await control.connect();
  }

  private async openDataStreams(ready: StreamsReady): Promise<void> {
    this.radioName = ready.radioName;
    // The radio told us its model; use its published CI-V address unless the operator
    // has set one explicitly, because a renamed address in the menu is common.
    if (this.opts.civAddress === undefined) {
      this.civAddress = CIV_DEFAULT_ADDRESS[ready.radioName] ?? this.civAddress;
    }

    const serial = new IcomSerialStream({
      host: this.opts.host,
      port: ready.serialPort,
      bindAddress: this.opts.bindAddress,
      controllerAddress: CIV_CONTROLLER,
    });
    const audio = new IcomAudioStream({
      host: this.opts.host,
      port: ready.audioPort,
      bindAddress: this.opts.bindAddress,
      keepalive: this.opts.audioKeepalive,
    });
    this.serial = serial;
    this.audio = audio;

    serial.on("error", (err) => this.emit("error", err));
    serial.on("frame", (f) => this.onCivFrame(f));
    audio.on("error", (err) => this.emit("error", err));
    audio.on("audio", ({ samples, at }) => {
      this.emit("audio", { samples, at });
      // The pipeline drops the guard-time tail of a window it has already taken; the
      // display has no windows and a gap in it reads as a dead receiver. So both are
      // fed and each decides for itself.
      this.pipeline.push(samples);
      this.spectrum.push(samples);
    });

    for (const s of [serial, audio]) {
      s.on("closed", ({ reason }) => {
        if (!this.stopping) this.handleDisconnect(reason);
      });
    }

    await serial.open();
    await audio.open();

    this.isConnected = true;
    this.pipeline.start();
    // Keep the decode windows aware of how far away the radio is. The audio stream's
    // own keepalive pings measure the path its samples travel; the pipeline shifts its
    // cuts by half the round trip so a radio across a VPN still gets whole windows.
    // See lib/radio/link-latency.ts. Cheap enough to run on a timer forever.
    this.linkTimer = setInterval(() => {
      this.pipeline.setLinkLatencyMs(this.linkOneWayMs());
    }, 15_000);
    this.linkTimer.unref?.();
    this.spectrumTimer = setInterval(() => {
      const row = this.spectrum.compute();
      if (row) this.emit("spectrum", row);
    }, spectrumIntervalFor(this.spectrumProfile));
    this.spectrumTimer.unref?.();
    this.emit("connected", this.identity);
    this.startPolling();
  }

  /**
   * Latest forward power, from the Po meter poll.
   *
   * Held between polls rather than emitted on its own: the display reads it off the
   * S-meter event, which arrives on the same 2 s cadence, and two competing streams
   * would make the meter flicker between them.
   */
  private forwardWatts = 0;
  private forwardDbm: number | null = null;

  /** What the radio can produce at 100%, for scaling the Po meter. */
  private get ratedWatts(): number {
    // The 705 is the outlier at 10 W; everything else here is a 100 W radio.
    return /IC-?705/i.test(this.radioName) ? 10 : 100;
  }

  /** Forward power in watts, as last polled. Zero when receiving. */
  get forwardPowerWatts(): number {
    return this.forwardWatts;
  }

  /**
   * Outgoing CI-V, one command at a time.
   *
   * CI-V is a serial bus with a serial bus's timing, and putting it inside UDP does not
   * change that: Icom's own documentation says to wait for a reply before sending the
   * next command. The poll used to write four commands in the same tick and the evidence
   * was unmistakable once anyone looked at WHICH ones came back:
   *
   *   0x03 frequency, first in the burst   -> answered every single time
   *   0x15 S-meter, SWR, power, 2nd-4th    -> never answered at all
   *   0x26 / 0x14 / 0x1C sent singly       -> intermittent, colliding with the burst
   *
   * So the signal bar was blank, forward power never displayed, SWR never reached the
   * operating guards, and preflight reported a radio that "did not answer" while it was
   * answering the one command that happened to be first.
   *
   * Queued and spaced, therefore. Reads and settings go through here; the TRANSMITTER
   * does not — PTT is timing-critical to a few milliseconds and must never queue behind
   * a meter poll.
   */
  private civQueue: Buffer[] = [];
  private civTimer: NodeJS.Timeout | null = null;
  private lastCivAt = 0;

  private civEnqueue(frame: Buffer): void {
    // Bounded. If the radio stops answering, the poll keeps adding and nothing must
    // accumulate for ever — the oldest reading is also the least interesting.
    if (this.civQueue.length >= CIV_QUEUE_MAX) this.civQueue.shift();
    this.civQueue.push(frame);
    if (this.civQueue.length > this.civQueueHighWater) {
      this.civQueueHighWater = this.civQueue.length;
    }
    this.civDrain();
  }

  /**
   * Send the next command, if enough time has passed since the last one.
   *
   * Paced against the LAST SEND rather than against the queue being empty, which was the
   * first attempt and paced nothing at all: every enqueue found an empty queue, sent
   * immediately, and four commands still left in the same tick. The test caught it, which
   * is the entire reason it exists.
   */
  private civDrain(): void {
    if (this.civTimer) return;

    const since = Date.now() - this.lastCivAt;
    if (since >= CIV_GAP_MS) {
      const next = this.civQueue.shift();
      if (next) {
        this.lastCivAt = Date.now();
        const serial = this.serial;
        if (serial?.state === "open") {
          try {
            serial.write(next);
          } catch (err) {
            this.emit("error", err instanceof Error ? err : new Error(String(err)));
          }
        }
      }
      if (this.civQueue.length === 0) return;
    }

    const wait = Math.max(1, CIV_GAP_MS - (Date.now() - this.lastCivAt));
    this.civTimer = setTimeout(() => {
      this.civTimer = null;
      this.civDrain();
    }, wait);
    this.civTimer.unref?.();
  }

  /** How many commands are waiting. Exposed for the pacing test. */
  get civQueueDepth(): number {
    return this.civQueue.length;
  }

  private civFrames = 0;

  /** How many CI-V replies the radio has sent. Zero means the address is wrong or the
   * serial stream is not carrying — both of which look like "the band is blank". */
  get civFramesSeen(): number {
    return this.civFrames;
  }

  /**
   * Replies counted per command, and the queue's high-water mark.
   *
   * The instrument the panadapter brief asks for. `civFramesSeen` alone cannot answer
   * the question that matters — whether the scope is starving the frequency poll and
   * the meters — because a radio sending 30 waveform frames a second and nothing else
   * has a magnificent frame count and a dead S-meter. That is exactly the shape of the
   * failure that cost this project weeks: the radio answered the FIRST command of every
   * burst and dropped the rest, and the total frame count looked healthy throughout.
   *
   * Keyed `0x<command>` or `0x<command>/0x<sub>` so a meter reply is distinguishable
   * from a mode reply.
   */
  private civReplyCounts = new Map<string, number>();
  private civUnmatched = 0;
  private civQueueHighWater = 0;
  private scopeFrames = 0;
  private scopeBytes = 0;

  get civStats(): {
    frames: number;
    byCommand: Record<string, number>;
    unmatched: number;
    queueHighWater: number;
    queueDepth: number;
    scopeFrames: number;
    scopeBytes: number;
  } {
    return {
      frames: this.civFrames,
      byCommand: Object.fromEntries(this.civReplyCounts),
      unmatched: this.civUnmatched,
      queueHighWater: this.civQueueHighWater,
      queueDepth: this.civQueue.length,
      scopeFrames: this.scopeFrames,
      scopeBytes: this.scopeBytes,
    };
  }

  /** Zero the counters, so a measurement covers one phase rather than the session. */
  resetCivStats(): void {
    this.civFrames = 0;
    this.civReplyCounts.clear();
    this.civUnmatched = 0;
    this.civQueueHighWater = this.civQueue.length;
    this.scopeFrames = 0;
    this.scopeBytes = 0;
  }

  /** How many audio packets have arrived. Zero means the stream opened and carries
   * nothing, which reads from every layer above as a dead band. */
  get audioPacketsSeen(): number {
    return this.audio?.received ?? 0;
  }

  /**
   * Traffic on the audio socket, split into everything and keepalives.
   *
   * The one measurement that separates "the radio stopped sending audio" from "we stopped
   * receiving anything at all" — the audio socket carries the radio's pings too, so pings
   * still climbing while audio does not is a radio that has stopped the data and kept the
   * session.
   */
  get audioTraffic(): { datagrams: number; pings: number } {
    return this.audio?.traffic ?? { datagrams: 0, pings: 0 };
  }

  /**
   * Silence datagrams WE have sent on the audio socket.
   *
   * The radio cuts off a receive-only client's audio after a minute or two, so the stream
   * sends silence while idle to look like a client that is using it. When the audio stalls
   * anyway, this is the counter that says whether the keepalive was actually running —
   * without it, "we stopped sending" and "we sent and the radio stopped regardless" are
   * indistinguishable, and they call for opposite fixes.
   */
  get audioKeepalivesSent(): number {
    return this.audio?.keepalivesSent ?? 0;
  }

  /**
   * Audio packets that went MISSING — gaps in the radio's sequence numbers.
   *
   * The counter that separates a network path from a radio. A Wi-Fi blip, a roam, or a
   * congested tunnel loses datagrams out of the middle of the stream and leaves gaps; a
   * radio that stops streaming leaves none, because there is nothing missing — the sequence
   * simply ends. Both look identical from the decoder, which just goes quiet.
   *
   * Asked of the wrong evidence for most of a day: the stall was blamed on a keepalive, then
   * on Wi-Fi, and this number was sitting unread the whole time.
   */
  get audioDropped(): number {
    return this.audio?.dropped ?? 0;
  }

  /**
   * Are all three streams actually CARRYING, not merely open?
   *
   * "Open" is a socket fact and it is not the interesting one. After a restart the radio
   * can leave the previous session's streams bound on its side, and the new ones open
   * cleanly and then deliver nothing — no CI-V, or no audio, or both. Every layer above
   * then reports something plausible and wrong: a blank band, a dead receiver, a radio
   * that will not tune.
   *
   * Waits rather than sampling once: audio starts within a packet or two, CI-V within a
   * poll, but a slow link makes both later than the moment the sockets opened.
   */
  async streamsCarrying(timeoutMs = 8_000): Promise<{ ok: boolean; civ: number; audio: number }> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const civ = this.civFrames;
      const audio = this.audioPacketsSeen;
      if (civ > 0 && audio > 0) return { ok: true, civ, audio };
      if (Date.now() >= until) return { ok: false, civ, audio };
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  /**
   * Callers waiting for a specific reply.
   *
   * CI-V has no request ids: a reply is matched by its command byte and, where the
   * command has one, its sub-command. That is good enough because only this class
   * sends, and it never has two reads of the same command outstanding — `civRequest`
   * is awaited by everything that uses it.
   */
  private pending: {
    command: number;
    sub: number | null;
    resolve: (f: CivFrame) => void;
    reject: (e: Error) => void;
  }[] = [];

  /**
   * Send a read and wait for the answer.
   *
   * Rejects rather than hanging when the radio does not reply. A CI-V address that is
   * wrong, or transceive turned off, produces silence rather than an error, and a
   * preflight check that waits forever is worse than one that says "no answer".
   */
  private civRequest(frame: Buffer, command: number, sub: number | null, timeoutMs = 2_000): Promise<CivFrame> {
    const serial = this.serial;
    if (serial?.state !== "open") {
      return Promise.reject(new Error("Serial stream is not open"));
    }
    return new Promise<CivFrame>((resolve, reject) => {
      const waiter = {
        command,
        sub,
        resolve: (f: CivFrame) => {
          clearTimeout(timer);
          resolve(f);
        },
        reject: (e: Error) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      const timer = setTimeout(() => {
        this.pending = this.pending.filter((p) => p !== waiter);
        reject(new Error(`The radio did not answer command 0x${command.toString(16)} within ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.push(waiter);
      // Through the queue, so a read cannot land in the middle of a poll burst and be
      // dropped — which is what made preflight's answers intermittent.
      this.civEnqueue(frame);
    });
  }

  /**
   * Write a receiver control, then READ IT BACK and require it to have taken.
   *
   * An acknowledgement would be cheaper — the radio does send 0xFB, confirmed on the bus —
   * but it proves less. It says the radio heard the command, not that the setting is now
   * what was asked for. Nothing else reads these controls back, so without this a wrong
   * sub-command byte would be indistinguishable from success, and a control that appears
   * to work and does nothing is exactly what these used to be.
   *
   * All four were verified against a real IC-7300MK2 this way: AGC fast/mid/slow, the
   * noise blanker, noise reduction and RF gain each written and read back as set.
   *
   * A caution for the next person debugging this. The first round of these calls failed
   * with "the radio did not answer", and the obvious conclusion — that it does not
   * acknowledge writes over the network — was wrong. The session was in the audio-stall
   * rebuild loop at the time and EVERY CI-V command was failing; one of the calls even
   * reported the radio as not connected. On this radio, check the session is carrying
   * before concluding anything about a command.
   */
  private async writeAndVerify<T>(
    write: Buffer,
    read: Buffer,
    sub: number,
    decode: (data: Buffer) => T | null,
    want: T,
    what: string,
    same: (a: T, b: T) => boolean = (a, b) => a === b,
  ): Promise<void> {
    this.civEnqueue(write);
    let got: T | null;
    try {
      // Byte 4 is the command: FE FE <to> <from> <cmd> <sub> FD. Taken from the frame
      // rather than passed in, so a read frame and the command it is matched against
      // cannot drift apart.
      const f = await this.civRequestRetry(read, read[4]!, sub, 2);
      got = decode(f.data);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      throw new Error(`${what}: sent, but the radio would not confirm it — ${why}`);
    }
    if (got === null) {
      throw new Error(`${what}: the radio answered with something this does not understand`);
    }
    if (!same(got, want)) {
      throw new Error(`${what}: sent, but the radio reports ${String(got)}`);
    }
  }

  // ------------------------------------------------------------- spectrum scope

  /**
   * Turn the radio's CI-V waveform output on or off, and confirm it took.
   *
   * The one command in this class that changes how much traffic the radio sends
   * rather than what it says. Everything else here is one frame out, one frame back;
   * this makes the radio push waveform frames continuously down the same stream the
   * frequency poll and all three meters share — the stream that is paced 70 ms apart
   * precisely because the radio drops commands when it is busy.
   *
   * Verified by read-back like every other control here, and for the same reason:
   * a scope that silently failed to start is indistinguishable from a band with
   * nothing on it.
   */
  async setScopeDataOutput(on: boolean): Promise<void> {
    await this.writeAndVerify(
      setScopeDataOutput(this.civAddress, on),
      readScopeDataOutput(this.civAddress),
      ScopeSub.dataOutput,
      functionStateFrom,
      on,
      `scope data output ${on ? "on" : "off"}`,
    );
  }

  /** The scope on the radio's own display. Independent of the CI-V tap. */
  async setScopeOn(on: boolean): Promise<void> {
    this.civEnqueue(setScopeOn(this.civAddress, on));
  }

  /** Centre mode follows the dial; fixed mode holds a band segment. */
  async setScopeMode(mode: "centre" | "fixed"): Promise<void> {
    this.civEnqueue(setScopeMode(this.civAddress, mode));
  }

  /**
   * Span either side of centre.
   *
   * Read back rather than assumed: the axis labels on the display come from this
   * number, and a span the radio quietly refused would put every signal at the wrong
   * frequency while looking entirely plausible.
   */
  async setScopeSpan(hz: ScopeSpanHz): Promise<void> {
    this.civEnqueue(setScopeSpan(this.civAddress, hz));
    const f = await this.civRequestRetry(
      readScopeSpan(this.civAddress),
      CivCommand.scope,
      ScopeSub.span,
      2,
    );
    // Payload is the sub-command, the scope selector, then a five-byte BCD frequency.
    const got = decodeFrequency(f.data.subarray(2));
    if (got !== hz) {
      throw new Error(`scope span ${hz} Hz: sent, but the radio reports ${got ?? "nothing"}`);
    }
  }

  /**
   * AGC time constant. `med` is the FlexRadio's spelling of `mid` and is accepted.
   *
   * `off` is refused: these radios have no AGC-OFF in this command set, and mapping it to
   * fast would be a control that says one thing and does another.
   */
  async setAgc(setting: string): Promise<void> {
    const raw = String(setting).toLowerCase();
    const want = raw === "med" ? "mid" : raw;
    if (want !== "fast" && want !== "mid" && want !== "slow") {
      throw new Error(`AGC "${setting}" is not one this radio has — fast, mid or slow`);
    }
    await this.writeAndVerify(
      setAgc(this.civAddress, want),
      readAgc(this.civAddress),
      FunctionSub.agc,
      agcFrom,
      want,
      `AGC ${want}`,
    );
  }

  async setNoiseBlanker(on: boolean): Promise<void> {
    await this.setSwitch(FunctionSub.noiseBlanker, on, "noise blanker");
  }

  async setNoiseReduction(on: boolean): Promise<void> {
    await this.setSwitch(FunctionSub.noiseReduction, on, "noise reduction");
  }

  private async setSwitch(
    sub: (typeof FunctionSub)[keyof typeof FunctionSub],
    on: boolean,
    what: string,
  ): Promise<void> {
    await this.writeAndVerify(
      setFunction(this.civAddress, sub, on),
      readFunction(this.civAddress, sub),
      sub,
      functionStateFrom,
      on,
      `${what} ${on ? "on" : "off"}`,
    );
  }

  /** RF gain, 0-100%. Not the same scale as the FlexRadio's dB — see setLevel. */
  async setRfGainPercent(percent: number): Promise<void> {
    const want = Math.round(Math.min(100, Math.max(0, percent)));
    await this.writeAndVerify(
      setLevel(this.civAddress, LevelSub.rfGain, want),
      readLevel(this.civAddress, LevelSub.rfGain),
      LevelSub.rfGain,
      rfPowerPercentFrom,
      want,
      `RF gain ${want}%`,
      // The radio's scale is 0-255, so a percentage does not survive the round trip
      // exactly: 80% is 204 of 255, which reads back as 80%, but neighbouring values
      // land a point either side. Rejecting on that would fail a write that worked.
      (a, b) => Math.abs(a - b) <= 2,
    );
  }

  /** Rate limit for the unmatched-frame warning below. */
  private lastOddFrameAt = 0;

  /** Last modulation seen or set. See radioMode. */
  private radioModeName: string | null = null;

  /** Which receiver control the next poll reads. See pollOnce. */
  private pollCount = 0;

  /**
   * The receiver controls as the radio reports them, for a panel that shows state.
   *
   * `filterLo`/`filterHi` stay null here and that is not an omission: this radio selects
   * FIL1/FIL2/FIL3, whose widths live in its own menu and are not readable over CI-V, so
   * there is no passband in Hz to report. Its UI offers no width buttons either — see
   * `filterEdgesHz` in lib/radio/capabilities.ts.
   */
  private receiverState: ReceiverControls = { ...UNREAD_RECEIVER };

  /**
   * AGC, noise blanker and noise reduction as the RADIO reports them.
   *
   * Null until the rotation in `pollOnce` has been round once, which is the honest answer:
   * "not asked yet" is not the same as "off", and showing off for a radio that has the noise
   * blanker on is worse than showing nothing.
   */
  get receiverControls(): ReceiverControls {
    return { ...this.receiverState };
  }

  private onCivFrame(frame: CivFrame): void {
    this.civFrames++;

    // Per-command tally, so "the radio is answering" can be separated from "the radio
    // is answering the thing we need". See civStats.
    //
    // `frame.sub` is the byte after the command FOR EVERY COMMAND, because whether one
    // exists is a property of the command and not of the framing — parseFrames says so
    // explicitly. For a frequency reply that byte is the low pair of BCD digits, so
    // keying every reply as `command/sub` files 14.074 MHz and 14.075 MHz under
    // different commands and the frequency poll appears never to be answered. That is
    // not hypothetical: the first run of the scope probe reported the frequency poll
    // STARVED at 0/8 while the radio was answering it.
    const key = COMMANDS_WITHOUT_SUB.has(frame.command)
      ? `0x${frame.command.toString(16).padStart(2, "0")}`
      : `0x${frame.command.toString(16).padStart(2, "0")}/0x${(frame.sub ?? 0).toString(16).padStart(2, "0")}`;
    this.civReplyCounts.set(key, (this.civReplyCounts.get(key) ?? 0) + 1);

    // Scope waveform frames are volunteered continuously and match no read. Counted
    // and handed on, never allowed to fall through to the waiter-matching below —
    // a waveform frame is not an answer to anything.
    if (frame.command === CivCommand.scope && frame.sub === ScopeSub.waveform) {
      this.scopeFrames++;
      this.scopeBytes += frame.data.length;
      this.emit("scopeFrame", frame);
      return;
    }

    // Hand it to anything waiting for this command before the switch below, which is
    // about unsolicited traffic — the meters and the dial.
    // A refusal answers the question too.
    //
    // The radio replies 0xFA to a command it will not honour, which matches no
    // pending read and therefore looked exactly like silence: preflight reported "the
    // radio did not answer" about a radio that had answered, in the negative,
    // immediately. Since only one read is ever outstanding, the oldest waiter owns it.
    if (frame.command === CivReply.notGood && this.pending.length > 0) {
      const [waiter] = this.pending.splice(0, 1);
      waiter?.reject(new Error(`the radio refused command 0x${waiter.command.toString(16)}`));
      return;
    }

    const hit = this.pending.findIndex(
      (p) => p.command === frame.command && (p.sub === null || p.sub === frame.sub),
    );
    if (hit >= 0) {
      const [waiter] = this.pending.splice(hit, 1);
      waiter?.resolve(frame);
    } else if (this.pending.length > 0 && !UNSOLICITED.has(frame.command)) {
      this.civUnmatched++;
      // Something is waiting, and this frame is not what it is waiting for.
      //
      // Worth saying out loud. CI-V has no request ids, so a reply whose sub-command byte
      // differs from the read that asked for it is indistinguishable from the radio never
      // answering at all — the caller times out and reports silence. That exact confusion
      // has already cost this project twice: a 0xFA refusal read as silence, and four
      // meters that "never replied" while the radio was answering the first of every
      // burst. Rate limited, because a mismatch tends to repeat every poll.
      const now = Date.now();
      if (now - this.lastOddFrameAt > 2_000) {
        this.lastOddFrameAt = now;
        const waiting = this.pending
          .map((p) => `0x${p.command.toString(16)}${p.sub === null ? "" : `/0x${p.sub.toString(16)}`}`)
          .join(", ");
        console.warn(
          `[icom] CI-V frame 0x${frame.command.toString(16)}` +
            `${frame.sub === null ? "" : `/0x${frame.sub.toString(16)}`} matched nothing ` +
            `while waiting for ${waiting} (data ${frame.data.toString("hex") || "none"})`,
        );
      }
    }

    switch (frame.command) {
      // 0x03 is our read reply; 0x00 is the radio volunteering a dial change.
      case CivCommand.readFrequency:
      case CivCommand.transceiveFrequency: {
        const hz = decodeFrequency(frame.data);
        if (hz !== null && hz > 0) this.frequencyHz = hz;
        break;
      }
      case CivCommand.modeWithData: {
        const decoded = modeWithDataFrom(frame.data);
        if (decoded) {
          const name = fromCivMode(decoded.mode ?? "", decoded.dataMode);
          if (name !== this.radioModeName) {
            this.radioModeName = name;
            this.emit("radioMode", name);
          }
        }
        break;
      }
      case CivCommand.function: {
        // 0x16 covers several controls and the sub-command says which. Reading the state from
        // the payload without checking the sub would attribute the noise blanker's answer to
        // whatever was asked for last.
        if (frame.sub === FunctionSub.agc) {
          const agc = agcFrom(frame.data);
          if (agc && agc !== this.receiverState.agc) {
            this.receiverState = { ...this.receiverState, agc };
            this.emit("receiverControls", this.receiverControls);
          }
        } else if (frame.sub === FunctionSub.noiseBlanker || frame.sub === FunctionSub.noiseReduction) {
          const on = functionStateFrom(frame.data);
          if (on !== null) {
            const key = frame.sub === FunctionSub.noiseBlanker ? "nb" : "nr";
            if (this.receiverState[key] !== on) {
              this.receiverState = { ...this.receiverState, [key]: on };
              this.emit("receiverControls", this.receiverControls);
            }
          }
        }
        break;
      }
      case CivCommand.meter: {
        // The sub-command says which meter, and the payload is two-byte BCD.
        const raw = decodeBcd2(frame.data.subarray(1));
        if (raw === null) break;
        if (frame.sub === MeterSub.sMeter) {
          // Forward power rides along on the same event the FlexRadio uses, so the
          // display needs to know nothing about which radio it is watching.
          this.emit("smeter", {
            dbm: sMeterToDbm(raw),
            fwdDbm: this.forwardDbm,
            at: Date.now(),
          });
        } else if (frame.sub === MeterSub.power) {
          const watts = poMeterToWatts(raw, this.ratedWatts);
          this.forwardWatts = watts;
          this.forwardDbm = wattsToDbm(watts);
        } else if (frame.sub === MeterSub.swr) {
          this.telemetryState = {
            ...this.telemetryState,
            swr: swrFromRaw(raw),
            at: Date.now(),
          };
          this.emit("telemetry", this.telemetryState);
        }
        break;
      }
      default:
        break;
    }
  }

  /**
   * Ask the radio for everything the poll covers.
   *
   * Guarded rather than assumed open: a stream can go away between the caller's check
   * and this line, and a throw from a timer callback is an unhandled rejection that
   * takes the bridge down.
   */
  private pollOnce(): void {
    const serial = this.serial;
    if (serial?.state !== "open") return;
    // Queued, not blasted. See civEnqueue: the radio answers the first of a burst and
    // drops the rest, which is why every meter here reported nothing for weeks.
    this.civEnqueue(readFrequency(this.civAddress));
    // The modulation, so the CAT panel shows what the radio is actually in rather than what
    // was last asked for — including changes made on the radio's own front panel.
    this.civEnqueue(readModeWithData(this.civAddress));
    this.civEnqueue(readMeter(this.civAddress, MeterSub.sMeter));
    this.civEnqueue(readMeter(this.civAddress, MeterSub.swr));
    // Forward power. Only meaningful while keyed, which is exactly when it is the only
    // number worth looking at.
    this.civEnqueue(readMeter(this.civAddress, MeterSub.power));

    // One receiver control per poll, in rotation.
    //
    // The CAT panel showed "select" for AGC and nothing at all for the noise blanker and
    // noise reduction, because none of them was ever read — they were write-only controls, so
    // the panel could not show the radio's state, only remember what had been clicked. And a
    // control that cannot show its state is one an operator has to guess at.
    //
    // Rotated rather than all three every poll: CI-V is a serial bus paced 70 ms apart, and
    // adding three more reads to every two-second cycle would push the queue past the poll
    // interval and start delaying the meters. One at a time refreshes all three in about six
    // seconds, which is far quicker than anybody changes them.
    const rotation = this.pollCount++ % 3;
    if (rotation === 0) this.civEnqueue(readAgc(this.civAddress));
    else if (rotation === 1) this.civEnqueue(readFunction(this.civAddress, FunctionSub.noiseBlanker));
    else this.civEnqueue(readFunction(this.civAddress, FunctionSub.noiseReduction));
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => this.pollOnce(), POLL_INTERVAL_MS);
    this.pollTimer.unref?.();

    // Ask once immediately rather than waiting out the first interval. An operator
    // watching the page should not see a blank frequency and a dead S-meter for two
    // seconds after connecting — that reads as "it did not work".
    this.pollOnce();
  }

  getFrequencyHz(): number | null {
    return this.frequencyHz;
  }

  async setFrequencyHz(hz: number): Promise<void> {
    const serial = this.serial;
    if (serial?.state !== "open") throw new Error("Serial stream is not open");
    // Paced: a retune dropped because it arrived inside a poll burst is a radio that
    // silently stays where it was, which during a POTA chase reads as a dead frequency.
    this.civEnqueue(setFrequency(this.civAddress, hz));
    // Optimistic, then confirmed by the next poll or transceive broadcast. The radio
    // does not acknowledge with the new value, so waiting for one would hang.
    this.frequencyHz = hz;
  }

  /**
   * Set transmit power, 1-100%.
   *
   * One CI-V command, and the reason /power was a FlexRadio-only endpoint until now:
   * the slider on the digital page did nothing at all on this radio. Power is the
   * control that most wants to work here — FT8 is full duty for 12.6 of every 15
   * seconds, and an IC-7300 left at 100% into that is how finals die.
   */
  async setRfPowerPercent(percent: number): Promise<void> {
    const serial = this.serial;
    if (serial?.state !== "open") throw new Error("Serial stream is not open");
    this.civEnqueue(setRfPower(this.civAddress, Math.max(0, Math.min(100, Math.round(percent)))));
  }

  /**
   * Put the radio in USB with data mode on.
   *
   * Not optional for FT8. In plain USB the transmit audio comes from the microphone
   * rather than the USB codec, so the radio keys and sends nothing — a symptom with no
   * obvious connection to a one-byte flag.
   */
  async setDataMode(): Promise<void> {
    const serial = this.serial;
    if (serial?.state !== "open") throw new Error("Serial stream is not open");
    this.civEnqueue(setModeWithData(this.civAddress, "USB", true, 1));
  }

  /**
   * Set any modulation the radio has.
   *
   * The CAT panel could previously only ask for USB, DIGU or USB-D, and all three were
   * answered with `setDataMode()` — so choosing USB gave you USB-D, and choosing LSB, CW, AM,
   * FM or RTTY did nothing whatsoever. Nothing was logged, nothing failed, the picker simply
   * sprang back to whatever the radio was already in.
   */
  async setModulation(name: string): Promise<string> {
    const serial = this.serial;
    if (serial?.state !== "open") throw new Error("Serial stream is not open");
    const civ = toCivMode(name);
    if (!civ) throw new Error(`"${name}" is not a modulation this radio has`);
    this.civEnqueue(setModeWithData(this.civAddress, civ.mode, civ.data, 1));
    // Recorded optimistically and then corrected by the poll below, because a CI-V write is
    // not acknowledged and the panel should not sit blank for two seconds after a click.
    this.radioModeName = fromCivMode(civ.mode, civ.data);
    return this.radioModeName;
  }

  /**
   * The modulation the radio says it is in — USB, LSB-D, CW, and so on.
   *
   * Distinct from `mode`, which is the DIGITAL mode (FT8/FT4) this source is decoding. Those
   * two were reported through one status field for a long time, which is why the rig page's
   * modulation picker displayed "FT8".
   */
  get radioMode(): string | null {
    return this.radioModeName;
  }

  /**
   * Put the radio in a VOICE mode — the data flag OFF.
   *
   * The exact inverse of setDataMode and for the same reason read the other way round: with
   * data mode on, modulation comes from the network or USB codec and the microphone is
   * ignored, so an operator holding the PTT keys the radio and transmits silence. That is
   * the `MOD Input` fault all over again, arrived at from software instead of a menu.
   *
   * Filter 1 to match the data path, so switching back and forth does not also change the
   * passband underneath the operator.
   */
  async setVoiceMode(mode: "USB" | "LSB" = "USB"): Promise<void> {
    const serial = this.serial;
    if (serial?.state !== "open") throw new Error("Serial stream is not open");
    this.civEnqueue(setModeWithData(this.civAddress, mode, false, 1));
  }

  /**
   * Run the internal ATU's tune cycle and wait for it to finish.
   *
   * THIS TRANSMITS — a low-power carrier for a second or two. Callers gate it exactly
   * as they gate keying.
   *
   * Polled rather than assumed: the radio acknowledges the command immediately and
   * then tunes, so returning on the acknowledgement would report success before the
   * tuner had done anything, and a band change would transmit into an untuned antenna
   * one window later.
   */
  async tuneAtu(timeoutMs = 20_000): Promise<{ ok: boolean; state: AtuState; reason?: string }> {
    const serial = this.serial;
    if (serial?.state !== "open") return { ok: false, state: "unknown", reason: "The CI-V stream is not open" };

    this.civEnqueue(atuTune(this.civAddress));

    const until = Date.now() + timeoutMs;
    // Give it a moment to actually start before the first read, or the answer is
    // whatever the tuner was doing beforehand.
    await new Promise((r) => setTimeout(r, 500));
    while (Date.now() < until) {
      const state = await this.readAtuState().catch(() => "unknown" as AtuState);
      if (state !== "tuning") {
        return state === "unknown"
          ? { ok: false, state, reason: "The tuner did not report its state" }
          : { ok: true, state };
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return { ok: false, state: "tuning", reason: `Still tuning after ${Math.round(timeoutMs / 1000)}s` };
  }

  async readAtuState(): Promise<AtuState> {
    const f = await this.civRequestRetry(readAtu(this.civAddress), CivCommand.control, 0x01, 2);
    return atuStateFrom(f.data);
  }

  /**
   * A read, retried.
   *
   * CI-V here is UDP inside the RS-BA1 protocol, over whatever network the radio is on
   * — a VPN, in the case this was written for — while 48 kHz of audio shares the link.
   * Frames go missing. The two-second poll never noticed because it simply asks again;
   * preflight asked once and reported "the radio did not answer" about a radio that was
   * answering fine a second later. Observed on real hardware: 0x26 and 0x14 timing out
   * while 0x03 and 0x15 came back on schedule throughout.
   */
  private async civRequestRetry(
    frame: Buffer,
    command: number,
    sub: number | null,
    attempts = 3,
  ): Promise<CivFrame> {
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await this.civRequest(frame, command, sub);
      } catch (err) {
        last = err;
      }
    }
    throw last instanceof Error ? last : new Error(String(last));
  }

  /**
   * Wait until CI-V has proved it is answering at all.
   *
   * Preflight used to fire its reads the instant the streams opened, which is before the
   * radio has answered anything. Asking a question of a channel that has never carried a
   * reply, and then reporting the silence as a fault, is a good way to blame the radio
   * for being slow to wake up.
   */
  private async civReady(timeoutMs = 6_000): Promise<boolean> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (this.civFrames > 0) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return this.civFrames > 0;
  }

  /**
   * Ask the radio the things that decide whether a transmission will work.
   *
   * The counterpart to the FlexRadio's preflight, which had been running on the live
   * path for a while and catching real misconfiguration. Reported rather than enforced,
   * for the same reason: refusing to attach over a warning leaves an operator unable to
   * work for a reason they cannot see.
   *
   * WHAT IT CANNOT CHECK, and this is the important part: `MOD Input -> DATA MOD` must
   * be LAN or the radio keys perfectly and transmits silence. That setting is in the
   * radio's own menu and is not exposed over CI-V on any model here, so no software can
   * detect it. It is named in the returned notes rather than left for an operator to
   * rediscover the way this project did.
   */
  async preflight(): Promise<{
    blockers: string[];
    warnings: string[];
    notes: string[];
    mode: string | null;
    dataMode: boolean | null;
    rfPower: number | null;
    atu: AtuState;
    /**
     * The radio is keyed right now.
     *
     * Reported as a field as well as a blocker so a caller can ACT on it. It was a
     * string in a list, which meant preflight could see a stuck transmitter — twice, on
     * consecutive evenings — and do nothing but mention it.
     */
    transmitting: boolean;
  }> {
    const blockers: string[] = [];
    const warnings: string[] = [];
    const notes: string[] = [];
    let mode: string | null = null;
    let dataMode: boolean | null = null;
    let rfPower: number | null = null;
    let atu: AtuState = "unknown";
    let transmitting = false;

    if (this.serial?.state !== "open") blockers.push("The CI-V stream is not open, so the radio cannot be keyed or unkeyed");
    if (this.audio?.state !== "open") blockers.push("The audio stream is not open, so nothing would go out");
    if (blockers.length > 0) {
      return { blockers, warnings, notes, mode, dataMode, rfPower, atu, transmitting };
    }

    // Nothing below is worth asking until the radio has answered something.
    if (!(await this.civReady())) {
      blockers.push(
        `No CI-V frame has arrived. The address is probably wrong — DigiShack is using 0x${this.civAddress.toString(16)}.`,
      );
      return { blockers, warnings, notes, mode, dataMode, rfPower, atu, transmitting };
    }

    try {
      const f = await this.civRequestRetry(readModeWithData(this.civAddress), CivCommand.modeWithData, 0x00);
      const m = modeWithDataFrom(f.data);
      mode = m?.mode ?? null;
      dataMode = m?.dataMode ?? null;
      if (m && !m.dataMode) {
        // Not a blocker: the transmitter sets USB-D itself before every transmission.
        // Worth saying anyway — if it is off now, something else is changing it.
        warnings.push(
          `The radio is in ${m.mode ?? "an unknown mode"} without data mode. DigiShack sets USB-D before each transmission, but something is putting it back.`,
        );
      } else if (m && m.mode !== "USB") {
        warnings.push(`The radio is in ${m.mode ?? "an unknown mode"}; digital modes want USB with data on.`);
      }
    } catch (err) {
      warnings.push(`Could not read the mode: ${err instanceof Error ? err.message : err}`);
    }

    try {
      const f = await this.civRequestRetry(readRfPower(this.civAddress), CivCommand.level, 0x0a);
      rfPower = rfPowerPercentFrom(f.data);
      // FT8 is 100% duty for 12.6 seconds out of every 15. The radio's own manual says
      // to reduce power for continuous-carrier modes, and this is the number that cooks
      // finals unattended.
      if (rfPower !== null && rfPower > 30) {
        warnings.push(`RF power is ${rfPower}% — FT8 is full duty for 12.6 s of every 15, and this is how finals die.`);
      }
    } catch (err) {
      warnings.push(`Could not read the power level: ${err instanceof Error ? err.message : err}`);
    }

    try {
      const f = await this.civRequestRetry(readPtt(this.civAddress), CivCommand.control, 0x00, 2);
      if (pttFrom(f.data)) {
        transmitting = true;
        blockers.push("The radio is already transmitting");
      }
    } catch {
      /* the PTT read is a nicety; the transmitter unkeys unconditionally anyway */
    }

    try {
      atu = await this.readAtuState();
      if (atu === "bypassed") {
        notes.push("The ATU is bypassed. That is correct with a resonant antenna or an external tuner, and wrong with anything else.");
      }
    } catch {
      notes.push("This radio did not answer the ATU query, so it may not have one.");
    }

    notes.push(
      "Not checkable over CI-V: MOD Input -> DATA MOD must be LAN. On anything else the radio keys, the timing is perfect, and it transmits silence.",
    );

    return { blockers, warnings, notes, mode, dataMode, rfPower, atu, transmitting };
  }

  /**
   * Read PTT back, to confirm the radio is not keyed.
   *
   * Used on the way out. An unkey is one CI-V datagram and nothing acknowledges it, so
   * "we sent the unkey" and "the radio is not transmitting" are different claims — and
   * the second is the one that matters when the alternative is a transmitter left on.
   *
   * Returns null when the radio would not say, which is not the same as "off" and must
   * not be reported as though it were.
   */
  async isKeyed(): Promise<boolean | null> {
    try {
      const f = await this.civRequestRetry(readPtt(this.civAddress), CivCommand.control, 0x00, 2);
      return pttFrom(f.data);
    } catch {
      return null;
    }
  }

  /** The CI-V address in use, after any model-based default was applied. */
  get address(): number {
    return this.civAddress;
  }

  /** The serial stream, for the transmitter to key PTT through. */
  get serialStream(): IcomSerialStream | null {
    return this.serial;
  }

  /** The audio stream, for the transmitter to push samples through. */
  get audioStream(): IcomAudioStream | null {
    return this.audio;
  }

  private handleDisconnect(reason: string): void {
    if (!this.isConnected && !this.control) return;
    this.isConnected = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.emit("disconnected", { reason });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.civTimer) clearTimeout(this.civTimer);
    this.civTimer = null;
    this.civQueue = [];
    this.pipeline.stop();
    if (this.spectrumTimer) clearInterval(this.spectrumTimer);
    this.spectrumTimer = null;
    if (this.linkTimer) clearInterval(this.linkTimer);
    this.linkTimer = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;

    // Data streams first, control last: the control stream's token removal is what
    // releases the session, and doing it before the others leaves them orphaned.
    await this.serial?.close("stopping").catch(() => undefined);
    await this.audio?.close("stopping").catch(() => undefined);
    await this.control?.disconnect("stopping").catch(() => undefined);

    this.serial = null;
    this.audio = null;
    this.control = null;
    this.isConnected = false;
  }
}
