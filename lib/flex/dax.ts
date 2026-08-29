import dgram from "node:dgram";
import { ft2DecodeAudio } from "@/lib/digital/ft2demod";
import { HashCallBook as Ft2HashCallBook } from "@/lib/digital/pack77";
import { DecodePipeline } from "@/lib/radio/decode-pipeline";
import {
  SPECTRUM_INTERVAL_MS,
  type SpectrumProfile,
  spectrumIntervalFor,
  SpectrumAnalyser,
  type SpectrumRow,
} from "@/lib/radio/spectrum";
import { EventEmitter } from "node:events";

import { decodeFT4, decodeFT8, HashCallBook } from "@e04/ft8ts";

import { FlexClient } from "@/lib/flex/client";
import { hasAntennaChoice, resolveAntenna } from "@/lib/flex/antennas";
import {
  FlexPanadapter,
  PAN_MAX_DBM,
  PAN_MIN_DBM,
  PAN_PACKET_CLASS,
  PAN_STALL_MS,
  panNeedsRecentre,
  PAN_Y_PIXELS,
  WATERFALL_PACKET_CLASS,
} from "@/lib/flex/panadapter";
import { LinkLatency } from "@/lib/radio/link-latency";
import { PanadapterScaler, type PanadapterRow } from "@/lib/radio/panadapter";
import { UNREAD_RECEIVER, type ReceiverControls } from "@/lib/radio/receiver-controls";

// Self-contained FT8/FT4 decoding from a FlexRadio, with no external decoder.
//
// Every constant here was measured against a FLEX-6400 on SmartSDR 4.2.18 rather
// than taken from documentation:
//
//   * DAX RX audio arrives as VITA-49 on a UDP port the client registers with
//     `client udpport <port>`. Without that registration the radio creates the
//     stream and sends nothing — which looks exactly like a broken parser.
//   * Packets are 1052 bytes: a 28-byte header then 256 big-endian float32,
//     i.e. 128 interleaved stereo frames. ~188 packets/s => 24 kHz.
//   * Left and right channels are identical for a receive slice, so only the
//     left is taken.
//   * The VITA-49 timestamps are dummy values (0x01020304 / 0x1020304050607080),
//     so window alignment must use arrival time, never the packet timestamp.
//   * `stream remove` requires the id with an `0x` prefix; without it the radio
//     answers 0x50000059 and the stream leaks.

const VITA_HEADER_BYTES = 28;

/** VITA packet classes seen on the client UDP socket. */
const AUDIO_PACKET_CLASS = 0x03e3;
const METER_PACKET_CLASS = 0x8002;

/**
 * How long without audio before the streams are rebuilt, ms.
 *
 * Comfortably inside the 90 s liveness watchdog so there is time for the rebuild to work
 * AND for audio to resume before the process is killed — the whole point is to recover
 * without a restart. Comfortably outside a transmission, too: DAX receive audio goes
 * near-silent while the radio is transmitting, and an FT8 cycle is 15 s, so anything much
 * below 20 s would fire during ordinary operating.
 */
const AUDIO_REBUILD_AFTER_MS = 30_000;

/** Minimum gap between rebuild attempts, so a radio that is truly gone is left alone. */
const AUDIO_REBUILD_COOLDOWN_MS = 45_000;

/** DAX RX audio sample rate. */
export const DAX_SAMPLE_RATE = 24_000;

/** FT8/FT4 decode input rate. */
export { DECODE_SAMPLE_RATE } from "@/lib/radio/decode-pipeline";

/** FT8 and FT4 transmit cycles are aligned to these UTC boundaries. */
export const FT8_PERIOD_MS = 15_000;
export const FT4_PERIOD_MS = 7_500;

/**
 * FT2's T/R period, from `m_TRperiod=3.75` in `on_actionFT2_triggered`.
 *
 * 3.75 s around a 1.947 s transmission leaves 1.80 s of guard time — close enough
 * to FT8's 2.36 s that FT2 needs no special timing treatment. An earlier revision
 * had 2.5 s, from `NMAX=30000` in the standalone harness's `ft2_params.f90`; that
 * is a decode-buffer length, not a T/R period.
 */
export const FT2_PERIOD_MS = 3_750;

/**
 * Half-band FIR for 24 kHz -> 12 kHz.
 *
 * A DIGU slice is already filtered to 0–3000 Hz so there is little above 3 kHz to
 * alias, but decimating without any filter would fold whatever leaks through
 * straight into the FT8 passband.
 */
export interface DaxDecode {
  /** Audio offset within the passband, Hz. Maps to DigitalDecode.freqOffset. */
  freqOffset: number;
  snr: number;
  /** Time offset of the transmission within its window, seconds. */
  dt: number;
  message: string;
  mode: "FT8" | "FT4" | "FT2";
  /** UTC start of the window this came from. */
  windowStart: Date;
}

export interface DaxSourceOptions {
  host: string;
  port?: number;
  /** DAX channel the slice routes audio to (slice property `dax`). */
  daxChannel?: number;
  mode?: "FT8" | "FT4" | "FT2";
  /**
   * Decoder depth. 2 is the live default: measured at ~0.6 s per window against
   * real 20 m traffic, comfortably inside the ~2.4 s gap between cycles. Depth 3
   * is ~1.5 s and still fits; depth 4 takes over 11 s and cannot be used live.
   */
  depth?: number;
  /**
   * Windows quieter than this RMS are skipped without decoding. DAX RX audio
   * goes near-silent while the radio transmits, and decoding silence is pure
   * waste — this is measured, not theoretical: it is why an early capture that
   * happened to land on a transmit cycle produced zero decodes.
   */
  silenceRms?: number;
  /**
   * Top of the audio passband, Hz: what the decoder searches AND what the waterfall
   * draws. One number for both, so the display can never disagree with the decoder.
   */
  passbandHz?: number;
  /**
   * Dial frequency for the slice created when the radio has none of its own.
   * Ignored when any slice already exists.
   */
  freqHz?: number;
  /**
   * Which antenna port to use, on a radio that has more than one.
   *
   * Both were `ANT1`, hardcoded into the `slice create` below, and nothing read the
   * antenna back — so an operator whose HF wire is on ANT2 got a bridge that listened to
   * an empty socket and would have transmitted into one. Every FLEX-6000 has two ports
   * and the bigger ones have five.
   *
   * `rx` is for an operator with a separate receive antenna — a loop, a beverage, the
   * 6600's RX_A BNC — and defaults to `tx` when it is not given, because one antenna for
   * both is the normal case and making it say so twice is how they end up disagreeing.
   *
   * Applied ONLY to a slice DigiShack owns: one it created, or the radio's restored
   * default profile when no other GUI client is connected. An operator's own slice is
   * left exactly where they put it — see the restored-profile note at the slice-create
   * site for why those two cases are distinguishable at all.
   */
  antenna?: { tx?: string | null; rx?: string | null };
  /**
   * RF panadapter: tens of kHz of band, alongside the audio waterfall rather than
   * instead of it.
   *
   * Off by default. It is not free — 4096 bins at 15 frames a second is about
   * 120 kB/s from the radio, which is comparable to the audio stream — and a page
   * that is not showing it should not be paying for it.
   */
  panadapter?: {
    enabled: boolean;
    /** Span in Hz. Clamped to what the radio offers. */
    spanHz?: number;
    bins?: number;
    fps?: number;
    /** Radio-side frame averaging, 0-100. See `PAN_AVERAGE_DEFAULT`. */
    average?: number;
  };

  /**
   * Where the radio is really tuned, asked fresh each time.
   *
   * REQUIRED for the panadapter to follow the dial, and the reason is a genuine
   * surprise in the radio's protocol: **a FlexRadio does not echo `slice tune` back to
   * the connection that sent it.** This connection receives `RF_frequency` exactly once,
   * in the subscription snapshot at connect, and never again — later slice statuses
   * carry mode, filters, antennas and the TX flag, but no frequency. Verified on the
   * wire: one slice status with RF_frequency, fifteen without.
   *
   * Since DigiShack tunes the radio through this very connection (it is the GUI client),
   * this connection is always the originator, so its own slice cache is stale for every
   * band change the operator makes from the UI. The panadapter then sits on the old band
   * drawing a confident ruler for a frequency the radio left minutes ago.
   *
   * The bridge already tracks the dial correctly on a SEPARATE connection, which — not
   * being the originator — does get the updates. This supplier borrows that answer
   * rather than trying to make a client observe its own commands.
   */
  dialHz?: () => number | null;
}

/** Radio health, read from the meter stream. */
export interface Telemetry {
  /** PA temperature, degrees C. */
  paTempC: number | null;
  /** Standing wave ratio. Only meaningful while transmitting. */
  swr: number | null;
  /** Supply voltage at the PA. */
  voltsPa: number | null;
  /** Main fan speed, RPM. */
  fanRpm: number | null;
  /** Reflected power, dBm. */
  reflectedDbm: number | null;
  at: number;
}

type Events = {
  decodes: [{ windowStart: Date; decodes: DaxDecode[]; rms: number; decodeMs: number }];
  window: [{ windowStart: Date; samples: number; rms: number; skipped: boolean }];
  spectrum: [SpectrumRow];
  /**
   * A row of RF spectrum — tens of kHz of band, not 3 kHz of audio.
   *
   * A separate event from `spectrum`, not a mode of it, for the reason
   * lib/radio/panadapter.ts sets out: one carries offsets within a passband and the
   * other carries absolute frequencies, and merging them is how a display ends up
   * drawing one as the other.
   */
  panadapter: [PanadapterRow];
  /**
   * AGC, noise blanker and noise reduction as the RADIO reports them.
   *
   * The same event the Icom emits, so the panel needs to know nothing about which
   * radio it is watching. Added late, and it should not have been: the FlexRadio has
   * reported `agc_mode`, `nb` and `nr` in every slice status line since the beginning
   * and nothing ever read them, so /rig showed AGC as "reading…" for ever — a control
   * that could only remember what had been clicked. Nothing was missing from the
   * radio; the field was simply never looked at.
   */
  receiverControls: [ReceiverControls];
  /**
   * Raw receiver audio, exactly as it arrived — 24 kHz mono float32 off DAX.
   *
   * The Icom's source emits the same event at 48 kHz, so a consumer must be told the rate
   * rather than assume one. Playing 24 kHz audio as 48 sounds like fast forward.
   */
  audio: [{ samples: Float32Array; at: number }];
  /**
   * Slice signal strength (the S-meter), dBm at the antenna, ~4 Hz — plus
   * forward power (dBm) while the radio is transmitting, so the same display
   * can show what is going OUT during a transmission.
   */
  smeter: [{ dbm: number; fwdDbm: number | null; at: number }];
  /** Radio health: PA temperature, SWR, supply voltage, fan. ~1 Hz. */
  telemetry: [Telemetry];
  error: [Error];
  connected: [{ streamId: string; udpPort: number; daxChannel: number }];
};



export class FlexDaxSource extends EventEmitter<Events> {
  // `passbandHz` stays optional: the pipeline owns the default and the clamp, and
  // duplicating the number here is how the waterfall and the decoder end up disagreeing.
  private opts: Required<Omit<DaxSourceOptions, "host" | "port" | "passbandHz" | "dialHz">> & {
    host: string;
    port: number;
    passbandHz?: number;
    // Optional so a caller that has no dial tracker still constructs. The panadapter
    // then falls back to this connection's own slice cache, which is correct at connect
    // and stale after any tune this connection issued — see the option's own comment.
    dialHz?: () => number | null;
  };

  private client: FlexClient | null = null;
  private socket: dgram.Socket | null = null;
  private streamId: string | null = null;
  /**
   * The UDP port the radio was told to send to, kept so the streams can be rebuilt.
   *
   * The radio ties every stream to a client's registered port. Re-registering is the
   * first thing a rebuild has to do, and without holding the port there is nothing to
   * re-register.
   */
  private udpPort = 0;
  /** When an audio packet last arrived. 0 = none yet. */
  private lastAudioAt = 0;
  private audioRecoverTimer: NodeJS.Timeout | null = null;
  /** When a rebuild was last attempted, so a dead radio is not hammered. */
  private lastRebuildAt = 0;
  private smeterTimer: NodeJS.Timeout | null = null;
  /** Slice feeding our DAX channel; created by us when the radio had none. */
  private sliceIndex: number | null = null;
  private createdSlice = false;

  /**
   * Antenna settings the RADIO would not accept, in words, for the operator to read.
   *
   * A configured port that does not exist is refused rather than quietly replaced with
   * ANT1 (see resolveAntenna), and a refusal nobody can see is the same failure in a
   * quieter voice — the operator sets ANT2, DigiShack uses ANT1, and the only evidence
   * is a band that sounds dead. The service copies these into the status the /rig page
   * already shows.
   */
  readonly antennaWarnings: string[] = [];

  /**
   * The receive port we asked the radio for, null when we asked for nothing.
   *
   * Kept because the PANADAPTER needs the same answer and is started later: it carries
   * its own `rxant` (measured — `display pan … rxant=ANT1 ant_list=…`), so a slice moved
   * to ANT2 with the panadapter left behind draws a confident spectrum of a different
   * antenna with nothing on the display to say so.
   */
  private appliedRxAnt: string | null = null;


  private spectrumTimer: NodeJS.Timeout | null = null;

  /** The RF panadapter, when one is wanted. Null when the option is off. */
  private pan: FlexPanadapter | null = null;
  private panScaler: PanadapterScaler | null = null;
  /** When the last panadapter frame arrived, for the stall check. 0 = none yet. */
  private lastPanFrameAt = 0;
  private panFollowTimer: NodeJS.Timeout | null = null;
  /**
   * Transit time to the radio, measured off the TCP command channel.
   *
   * This radio is often on the far side of a VPN, and the SNTP-corrected clock cannot
   * see that path — see lib/radio/link-latency.ts for what an unmeasured 150 ms does
   * to transmit timing and dt readings. Public so the service can report it and hand
   * the transmitter its `linkOneWayMs` supplier from the same estimate the decode
   * windows use; two estimates of one path is how they end up disagreeing.
   */
  readonly link = new LinkLatency();
  private linkTimer: NodeJS.Timeout | null = null;
  /** Last compensation logged, so the log says when it changes, not every 15 s. */
  private linkLoggedMs = -1;
  /**
   * `display pan` status lines, accumulated by object id.
   *
   * Needed to find the panadapter the radio restored for this client — it is the one
   * whose `client_handle` is ours. Merged rather than replaced, because a status line
   * carries only the fields that changed.
   */
  private panStatuses = new Map<string, Record<string, string>>();

  /**
   * AGC / NB / NR as last reported. Null means the radio has not said, which is a
   * different thing from off — see the tooltip on those controls.
   */
  private receiverState: ReceiverControls = { ...UNREAD_RECEIVER };

  /** What the radio last reported for the receiver controls. */
  get receiverControls(): ReceiverControls {
    return { ...this.receiverState };
  }

  /**
   * Rebuild the radio's streams after they stop arriving.
   *
   * THE RECOVERY THAT EXISTED DID NOT RECOVER ANYTHING. When frames stopped, the only
   * thing that happened was `display pan set` being re-sent — see the panadapter stall
   * check below. That could at best have fixed the panadapter; it never touched the DAX
   * audio stream, which is what the liveness watchdog is actually measuring. Measured
   * over one day on the live installation: seven stall episodes, five of which ran the
   * full 90 seconds and ended in the process being killed and restarted. The watchdog
   * was not a safety net, it was the recovery mechanism, and it costs ~25 s off air and
   * an abandoned contact every time.
   *
   * What the radio actually needs is its streams recreated. Both directions stop
   * together — audio AND panadapter, which are separate streams on the same socket —
   * while the TCP command channel stays ESTABLISHED with nothing queued, so the control
   * link is healthy and only the streaming has stopped. Re-registering the UDP port and
   * recreating the stream is the smallest thing that could plausibly restore it.
   *
   * UNVERIFIED: that this fixes it. The commands are the same ones that establish the
   * streams at connect, and they are cheap and idempotent, but the fault has not been
   * reproduced on demand — it happens every few hours and the evidence so far is a
   * network-counter sampler left running on the box. If a stall survives this, the
   * watchdog still fires at 90 s exactly as before, so the worst case is unchanged.
   */
  private async rebuildStreams(): Promise<void> {
    const client = this.client;
    if (!client || !this.udpPort) return;

    // One attempt per stall, not one per check. A radio that is genuinely gone must not
    // be sent a stream teardown every few seconds for the rest of the outage.
    const now = Date.now();
    if (now - this.lastRebuildAt < AUDIO_REBUILD_COOLDOWN_MS) return;
    this.lastRebuildAt = now;

    console.warn(
      `[flex] no receiver audio for ${((now - this.lastAudioAt) / 1000).toFixed(0)}s — ` +
        `rebuilding the DAX stream before the watchdog gives up`,
    );

    try {
      // The radio ties streams to the client's registered port, so this comes first.
      await client.command(`client udpport ${this.udpPort}`).catch(() => {});

      if (this.streamId) {
        // `stream remove` needs the 0x prefix; without it the radio answers 0x50000059
        // and the stream leaks — the same trap the connect path documents.
        await client.command(`stream remove 0x${this.streamId}`).catch(() => {});
        this.streamId = null;
      }

      const created = await client.command(
        `stream create type=dax_rx dax_channel=${this.opts.daxChannel}`,
      );
      if (created.status !== 0) {
        console.warn(
          `[flex] could not recreate the DAX stream (0x${created.status.toString(16)}) — ` +
            `leaving it to the watchdog`,
        );
        return;
      }
      this.streamId = created.message.trim();

      // Re-assert the slice's DAX routing. Cheap, and a slice that lost it produces a
      // stream that exists and carries nothing — indistinguishable from this fault.
      if (this.sliceIndex !== null) {
        await client
          .command(`slice set ${this.sliceIndex} dax=${this.opts.daxChannel}`)
          .catch(() => {});
      }

      // The panadapter is a separate stream and stops with the audio, so it is rebuilt in
      // the same breath rather than waiting for its own 15 s nudge to fail again.
      if (this.pan) {
        const dial = this.opts.dialHz?.() ?? this.opts.freqHz;
        await this.pan.tune(dial).catch(() => {});
      }

      console.log(`[flex] DAX stream rebuilt as ${this.streamId}`);
    } catch (err) {
      console.warn(
        `[flex] stream rebuild failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Follow a live antenna change with the RF panadapter.
   *
   * Called by the service after it has moved the SLICE, so the two cannot disagree: the
   * panadapter has its own `rxant` and a display left on the old socket keeps drawing a
   * spectrum of an antenna the receiver is no longer using — with correct axis labels,
   * which is what makes it convincing.
   */
  async setPanadapterAntenna(ant: string): Promise<void> {
    this.appliedRxAnt = ant;
    await this.pan?.setRxAnt(ant);
  }

  /**
   * Move a slice we own to the configured antenna ports.
   *
   * One command, both fields, because each is a round trip and the radio switches
   * relays between them — sending `rxant` and `txant` separately puts a two-antenna
   * station briefly on a mismatched pair.
   *
   * A port the radio does not have is not sent at all: resolveAntenna refuses it and the
   * refusal is recorded for the operator to read. The alternative — falling back to ANT1
   * — is precisely the fault this work exists to remove, and doing it after being told
   * otherwise would be worse than doing it by default.
   */
  private async applyAntennas(client: FlexClient, sliceIndex: number): Promise<void> {
    const ports = client.state.antennas;
    const rx = resolveAntenna(this.opts.antenna.rx, ports.rx, "receive");
    const tx = resolveAntenna(this.opts.antenna.tx, ports.tx, "transmit");

    for (const refused of [rx.refused, tx.refused]) {
      if (!refused) continue;
      console.warn(`[flex/ant] ${refused}`);
      this.antennaWarnings.push(refused);
    }

    const sets: string[] = [];
    if (rx.ant) sets.push(`rxant=${rx.ant}`);
    if (tx.ant) sets.push(`txant=${tx.ant}`);
    if (sets.length === 0) return;

    const r = await client.command(`slice set ${sliceIndex} ${sets.join(" ")}`);
    if (r.status !== 0) {
      const note =
        `The radio refused ${sets.join(" ")} on slice ${sliceIndex} ` +
        `(0x${r.status.toString(16)}) — it is still on whatever port it was.`;
      console.warn(`[flex/ant] ${note}`);
      this.antennaWarnings.push(note);
      return;
    }
    // Remembered for the panadapter, which is started later and carries its own rxant.
    this.appliedRxAnt = rx.ant;
    console.log(`[flex/ant] slice ${sliceIndex} ${sets.join(" ")}`);
  }

  /**
   * Record a noise-blanker or noise-reduction setting we just made.
   *
   * NECESSARY BECAUSE THE RADIO DOES NOT REPORT `nb` AT ALL. Measured against a FLEX-8400
   * on v3.9.18: subscribing with `sub slice all` returns `nb=1 nb_level=50` in the opening
   * dump, and from then on `slice set 0 nb=0` and `slice set 0 nb=1` both answer `0` for
   * success and emit NO slice status whatsoever. The neighbouring `wnb` emits one on every
   * change, and so does `nr`, so this is specific to `nb` rather than a subscription that
   * was never made.
   *
   * The consequence was a button that did nothing — not because the command failed, it
   * worked every time, but because nothing could ever observe that it had. The panel reads
   * the radio's own state by design, and the radio had gone silent on this one field.
   *
   * So this is our own record of a command the radio accepted, and it is deliberately
   * NARROW: only the two fields involved, only after a successful set, and it is
   * overwritten by the subscription dump on the next reconnect — which remains the one
   * authority. `nr` goes through here too, even though the radio does report it, so a
   * button never waits on a round trip it does not need.
   */
  noteNoiseState(which: "nb" | "nr", on: boolean): void {
    if (this.receiverState[which] === on) return;
    this.receiverState = { ...this.receiverState, [which]: on };
    this.emit("receiverControls", { ...this.receiverState });
  }

  constructor(options: DaxSourceOptions) {
    super();
    this.opts = {
      host: options.host,
      port: options.port ?? 4992,
      daxChannel: options.daxChannel ?? 1,
      mode: options.mode ?? "FT8",
      depth: options.depth ?? 2,
      silenceRms: options.silenceRms ?? 1e-5,
      passbandHz: options.passbandHz,
      freqHz: options.freqHz ?? 7_074_000,
      // `rx` falls back to `tx` here, once, so nothing downstream has to remember that
      // one antenna for both is the normal case.
      antenna: {
        tx: options.antenna?.tx ?? null,
        rx: options.antenna?.rx ?? options.antenna?.tx ?? null,
      },
      panadapter: options.panadapter ?? { enabled: false },
      dialHz: options.dialHz,
    };

    // The decode half lives in lib/radio/decode-pipeline.ts, shared with the Icom
    // source. This class keeps what is genuinely Flex: VITA-49 parsing, the meter
    // stream, slice and client management, and the waterfall.
    this.pipeline = new DecodePipeline({
      mode: this.opts.mode,
      inputSampleRate: DAX_SAMPLE_RATE,
      depth: this.opts.depth,
      silenceRms: this.opts.silenceRms,
      maxHz: this.opts.passbandHz,
    });
    // Built from the pipeline's clamped value rather than the raw option, so the
    // waterfall shows exactly the range the decoder searches even when the setting is
    // out of range.
    this.spectrum = new SpectrumAnalyser(DAX_SAMPLE_RATE, this.pipeline.maxHz, this.spectrumProfile);
    this.pipeline.on("decodes", (d) => this.emit("decodes", d));
    this.pipeline.on("window", (w) => this.emit("window", w));
    this.pipeline.on("error", (e) => this.emit("error", e));
  }

  private readonly pipeline: DecodePipeline;
  /** Which spectrum trade is in force. Switched by voice mode; see setSpectrumProfile. */
  private spectrumProfile: SpectrumProfile = "digital";
  private spectrum: SpectrumAnalyser;

  /** Connection internals, exposed for the shared-mode transmitter. */
  get shared(): { client: FlexClient; socket: import("node:dgram").Socket; sliceIndex: number } | null {
    if (!this.client || !this.socket || this.sliceIndex === null) return null;
    return { client: this.client, socket: this.socket, sliceIndex: this.sliceIndex };
  }

  get periodMs(): number {
    if (this.opts.mode === "FT2") return FT2_PERIOD_MS;
    return this.opts.mode === "FT4" ? FT4_PERIOD_MS : FT8_PERIOD_MS;
  }

  get mode(): "FT8" | "FT4" | "FT2" {
    return this.opts.mode;
  }

  /**
   * Switch mode while running — used when the operator retunes from an FT8
   * frequency to an FT4 one.
   *
   * The window length changes with the mode (15 / 7.5 / 2.5 s), so the buffer is
   * discarded: a partly-filled FT8 window is not a valid FT4 window, and feeding
   * it to the FT4 decoder would produce nothing while looking like a fault.
   */
  setMode(mode: "FT8" | "FT4" | "FT2"): boolean {
    if (mode === this.opts.mode) return false;
    this.opts.mode = mode;
    this.pipeline.setMode(mode);
    return true;
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
    this.spectrum = new SpectrumAnalyser(DAX_SAMPLE_RATE, this.pipeline.maxHz, profile);
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
    // Bind the socket before telling the radio about it, or the first packets
    // arrive with nothing listening.
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    this.socket = socket;

    socket.on("message", (buf) => this.onPacket(buf));
    socket.on("error", (err) => this.emit("error", err));

    const udpPort = await new Promise<number>((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(0, "0.0.0.0", () => {
        resolve((socket.address() as { port: number }).port);
      });
    });
    this.udpPort = udpPort;

    const client = new FlexClient(this.opts.host, this.opts.port);
    this.client = client;
    await client.connect();
    this.startLinkMeasurement(client);

    // Register as a GUI client, for the same reason the transmitter does: it is
    // what lets DigiShack stand alone. A GUI client owns slices, so when nothing
    // else is connected to the radio we can create our own and decode from it —
    // no SmartSDR, no AetherSDR required.
    //
    // Count the GUI clients that were here first: it decides below whether an
    // existing slice is an operator's (leave it alone) or the radio's restored
    // default profile (ours to steer).
    const seen = new Set<string>();
    const onClient = (st: { object: string; fields: Record<string, string> }): void => {
      if (st.object.startsWith("client") && st.fields.client_id && st.fields.program) {
        seen.add(st.fields.client_id);
      }
    };
    client.on("status", onClient);
    await client.command("sub client all");
    await new Promise((r) => setTimeout(r, 1_000));
    client.off("status", onClient);
    const otherGuiClients = seen.size;

    await client.command("client gui").catch(() => {});
    await client.command("client station DigiShack").catch(() => {});

    const reg = await client.command(`client udpport ${udpPort}`);
    if (reg.status !== 0) {
      throw new Error(
        `Radio rejected 'client udpport ${udpPort}' (0x${reg.status.toString(16)}) — no audio will arrive`,
      );
    }

    // Make sure a slice exists and feeds our DAX channel. Three cases:
    //   1. An operator's slice already routes this DAX channel — use it untouched.
    //   2. Slices exist but none feeds the channel — attach it to the active/TX
    //      slice. (This is what the SmartSDR DAX panel does when you pick a
    //      channel; it does not retune anything.)
    //   3. No slice at all (bare radio) — create one at the configured frequency
    //      in DIGU. The radio may also restore its default profile slice in
    //      response to our GUI registration; if so, steer that one instead.
    await client.command("sub slice all");
    await new Promise((r) => setTimeout(r, 1_200));
    const slices = [...client.state.slices.values()];
    const routed = slices.find(
      (s) => s.raw.dax === String(this.opts.daxChannel),
    );

    if (!routed) {
      let slice = slices.find((s) => s.tx) ?? slices[0];

      if (!slice) {
        const mhz = (this.opts.freqHz / 1_000_000).toFixed(6);
        // `ant=` on a create is the RECEIVE port; the transmit one is a separate field
        // and is set below with the rest. ANT1 remains the fallback for a radio that has
        // said nothing and an operator who has configured nothing — it is the socket a
        // single-antenna station uses — but it is now a default rather than the only
        // possibility, which is what it used to be.
        const createAnt =
          resolveAntenna(this.opts.antenna.rx, client.state.antennas.rx).ant ?? "ANT1";
        const madeSlice = await client.command(
          `slice create freq=${mhz} ant=${createAnt} mode=DIGU`,
        );
        if (madeSlice.status !== 0) {
          throw new Error(
            `The radio has no slice and one could not be created (0x${madeSlice.status.toString(16)})`,
          );
        }
        this.createdSlice = true;
        await new Promise((r) => setTimeout(r, 1_200));
        slice = [...client.state.slices.values()].find((s) => s.tx)
          ?? [...client.state.slices.values()][0];
        if (!slice) {
          throw new Error("Created a slice but the radio never reported it");
        }
      }

      await client.command(
        `slice set ${slice.index} dax=${this.opts.daxChannel}`,
      ).catch(() => {});
      this.sliceIndex = slice.index;
    } else {
      this.sliceIndex = routed.index;
    }

    // The restored-profile trap: when no other GUI client was here before us, any
    // slice we found — even one already routed to our DAX channel — is the radio's
    // default profile, revived by our own `client gui`. Live consequence of not
    // steering it: the profile slice came back at 14.100 USB with dax=1 left over
    // from testing, and the bridge sat decoding FT8 in empty USB noise. Nobody
    // owns that slice; move it to where the decoder expects to listen.
    if (!this.createdSlice && otherGuiClients === 0 && this.sliceIndex !== null) {
      const mhz = (this.opts.freqHz / 1_000_000).toFixed(6);
      await client.command(`slice tune ${this.sliceIndex} ${mhz}`).catch(() => {});
      const s = client.state.slices.get(this.sliceIndex);
      if (!/^DIG[UL]$/i.test(s?.mode ?? "")) {
        await client.command(`slice set ${this.sliceIndex} mode=DIGU`).catch(() => {});
      }
    }

    // The antenna, on a slice that is ours to steer — one we created, or the restored
    // default profile. The condition is deliberately the SAME one the tune and mode
    // steering above uses: a slice an operator is working on is not ours to move, and
    // moving a working station's antenna out from under them would be the worst thing in
    // this file. Frequency, mode and antenna are one decision about one slice.
    if ((this.createdSlice || otherGuiClients === 0) && this.sliceIndex !== null) {
      await this.applyAntennas(client, this.sliceIndex);
    } else if (hasAntennaChoice(client.state.antennas) && this.opts.antenna.tx) {
      // Configured, but not applied, and the operator is entitled to know which.
      const note =
        `Antenna left as the operator's slice had it: another SmartSDR client owns slice ` +
        `${this.sliceIndex}, so DigiShack did not move it to ${this.opts.antenna.tx}.`;
      console.warn(`[flex/ant] ${note}`);
      this.antennaWarnings.push(note);
    }

    const created = await client.command(
      `stream create type=dax_rx dax_channel=${this.opts.daxChannel}`,
    );
    if (created.status !== 0) {
      throw new Error(
        `Could not create a DAX RX stream on channel ${this.opts.daxChannel} (0x${created.status.toString(16)})`,
      );
    }
    this.streamId = created.message.trim();

    if (this.opts.panadapter.enabled) {
      await this.startPanadapter(client);
    }

    // SEED FROM THE SUBSCRIPTION DUMP, which the handler below is registered too late to
    // see.
    //
    // `sub slice all` happens ~70 lines and a 1.2 second wait earlier, and the radio
    // answers it with ONE enormous status line carrying all 98 slice properties. The
    // client parses and caches that; this handler, registered afterwards, never receives
    // it. Everything the radio re-broadcasts on change recovers by itself, so the gap was
    // invisible — until `nb`, which it never re-broadcasts at all (see setNoiseState).
    // Reading the cache directly is what makes the panel correct at startup rather than
    // only after the operator happens to change something.
    const seed = [...client.state.slices.values()].find(
      (s) => this.sliceIndex === null || s.index === this.sliceIndex,
    );
    if (seed) {
      this.receiverState = {
        agc: seed.raw.agc_mode ?? null,
        nb: seed.raw.nb !== undefined ? seed.raw.nb === "1" : null,
        nr: seed.raw.nr !== undefined ? seed.raw.nr === "1" : null,
        filterLo: seed.filterLo ?? null,
        filterHi: seed.filterHi ?? null,
        // Which port the radio is ACTUALLY on, and which ones it has. Reported rather
        // than assumed, for the same reason as everything else in this shape: DigiShack
        // spent a year certain the answer was ANT1 because it had written ANT1 itself.
        rxAnt: seed.rxAnt,
        txAnt: seed.txAnt,
        antennas: client.state.antennas,
      };
      this.emit("receiverControls", { ...this.receiverState });
    }

    // Receiver controls, straight off the slice status. Emitted only on a change,
    // because a slice status arrives for every field the radio touches and the panel
    // does not need re-rendering when the audio pan moves.
    client.on("slice", (slice) => {
      if (this.sliceIndex !== null && slice.index !== this.sliceIndex) return;
      const next: ReceiverControls = {
        // SmartSDR spells it `med`; the Icom's command set calls the same thing `mid`.
        // Left as the radio says it — the picker offers this radio's own vocabulary.
        agc: slice.raw.agc_mode ?? this.receiverState.agc,
        nb: slice.raw.nb !== undefined ? slice.raw.nb === "1" : this.receiverState.nb,
        nr: slice.raw.nr !== undefined ? slice.raw.nr === "1" : this.receiverState.nr,
        // The passband, which the client has parsed off every slice status since it was
        // written and which nothing has ever forwarded. Taken from the parsed slice
        // rather than `raw`, because that is where the carry-forward for an omitted
        // field already lives — a status that mentions only the AGC must not blank the
        // filter the operator can see on the radio's own screen.
        filterLo: slice.filterLo ?? this.receiverState.filterLo ?? null,
        filterHi: slice.filterHi ?? this.receiverState.filterHi ?? null,
        // Same carry-forward as the filter, and for the same reason: the radio broadcasts
        // `rxant`/`txant` on a change and mentions them in no other status line, so
        // reading them off `raw` unconditionally would blank the panel on the next
        // `mode=` update.
        rxAnt: slice.rxAnt ?? this.receiverState.rxAnt ?? null,
        txAnt: slice.txAnt ?? this.receiverState.txAnt ?? null,
        antennas: client.state.antennas,
      };
      if (
        next.agc === this.receiverState.agc &&
        next.nb === this.receiverState.nb &&
        next.nr === this.receiverState.nr &&
        next.filterLo === this.receiverState.filterLo &&
        next.filterHi === this.receiverState.filterHi &&
        next.rxAnt === this.receiverState.rxAnt &&
        next.txAnt === this.receiverState.txAnt &&
        // The port LIST changes once, when the radio first mentions it, and a panel with
        // no antenna picker until the operator happens to touch something is the same
        // class of fault as an AGC control that could only remember its own clicks.
        next.antennas?.rx.length === this.receiverState.antennas?.rx.length &&
        next.antennas?.tx.length === this.receiverState.antennas?.tx.length
      ) {
        return;
      }
      this.receiverState = next;
      this.emit("receiverControls", { ...next });
    });

    // Audio liveness, checked here rather than only in the service.
    //
    // The bridge's watchdog notices the same silence and responds by killing the process.
    // This gets a chance first, because a rebuilt stream costs a couple of commands and a
    // restart costs ~25 s off air and whatever contact was in progress.
    this.lastAudioAt = Date.now();
    this.audioRecoverTimer = setInterval(() => {
      if (!this.lastAudioAt) return;
      if (Date.now() - this.lastAudioAt < AUDIO_REBUILD_AFTER_MS) return;
      void this.rebuildStreams();
    }, 5_000);
    this.audioRecoverTimer.unref?.();

    this.emit("connected", {
      streamId: this.streamId,
      udpPort,
      daxChannel: this.opts.daxChannel,
    });

    this.pipeline.start();

    // The waterfall updates independently of the decode windows: four rows a
    // second regardless of whether a 15s or 7.5s window is in progress.
    this.spectrumTimer = setInterval(() => {
      const row = this.spectrum.compute();
      if (row) this.emit("spectrum", row);
    }, spectrumIntervalFor(this.spectrumProfile));

    // S-meter: the slice LEVEL meter only exists while a slice does, so keep
    // checking — a slice created after we start (SmartSDR opening, DigiShack's
    // own transmitter) should get a meter without a restart.
    void this.subscribeSmeter(client);
    this.smeterTimer = setInterval(() => {
      if (this.client) void this.subscribeSmeter(this.client);
    }, 15_000);
  }

  /**
   * Bring up the RF panadapter on the client and slice we already have.
   *
   * Shares the FlexClient and the UDP socket rather than opening its own, because the
   * radio sends panadapter data to the one port a client registers with
   * `client udpport` — there is no second port to have — and because a second GUI
   * client would consume one of the radio's two panadapter objects for nothing.
   */
  private async startPanadapter(client: FlexClient): Promise<void> {
    client.on("status", (s) => {
      if (s.object === "display pan" && s.id) {
        this.panStatuses.set(s.id, { ...(this.panStatuses.get(s.id) ?? {}), ...s.fields });
      }
    });
    await client.command("sub pan all").catch(() => {});
    // The restored panadapter is reported shortly after `client gui`, which has
    // already happened by now; this waits for the status lines rather than for the
    // object, which already exists.
    await new Promise((r) => setTimeout(r, 1_200));

    const pan = new FlexPanadapter(client, {
      bins: this.opts.panadapter.bins,
      fps: this.opts.panadapter.fps,
      spanHz: this.opts.panadapter.spanHz,
      average: this.opts.panadapter.average,
      // The port the SLICE was actually moved to, not the port that was configured: if
      // the radio refused the antenna the display must keep showing what the receiver is
      // really hearing. A panadapter on a different antenna from the receiver is a lie
      // told with correct axis labels.
      rxAnt: this.appliedRxAnt,
    });
    pan.on("error", (e) => this.emit("error", e));

    // A bin is a y pixel index over the panadapter's dBm window; the scaler wants dB.
    this.panScaler = new PanadapterScaler(
      (raw) => PAN_MIN_DBM + (raw / PAN_Y_PIXELS) * (PAN_MAX_DBM - PAN_MIN_DBM),
    );

    pan.on("frame", (f) => {
      this.lastPanFrameAt = Date.now();
      const row = this.panScaler?.row(f.bins, f.centerHz, f.spanHz, f.at);
      if (row) this.emit("panadapter", row);
    });

    const centerHz =
      (this.sliceIndex !== null ? client.state.slices.get(this.sliceIndex)?.freqHz : null) ??
      this.opts.freqHz;

    try {
      await pan.start(centerHz, this.panStatuses);
      this.pan = pan;
    } catch (err) {
      // A panadapter that will not start must not take the decoder down with it —
      // FT8 does not need it, and a radio with both panadapters already in use is a
      // perfectly workable radio.
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
      return;
    }

    // Follow the dial. Without this the panadapter stays where it started while the
    // operator band-hops, which is worse than showing nothing: it is a display
    // confidently showing the wrong band with correct-looking axis labels.
    client.on("slice", (slice) => {
      if (slice.index !== this.sliceIndex) return;
      this.reconcilePanCentre();
    });

    // ...and CHECK, not just react.
    //
    // The listener above is edge-triggered: it only ever runs when the radio sends a
    // slice status. That is one dropped or coalesced status away from a display parked
    // on the wrong band indefinitely, and it was caught doing exactly that — the slice
    // read 7.200 MHz LSB while the panadapter reported 7.074 and drew a confident
    // 7.024-7.124 ruler under it. Reported as "top waterfall doesn't update when freq
    // changes", which is precisely what it looks like from the outside.
    //
    // So the same reconciliation also runs on a timer. Comparing two numbers a few
    // times a second costs nothing, and unlike the listener it cannot miss an edge:
    // however the panadapter and the dial got out of step, the next tick fixes it.
    this.panFollowTimer = setInterval(() => {
      this.reconcilePanCentre();
      this.nudgeStalledPan();
    }, 2_000);
    this.panFollowTimer.unref?.();
  }

  /**
   * Put the panadapter where the dial is, if it is not there already.
   *
   * Level-triggered: safe to call as often as you like. Both the slice listener and
   * the follow timer come through here so there is one definition of "out of view".
   */
  /**
   * Where the radio is tuned, best available answer.
   *
   * The supplier first, because this connection's own slice cache is stale for every
   * tune it issued itself — see the note on `dialHz` in the options. The local cache is
   * the fallback for callers that provide no supplier, and it is still right in the one
   * case that matters to them: the frequency at connect.
   */
  private currentDialHz(): number | null {
    const supplied = this.opts.dialHz?.();
    if (supplied !== null && supplied !== undefined && supplied > 0) return supplied;
    if (this.sliceIndex === null) return null;
    return this.client?.state.slices.get(this.sliceIndex)?.freqHz ?? null;
  }

  private reconcilePanCentre(): void {
    const settings = this.pan?.settings;
    const dialHz = this.currentDialHz();
    if (!settings || dialHz === null) return;

    if (!panNeedsRecentre(settings.centerHz, settings.spanHz, dialHz)) return;
    console.log(`[flex] panadapter following the dial to ${(dialHz / 1e6).toFixed(6)} MHz`);
    void this.pan?.tune(dialHz);
  }

  /**
   * Re-issue the panadapter settings if frames have stopped arriving.
   *
   * The radio restarts its sweep when the centre changes, and that restart has been
   * seen not to come back — frames simply stop while the object still exists, so
   * nothing errors and nothing reconnects. `display pan set` is idempotent and cheap,
   * which makes re-sending it the whole recovery: no teardown, no new panadapter
   * object, no risk of losing the radio's second one to a leak.
   */
  private nudgeStalledPan(): void {
    const settings = this.pan?.settings;
    if (!settings || this.lastPanFrameAt === 0) return;
    const silentMs = Date.now() - this.lastPanFrameAt;
    if (silentMs < PAN_STALL_MS) return;
    // Count from now, so a nudge that does not help waits another full interval
    // instead of firing every two seconds forever.
    this.lastPanFrameAt = Date.now();
    console.warn(
      `[flex] no panadapter frame for ${(silentMs / 1000).toFixed(0)}s — re-sending settings`,
    );
    void this.pan?.tune(settings.centerHz);
  }

  /**
   * Change the span without restarting anything. Returns the span actually applied,
   * which may be clamped to what the radio supports.
   */
  async setPanSpan(spanHz: number): Promise<number | null> {
    const s = this.pan?.settings;
    if (!this.pan || !s) return null;
    // Re-centre on the dial at the same time. Zooming out around a stale centre is how
    // you end up with the dial cursor off the edge of a wider view.
    await this.pan.tune(this.currentDialHz() ?? s.centerHz, spanHz);
    return this.pan.settings.spanHz;
  }

  /** What the panadapter is currently set to, or null when it is not running. */
  get panadapterSettings(): { centerHz: number; spanHz: number; bins: number; fps: number } | null {
    return this.pan?.settings ?? null;
  }

  /**
   * Measure the round trip to the radio, now and then every 15 seconds.
   *
   * `version` is the probe: read-only, answered from the radio's own state, and already
   * sent once at connect. Any reply measures the same TCP path the key command travels
   * and that the VITA-49 audio shares, which is the path the compensation is for. The
   * minimum-of-recent estimator in LinkLatency absorbs the odd slow reply, so one probe
   * caught behind a burst of status traffic does not move the timing.
   */
  private startLinkMeasurement(client: FlexClient): void {
    const probe = async (): Promise<void> => {
      const t0 = Date.now();
      try {
        await client.command("version", 5_000);
      } catch {
        return; // a dead connection is the supervisor's problem, not a latency sample
      }
      this.link.sample(Date.now() - t0);
      const oneWay = this.link.oneWayMs();
      this.pipeline.setLinkLatencyMs(oneWay);
      // Say it when it changes by more than jitter, and once at first measurement —
      // silence would leave "why is my dt suddenly centred" without its explanation.
      if (Math.abs(oneWay - this.linkLoggedMs) >= 20 || this.linkLoggedMs === -1) {
        this.linkLoggedMs = oneWay;
        const rtt = this.link.rttMs() ?? 0;
        console.log(
          oneWay > 0
            ? `[flex] radio link: ${rtt} ms round trip — keying ${oneWay} ms early and holding decode windows ${oneWay} ms open`
            : `[flex] radio link: ${rtt} ms round trip — close enough that no compensation is applied`,
        );
      }
    };
    void probe();
    this.linkTimer = setInterval(() => void probe(), 15_000);
    this.linkTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.pipeline.stop();
    if (this.linkTimer) clearInterval(this.linkTimer);
    this.linkTimer = null;
    this.link.reset();
    this.linkLoggedMs = -1;
    if (this.panFollowTimer) clearInterval(this.panFollowTimer);
    this.panFollowTimer = null;
    await this.pan?.stop().catch(() => {});
    this.pan = null;
    this.panScaler = null;
    this.lastPanFrameAt = 0;
    this.panStatuses.clear();
    if (this.spectrumTimer) clearInterval(this.spectrumTimer);
    this.spectrumTimer = null;
    if (this.audioRecoverTimer) clearInterval(this.audioRecoverTimer);
    this.audioRecoverTimer = null;
    if (this.smeterTimer) clearInterval(this.smeterTimer);
    this.smeterTimer = null;

    if (this.client && this.streamId) {
      // The 0x prefix is required; without it the radio answers 0x50000059 and
      // the stream is left running on the radio.
      await this.client.command(`stream remove 0x${this.streamId}`).catch(() => {});
    }
    this.streamId = null;

    // Only remove a slice we created ourselves.
    if (this.client && this.createdSlice && this.sliceIndex !== null) {
      await this.client.command(`slice remove ${this.sliceIndex}`).catch(() => {});
      this.createdSlice = false;
    }
    this.sliceIndex = null;

    this.client?.disconnect();
    this.client = null;

    try {
      this.socket?.close();
    } catch {
      /* already closed */
    }
    this.socket = null;
  }

  private onPacket(buf: Buffer): void {
    if (buf.length <= VITA_HEADER_BYTES) return;

    // Dispatch on the VITA packet class. Once meters are subscribed, meter packets
    // (class 0x8002) arrive on this same socket — parsing those as float32 audio
    // would inject garbage samples straight into the decode buffer.
    const packetClass = buf.readUInt16BE(14);

    if (packetClass === METER_PACKET_CLASS) {
      this.onMeterPacket(buf);
      return;
    }
    if (packetClass === PAN_PACKET_CLASS) {
      this.pan?.onPacket(buf);
      return;
    }
    // The radio renders its own waterfall and sends it whether or not anybody asked —
    // about 86 kB/s of it. We draw our own from the FFT frames, so it is dropped here
    // rather than parsed. Named rather than falling through the default, because an
    // unexplained 86 kB/s on this socket is exactly the kind of thing that gets
    // investigated twice.
    if (packetClass === WATERFALL_PACKET_CLASS) return;
    if (packetClass !== AUDIO_PACKET_CLASS) return;
    this.lastAudioAt = Date.now();

    // Interleaved stereo float32 BE; L and R are identical on a receive slice.
    //
    // The decode buffer and the waterfall diverge here: the pipeline drops the
    // guard-time tail of a window it has already taken, but the display has no
    // windows and wants every sample. Hence the ring is fed unconditionally while
    // the pipeline decides for itself what to keep.
    const forDecode: number[] = [];
    for (let off = VITA_HEADER_BYTES; off + 8 <= buf.length; off += 8) {
      const sample = buf.readFloatBE(off);
      forDecode.push(sample);

    }
    // Both halves get every sample, but they want different things: the pipeline drops
    // the guard-time tail of a window it has already taken, while the display has no
    // windows and a gap in it reads as a dead receiver.
    this.pipeline.push(forDecode);
    this.spectrum.push(forDecode);
    // And a third consumer, which wants the samples untouched: anyone listening to the
    // receiver. Emitted rather than pushed anywhere, so nothing is allocated or converted
    // when nobody is listening — this runs for every VITA-49 packet the radio sends.
    // Copied into a typed array here rather than earlier: the decode and spectrum paths
    // both take the plain array, and converting for them too would allocate on every packet
    // for no reason. This one only runs when somebody is listening.
    if (this.listenerCount("audio") > 0) {
      this.emit("audio", { samples: Float32Array.from(forDecode), at: Date.now() });
    }
  }

  /** Meter id of the slice signal-strength meter (`src=SLC`, `nam=LEVEL`). */
  private levelMeterId: number | null = null;
  /** Meter id of RF forward power (`src=TX-`, `nam=FWDPWR`). */
  private fwdMeterId: number | null = null;
  /** Health meters: name -> id, populated from `meter list`. */
  private healthMeters = new Map<string, number>();
  private telemetry: Telemetry = {
    paTempC: null,
    swr: null,
    voltsPa: null,
    fanRpm: null,
    reflectedDbm: null,
    at: 0,
  };
  private lastTelemetryEmit = 0;
  private lastSmeterAt = 0;
  private lastFwdDbm: number | null = null;
  private lastFwdAt = 0;

  /**
   * Meter payload: repeating pairs of uint16 meter id + int16 raw value.
   * dBm-unit meters are scaled by 128 (verified live: WSJT-X at 85 % power read
   * FWDPWR 6342 = 49.5 dBm ≈ 89 W).
   */
  private healthNameFor(id: number): string | null {
    for (const [name, mid] of this.healthMeters) if (mid === id) return name;
    return null;
  }

  private onMeterPacket(buf: Buffer): void {
    if (this.levelMeterId === null && this.fwdMeterId === null) return;
    const now = Date.now();
    for (let off = VITA_HEADER_BYTES; off + 4 <= buf.length; off += 4) {
      const id = buf.readUInt16BE(off);
      if (id === this.fwdMeterId) {
        this.lastFwdDbm = buf.readInt16BE(off + 2) / 128;
        this.lastFwdAt = now;
        continue;
      }
      const health = this.healthNameFor(id);
      if (health) {
        // Meter scaling is per unit: dBm and SWR are x128, temperature and
        // volts x64, RPM raw. Taken from the radio's own meter definitions.
        const raw = buf.readInt16BE(off + 2);
        if (health === "PATEMP") this.telemetry.paTempC = raw / 64;
        else if (health === "SWR") this.telemetry.swr = raw / 128;
        else if (health === "+13.8A") this.telemetry.voltsPa = raw / 256;
        else if (health === "MAINFAN") this.telemetry.fanRpm = raw;
        else if (health === "REFPWR") this.telemetry.reflectedDbm = raw / 128;
        this.telemetry.at = now;
        if (now - this.lastTelemetryEmit > 1_000) {
          this.lastTelemetryEmit = now;
          this.emit("telemetry", { ...this.telemetry });
        }
        continue;
      }
      if (id !== this.levelMeterId) continue;
      // The radio sends this at 10 fps; a UI S-meter needs 4.
      if (now - this.lastSmeterAt < 250) continue;
      this.lastSmeterAt = now;
      this.emit("smeter", {
        dbm: buf.readInt16BE(off + 2) / 128,
        // Forward power is only meaningful while it is fresh — during TX. Stale
        // values (radio back on receive) go out as null so the UI reverts.
        fwdDbm: now - this.lastFwdAt < 1_000 ? this.lastFwdDbm : null,
        at: now,
      });
    }
  }

  /**
   * Find the slice LEVEL meter and subscribe to it.
   *
   * Slice meters only exist while a slice does, so this re-runs whenever the
   * radio's slice inventory changes rather than only at startup.
   */
  private async subscribeSmeter(client: FlexClient): Promise<void> {
    const ml = await client.command("meter list");
    if (ml.status !== 0) return;

    // Health meters: PA temperature, SWR, supply voltage, fan, reflected power.
    // Definitions look like `#10.src=TX-#10.num=4#10.nam=PATEMP#10.low=0.0#…`,
    // so the id is whatever precedes `.nam=<name>`. Meter names can contain `+`
    // and `.` (the supply rails are named "+13.8A"), which must be escaped
    // before going into a pattern.
    for (const name of ["PATEMP", "SWR", "+13.8A", "MAINFAN", "REFPWR"]) {
      const esc = name.replace(/[+.]/g, (ch) => "\\" + ch);
      const m = new RegExp("(\\d+)\\.nam=" + esc + "(?:#|$)").exec(ml.message);
      if (m) this.healthMeters.set(name, Number(m[1]));
    }

    // The TX forward-power meter, for the outgoing side of the display.
    const fwd = /(\d+)\.src=TX-#\1\.num=\d+#\1\.nam=FWDPWR/.exec(ml.message);
    if (fwd) this.fwdMeterId = Number(fwd[1]);

    // Format: #<id>.src=SLC#<id>.num=<slice>#<id>.nam=LEVEL#…
    let levelId: number | null = null;
    let levelSlice = Number.POSITIVE_INFINITY;
    const re = /(\d+)\.src=SLC#\1\.num=(\d+)#\1\.nam=LEVEL/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(ml.message)) !== null) {
      const slice = Number(m[2]);
      // Lowest slice index wins — that is the slice the digital path decodes.
      if (slice < levelSlice) {
        levelSlice = slice;
        levelId = Number(m[1]);
      }
    }

    if (levelId !== null && levelId !== this.levelMeterId) {
      this.levelMeterId = levelId;
      await client.command("sub meter all").catch(() => {});
    }
  }






}

// Re-exported from lib/radio/decode-pipeline.ts, which owns them now. Kept here so
// existing importers do not have to move, and because "the decimation the Flex path
// uses" is a reasonable thing to want from this module.
export { decimateBy2, decimateTo12k, normalise } from "@/lib/radio/decode-pipeline";
