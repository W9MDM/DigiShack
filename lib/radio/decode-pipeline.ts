// Audio in, decodes out. No radio in sight.
//
// This was the second half of `FlexDaxSource`: the window buffer, the scheduler that
// cuts a window shortly after the transmission ends, the silence check, decimation to
// the decoders' 12 kHz, and the decode itself. None of it was ever Flex-specific — it
// operates on samples and produces messages — but it lived inside the Flex driver, so
// the Icom source could deliver perfect audio and had nothing to hand it to.
//
// The only thing a radio contributes here is its sample rate. Flex DAX is 24 kHz, Icom
// is 48 kHz, and both divide into 12 kHz exactly.
//
// WHAT MUST NOT DRIFT: `scripts/check-pipeline-golden.ts` pins the behaviour of this
// file — known message in, decoded message out, all three modes, plus the silence and
// short-window guards. It was written against the pre-extraction code specifically so
// the move could be proved to change nothing.

import { nowMs } from "@/lib/time/clock";
import { EventEmitter } from "node:events";

import { decodeFT4, decodeFT8, HashCallBook } from "@e04/ft8ts";

import { ft2DecodeAudio } from "@/lib/digital/ft2demod";
import { HashCallBook as Ft2HashCallBook } from "@/lib/digital/pack77";
import { PERIOD_MS } from "@/lib/radio/timing";
import type { TxMode } from "@/lib/radio/waveform";

/** What every decoder here is fed, whatever the radio delivered. */
export const DECODE_SAMPLE_RATE = 12_000;

/**
 * On-air length of a transmission, ms — where the guard time begins.
 *
 * FT2's 1947 includes the modulator's two-symbol pulse tail, not just its 144 channel
 * symbols; cutting at 1920 would clip the last symbol's energy.
 */
export const TRANSMISSION_MS: Record<TxMode, number> = {
  FT8: 12_640,
  FT4: 5_040,
  FT2: 1_947,
};

/**
 * How long after the transmission ends the window is cut for decoding.
 *
 * The transmission occupies only the first 12.64 s (FT8) / 5.04 s (FT4) of the window;
 * the tail is guard time. Cutting shortly after the audio ends — rather than at the
 * boundary — buys the decode back that guard time, so results are ready BEFORE the next
 * window starts. That is what lets a QSO answer in the very next cycle with on-time
 * keying instead of keying a second late.
 *
 * But the margin also sets the LATEST DT that can be decoded, and 400 ms was too mean. A
 * station whose transmission starts at +0.5 s has audio running to 13.14 s (FT8), and
 * the buffer stopped at 13.04 s — so it was truncated and lost. That put a hard ceiling
 * of about +0.4 s on the DT column and quietly dropped every station with a slower clock
 * or a longer path, which is exactly the "why am I decoding fewer stations than WSJT-X"
 * complaint.
 *
 * 1200 ms roughly triples the tolerance to about +1.2 s while still leaving 1.16 s (FT8)
 * and 1.26 s (FT4) before the next boundary — comfortably more than the ~0.55 s a
 * depth-2 decode takes, so answering in the next cycle is unaffected.
 *
 * It is also FT2's floor. `ft2DecodeAudio` refuses any buffer under (144*10 + 375) * 16
 * = 29,040 samples at 12 kHz, i.e. 2.42 s. With the old 400 ms margin an FT2 window was
 * 2347 ms => 28,164 samples: 876 short, so every live FT2 window was thrown away at the
 * length gate before any demodulation ran, and the mode could never have decoded on air.
 */
export const CUT_MARGIN_MS = 1_200;

export interface Decode {
  freqOffset: number;
  snr: number;
  dt: number;
  message: string;
  mode: TxMode;
  windowStart: Date;
}

export type DecodePipelineEvents = {
  decodes: [{ windowStart: Date; decodes: Decode[]; rms: number; decodeMs: number }];
  window: [{ windowStart: Date; samples: number; rms: number; skipped: boolean }];
  error: [Error];
};

export interface DecodePipelineOptions {
  mode: TxMode;
  /** The rate samples arrive at. 24 kHz for Flex DAX, 48 kHz for Icom. */
  inputSampleRate: number;
  /**
   * Decoder depth. 2 is the live default: ~0.6 s per window against real 20 m traffic,
   * comfortably inside the gap between cycles. Depth 3 is ~1.5 s and still fits; depth 4
   * takes over 11 s and cannot be used live.
   */
  depth?: number;
  /**
   * Windows quieter than this RMS are skipped without decoding.
   *
   * MUST differ per radio. The filter below has ~0.80 gain per halving, so 48 kHz audio
   * takes two passes and arrives about 20% quieter than 24 kHz audio taking one. Reusing
   * one radio's value on the other silently drops marginal windows, and the symptom
   * reads as an antenna fault.
   */
  silenceRms?: number;
  /**
   * Top of the audio passband to search, Hz.
   *
   * The library defaults to 3000, and so did the waterfall, so the two agreed by
   * coincidence. On a busy band that ceiling is real: 3,052 decodes out of 111,829 in
   * this station's log sit above 2800 Hz and the maximum is *exactly* 3000 on every
   * busy band, which is a clipped distribution rather than a natural one.
   *
   * Raising it costs decode time — a wider search means more candidates — so it is a
   * setting rather than a new default, and the cycle-overrun warning is what says when
   * it has been raised too far.
   */
  maxHz?: number;
}

export class DecodePipeline extends EventEmitter<DecodePipelineEvents> {
  /** Top of the searched passband. Read by the waterfall too, so the two agree. */
  readonly maxHz: number;
  private mode: TxMode;
  private readonly inputRate: number;
  private readonly depth: number;
  private readonly silenceRms: number;

  private buffer: number[] = [];
  private timer: NodeJS.Timeout | null = null;
  /** Discard samples until this UTC ms — the tail of a window already taken. */
  private dropUntil = 0;
  /**
   * One-way transit from the radio, ms. See lib/radio/link-latency.ts.
   *
   * Audio over a VPN arrives this much after it happened at the antenna. The window
   * schedule works in ARRIVAL time: every cut and every drop boundary is shifted this
   * far later, so the buffer holds exactly the radio-time window it claims to — without
   * the shift, the last `lag` ms of every window have not arrived when it is cut, and
   * every decoded dt reads `lag` high.
   */
  private linkLatencyMs = 0;

  private readonly hashBook = new HashCallBook();
  private readonly ft2Book = new Ft2HashCallBook();

  constructor(opts: DecodePipelineOptions) {
    super();
    this.mode = opts.mode;
    this.inputRate = opts.inputSampleRate;
    this.depth = opts.depth ?? 2;
    this.silenceRms = opts.silenceRms ?? 0.001;
    // Clamped rather than trusted: the decoders work on 12 kHz audio, so anything at or
    // above 6 kHz is past Nyquist and asking for it would search noise. The floor keeps
    // a typo from producing a pipeline that decodes nothing at all.
    this.maxHz = Math.max(1_000, Math.min(5_500, Math.round(opts.maxHz ?? 3_000)));
    assertDecimable(this.inputRate);
  }

  get currentMode(): TxMode {
    return this.mode;
  }

  get periodMs(): number {
    return PERIOD_MS[this.mode];
  }

  get transmissionMs(): number {
    return TRANSMISSION_MS[this.mode];
  }

  /**
   * Tell the schedule how far away the radio is. Safe to call on every measurement —
   * it takes effect at the next window cut, which is the only place it is read.
   */
  setLinkLatencyMs(ms: number): void {
    this.linkLatencyMs = Math.max(0, Math.round(ms));
  }

  /**
   * The shift the schedule will actually use.
   *
   * Capped so the cut can never spill past the next boundary — FT2's window leaves only
   * ~600 ms between its cut point and the boundary, and a lag larger than the gap would
   * make the cut for window N fire after window N+1 began, taking N+1's head with it.
   * Exported as a pure function so check:link can assert the cap without waiting out
   * real T/R periods.
   */
  effectiveLagMs(): number {
    return effectiveLagMs(this.linkLatencyMs, this.periodMs, this.transmissionMs + CUT_MARGIN_MS);
  }

  /** Changing mode changes the window length, so the schedule restarts. */
  setMode(mode: TxMode): boolean {
    if (mode === this.mode) return false;
    this.mode = mode;
    this.buffer = [];
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      this.start();
    }
    return true;
  }

  /**
   * Add received samples.
   *
   * Samples arriving between the cut and the next boundary are the guard-time tail of
   * the window already taken. They are dropped rather than buffered, or every window
   * would begin with a stale prefix.
   */
  push(samples: ArrayLike<number>): void {
    // The corrected clock, not Date.now(): dropUntil is derived from window starts,
    // which live on the corrected clock. Mixing the two frames made the drop run long
    // by exactly the SNTP offset, shaving the head off every window on a slow clock.
    if (nowMs() < this.dropUntil) return;
    for (let i = 0; i < samples.length; i++) this.buffer.push(samples[i] as number);
  }

  /** True while the tail of an already-decoded window is being discarded. */
  get dropping(): boolean {
    return nowMs() < this.dropUntil;
  }

  /**
   * Discard receive audio until `untilMs` — used while WE are transmitting.
   *
   * On a FlexRadio this is not needed: DAX receive audio goes silent while the radio
   * transmits, so the window is skipped as silent and nothing decodes. **The Icom keeps
   * streaming audio right through a transmission**, so without this the decoder hears our
   * own signal and reports it as a decode. Which it duly did, and the consequences were
   * worse than the cosmetic noise in the decode list:
   *
   *   - every one of our own transmissions was uploaded to PSKReporter as a station we
   *     had heard, so the coverage map showed us spotting ourselves
   *   - the deaf guard counts decodes to decide whether the receiver is working, and
   *     hearing ourselves would satisfy it while genuinely deaf
   *   - the clock check medians DT across decodes, and our own transmission is by
   *     definition perfectly timed, so it drags the estimate toward zero
   *
   * Never brought forward: a mute already extending past this is a longer transmission
   * than the one being asked about, and shortening it would un-mute mid-transmission.
   */
  muteUntil(untilMs: number): void {
    if (untilMs > this.dropUntil) this.dropUntil = untilMs;
  }

  start(): void {
    if (this.timer) return;
    this.scheduleNextWindow();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.buffer = [];
  }

  private scheduleNextWindow(): void {
    const period = this.periodMs;
    const cutAt = this.transmissionMs + CUT_MARGIN_MS; // within the window

    // The whole schedule runs in the audio's ARRIVAL frame: real time minus the
    // one-way transit from the radio. A sample that left the antenna at boundary+cutAt
    // arrives lag ms later, and cutting before it arrives truncates every window by
    // the transit time. Subtracting lag from "now" shifts every cut and drop boundary
    // later by exactly that much, with no other arithmetic changing.
    const lag = this.effectiveLagMs();

    // Corrected time, not the OS clock. A window boundary is a claim about where the
    // rest of the world thinks the cycle starts, so it has to use the same clock the
    // rest of the world does — see lib/time/clock.ts.
    const sincePeriod = (nowMs() - lag) % period;
    // Next cut instant: this window's cut point if still ahead, else the next's.
    const delay = sincePeriod < cutAt ? cutAt - sincePeriod : period - sincePeriod + cutAt;

    this.timer = setTimeout(() => {
      // Re-read rather than captured: a measurement may have landed during the wait.
      const lagNow = this.effectiveLagMs();
      const samples = this.buffer;
      this.buffer = [];
      // We are at boundary+cutAt of the current window, in arrival time; identify
      // the window's start on the real clock.
      const windowStart = new Date(Math.floor((nowMs() - lagNow) / period) * period);
      // The guard-time tail also arrives lag late, so the drop extends by the same.
      this.dropUntil = windowStart.getTime() + period + lagNow;

      this.scheduleNextWindow();
      this.processWindow(samples, windowStart);
    }, delay);
    this.timer.unref?.();
  }

  /**
   * Decode one window.
   *
   * Public so it can be driven directly by the golden test, which is the only way to
   * assert this behaviour without waiting out real T/R periods.
   */
  processWindow(samples: number[], windowStart: Date): void {
    // A partial window (startup, or packet loss) cannot contain a whole transmission.
    // The buffer covers the transmission span plus the cut margin, so the floor is
    // relative to that span rather than the full period.
    const minSamples = Math.floor(this.inputRate * (this.transmissionMs / 1000) * 0.7);
    if (samples.length < minSamples) {
      this.emit("window", { windowStart, samples: samples.length, rms: 0, skipped: true });
      return;
    }

    let sumSq = 0;
    for (const s of samples) sumSq += s * s;
    const rms = Math.sqrt(sumSq / samples.length);

    if (rms < this.silenceRms) {
      // Almost certainly our own transmit cycle.
      this.emit("window", { windowStart, samples: samples.length, rms, skipped: true });
      return;
    }

    this.emit("window", { windowStart, samples: samples.length, rms, skipped: false });

    const audio = decimateTo12k(samples, this.inputRate);
    normalise(audio);

    const started = Date.now();
    let decoded: { freq: number; snr: number; dt: number; msg: string }[];
    try {
      if (this.mode === "FT2") {
        // FT2 is decoded by our own port in lib/digital, not @e04/ft8ts, which does not
        // implement it. Mapped onto the same shape so nothing downstream has to know.
        decoded = ft2DecodeAudio(audio, {
          sampleRate: DECODE_SAMPLE_RATE,
          book: this.ft2Book,
        }).map((d) => ({
          freq: d.frequencyHz,
          snr: d.snrDb,
          dt: d.dtSeconds,
          msg: d.message,
        }));
      } else {
        const opts = {
          sampleRate: DECODE_SAMPLE_RATE,
          depth: this.depth,
          hashCallBook: this.hashBook,
          freqHigh: this.maxHz,
        };
        decoded = this.mode === "FT4" ? decodeFT4(audio, opts) : decodeFT8(audio, opts);
      }
    } catch (err) {
      this.emit("error", err instanceof Error ? err : new Error("decode failed"));
      return;
    }
    const decodeMs = Date.now() - started;

    const decodes: Decode[] = decoded.map((d) => ({
      freqOffset: Math.round(d.freq),
      snr: Math.round(d.snr),
      dt: d.dt,
      message: d.msg.trim(),
      mode: this.mode,
      windowStart,
    }));

    this.emit("decodes", { windowStart, decodes, rms, decodeMs });
  }
}

/**
 * How much of a measured link latency the window schedule may actually apply.
 *
 * The cut for window N happens at boundary(N) + cutAt + lag in wall time. If lag
 * exceeds the gap between the cut point and the next boundary, that instant falls
 * inside window N+1 and the cut steals its head. FT8 leaves ~1.2 s of gap, FT2 only
 * ~600 ms, so the cap is per mode and a link slower than the gap gets the gap — the
 * remainder shows up as reduced late-DT tolerance, which is the honest place for it.
 */
export function effectiveLagMs(latencyMs: number, periodMs: number, cutAtMs: number): number {
  const gap = periodMs - cutAtMs - 100; // 100 ms of scheduling slack
  if (gap <= 0) return 0;
  return Math.max(0, Math.min(Math.round(latencyMs), gap));
}

// ------------------------------------------------------------------------ filtering

/**
 * Anti-alias FIR taps for halving the sample rate.
 *
 * The taps sum to exactly 0.8000, so the passband gain is 0.80 and not unity. That is
 * not an accident of the design, it is the measurement: a 400 Hz tone goes in at 0.7071
 * RMS and comes out at 0.5639, and 0.5639/0.7071 = 0.797.
 *
 * It is also why `silenceRms` has to differ between a radio needing one pass and one
 * needing two. `normalise` removes the level difference before the decoder sees it, but
 * the silence check runs BEFORE normalisation, on the raw window.
 */
const DECIM_TAPS = [
  0.0072, 0.0303, 0.0904, 0.1633, 0.2176, 0.1633, 0.0904, 0.0303, 0.0072,
] as const;

function assertDecimable(rate: number): void {
  if (rate === DECODE_SAMPLE_RATE) return;
  const ratio = rate / DECODE_SAMPLE_RATE;
  if (!Number.isInteger(ratio) || (ratio & (ratio - 1)) !== 0) {
    throw new Error(
      `Sample rate ${rate} does not reduce to ${DECODE_SAMPLE_RATE} by halving; ` +
        `a resampler would be needed, and none exists here`,
    );
  }
}

/**
 * Halve the sample rate with an anti-alias FIR.
 *
 * Filtered in float64 first: the taps quantise badly at DAX's small amplitudes, which
 * peak around 0.07.
 */
export function decimateBy2(input: number[] | Float32Array): Float32Array {
  const n = input.length;
  const centre = (DECIM_TAPS.length - 1) >> 1;
  const filtered = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let k = 0; k < DECIM_TAPS.length; k++) {
      const j = i - k + centre;
      if (j >= 0 && j < n) acc += DECIM_TAPS[k]! * (input[j] as number);
    }
    filtered[i] = acc;
  }

  const out = new Float32Array(Math.floor(n / 2));
  for (let i = 0; i < out.length; i++) out[i] = filtered[i * 2]!;
  return out;
}

/**
 * Reduce any supported rate to the decoders' 12 kHz.
 *
 * 24 kHz takes one halving, 48 kHz takes two. Both are exact, which is the reason no
 * resampler exists in this codebase and the reason `assertDecimable` refuses anything
 * else loudly rather than silently producing audio at the wrong rate — which decodes as
 * nothing at all, with no error to explain it.
 */
export function decimateTo12k(
  input: number[] | Float32Array,
  inputRate: number,
): Float32Array {
  assertDecimable(inputRate);
  let out: Float32Array =
    input instanceof Float32Array ? input : Float32Array.from(input);
  let rate = inputRate;
  while (rate > DECODE_SAMPLE_RATE) {
    out = decimateBy2(out);
    rate /= 2;
  }
  return out;
}

/** Scale to a usable amplitude in place. DAX audio peaks around 0.07. */
export function normalise(samples: Float32Array, target = 0.9): void {
  let peak = 0;
  for (const s of samples) {
    const a = Math.abs(s);
    if (a > peak) peak = a;
  }
  if (peak <= 0) return;
  const gain = target / peak;
  for (let i = 0; i < samples.length; i++) samples[i] = samples[i]! * gain;
}
