// The waterfall.
//
// Lifted out of `FlexDaxSource` because it was never Flex-specific: a ring of audio
// samples, an FFT, and a noise floor. Exactly the same code produces the Icom's
// waterfall from the Icom's audio. It was very nearly written off as a feature the
// Icom would not get, which would have been wrong.
//
// THE ONE THING THAT DOES DEPEND ON THE RADIO is how many bins to keep. The Flex ran
// 4096-point FFTs at 24 kHz and kept the first 512, which is 512 x 5.86 Hz = 3 kHz —
// the audio passband, chosen deliberately. Keeping 512 bins of a 48 kHz stream would
// span 6 kHz instead, so the Icom's waterfall would show twice the bandwidth with every
// signal squeezed into the left half. Not broken, just wrong-looking, and the sort of
// thing that gets blamed on the radio. So the span is fixed and the bin count follows
// from the sample rate.

import { FftPlan } from "@/lib/dsp/fft";

/**
 * FFT size at 24 kHz. Scaled with the sample rate — see `fftSizeForRate`.
 *
 * 4096 points at 24 kHz is 5.86 Hz per bin over 170 ms of audio.
 */
const SPECTRUM_FFT_AT_24K = 4096;
const REFERENCE_RATE = 24_000;

export const SPECTRUM_INTERVAL_MS = 250;

/**
 * The same display, for SPEECH instead of FT8 tones.
 *
 * The digital profile is built around one requirement: separate tones 6.25 Hz apart. That
 * needs a long look at the audio — 170 ms per transform — and 170 ms is most of a spoken
 * syllable. So a voice waterfall drawn with the digital analyser is not merely imperfect, it
 * is showing the average of a syllable four times a second: speech comes out as featureless
 * blobs with none of the structure an ear expects to see.
 *
 * Voice wants the opposite trade. A short window (~43 ms) resolves the rise and fall of
 * speech, and 23 Hz bins are plenty when the features of interest are hundreds of Hz wide.
 * Rows every 50 ms give twenty a second, so a 300-pixel canvas holds fifteen seconds — about
 * one over.
 */
export const SPECTRUM_VOICE_INTERVAL_MS = 50;

/**
 * FFT size for the voice profile: ~43 ms of audio whatever the radio's sample rate.
 *
 * 21 ms was the first choice and resolved speech beautifully into 64 bins across the
 * passband, which on a 1024-pixel canvas is sixteen pixels per bin — a bar chart, not a
 * waterfall. 43 ms is still well inside a syllable and gives twice the frequency detail.
 */
export function fftSizeForVoice(sampleRate: number): number {
  const scaled = sampleRate * 0.043;
  const pow = Math.round(Math.log2(Math.max(256, scaled)));
  return 2 ** Math.min(16, Math.max(8, pow));
}

export type SpectrumProfile = "digital" | "voice";

/** Row interval for a profile. */
export function spectrumIntervalFor(profile: SpectrumProfile): number {
  return profile === "voice" ? SPECTRUM_VOICE_INTERVAL_MS : SPECTRUM_INTERVAL_MS;
}

/**
 * How many points to transform at this sample rate.
 *
 * Proportional, so bin width and the time window come out identical on every radio.
 * A fixed 4096 was the first version and it was wrong twice over on a 48 kHz radio:
 *
 *   - **Resolution halved.** 11.72 Hz per bin, when FT8 tones are 6.25 Hz apart. The
 *     display cannot separate adjacent tones at all — it goes blobby where the Flex is
 *     crisp.
 *   - **The window halved**, to 85 ms. Frames are drawn every 250 ms, so consecutive
 *     frames shared almost nothing and the waterfall stuttered instead of scrolling.
 *     That is what "it just randomly refreshes" looks like.
 *
 * 8192 points at 48 kHz restores both: 5.86 Hz bins over 170 ms, exactly the Flex.
 */
export function fftSizeForRate(sampleRate: number): number {
  const scaled = (SPECTRUM_FFT_AT_24K * sampleRate) / REFERENCE_RATE;
  // Round to a power of two — FftPlan requires it, and a rate that is not a clean
  // multiple of 24 kHz should still get the nearest sensible size rather than throw.
  const pow = Math.round(Math.log2(Math.max(256, scaled)));
  return 2 ** Math.min(16, Math.max(8, pow));
}

/**
 * How much of the audio passband the waterfall shows.
 *
 * 3 kHz, matching what the Flex path has always displayed. FT8 signals sit ~50 Hz
 * apart, so the resolution at any supported rate is far finer than it needs to be.
 */
export const SPECTRUM_SPAN_HZ = 3_000;

/**
 * A frame whose noise floor is below this has no audio in it at all — the radio is
 * transmitting. Such frames are still drawn (seeing your own transmit gaps is useful)
 * but they do not update the display scale.
 */
const SILENT_FLOOR_DB = -150;

/** Above this step, jump the floor rather than smoothing toward it. */
const FLOOR_SNAP_DB = 15;

/**
 * Height of the colour ramp above the floor.
 *
 * The floor is measured per frame rather than fixed. A hardcoded window cannot work:
 * audio level depends on the operator's gain and on band conditions, and getting it
 * wrong saturates the display to solid colour or blanks it entirely — both of which
 * happened before this was adaptive.
 */
const DISPLAY_SPAN_DB = 40;

/**
 * Where the palette starts, relative to the measured noise floor.
 *
 * Slightly ABOVE the floor, not below it. Starting below means the noise itself — which
 * has maybe 10 dB of frame-to-frame spread — occupies the lower third of the ramp and
 * the display washes out. Above it, noise clamps to black and only real signals climb.
 */
const FLOOR_OFFSET_DB = 2;

export interface SpectrumRow {
  bins: Uint8Array;
  binHz: number;
  maxHz: number;
  floorDb: number;
  ceilingDb: number;
  at: number;
}

/** How many bins cover `spanHz` at this sample rate. */
export function binsForRate(
  sampleRate: number,
  spanHz: number = SPECTRUM_SPAN_HZ,
  /**
   * The FFT size actually in use.
   *
   * Recomputed from the sample rate when omitted, which was the only behaviour and was wrong
   * the moment a second FFT size existed: the voice profile transforms fewer points, so its
   * bins are wider, and taking the digital profile's BIN COUNT of them covered 24 kHz instead
   * of 3 kHz. The waterfall drew the entire spectrum squeezed into the passband's width —
   * reported as "not the right width", and correctly.
   */
  fftSize: number = fftSizeForRate(sampleRate),
): number {
  const binHz = sampleRate / fftSize;
  return Math.max(64, Math.min(fftSize / 2, Math.round(spanHz / binHz)));
}

export class SpectrumAnalyser {
  private readonly size: number;
  private readonly ring: Float32Array;
  private write = 0;
  private filled = 0;
  private readonly fft: FftPlan;
  private readonly scratch: Float32Array;
  private readonly db: Float32Array;
  private readonly bins: number;
  private noiseFloorDb: number | null = null;

  /**
   * `spanHz` must match what the DECODER is searching.
   *
   * When they disagree the waterfall is a lie in one direction or the other: signals
   * decoded but not drawn, or drawn in a region nothing will ever decode. Both were
   * 3 kHz by coincidence of both being written that way, and that is now the caller's
   * job to keep true — see `digital.passbandHz`.
   */
  constructor(
    private readonly sampleRate: number,
    spanHz: number = SPECTRUM_SPAN_HZ,
    /**
     * Which trade to make between frequency and time resolution.
     *
     * `digital` separates FT8 tones; `voice` resolves syllables. See
     * SPECTRUM_VOICE_INTERVAL_MS for why one display cannot do both.
     */
    profile: SpectrumProfile = "digital",
  ) {
    this.size = profile === "voice" ? fftSizeForVoice(sampleRate) : fftSizeForRate(sampleRate);
    this.ring = new Float32Array(this.size);
    this.scratch = new Float32Array(this.size);
    this.fft = new FftPlan(this.size);
    this.bins = binsForRate(sampleRate, spanHz, this.size);
    this.db = new Float32Array(this.size / 2);
  }

  /** Seconds of audio each frame covers. Equal across radios by construction. */
  get windowSeconds(): number {
    return this.size / this.sampleRate;
  }

  /** Feed every received sample. Unlike the decode buffer this never drops any — the
   * display has no windows and a gap in it reads as a dead receiver. */
  push(samples: ArrayLike<number>): void {
    for (let i = 0; i < samples.length; i++) {
      this.ring[this.write] = samples[i] as number;
      this.write = (this.write + 1) % this.size;
      if (this.filled < this.size) this.filled++;
    }
  }

  /** One frame, or null until the ring has filled. */
  compute(): SpectrumRow | null {
    if (this.filled < this.size) return null;

    // Unwrap the ring into chronological order — an FFT over a wrapped buffer sees a
    // discontinuity at the seam and reports it as broadband noise.
    for (let i = 0; i < this.size; i++) {
      this.scratch[i] = this.ring[(this.write + i) % this.size]!;
    }
    this.fft.magnitudeDb(this.scratch, this.db);

    // Noise floor as the 25th percentile of this frame. The median would be dragged up
    // by a busy band — on 20 m FT8 a good fraction of the passband is occupied — and
    // the minimum is too twitchy to smooth.
    const usable = this.db.subarray(0, this.bins);
    const sorted = Float32Array.from(usable).sort();
    const frameFloor = sorted[Math.floor(sorted.length * 0.25)] ?? -100;

    // Silent frames must NOT train the scale. Receive audio goes to nothing while the
    // radio transmits, which drags the tracked floor down to ~-200 dB; when receive
    // resumes, a slowly-smoothed floor is 60+ dB too low and the whole display
    // saturates for several seconds.
    if (frameFloor >= SILENT_FLOOR_DB) {
      const tracked = this.noiseFloorDb;
      if (tracked === null || Math.abs(frameFloor - tracked) > FLOOR_SNAP_DB) {
        // Snap across a large step — coming out of transmit, or a gain change.
        // Smoothing through it just means a slow wrong scale.
        this.noiseFloorDb = frameFloor;
      } else {
        this.noiseFloorDb = tracked * 0.9 + frameFloor * 0.1;
      }
    }

    const floor = (this.noiseFloorDb ?? frameFloor) + FLOOR_OFFSET_DB;
    const ceiling = floor + DISPLAY_SPAN_DB;
    const span = ceiling - floor;

    const out = new Uint8Array(this.bins);
    for (let i = 0; i < this.bins; i++) {
      const norm = ((this.db[i] as number) - floor) / span;
      out[i] = Math.max(0, Math.min(255, Math.round(norm * 255)));
    }

    const binHz = this.fft.binHz(this.sampleRate);
    return {
      bins: out,
      binHz,
      maxHz: Math.round(binHz * this.bins),
      floorDb: floor,
      ceilingDb: ceiling,
      at: Date.now(),
    };
  }
}

/**
 * A spectrum row as it goes over the websocket.
 *
 * Shared because it was not, and the Icom path spent its first run showing "waiting for
 * spectrum..." — it broadcast the raw row, whose `bins` is a Uint8Array, and a
 * Uint8Array JSON-serialises to `{"0":12,"1":45,...}` rather than to an array. The
 * client had no idea what it was being sent.
 *
 * Base64 rather than a JSON number array: 512 bins is about 2.8 kB as numbers against
 * 684 bytes encoded, four times a second, per connected client.
 */
export interface SpectrumMessage {
  kind: "spectrum";
  bins: string;
  binHz: number;
  maxHz: number;
  floorDb: number;
  ceilingDb: number;
  at: number;
  mode: string;
  periodMs: number;
}

export function spectrumMessage(
  row: SpectrumRow,
  mode: string,
  periodMs: number,
): SpectrumMessage {
  return {
    kind: "spectrum",
    bins: Buffer.from(row.bins).toString("base64"),
    binHz: row.binHz,
    maxHz: row.maxHz,
    floorDb: row.floorDb,
    ceilingDb: row.ceilingDb,
    at: row.at,
    mode,
    periodMs,
  };
}
