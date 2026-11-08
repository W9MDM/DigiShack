// An MFSK demodulator: audio in, text out, as a stream.
//
// The signal is one of 16 (or 32) tones at a time, a symbol at a time, the tones one baud
// apart. The receiver's job each symbol is to say how strongly each tone was there, turn
// that into a soft vote on each of the symbol's bits, and hand the votes through the
// de-interleaver to the Viterbi decoder, which reads the data bits that best fit the
// code. It works in four parts:
//
//   THE FRONT END mixes the audio down with an oscillator at the centre of the tone set,
//   low-pass filters it to the signal's width and resamples it to a rate of 4 x tones
//   samples a symbol (64 for MFSK16: 1000 Hz). A second, fixed shift then puts the lowest
//   tone at 0 Hz, so tone k is exactly bin k of a DFT one symbol long. fldigi does the
//   same with a Hilbert filter, a mixer and a band-pass filter at its own 8 kHz; this
//   works at whatever rate the radio gives (12, 24 or 48 kHz) and resamples fractionally,
//   which is what lets MFSK11 and MFSK22, whose symbols are not a whole number of samples
//   at those rates, run on the same code.
//
//   A SLIDING DFT gives every tone's bin at every sample: the window is always the last
//   symbol's worth. It peaks when the window lines up with a symbol and falls away when
//   the window straddles two, which is what the timing recovery uses.
//
//   SYMBOL TIMING keeps, for every sample phase in a symbol (64 of them with 16 tones), the strongest
//   bin's magnitude averaged over the last dozen or so symbols, and decides at the phase
//   where that is largest - stepping towards it, faster when far off. fldigi measures the
//   same peak a different way (synchronize(): where the last isolated tone's bin peaked
//   in a two-symbol history) but the quantity is the same; this one also learns from
//   symbols that are not isolated and so locks within a few seconds of a call starting.
//
//   THE DECISION is fldigi's, ported line for line from src/mfsk/mfsk.cxx (W1HKJ, after
//   gMFSK by Tomi Manninen OH2BNS): harddecode() picks the strongest tone, softdecode()
//   has every tone vote for the bits of its Gray-decoded value with its magnitude (the
//   hard decision's tone counted twice, and a tone that has stayed on for six symbols -
//   a carrier sitting in the passband - silenced to the average), scaled into 0..255 for
//   the decoder; decodesymbol() pairs the bits for the Viterbi decoder (two decoders a
//   bit apart, voting by metric, when a symbol has an odd number of bits as MFSK8's
//   five does) and the Varicode is read as fldigi's recvbit() reads it.
//
// FREQUENCY. When the same tone is sent twice running the waveform is one unbroken tone,
// so its bin's phase turns by 2 pi times the tuning error (in bins) between the two
// decisions; the oscillator follows a fraction of that while the squelch is open, as
// fldigi's afc() does from the same bin. The pull-in is about two fifths of a tone
// spacing either way: about 6 Hz at MFSK16, 12 Hz at MFSK32.
//
// QUALITY AND THE SQUELCH. The Viterbi decoder's path metric over each bit, averaged as
// fldigi averages it (over 50 bits), is the quality, scaled 0 for noise to 1 for a clean
// signal (see scaleMetric). Below the squelch the bits are still decoded, so the decoders
// and the Varicode stay in step, but nothing is printed. A second, faster average closes
// the squelch when a signal stops: the slow one takes a couple of seconds to fall, and in
// that time the noise after an over decoded as a line of junk.
//
// Chunks of any size give the same text as one call; nothing here depends on a chunk
// boundary. scripts/check-mfsk.ts runs it clean, off frequency, in noise, at every rate,
// and on noise alone.

import { Interleaver, NASA_K, NASA_POLY1, NASA_POLY2, ViterbiDecoder } from "@/lib/digital/fec";
import { MFSK_CENTRE_HZ, mfskGrayDecode, mfskMode, type MfskModeName } from "@/lib/digital/mfsk";
import { MfskVaricodeDecoder } from "@/lib/digital/mfsk-varicode";

export interface MfskDemodOptions {
  sampleRate: number;
  /** Centre of the tone set, Hz audio. Default 1500. */
  centreHz?: number;
  mode?: MfskModeName;
  /**
   * Squelch, 0 to 1: the quality (see above) below which nothing is printed. Noise reads
   * under 0.1 in every mode, a signal at the edge of copy 0.2 to 0.35, a clean one near 1.
   * 0 disables it. Default 0.15.
   */
  squelch?: number;
  /** Follow the signal's frequency. Default true. */
  afc?: boolean;
  /** Diagnostics: each symbol decision, with the strongest tone and the working-sample count. */
  onSymbol?: (tone: number, at: number) => void;
  /** Diagnostics: each decoded bit, with the quality, its fast average, and the unscaled averaged path metric. */
  onBit?: (quality: number, fast: number, metric: number) => void;
}

export interface MfskDemodStats {
  /** Characters delivered, including spaces and newlines. */
  chars: number;
  /** Varicodes no character has, counted while the squelch is open. */
  errors: number;
  /** 0 to 1: the Viterbi decoder's averaged path metric, 0 for noise and 1 for a clean signal. */
  quality: number;
  /** Where the oscillator sits relative to the centre asked for, Hz. */
  afcHz: number;
  /** Whether the last decoded bit was printed (quality at or over the squelch). */
  open: boolean;
  /** The strongest tone's amplitude at the last symbol, linear, in the units of the input. */
  level: number;
}

/** fldigi's tracepair.trace: how far back the Viterbi decoder reads. */
const TRACEBACK = 45;
/** Working samples a symbol per tone. */
const OVERSAMPLE = 4;
/** The resampling filter's half length, in working samples. */
const FILTER_HALF = 8;
/** Kernel table points per input sample. */
const KERNEL_OS = 64;
/** Timing average, per symbol. */
const TIMING_ALPHA = 1 / 12;
/** AFC step, as a fraction of the measured error. */
const AFC_GAIN = 1 / 8;
/** fldigi's CWI_MAXCOUNT: a tone repeated more than this many times running is a carrier. */
const CWI_MAXCOUNT = 6;
/** The fast quality average, in bits: about 0.4 s at MFSK16. */
const FAST_WEIGHT = 12;
/**
 * The fast average must clear three quarters of the squelch and half the slow average.
 * The second is what closes it at the end of an over: the slow average is still high, the
 * fast one has fallen to noise. On a steady weak signal the two agree and it costs nothing.
 */
const FAST_OF_SQUELCH = 0.75;
const FAST_OF_SLOW = 0.5;

function decayavg(average: number, input: number, weight: number): number {
  if (weight <= 1) return input;
  return (input - average) / weight + average;
}

function blackman(x: number): number {
  return 0.42 - 0.5 * Math.cos(2 * Math.PI * x) + 0.08 * Math.cos(4 * Math.PI * x);
}

export class MfskDemodulator {
  private readonly fs: number;
  private readonly tones: number;
  private readonly symbits: number;
  private readonly baud: number;
  private readonly spacing: number;
  private readonly squelch: number;
  private readonly afcOn: boolean;
  private readonly onSymbol?: (tone: number, at: number) => void;
  private readonly onBit?: (quality: number, fast: number, metric: number) => void;
  private centreHz: number;
  private lo: number;

  /** Working samples a symbol, and the working rate. */
  private readonly M: number;
  private readonly fsw: number;
  /** Input samples per working sample. */
  private readonly ratio: number;

  // Front end: the oscillator, and a ring of mixed input samples.
  private loPhase = 0;
  private readonly ringRe: Float64Array;
  private readonly ringIm: Float64Array;
  private readonly ringMask: number;
  private n = 0;
  private tOut: number;
  private readonly halfSpan: number;
  private readonly kernel: Float64Array;
  private readonly shiftRe: Float64Array;
  private readonly shiftIm: Float64Array;
  private m = 0;

  // Sliding DFT.
  private readonly winRe: Float64Array;
  private readonly winIm: Float64Array;
  private readonly sRe: Float64Array;
  private readonly sIm: Float64Array;
  private readonly twRe: Float64Array;
  private readonly twIm: Float64Array;

  // Timing.
  private readonly timing: Float64Array;
  private untilDecision: number;
  private lastDecisionM = 0;

  // Decision state, as fldigi names it.
  private currsymbol = 0;
  private prev1symbol = 0;
  private prev1Re = 0;
  private prev1Im = 0;
  private staticburst = false;
  private readonly cwi: Int32Array;
  private readonly rxinlv: Interleaver;
  private readonly dec1 = new ViterbiDecoder(NASA_K, NASA_POLY1, NASA_POLY2);
  private readonly dec2 = new ViterbiDecoder(NASA_K, NASA_POLY1, NASA_POLY2);
  private symbolpair0 = 0;
  private symbolpair1 = 0;
  private symcounter = 0;
  private met1 = 0;
  private met2 = 0;
  private fastMet = 0;
  private readonly noiseMetric: number;
  private readonly varicode = new MfskVaricodeDecoder();
  private readonly mags: Float64Array;
  private readonly soft: Uint8Array;
  private readonly b: Float64Array;

  private readonly stats: MfskDemodStats = { chars: 0, errors: 0, quality: 0, afcHz: 0, open: false, level: 0 };

  constructor(opts: MfskDemodOptions) {
    const mode = mfskMode(opts.mode);
    this.fs = opts.sampleRate;
    this.tones = mode.tones;
    this.symbits = mode.symbits;
    this.baud = mode.baud;
    this.spacing = mode.toneSpacingHz;
    this.squelch = Math.max(0, Math.min(1, opts.squelch ?? 0.15));
    this.afcOn = opts.afc ?? true;
    this.onSymbol = opts.onSymbol;
    this.onBit = opts.onBit;
    this.noiseMetric = this.tones === 32 ? 57 : 85;
    this.centreHz = opts.centreHz ?? MFSK_CENTRE_HZ;
    this.lo = this.centreHz;

    this.M = Math.max(64, OVERSAMPLE * this.tones);
    this.fsw = this.M * this.baud;
    this.ratio = this.fs / this.fsw;
    if (this.ratio < 2) throw new Error(`MFSK: a sample rate of ${this.fs} is too low for ${mode.name}`);

    // The resampling filter: a Blackman-windowed sinc, passing the tone set and a tone
    // either side, tabulated finely enough that a fractional position is a linear step.
    this.halfSpan = FILTER_HALF * this.ratio;
    const cutoff = (this.tones / 2 + 2) * this.spacing;
    const fc = cutoff / this.fs;
    const tableLen = Math.ceil(2 * this.halfSpan * KERNEL_OS) + 2;
    this.kernel = new Float64Array(tableLen);
    for (let i = 0; i < tableLen; i++) {
      const tau = i / KERNEL_OS - this.halfSpan;
      const x = 2 * fc * tau;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const w = Math.abs(tau) >= this.halfSpan ? 0 : blackman((tau + this.halfSpan) / (2 * this.halfSpan));
      this.kernel[i] = 2 * fc * sinc * w;
    }
    // Normalise to unity gain at 0 Hz as the taps fall at whole input samples.
    let dc = 0;
    for (let t = -Math.floor(this.halfSpan); t <= Math.floor(this.halfSpan); t++) dc += this.kernelAt(t);
    for (let i = 0; i < tableLen; i++) this.kernel[i] = this.kernel[i]! / dc;

    let ring = 1;
    while (ring < 2 * this.halfSpan + 8) ring <<= 1;
    this.ringRe = new Float64Array(ring);
    this.ringIm = new Float64Array(ring);
    this.ringMask = ring - 1;
    this.tOut = this.halfSpan;

    // The fixed shift by half the bandwidth: (tones - 1) / (2 M) cycles a working sample,
    // a whole number of turns every 2 M samples.
    this.shiftRe = new Float64Array(2 * this.M);
    this.shiftIm = new Float64Array(2 * this.M);
    for (let q = 0; q < 2 * this.M; q++) {
      const a = (Math.PI * q) / this.M;
      this.shiftRe[q] = Math.cos(a);
      this.shiftIm[q] = Math.sin(a);
    }

    this.winRe = new Float64Array(this.M);
    this.winIm = new Float64Array(this.M);
    this.sRe = new Float64Array(this.tones);
    this.sIm = new Float64Array(this.tones);
    this.twRe = new Float64Array(this.M);
    this.twIm = new Float64Array(this.M);
    for (let j = 0; j < this.M; j++) {
      this.twRe[j] = Math.cos((-2 * Math.PI * j) / this.M);
      this.twIm[j] = Math.sin((-2 * Math.PI * j) / this.M);
    }

    this.timing = new Float64Array(this.M);
    this.untilDecision = this.M;
    this.cwi = new Int32Array(this.tones);
    this.rxinlv = new Interleaver(this.symbits, mode.depth, "rev");
    for (const d of [this.dec1, this.dec2]) {
      d.setTraceback(TRACEBACK);
      d.setChunkSize(1);
    }
    this.mags = new Float64Array(this.tones);
    this.soft = new Uint8Array(this.symbits);
    this.b = new Float64Array(this.symbits);
  }

  get statistics(): Readonly<MfskDemodStats> {
    return this.stats;
  }

  /** Move the tone set while running. The AFC offset is dropped: the operator chose a new centre. */
  retune(centreHz: number): void {
    this.centreHz = centreHz;
    this.lo = centreHz;
    this.stats.afcHz = 0;
  }

  /** Start over: decoders, interleaver, timing and AFC. */
  reset(): void {
    this.lo = this.centreHz;
    this.stats.afcHz = 0;
    this.stats.quality = 0;
    this.stats.open = false;
    this.timing.fill(0);
    this.cwi.fill(0);
    this.rxinlv.flush();
    this.dec1.reset();
    this.dec2.reset();
    this.met1 = 0;
    this.met2 = 0;
    this.fastMet = 0;
    this.symcounter = 0;
    this.symbolpair0 = this.symbolpair1 = 0;
    this.varicode.reset();
  }

  private kernelAt(tau: number): number {
    const x = (tau + this.halfSpan) * KERNEL_OS;
    if (x < 0) return 0;
    const i = Math.floor(x);
    if (i + 1 >= this.kernel.length) return 0;
    const f = x - i;
    return this.kernel[i]! * (1 - f) + this.kernel[i + 1]! * f;
  }

  feed(samples: ArrayLike<number>): string {
    let out = "";
    const twoPi = 2 * Math.PI;
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i]!;
      const idx = this.n & this.ringMask;
      this.ringRe[idx] = x * Math.cos(this.loPhase);
      this.ringIm[idx] = -x * Math.sin(this.loPhase);
      this.loPhase += (twoPi * this.lo) / this.fs;
      if (this.loPhase > twoPi) this.loPhase -= twoPi;
      // Every working sample whose filter window this sample completes.
      while (this.n >= this.tOut + this.halfSpan) {
        out += this.working(this.tOut);
        this.tOut += this.ratio;
      }
      this.n++;
    }
    return out;
  }

  /** One working-rate sample, filtered at input time `t`. */
  private working(t: number): string {
    let re = 0;
    let im = 0;
    const lo = Math.ceil(t - this.halfSpan);
    const hi = Math.floor(t + this.halfSpan);
    for (let k = lo; k <= hi; k++) {
      const h = this.kernelAt(k - t);
      const idx = k & this.ringMask;
      re += h * this.ringRe[idx]!;
      im += h * this.ringIm[idx]!;
    }
    // Lowest tone to 0 Hz.
    const q = (this.m * (this.tones - 1)) % (2 * this.M);
    const cr = this.shiftRe[q]!;
    const ci = this.shiftIm[q]!;
    const yr = re * cr - im * ci;
    const yi = re * ci + im * cr;
    // Sliding DFT, referenced to absolute time so a steady tone's bin does not turn.
    const w = this.m % this.M;
    const dr = yr - this.winRe[w]!;
    const di = yi - this.winIm[w]!;
    this.winRe[w] = yr;
    this.winIm[w] = yi;
    let best = 0;
    for (let k = 0; k < this.tones; k++) {
      const j = (k * w) % this.M;
      const tr = this.twRe[j]!;
      const ti = this.twIm[j]!;
      this.sRe[k] = this.sRe[k]! + dr * tr - di * ti;
      this.sIm[k] = this.sIm[k]! + dr * ti + di * tr;
      const mag = Math.hypot(this.sRe[k]!, this.sIm[k]!);
      if (mag > best) best = mag;
    }
    const tp = this.timing[w]!;
    this.timing[w] = tp + TIMING_ALPHA * (best - tp);
    this.m++;
    if (--this.untilDecision > 0) return "";
    const text = this.decide();
    // Re-pick when the next decision falls: towards the phase where the strongest bin
    // peaks on average, a quarter of the way at a time and at least one sample.
    let bp = 0;
    for (let p = 1; p < this.M; p++) if (this.timing[p]! > this.timing[bp]!) bp = p;
    let step = 0;
    if (bp !== w && this.timing[bp]! > this.timing[w]! * 1.05) {
      let dist = (bp - w + this.M) % this.M;
      if (dist > this.M / 2) dist -= this.M;
      step = Math.sign(dist) * Math.max(1, Math.round(Math.abs(dist) / 4));
    }
    this.untilDecision = this.M + step;
    return text;
  }

  /** One symbol: fldigi's rx_process() at the symbol tick. */
  private decide(): string {
    for (let k = 0; k < this.tones; k++) this.mags[k] = Math.hypot(this.sRe[k]!, this.sIm[k]!);
    this.currsymbol = this.harddecode();
    this.onSymbol?.(this.currsymbol, this.m);
    const cr = this.sRe[this.currsymbol]!;
    const ci = this.sIm[this.currsymbol]!;
    this.stats.level = (2 * this.mags[this.currsymbol]!) / this.M;
    const text = this.softdecode();
    this.afc(cr, ci);
    this.prev1symbol = this.currsymbol;
    this.prev1Re = cr;
    this.prev1Im = ci;
    this.lastDecisionM = this.m;
    return text;
  }

  private harddecode(): number {
    let avg = 0;
    for (let i = 0; i < this.tones; i++) avg += this.mags[i]!;
    avg /= this.tones;
    if (avg < 1e-20) avg = 1e-20;
    let max = 0;
    let symbol = 0;
    let burstcount = 0;
    for (let i = 0; i < this.tones; i++) {
      const x = this.mags[i]!;
      if (x > max) {
        max = x;
        symbol = i;
      }
      if (x > 2 * avg) burstcount++;
    }
    this.staticburst = burstcount === this.tones;
    return symbol;
  }

  private softdecode(): string {
    const n = this.tones;
    const sb = this.symbits;
    const b = this.b;
    b.fill(0);
    let sum = 0;
    for (let i = 0; i < n; i++) if (this.cwi[i]! < CWI_MAXCOUNT) sum += this.mags[i]!;
    const avg = sum / n;
    if (sum < 1e-10) sum = 1e-10;
    const cwiSymbol = this.currsymbol;
    // A tone the hard decision picks over and over is counted up, the others down; tone
    // 0 is left out, since the preamble and the idle sit on it legitimately.
    for (let k = 1; k < n; k++) {
      if (k === cwiSymbol) this.cwi[k] = this.cwi[k]! + 1;
      else this.cwi[k] = this.cwi[k]! - 1;
      if (this.cwi[k]! < 0) this.cwi[k] = 0;
      if (this.cwi[k]! > CWI_MAXCOUNT) this.cwi[k] = CWI_MAXCOUNT + 1;
    }
    for (let i = 0; i < n; i++) {
      const j = mfskGrayDecode(i);
      let binmag: number;
      if (this.cwi[i]! > CWI_MAXCOUNT) binmag = avg;
      else if (cwiSymbol === i) binmag = 2 * this.mags[i]!;
      else binmag = this.mags[i]!;
      for (let k = 0; k < sb; k++) b[k] = b[k]! + (j & (1 << (sb - k - 1)) ? binmag : -binmag);
    }
    for (let i = 0; i < sb; i++) {
      this.soft[i] = this.staticburst ? 128 : Math.floor(Math.max(0, Math.min(255, 128 + (b[i]! / sum) * 256)));
    }
    this.rxinlv.symbols(this.soft);
    let out = "";
    for (let i = 0; i < sb; i++) out += this.decodesymbol(this.soft[i]!);
    return out;
  }

  /** fldigi's decodesymbol(): pair the soft bits for the decoder, and read what it gives. */
  private decodesymbol(symbol: number): string {
    this.symbolpair0 = this.symbolpair1;
    this.symbolpair1 = symbol;
    this.symcounter = this.symcounter ? 0 : 1;
    let c: number;
    let metric: number;
    let raw = 0;
    if (this.symbits % 2 === 1) {
      // An odd number of bits a symbol: the pairs straddle symbols, and which bit starts
      // a pair is not known, so two decoders run a bit apart and the better one speaks.
      if (this.symcounter) {
        c = this.dec1.decode(this.symbolpair0, this.symbolpair1);
        if (c === -1) return "";
        this.met1 = decayavg(this.met1, this.dec1.metric, 50);
        raw = this.dec1.metric;
        if (this.met1 < this.met2) return "";
        metric = this.met1;
      } else {
        c = this.dec2.decode(this.symbolpair0, this.symbolpair1);
        if (c === -1) return "";
        this.met2 = decayavg(this.met2, this.dec2.metric, 50);
        raw = this.dec2.metric;
        if (this.met2 < this.met1) return "";
        metric = this.met2;
      }
    } else {
      if (this.symcounter) return "";
      c = this.dec2.decode(this.symbolpair0, this.symbolpair1);
      if (c === -1) return "";
      this.met2 = decayavg(this.met2, this.dec2.metric, 50);
      raw = this.dec2.metric;
      metric = this.met2;
    }
    const quality = this.scaleMetric(metric);
    this.stats.quality = quality;
    this.fastMet = decayavg(this.fastMet, raw, FAST_WEIGHT);
    const fast = this.scaleMetric(this.fastMet);
    this.onBit?.(quality, fast, metric);
    const open = this.squelch === 0 || (quality >= this.squelch && fast >= Math.max(this.squelch * FAST_OF_SQUELCH, quality * FAST_OF_SLOW));
    this.stats.open = open;
    // fldigi drops the bit when the squelch is closed; here it is read and not printed,
    // so the Varicode stays in step through a dip.
    const before = this.varicode.errors;
    const ch = this.varicode.pushBit(c);
    if (!open) return "";
    this.stats.errors += this.varicode.errors - before;
    if (ch) this.stats.chars += ch.length;
    return ch;
  }

  /**
   * A path metric as 0 to 1: 0 at what noise averages, 1 at a clean signal (254, both soft
   * bits of every pair at the rail). fldigi scales (metric - 60) / 2 for its display, which
   * reads noise at 12-15 with 16 tones but near 0 with MFSK8's 32 - where the soft votes
   * are spread over twice the tones - so one squelch setting meant different things in
   * different modes. Measured on noise: 85 with 16 tones, 57 with 32.
   */
  private scaleMetric(metric: number): number {
    return Math.max(0, Math.min(1, (metric - this.noiseMetric) / (254 - this.noiseMetric)));
  }

  /** fldigi's afc(): a tone sent twice running is one unbroken tone; its bin's turn is the error. */
  private afc(cr: number, ci: number): void {
    if (!this.afcOn || !this.stats.open || this.staticburst) return;
    if (this.currsymbol !== this.prev1symbol) return;
    const dn = this.m - this.lastDecisionM;
    if (dn <= 0) return;
    // z = conj(prev) * curr
    const zr = this.prev1Re * cr + this.prev1Im * ci;
    const zi = this.prev1Re * ci - this.prev1Im * cr;
    if (zr === 0 && zi === 0) return;
    const bins = (Math.atan2(zi, zr) * this.M) / (2 * Math.PI * dn);
    const errHz = bins * this.baud;
    if (Math.abs(errHz) > 0.4 * this.spacing) return;
    this.lo += AFC_GAIN * errHz;
    const limit = this.spacing;
    if (this.lo > this.centreHz + limit) this.lo = this.centreHz + limit;
    if (this.lo < this.centreHz - limit) this.lo = this.centreHz - limit;
    this.stats.afcHz = this.lo - this.centreHz;
  }
}
