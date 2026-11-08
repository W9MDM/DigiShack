// A Throb / ThrobX demodulator: audio in, text out, as a stream.
//
// The receive side of fldigi's Throb (src/throb/throb.cxx, rx_process and what it calls),
// in the same shape: the audio is mixed to complex baseband at the operator's frequency and
// brought down to 250 samples a second, fldigi's 8000 Hz divided by its DOWN_SAMPLE of 32
// (throb.h:40), so a symbol is 256, 128 or 64 samples there; at each symbol the window is
// correlated against every tone shaped by the throb pulse (mk_rxtone, throb.cxx:264-279);
// the two strongest tones are the symbol, or one tone alone when the strongest is more than
// twice the next (findtones, throb.cxx:324-329, Throb only); the pair goes through the
// character table. Three things are worked out from the signal itself:
//
//   FREQUENCY. A Throb 1 tone is a second long and the tones are 8 Hz apart, so a station
//   2 Hz off is already losing most of its correlation. fldigi's AFC (throb.cxx:442-454)
//   reads the frequency of the strongest tone from the phase step between two samples and
//   moves an eighth of the error a symbol, which takes most of a line to settle at Throb 1
//   and only runs while the squelch is open - and a signal a few hertz off never opens it.
//   Here every tone is correlated on a grid a sixteenth of a tone spacing fine, across
//   seven sixteenths either side of where the AFC has the signal; the offset that makes
//   the clearest symbol is that symbol's reading, and the AFC moves halfway to it whenever
//   the symbol is clearly a signal. The four idles of the preamble pull in a station up to
//   half a tone spacing off before the text starts.
//
//   SYMBOL TIMING. Every throb rises from nothing and falls back, and the correlation is
//   strongest when the window covers exactly one throb. The demodulator measures the
//   strongest correlation at 32 phases across a symbol, keeps each phase's average over
//   the last few symbols, and decides at the phase with the largest. fldigi's loop
//   (sync, throb.cxx:466-503) does the same with the envelope and moves an eighth of the
//   error a symbol; at Throb 1 that is several seconds, longer than the preamble.
//
//   WHETHER THERE IS A SIGNAL. On a signal the symbol's tones stand far above the rest; on
//   noise the strongest two of nine or eleven are only a little above the others. The
//   ratio of the symbol's tones to the noise around them (fldigi's signal / noise,
//   throb.cxx:337-345, but with the noise read across the whole search grid rather than
//   the seven other tones), in dB and averaged over a few symbols, is the quality, scaled
//   so noise sits near 0 and a clean signal at 1, and the squelch is a floor on it. Below
//   the floor symbols are still clocked and decoded, so a Throb SHIFT is not lost, but
//   nothing prints. A character prints only if the squelch was open before its symbol and
//   still is one symbol later, its own symbol stood clear of the noise at the AFC's
//   frequency, and so did the symbol after it. After the last character of an over that
//   next symbol is the closing idle; after a noise symbol it is more noise.
//
// Digital silence (a FlexRadio's DAX between overs is exact zeros) has no noise either, and
// a ratio of nothing to nothing reads anything at all: under -80 dBFS the symbol counts as
// no signal.
//
// The baseband filter is a windowed sinc, flat to well past ThrobX 4's outermost tone and
// down before 250 Hz folds anything into the band, so a PSK signal 200 Hz away does not
// land on a Throb tone. Chunks of any size give the same text as one call.
//
// Not ported: fldigi's "reverse" (lower sideband), and its scope display.
//
// scripts/check-throb.ts runs it clean, offset, in noise, chunked, on noise alone and on
// digital silence.

import { ThrobCharDecoder, throbParams, throbPulse, type ThrobMode } from "@/lib/digital/throb";

export interface ThrobDemodOptions {
  sampleRate: number;
  /** The operator's frequency: the middle tone, Hz audio. */
  centreHz: number;
  mode: ThrobMode;
  /**
   * Squelch, 0 to 1: the quality (see above) below which characters are not printed.
   * Noise reads 0 to 0.05, a signal at the edge of copy 0.15 to 0.3, a clean one 0.8 and
   * up. 0 disables it, and every gate below with it. Default 0.1.
   */
  squelch?: number;
}

export interface ThrobDemodStats {
  /** Characters delivered, including spaces and newlines. */
  chars: number;
  /** Throb SHIFTs followed by a pair with no shifted character, while the squelch is open. */
  errors: number;
  /** 0 to 1: how far the symbol's tones stand above the rest, averaged. */
  quality: number;
  /** Where the tone set appears to sit relative to the centre asked for, Hz. */
  afcHz: number;
  /** Whether the squelch is open: the quality over the squelch at the last symbol. */
  open: boolean;
  /** The strongest tone's amplitude at the last symbol, in the input's units, for a level display. */
  level: number;
}

/** Baseband rate: fldigi's 8000 Hz over DOWN_SAMPLE (throb.h:34, :40). */
const RATE = 250;
/** Baseband filter: cutoff, Hz, and length in baseband samples. */
const FILTER_CUTOFF_HZ = 110;
const FILTER_SPAN = 20;
/** Timing phases measured across a symbol. */
const TICKS = 32;
/** Frequency grid steps per tone spacing. */
const FINE = 16;
/** Grid steps searched either side of the AFC's frequency at each symbol: under half a spacing, so a tone is never read as its neighbour. */
const SEARCH = 7;
/** The AFC may move this many tone spacings from the centre. */
const AFC_RANGE = 1;
/** How far the AFC moves toward each clear symbol's reading. */
const AFC_ALPHA = 0.5;
/**
 * The timing average, per symbol: fast while the squelch is shut, because the preamble is
 * only four symbols, and slow once it is open. A Throb 4 throb is a raised cosine a
 * quarter second long, and a decision a few tens of milliseconds early takes in the tail
 * of the last symbol - enough, when the two share a tone, to read a pair as one tone.
 */
const TIMING_ALPHA = 1 / 3;
const TIMING_ALPHA_OPEN = 1 / 8;
/**
 * The quality average per symbol, rising: half the way each symbol, so the squelch opens
 * inside the four-symbol preamble even at the edge of copy.
 */
const QUALITY_ALPHA = 1 / 2;
/**
 * And falling: two thirds, so one symbol of noise after an over takes even a perfect
 * signal's quality (capped below) to the squelch, and the second shuts it.
 */
const QUALITY_ALPHA_DOWN = 2 / 3;
/**
 * Quality scale, dB of the symbol's tones over the noise: the floor reads 0 and the cap
 * reads 1. Noise alone averages about 7 dB (the stronger of the best two tones at the best
 * of fifteen frequency offsets is always a little above the mean); copy starts to fail
 * around 10 to 11 dB on single symbols.
 */
const QUALITY_FLOOR_DB = 7;
const QUALITY_CAP_DB = 25;
/**
 * A symbol this clear, at a frequency within LOCK grid steps of the AFC's, is a signal:
 * a character from it may print, and with the squelch open the AFC follows it. Noise alone
 * passes the first test about one symbol in ten, and both about one in twenty-five at the
 * slow speeds (a quarter-second throb places its frequency less exactly, so at Throb 4 the
 * second test does less).
 */
const CLEAR_DB = 8.5;
const LOCK = 3;
/**
 * With the squelch shut the AFC moves only for a symbol this clear: one noise symbol in a
 * hundred or so, so the noise between overs does not walk it away from a station it has
 * found, while a preamble at the edge of copy still pulls it in.
 */
const ACQUIRE_DB = 10.5;
/**
 * Symbols a character waits before it prints. The symbol that releases it must be clear
 * as well (CLEAR_DB): after the last character of an over that is the closing idle, a
 * clean signal; after a noise symbol read in the moment the quality takes to fall - or
 * the one straddling the end of the closing idle - it is more noise, and rarely clear.
 */
const HOLD_SYMBOLS = 1;
/** Under this the input is digital silence: -80 dBFS. */
const SILENCE = 1e-4;

export class ThrobDemodulator {
  private readonly fs: number;
  private readonly x: boolean;
  private readonly nTones: number;
  private centreHz: number;
  private readonly squelch: number;
  private readonly chars: ThrobCharDecoder;

  /** Input samples per baseband sample: fractional for a rate that is not a multiple of 250. */
  private readonly decim: number;
  private readonly taps: Float64Array;
  private readonly inI: Float64Array;
  private readonly inQ: Float64Array;
  private inHead = 0;
  private loPhase = 0;
  private clock = 0;

  /** Baseband samples a symbol, and a timing tick every `tickStep` of them. */
  private readonly N: number;
  private readonly tickStep: number;
  private readonly zr: Float64Array;
  private readonly zi: Float64Array;
  private readonly wr: Float64Array;
  private readonly wi: Float64Array;
  private zHead = 0;
  private zFilled = 0;
  private bbCount = 0;

  /** The frequency grid: position g is g / FINE tone spacings from the centre, g from -G to G. */
  private readonly G: number;
  private readonly stepHz: number;
  private readonly tplRe: Float64Array;
  private readonly tplIm: Float64Array;
  /** The pulse times itself, summed: a throb of amplitude A on a tone correlates to A / 2 times this. */
  private readonly pulseEnergy: number;
  private readonly mags: Float64Array;

  private readonly timing: Float64Array;
  private tickPhase = 0;
  private samplePhase = 0;
  private sinceLast = 0;

  private afcHz = 0;
  private qualDb = 0;
  private symbolCount = 0;
  /** Characters decoded and waiting HOLD_SYMBOLS, with the symbol they came on and whether it was clear. */
  private pending: { text: string; at: number; clear: boolean }[] = [];
  /** ThrobX: a space waiting for the next character, so an over does not end in one. */
  private spacePending = false;
  private lineStart = true;

  private readonly stats: ThrobDemodStats = { chars: 0, errors: 0, quality: 0, afcHz: 0, open: false, level: 0 };

  constructor(opts: ThrobDemodOptions) {
    const p = throbParams(opts.mode);
    this.fs = opts.sampleRate;
    this.x = p.x;
    this.nTones = p.tones;
    this.centreHz = opts.centreHz;
    this.squelch = Math.max(0, Math.min(1, opts.squelch ?? 0.1));
    this.chars = new ThrobCharDecoder(opts.mode);

    this.decim = this.fs / RATE;
    if (this.decim < 2) throw new Error(`Throb needs a sample rate above ${2 * RATE} Hz`);
    const L = Math.round(FILTER_SPAN * this.decim);
    this.taps = new Float64Array(L);
    let sum = 0;
    for (let j = 0; j < L; j++) {
      const t = j - (L - 1) / 2;
      const sinc = t === 0 ? 1 : Math.sin((2 * Math.PI * FILTER_CUTOFF_HZ * t) / this.fs) / ((2 * Math.PI * FILTER_CUTOFF_HZ * t) / this.fs);
      const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * j) / (L - 1)) + 0.08 * Math.cos((4 * Math.PI * j) / (L - 1));
      this.taps[j] = sinc * w;
      sum += sinc * w;
    }
    for (let j = 0; j < L; j++) this.taps[j] = this.taps[j]! / sum;
    this.inI = new Float64Array(L);
    this.inQ = new Float64Array(L);

    this.N = p.symbolLen / 32;
    this.tickStep = this.N / TICKS;
    this.zr = new Float64Array(this.N);
    this.zi = new Float64Array(this.N);
    this.wr = new Float64Array(this.N);
    this.wi = new Float64Array(this.N);

    this.stepHz = p.toneSpacingHz / FINE;
    this.G = ((this.nTones - 1) / 2) * FINE + AFC_RANGE * FINE + SEARCH + 1;
    const positions = 2 * this.G + 1;
    this.tplRe = new Float64Array(positions * this.N);
    this.tplIm = new Float64Array(positions * this.N);
    const pulse = new Float64Array(this.N);
    let ps = 0;
    for (let m = 0; m < this.N; m++) {
      pulse[m] = throbPulse(m, this.N, p.pulse);
      ps += pulse[m]! * pulse[m]!;
    }
    this.pulseEnergy = ps;
    for (let gi = 0; gi < positions; gi++) {
      const f = (gi - this.G) * this.stepHz;
      for (let m = 0; m < this.N; m++) {
        const a = (-2 * Math.PI * f * m) / RATE;
        this.tplRe[gi * this.N + m] = pulse[m]! * Math.cos(a);
        this.tplIm[gi * this.N + m] = pulse[m]! * Math.sin(a);
      }
    }
    this.mags = new Float64Array(positions);
    this.timing = new Float64Array(TICKS);
  }

  get statistics(): Readonly<ThrobDemodStats> {
    return this.stats;
  }

  /** Move the operator's frequency while running. The AFC starts over: the operator chose a new centre. */
  retune(centreHz: number): void {
    this.centreHz = centreHz;
    this.afcHz = 0;
    this.stats.afcHz = 0;
  }

  /** Back to how the constructor left it: nothing heard, nothing counted. */
  reset(): void {
    this.chars.reset();
    this.inI.fill(0);
    this.inQ.fill(0);
    this.inHead = 0;
    this.loPhase = 0;
    this.clock = 0;
    this.zr.fill(0);
    this.zi.fill(0);
    this.zHead = 0;
    this.zFilled = 0;
    this.bbCount = 0;
    this.mags.fill(0);
    this.timing.fill(0);
    this.tickPhase = 0;
    this.samplePhase = 0;
    this.sinceLast = 0;
    this.afcHz = 0;
    this.qualDb = 0;
    this.symbolCount = 0;
    this.pending = [];
    this.spacePending = false;
    this.lineStart = true;
    this.stats.chars = 0;
    this.stats.errors = 0;
    this.stats.quality = 0;
    this.stats.afcHz = 0;
    this.stats.open = false;
    this.stats.level = 0;
  }

  feed(samples: ArrayLike<number>): string {
    let out = "";
    const dphi = (2 * Math.PI * this.centreHz) / this.fs;
    const L = this.taps.length;
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i]!;
      this.inI[this.inHead] = x * Math.cos(this.loPhase);
      this.inQ[this.inHead] = -x * Math.sin(this.loPhase);
      this.inHead = this.inHead + 1 === L ? 0 : this.inHead + 1;
      this.loPhase += dphi;
      if (this.loPhase > 2 * Math.PI) this.loPhase -= 2 * Math.PI;
      this.clock += 1;
      if (this.clock < this.decim) continue;
      this.clock -= this.decim;
      // The filter over the last L samples, oldest at inHead.
      let yI = 0;
      let yQ = 0;
      let k = this.inHead;
      for (let j = 0; j < L; j++) {
        const h = this.taps[j]!;
        yI += h * this.inI[k]!;
        yQ += h * this.inQ[k]!;
        k = k + 1 === L ? 0 : k + 1;
      }
      out += this.baseband(yI, yQ);
    }
    return out;
  }

  /** The grid position of tone k with the AFC and a search step s applied. */
  private position(k: number, afcIdx: number, s: number): number {
    return (k - (this.nTones - 1) / 2) * FINE + afcIdx + s;
  }

  /** One baseband sample: into the window, and at each timing tick the correlations, the timing, and maybe a symbol. */
  private baseband(yI: number, yQ: number): string {
    const N = this.N;
    this.zr[this.zHead] = yI;
    this.zi[this.zHead] = yQ;
    this.zHead = (this.zHead + 1) % N;
    if (this.zFilled < N) this.zFilled++;
    this.bbCount = (this.bbCount + 1) % this.tickStep;
    if (this.bbCount !== 0 || this.zFilled < N) return "";

    // The window in order, oldest first.
    for (let m = 0; m < N; m++) {
      const slot = (this.zHead + m) % N;
      this.wr[m] = this.zr[slot]!;
      this.wi[m] = this.zi[slot]!;
    }
    const afcIdx = Math.round(this.afcHz / this.stepHz);
    const lo = this.position(0, afcIdx, -SEARCH);
    const hi = this.position(this.nTones - 1, afcIdx, SEARCH);
    let peak = 0;
    for (let g = lo; g <= hi; g++) {
      const base = (g + this.G) * N;
      let re = 0;
      let im = 0;
      for (let m = 0; m < N; m++) {
        const tr = this.tplRe[base + m]!;
        const ti = this.tplIm[base + m]!;
        const zr = this.wr[m]!;
        const zi = this.wi[m]!;
        re += tr * zr - ti * zi;
        im += tr * zi + ti * zr;
      }
      const mag = Math.sqrt(re * re + im * im);
      this.mags[g + this.G] = mag;
      if (mag > peak) peak = mag;
    }

    const ph = this.tickPhase;
    this.timing[ph] = this.timing[ph]! + (this.stats.open ? TIMING_ALPHA_OPEN : TIMING_ALPHA) * (peak - this.timing[ph]!);
    this.tickPhase = (ph + 1) % TICKS;
    this.sinceLast++;
    // A decision at the sampling phase - unless the phase moved and the last decision was
    // less than half a symbol ago, which would read the same symbol twice.
    if (ph !== this.samplePhase || this.sinceLast < TICKS / 2) return "";
    this.sinceLast = 0;
    const out = this.symbol(afcIdx);
    let best = 0;
    for (let i = 1; i < TICKS; i++) if (this.timing[i]! > this.timing[best]!) best = i;
    if (this.timing[best]! > this.timing[this.samplePhase]! * 1.02) this.samplePhase = best;
    return out;
  }

  /** One symbol: the frequency that reads strongest, its tones, the quality, the AFC, and the character. */
  private symbol(afcIdx: number): string {
    const n = this.nTones;
    let bestSig = -1;
    let bestS = 0;
    let bestA = 0;
    let bestB = 0;
    let bestPeak = 0;
    for (let s = -SEARCH; s <= SEARCH; s++) {
      // The strongest tone and the next (findtones, throb.cxx:297-322).
      let a = -1;
      let b = -1;
      let ma = -1;
      let mb = -1;
      for (let k = 0; k < n; k++) {
        const m = this.mags[this.position(k, afcIdx, s) + this.G]!;
        if (m > ma) {
          b = a;
          mb = ma;
          a = k;
          ma = m;
        } else if (m > mb) {
          b = k;
          mb = m;
        }
      }
      // A Throb single tone carries the whole amplitude, a pair half each, so either way
      // the symbol's strength is half the amplitude sum; the offset with the strongest
      // symbol is where the signal is.
      const single = !this.x && ma > 2 * mb;
      const sig = single ? ma / 2 : (ma + mb) / 2;
      if (sig > bestSig) {
        bestSig = sig;
        bestS = s;
        bestA = a;
        bestB = single ? a : b;
        bestPeak = ma;
      }
    }

    // The noise: every grid frequency searched, less half a spacing either side of the
    // symbol's tones - a hundred or so readings, against fldigi's seven (throb.cxx:338-343),
    // so the ratio of one symbol is not at the mercy of a handful of noise samples.
    const pa = this.position(bestA, afcIdx, bestS);
    const pb = this.position(bestB, afcIdx, bestS);
    let noiseSum = 0;
    let noiseN = 0;
    for (let g = this.position(0, afcIdx, -SEARCH); g <= this.position(n - 1, afcIdx, SEARCH); g++) {
      if (Math.abs(g - pa) < FINE / 2 || Math.abs(g - pb) < FINE / 2) continue;
      noiseSum += this.mags[g + this.G]!;
      noiseN++;
    }
    const level = (2 * bestPeak) / this.pulseEnergy;
    const wasOpen = this.squelch === 0 || this.quality() >= this.squelch;
    const db = level < SILENCE ? 0 : Math.min(QUALITY_CAP_DB, 20 * Math.log10(bestSig / (noiseSum / noiseN + 1e-30)));
    this.qualDb += (db < this.qualDb ? QUALITY_ALPHA_DOWN : QUALITY_ALPHA) * (db - this.qualDb);
    const quality = this.quality();
    const open = this.squelch === 0 || quality >= this.squelch;
    const clear = db >= CLEAR_DB;
    this.stats.quality = quality;
    this.stats.level = level;
    this.stats.open = open;

    if (wasOpen ? clear : db >= ACQUIRE_DB) {
      const measured = (afcIdx + bestS) * this.stepHz;
      const limit = AFC_RANGE * FINE * this.stepHz;
      this.afcHz = Math.max(-limit, Math.min(limit, this.afcHz + (wasOpen ? AFC_ALPHA / 2 : AFC_ALPHA) * (measured - this.afcHz)));
      this.stats.afcHz = this.afcHz;
    }

    this.symbolCount++;
    const text = this.chars.push(bestA, bestB);
    if (this.chars.invalid && open) this.stats.errors++;
    // A character counts only if the squelch was open before its symbol - the symbol where
    // an over starts straddles noise and the first idle, and reads as anything - and the
    // symbol itself was clear at the frequency the AFC is following: noise picks its
    // frequency anywhere in the search, a signal sits within a step or two of the AFC.
    const signal = this.squelch === 0 || (wasOpen && clear && Math.abs(bestS) <= LOCK);
    if (text) this.pending.push({ text, at: this.symbolCount, clear: signal });

    let out = "";
    while (this.pending.length > 0 && this.pending[0]!.at + HOLD_SYMBOLS <= this.symbolCount) {
      const p = this.pending.shift()!;
      if (this.squelch === 0 || (open && p.clear && db >= CLEAR_DB)) out += this.deliver(p.text);
    }
    return out;
  }

  /** The quality average on the 0 to 1 scale. */
  private quality(): number {
    return Math.max(0, Math.min(1, (this.qualDb - QUALITY_FLOOR_DB) / (QUALITY_CAP_DB - QUALITY_FLOOR_DB)));
  }

  /** A held character, out. ThrobX's spaces wait for the next character, so a line does not start or end with one. */
  private deliver(c: string): string {
    if (this.x) {
      if (c === " ") {
        if (!this.lineStart) this.spacePending = true;
        return "";
      }
      if (c !== "\n" && this.spacePending) c = " " + c;
      this.spacePending = false;
    }
    this.lineStart = c === "\n";
    this.stats.chars += c.length;
    return c;
  }
}
