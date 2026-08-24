// The FlexRadio panadapter: RF spectrum, as opposed to the 3 kHz of demodulated
// audio the FT8 waterfall shows.
//
// Everything in this file was measured against a FLEX-6400 on SmartSDR 4.2.18 with
// scripts/probe-flex-pan.ts, not taken from documentation. The measurements, and the
// two that would have been got wrong by assuming:
//
//   * FFT frames arrive under VITA packet class 0x8003 on the SAME UDP socket DAX
//     audio uses — the one registered with `client udpport`. 0x8004 is the radio's
//     own waterfall rendering, which arrives whether or not anybody wants it.
//   * The VITA stream id (header offset 4) is the panadapter's object id, so two
//     panadapters are told apart by it and nothing else.
//   * Payload: uint16 start_bin, uint16 num_bins, uint16 bin_size, uint16
//     total_bins_in_frame, uint32 frame_index, then num_bins big-endian uint16, then
//     FOUR TRAILING ZERO BYTES. The tail is not a bin. Reading it as one puts a
//     -infinity notch at the end of every packet, which on a waterfall is a black
//     stripe down the display that looks like a hardware fault.
//   * A frame is split across packets — 4096 bins arrives as 7 — and must be
//     reassembled on frame_index before it means anything.
//
// The two that matter most, because both are silent:
//
//   * `client gui` ALONE CREATES A PANADAPTER. The radio restores the client's
//     profile, which contains one. Creating another is not merely wasteful: a
//     FLEX-6400 has two, and a run that exits without cleaning up leaves the next
//     one answering 0x50000009 to every create. So this adopts the restored object
//     rather than making its own.
//   * `display pan set` APPLIES BUT IS NEVER REFLECTED IN STATUS. The radio accepts
//     xpixels, ypixels, fps, min_dbm, max_dbm and center, answers 0x0, changes its
//     behaviour accordingly — and goes on reporting the object's creation-time
//     values in every status line forever. Reading settings back is therefore
//     meaningless, and the first sweep that did so concluded "the radio will not go
//     above 50 bins" while it was delivering 1024. What we asked for is the only
//     record of what the radio is doing, so this class keeps it.

import { EventEmitter } from "node:events";
import type { FlexClient } from "@/lib/flex/client";

/** Measured: FFT frames. */
export const PAN_PACKET_CLASS = 0x8003;
/** Measured: the radio's own waterfall rendering. Ignored — we draw our own. */
export const WATERFALL_PACKET_CLASS = 0x8004;

const VITA_HEADER_BYTES = 28;
/** start_bin, num_bins, bin_size, total_bins (uint16 each) then frame_index (uint32). */
const FFT_HEADER_BYTES = 12;
/** Measured: every payload ends with four zero bytes that are not bins. */
const FFT_TRAILER_BYTES = 4;

/**
 * Highest bin count the radio will actually produce.
 *
 * Measured, not documented: asking for 8192 returns 4096, silently. Requesting more
 * than this is not an error anywhere — it just quietly gives you less than you think
 * you have, which is precisely how the FT8 analyser ran at half resolution on a
 * 48 kHz radio for as long as it did.
 */
export const PAN_MAX_BINS = 4096;

/**
 * Vertical quantisation, and the single most consequential number here.
 *
 * A bin's value is NOT a dBm code — it is a Y PIXEL INDEX between 0 and `ypixels`,
 * linear in dB across the panadapter's own `min_dbm`..`max_dbm` window. That was
 * established by sweeping ypixels and watching the implied noise floor stay put at
 * -66.3 dBm across 100, 256, 1024, 4096 and 16384, which only happens if the map is
 * linear and the divisor is ypixels.
 *
 * The radio's default is **20**, which over a 120 dB window is **6 dB per step**. A
 * waterfall drawn from that has six usable colours and looks like a fault. Nothing
 * reports it, because 20 is a perfectly valid number of pixels for the display the
 * radio thinks it is feeding.
 *
 * 4096 gives 0.03 dB per step, far finer than the byte the row is sent as. Not
 * higher: 65535 returns values inconsistent with every other setting and 65536
 * returns all zeros, so the safe range has an upper end and this sits well inside it.
 */
export const PAN_Y_PIXELS = 4096;

/**
 * The dBm window the radio maps onto those pixels.
 *
 * Deliberately wider than any real signal range. The floor and ceiling actually
 * drawn are tracked from the data, exactly as the audio waterfall does it, so this
 * only has to be wide enough never to clip — a window that clips is a signal the
 * display cannot show however the colours are scaled.
 *
 * NOT CALIBRATED. The implied noise floor sits about 12 dB hotter than the slice
 * S-meter suggests it should, and with `rfgain`/`pre` moving underneath it that has
 * not been chased down. Every consumer of this treats the numbers as relative, and
 * nothing should print them as an absolute measurement until somebody does.
 */
export const PAN_MIN_DBM = -140;
export const PAN_MAX_DBM = -20;

/** Measured span limits: `min_bw=0.004920 max_bw=7.372800` MHz. */
/**
 * How long a running panadapter may go without a frame before its settings are
 * re-sent. Generous next to the 10 fps default: a band change legitimately pauses the
 * sweep, and a nudge during that pause would restart it again.
 */
export const PAN_STALL_MS = 15_000;

/**
 * How long the receiver may send NO AUDIO AT ALL before the bridge restarts itself.
 *
 * A separate and much blunter condition from the panadapter stall above. That one nudges
 * the settings and hopes; this one gives up, because the failure it exists for is not a
 * panadapter that needs re-tuning but a radio that has stopped sending anything while its
 * control connection stays up and answers status queries normally.
 *
 * Observed on 10 August 2026: DAX audio and panadapter frames both stopped, the TCP link
 * stayed healthy, the decode pipeline went on producing empty windows on its own timer,
 * and the liveness watchdog — which beats on those windows — never noticed. Four minutes
 * of a dead receiver with nothing in the log but the panadapter nudging itself every 16
 * seconds. A restart re-created the DAX stream and everything came back.
 *
 * 90 seconds is chosen to sit well clear of the legitimate silences: DAX RX audio stops
 * while the radio transmits and an FT8 over is about thirteen seconds, and a band change
 * or slice retune pauses it briefly. Anything approaching a minute and a half is not a
 * pause.
 */
export const AUDIO_STALL_MS = 90_000;

/**
 * Should the panadapter be re-centred on the dial?
 *
 * A pure function so the rule has one definition and can be asserted on. Both the
 * slice listener and the follow timer in dax.ts route through it.
 *
 * The threshold is a tenth of the span. Tuning around inside the displayed window
 * leaves the picture stable and lets the dial cursor do the moving — retuning on every
 * slice status is the "waterfall randomly refreshes" failure — while a band change,
 * which is always further than that, moves the view.
 */
export function panNeedsRecentre(centerHz: number, spanHz: number, dialHz: number): boolean {
  return Math.abs(dialHz - centerHz) >= spanHz / 10;
}

export const PAN_MIN_SPAN_HZ = 4_920;
export const PAN_MAX_SPAN_HZ = 7_372_800;

/** One packet off the wire, before reassembly. */
export interface PanPacket {
  /** The panadapter object id this belongs to. */
  streamId: number;
  startBin: number;
  numBins: number;
  totalBins: number;
  frameIndex: number;
  /** Y pixel indices, `numBins` of them. */
  bins: Uint16Array;
}

/**
 * One reassembled FFT frame.
 *
 * `centerHz` and `spanHz` come from what the driver last ASKED the radio for, not
 * from the frame — the payload carries no frequency at all and the status line does
 * not report the setting. See the note at the top of this file.
 */
export interface PanFrame {
  centerHz: number;
  spanHz: number;
  /** Y pixel indices, `0..yPixels`, low frequency first. */
  bins: Uint16Array;
  yPixels: number;
  minDbm: number;
  maxDbm: number;
  frameIndex: number;
  at: number;
}

/**
 * Parse one VITA-49 datagram as a panadapter packet, or null if it is not one.
 *
 * Rejects rather than guesses. A packet whose declared bin count does not match its
 * length is a truncated datagram or a firmware whose layout has moved, and both are
 * better reported as nothing than drawn as spectrum.
 */
export function parsePanPacket(buf: Buffer): PanPacket | null {
  if (buf.length <= VITA_HEADER_BYTES) return null;
  if (buf.readUInt16BE(14) !== PAN_PACKET_CLASS) return null;

  const streamId = buf.readUInt32BE(4);
  const p = buf.subarray(VITA_HEADER_BYTES);
  if (p.length < FFT_HEADER_BYTES) return null;

  const startBin = p.readUInt16BE(0);
  const numBins = p.readUInt16BE(2);
  const binSize = p.readUInt16BE(4);
  const totalBins = p.readUInt16BE(6);
  const frameIndex = p.readUInt32BE(8);

  // bin_size is bytes per bin and has been 2 on every frame seen. Anything else is a
  // format this parser does not know, and quietly reading it as uint16 would produce
  // a spectrum that is wrong in a way nothing downstream can detect.
  if (binSize !== 2) return null;
  if (numBins === 0 || totalBins === 0 || startBin + numBins > totalBins) return null;

  const need = FFT_HEADER_BYTES + numBins * 2;
  // The four trailing bytes are tolerated but not required, so a firmware that drops
  // them still parses. More than four means the layout has changed.
  if (p.length < need || p.length > need + FFT_TRAILER_BYTES) return null;

  const bins = new Uint16Array(numBins);
  for (let i = 0; i < numBins; i++) bins[i] = p.readUInt16BE(FFT_HEADER_BYTES + i * 2);

  return { streamId, startBin, numBins, totalBins, frameIndex, bins };
}

/**
 * Reassemble packets into whole frames.
 *
 * A frame is only released once every bin has arrived. A partial frame drawn as if it
 * were whole is a row that is half spectrum and half whatever the buffer held, and on
 * a scrolling waterfall that reads as interference rather than as packet loss — so
 * incomplete frames are counted and dropped, and the count is the instrument that
 * says which it is.
 */
export class PanFrameAssembler {
  private frameIndex: number | null = null;
  private bins: Uint16Array | null = null;
  private filled = 0;
  private seen: Uint8Array | null = null;

  /** Frames abandoned because the next one started before they were complete. */
  incomplete = 0;
  /** Frames released whole. */
  completed = 0;

  /**
   * Feed one packet. Returns the finished frame's bins, or null.
   *
   * Only one frame is held at a time: the radio finishes each before starting the
   * next, so a packet for a new frame_index is proof the previous one will never
   * complete. Buffering several would only delay noticing loss.
   */
  push(pkt: PanPacket): Uint16Array | null {
    if (pkt.frameIndex !== this.frameIndex) {
      if (this.frameIndex !== null && this.filled > 0) this.incomplete++;
      this.frameIndex = pkt.frameIndex;
      this.bins = new Uint16Array(pkt.totalBins);
      this.seen = new Uint8Array(pkt.totalBins);
      this.filled = 0;
    }

    const bins = this.bins!;
    const seen = this.seen!;
    if (pkt.startBin + pkt.numBins > bins.length) return null;

    for (let i = 0; i < pkt.numBins; i++) {
      const at = pkt.startBin + i;
      // A retransmitted or duplicated packet must not be counted twice, or the frame
      // "completes" with a hole still in it.
      if (seen[at] === 0) {
        seen[at] = 1;
        this.filled++;
      }
      bins[at] = pkt.bins[i]!;
    }

    if (this.filled < bins.length) return null;

    this.completed++;
    this.frameIndex = null;
    this.bins = null;
    this.seen = null;
    return bins;
  }
}

export interface FlexPanadapterOptions {
  /** Bins across the span. Clamped to `PAN_MAX_BINS`. */
  bins?: number;
  /** Frames a second. The radio honoured 100; the cost is bandwidth. */
  fps?: number;
  /** Span in Hz. Clamped between `PAN_MIN_SPAN_HZ` and `PAN_MAX_SPAN_HZ`. */
  spanHz?: number;
  /** Radio-side frame averaging, 0-100. See `PAN_AVERAGE`. */
  average?: number;
}

/**
 * How much the radio averages successive FFT frames before sending them.
 *
 * This was hardcoded to 0 — averaging OFF — and the reason recorded for it in
 * docs/panadapter.md was that "a narrow carrier must stay visible rather than being
 * averaged away". That reason is sound and it is about a DIFFERENT AXIS. There are two
 * kinds of averaging available to a spectrum display:
 *
 *   * ACROSS BINS, in frequency. This genuinely smears a narrow carrier into its
 *     neighbours, which is why the display takes the strongest bin per pixel rather
 *     than the mean, and why more bins than screen pixels is not waste.
 *   * ACROSS FRAMES, in time. This does NOT touch a steady carrier — a signal present
 *     in every frame averages to itself — and reduces only the variance of the noise,
 *     which is random frame to frame.
 *
 * `average` is the second kind, and turning it off cost the display dearly. An
 * unaveraged bin's noise power is exponentially distributed, spreading 12.65 dB from
 * p25 to p99.5; averaging four frames narrows that to 6.35 dB. The panadapter scaler
 * sizes its colour ramp from exactly that measured width (see NOISE_REACH in
 * lib/radio/panadapter.ts), so a narrower noise distribution is spent directly on
 * signal contrast. It is the difference between a correct but grainy display and the
 * near-black waterfall with distinct carriers that every other SDR client shows.
 *
 * NOT VERIFIED AGAINST THE RADIO. SmartSDR presents this as a 0-100 control and it is
 * sent here in those units, but `display pan set` is one of the commands documented
 * above as applying without ever being reflected in status, so the radio cannot be
 * asked what it did with the number. It is a setting rather than a constant for that
 * reason — `flex.panadapterAverage`, defaulting to a deliberately modest value — and
 * the scaler is correct at any of them, including 0.
 */
export const PAN_AVERAGE_DEFAULT = 20;

type Events = {
  frame: [PanFrame];
  error: [Error];
};

/**
 * Drives one panadapter object and turns its packets into frames.
 *
 * Does NOT own a socket or a client. Both are the DAX source's, because the radio
 * sends panadapter data to the one UDP port a client registers — there is no second
 * port to have — and because a second GUI client would consume one of the radio's
 * two panadapters for nothing.
 */
export class FlexPanadapter extends EventEmitter<Events> {
  private panId: string | null = null;
  private streamId = -1;
  private createdIt = false;
  private readonly assembler = new PanFrameAssembler();

  /**
   * What we last asked the radio for.
   *
   * This is the only record that exists. The radio applies these and then reports
   * the object's creation-time values forever, so asking it is worse than useless —
   * it answers confidently and wrongly.
   */
  private requested: {
    centerHz: number;
    spanHz: number;
    bins: number;
    fps: number;
    average: number;
  };

  constructor(
    private readonly client: FlexClient,
    options: FlexPanadapterOptions = {},
  ) {
    super();
    this.requested = {
      centerHz: 0,
      spanHz: clamp(options.spanHz ?? 200_000, PAN_MIN_SPAN_HZ, PAN_MAX_SPAN_HZ),
      bins: Math.min(options.bins ?? 2048, PAN_MAX_BINS),
      fps: Math.max(1, Math.min(options.fps ?? 15, 100)),
      // Clamped rather than trusted: this reaches the radio inside a command whose
      // status never reflects what was applied, so an out-of-range value would be
      // accepted silently and never traceable back to the setting that produced it.
      average: clamp(options.average ?? PAN_AVERAGE_DEFAULT, 0, 100),
    };
  }

  get objectId(): string | null {
    return this.panId;
  }

  get settings(): {
    centerHz: number;
    spanHz: number;
    bins: number;
    fps: number;
    average: number;
  } {
    return { ...this.requested };
  }

  /** Frames released whole, and frames abandoned with bins missing. */
  get frameCounts(): { completed: number; incomplete: number } {
    return { completed: this.assembler.completed, incomplete: this.assembler.incomplete };
  }

  /**
   * Adopt the panadapter the radio restored for us, or create one.
   *
   * `panStatuses` is what the caller has collected from `display pan` status lines;
   * the restored object is the one whose `client_handle` is ours. Creating is the
   * fallback, not the normal path — see the note at the top of this file.
   */
  async start(
    centerHz: number,
    panStatuses: Map<string, Record<string, string>>,
  ): Promise<void> {
    const mine = [...panStatuses].find(
      ([, f]) => f.client_handle?.toLowerCase() === `0x${this.client.state.handle}`.toLowerCase(),
    );

    if (mine) {
      this.panId = mine[0];
    } else {
      const r = await this.client.command(`display pan create x=${this.requested.bins} y=${PAN_Y_PIXELS}`);
      if (r.status !== 0) {
        // 0x50000009 is a FLEX-6400 with both its panadapters already in use.
        throw new Error(
          `Could not create a panadapter (0x${r.status.toString(16)})` +
            (r.status === 0x50000009 ? " — both of the radio's panadapters are in use" : ""),
        );
      }
      this.panId = r.message.trim().split(/[,\s]+/)[0] ?? null;
      if (!this.panId) throw new Error("The radio created a panadapter but did not say its id");
      this.createdIt = true;
    }

    this.streamId = Number.parseInt(this.panId.replace(/^0x/i, ""), 16);
    await this.tune(centerHz);
  }

  /**
   * Point it somewhere and apply every setting.
   *
   * Sent as one command because each one is a round trip and the radio redraws
   * between them; six separate sets make the display jump through six intermediate
   * states on every band change.
   */
  async tune(centerHz: number, spanHz?: number): Promise<void> {
    if (!this.panId) return;
    if (spanHz !== undefined) {
      this.requested.spanHz = clamp(spanHz, PAN_MIN_SPAN_HZ, PAN_MAX_SPAN_HZ);
    }
    this.requested.centerHz = centerHz;

    const r = await this.client.command(
      `display pan set ${hexId(this.panId)}` +
        ` center=${(centerHz / 1e6).toFixed(6)}` +
        ` bandwidth=${(this.requested.spanHz / 1e6).toFixed(6)}` +
        ` xpixels=${this.requested.bins}` +
        ` ypixels=${PAN_Y_PIXELS}` +
        ` fps=${this.requested.fps}` +
        // Time averaging on, frequency-domain weighting still off: see PAN_AVERAGE_DEFAULT
        // for why those two are not the same decision.
        ` average=${this.requested.average} weighted_average=0` +
        ` min_dbm=${PAN_MIN_DBM} max_dbm=${PAN_MAX_DBM}`,
    );
    if (r.status !== 0) {
      this.emit(
        "error",
        new Error(`The radio refused the panadapter settings (0x${r.status.toString(16)})`),
      );
    }
  }

  /**
   * Feed a datagram from the shared socket. Returns true if it was ours.
   *
   * The caller dispatches on packet class; this still checks the stream id, because
   * a second panadapter on the radio sends the same class to the same port and its
   * frames would otherwise be drawn as ours — a waterfall showing another band with
   * no indication that is what it is doing.
   */
  onPacket(buf: Buffer): boolean {
    if (this.streamId < 0) return false;
    const pkt = parsePanPacket(buf);
    if (!pkt || pkt.streamId !== this.streamId) return false;

    const bins = this.assembler.push(pkt);
    if (!bins) return true;

    this.emit("frame", {
      centerHz: this.requested.centerHz,
      spanHz: this.requested.spanHz,
      bins,
      yPixels: PAN_Y_PIXELS,
      minDbm: PAN_MIN_DBM,
      maxDbm: PAN_MAX_DBM,
      frameIndex: pkt.frameIndex,
      at: Date.now(),
    });
    return true;
  }

  async stop(): Promise<void> {
    // Only remove an object we created. One the radio restored with our profile goes
    // away when the client disconnects, and removing it explicitly means the next
    // connection's restore comes back empty and has to create one — straight into
    // the two-panadapter limit.
    if (this.panId && this.createdIt) {
      await this.client.command(`display pan remove ${hexId(this.panId)}`).catch(() => {});
    }
    this.panId = null;
    this.streamId = -1;
    this.createdIt = false;
  }
}

/**
 * Object ids carry exactly one `0x`.
 *
 * The radio writes the prefix in a status field (`waterfall=0x42000001`) and omits it
 * in a create reply, and `display pan set 0x0x40000001 …` is answered 0x50000029 —
 * which reads as "these settings were refused" rather than "you addressed nothing".
 * An entire sweep came back refused for this reason and very nearly became the
 * recorded fact that the radio would not go above 50 bins.
 */
function hexId(id: string): string {
  return `0x${id.replace(/^0x/i, "")}`;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
