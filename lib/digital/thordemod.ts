// A Thor demodulator: audio in, text out, as a stream.
//
// The front end is the DominoEX receiver's (lib/digital/dominoexdemod.ts), since the tones
// are DominoEX's: the audio is mixed to complex baseband at the centre, decimated by a box
// average to a fixed number of samples a symbol, and run through a bank of sliding DFTs a
// symbol long, five to a baud ("paths" in fldigi) across the 18 tones and nine tones
// either side. The symbol clock is where the strongest filter peaks on average across
// the sampling phases of a symbol, and only the step between consecutive tones is read,
// so a signal anywhere in the search window, or drifting slowly within it, reads the same.
//
// THE SOFT BITS are where it parts from fldigi. fldigi's receiver (softdecodesymbol,
// thor.cxx:608-729) takes the hard step between the two strongest filters and gives all
// four of its bits one confidence. Here each bit gets its own log-likelihood ratio. Every
// filter gets the likelihood that the tone is there (the Rician ln I0 for the averaged
// signal amplitude over the noise), weighted by a prior: where tones have been lately,
// since a signal's 18 tones land on the same 18 filters symbol after symbol and noise
// peaks do not. Each of the sixteen values a step can carry is then the sum, over every
// place the last tone could have been, of last-tone-there times this-tone-v+2-up (or
// 18-v-2 down, the way the step wraps); each bit is the values with it set against those
// with it clear. A misread last tone, which in fldigi spoils both its symbols with full
// confidence, here only spreads the votes. That and the prior were worth about a dB over
// taking the step between the two strongest filters. The bits go through the de-interleaver and the Viterbi
// decoder (lib/digital/fec.ts) in fldigi's pairs (decodePairs, thor.cxx:525-563) and the
// decoded bits through the Varicode.
//
// THE PREAMBLE. An over starts with sixteen symbols of value 0, steps of two tones. Seven
// in ten is taken as the preamble, as fldigi's preambledetect (thor.cxx:857-881) counts
// them: the de-interleaver and the decoder are cleared (softflushrx, thor.cxx:884-899) and
// those symbols are not fed to them. What first comes out of the decoder after that is the
// far end's interleaver filler and is not read (see decodePair).
//
// QUALITY AND THE SQUELCH are MFSK's (lib/digital/mfskdemod.ts): the Viterbi decoder's
// path metric over each decoded bit, averaged over 50 bits, scaled 0 for what noise
// averages and 1 for a clean signal. The metric belongs to the bit being output, so it
// lines up with the text even though the text comes out of the de-interleaver and the
// decoder well after its audio (30 symbols of interleaving and 45 bits of traceback in the
// slow submodes, 150 and 180 in the fast ones). Below the squelch the bits are still
// decoded, so nothing has to catch up when it opens, but nothing prints. A character
// waits twelve bits and prints only if its own bits and the twelve after them, averaged,
// read as signal.
//
// BETWEEN OVERS. The far end's interleaver spreads every bit over 3 x depth symbols, so
// the last stretch of an over is only partly sent and the first stretch out of a receiver
// is partly what was there before: both decode, with a middling metric, as junk, and the
// stronger the signal the more confident the junk. fldigi prints it. Here the receiver
// mutes at EOT, at a character from after the signal ended (when that is clear), and
// after a long silence, and unmutes at a preamble, a clean STX, or a run of clean text
// with a signal on the air throughout (a station picked up mid-over). Digital silence (a
// FlexRadio's DAX between overs is exact zeros) is under -80 dBFS and goes to the decoder
// as erasures, which carry no metric and cannot open the squelch; the rest of an over
// still in the pipeline decodes through it.
//
// Not ported: fldigi's CW-interference masks (softdecode, thor.cxx:782-855) beyond its
// simplest rule - a tone at the last symbol's position is not this symbol's, since IFK+
// never repeats one - the FFT pre-filter, the image modes, and the s/n readout.
//
// scripts/check-thor.ts runs it clean, offset, in noise, against injected symbol errors,
// chunked, and on noise and silence alone.

import { Interleaver, PUNCTURE, ViterbiDecoder } from "@/lib/digital/fec";
import { THOR_TONES, ThorVaricodeDecoder, thorParams, type ThorMode } from "@/lib/digital/thor";

export interface ThorDemodOptions {
  sampleRate: number;
  /** Centre of the tone set, Hz audio. */
  centreHz: number;
  mode: ThorMode;
  /**
   * Squelch, 0 to 1: the quality (see above) below which characters are not printed.
   * Noise reads under 0.1, a signal at the edge of copy 0.2 to 0.4, a clean one near 1.
   * 0 disables it. Default 0.15.
   */
  squelch?: number;
}

export interface ThorDemodStats {
  /** Characters delivered, including spaces and newlines. */
  chars: number;
  /** Varicodes no character has, counted while the squelch is open. */
  errors: number;
  /** 0 to 1: the Viterbi decoder's averaged path metric, 0 for noise and 1 for a clean signal. */
  quality: number;
  /** Where the tone set appears to sit relative to the centre asked for, Hz. */
  afcHz: number;
  /** Whether the squelch is open, as of the last decoded bit. */
  open: boolean;
  /** The strongest tone's amplitude at the last symbol, in the input's units, for a level display. */
  level: number;
}

/** Matched filters per baud: fldigi's THORFASTPATHS (thor.h:67). */
const PATHS = 5;
/** Tones searched either side of the tone set: fldigi's `extones`, THORNUMTONES / 2 (thor.cxx:126). */
const EXTRA_TONES = 9;
/** Decimated samples per symbol per unit of tone spacing, at the least: room for the search span below Nyquist. */
const MIN_SAMPLES_PER_SYMBOL = 48;
/** The timing average, per symbol. */
const TIMING_ALPHA = 1 / 12;
/** A static burst: the strongest filter under this many times the average magnitude (harddecode, thor.cxx:777). */
const STATIC_BURST = 1.2;
/** Of the last PREAMBLE_SPAN steps, PREAMBLE_HITS of value 0 are the preamble (fldigi counts much the same way, preambledetect). */
const PREAMBLE_SPAN = 10;
const PREAMBLE_HITS = 7;
/**
 * Decoder units per unit of log-likelihood ratio: a bit eight times likelier one way than
 * the other (e^8) is at the rail. Copy hardly changes from 6 to 32.
 */
const SOFT_SCALE = 16;
/** The signal-amplitude average, in symbols. */
const AMP_WEIGHT = 16;
/** The tone-position prior's memory, in symbols, and its floor as a fraction of its peak. */
const PRIOR_WEIGHT = 64;
const PRIOR_FLOOR = 0.05;
/** fldigi's decayavg weight for the quality (50 bits, as MFSK's), and the faster one that closes the squelch. */
const SLOW_WEIGHT = 50;
const FAST_WEIGHT = 12;
const FAST_OF_SQUELCH = 0.75;
const FAST_OF_SLOW = 0.5;
/** What the averaged path metric reads on noise alone, measured (see scaleMetric). */
const NOISE_METRIC = 16;
/** Decoded bits a character waits before it prints, and prints only if the squelch is still open then. */
const HOLD_BITS = 12;
/** A character's own quality that only a real signal gives, CLEAN_RUN in a row: the junk around an over peaks near 0.6. */
const CLEAN_QUALITY = 0.75;
const CLEAN_RUN = 4;
/**
 * A symbol has a signal on it when the strongest filter stands PRESENT_DB over the mean of
 * the rest and the average over the last FAST_RATIO_WEIGHT or so symbols is PRESENT_AVG_DB:
 * noise alone averages 7 dB and passes 10 one symbol in thirty, but its average stays
 * under 9. The mute lifts on clean text only while PRESENT_FRACTION of the symbols over
 * the decoder's whole span had one: the junk around an over can be as confident as text
 * (half its bits are real), but it always comes out of the decoder with noise on the air
 * behind it.
 */
const PRESENT_DB = 10;
const PRESENT_AVG_DB = 9;
const FAST_RATIO_WEIGHT = 4;
const PRESENT_FRACTION = 0.9;
/** The ratio is capped here before averaging, so a strong signal's average falls to the noise within a few symbols of its end. */
const RATIO_CAP_DB = 12;
/** A signal is "strong" when its ratio, averaged over STRONG_WEIGHT symbols, was this or more (of the cap) where it was last present. */
const STRONG_DB = 11.5;
const STRONG_WEIGHT = 32;
/** Decoded bits of metric kept: the longest code and the hold, with room to spare. */
const BIT_HISTORY = 64;
/** Symbols of tone positions the offset estimate is taken over. */
const AFC_SYMBOLS = 48;
/** The tone-over-the-rest ratio, dB, above which a symbol counts towards the offset estimate. */
const AFC_RATIO_DB = 12;

/** ln I0(x): the series to 15, the asymptote beyond. */
function lnI0(x: number): number {
  if (x > 15) return x - 0.5 * Math.log(2 * Math.PI * x);
  const q = (x * x) / 4;
  let term = 1;
  let sum = 1;
  for (let k = 1; k < 60; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < sum * 1e-12) break;
  }
  return Math.log(sum);
}

function logAdd(a: number, b: number): number {
  if (a === -Infinity) return b;
  if (b === -Infinity) return a;
  return a > b ? a + Math.log1p(Math.exp(b - a)) : b + Math.log1p(Math.exp(a - b));
}

function decayavg(average: number, input: number, weight: number): number {
  return (input - average) / weight + average;
}

/**
 * The decimated samples a symbol: at least MIN_SAMPLES_PER_SYMBOL per unit of spacing, and
 * where the input has a whole number of samples a symbol (the 8000 Hz submodes at 12, 24
 * and 48 kHz), a divisor of it, so the decimation is a whole number of input samples and
 * the box average does not jitter - which matters at 50 and 100 baud, where the outer
 * tones are a kilohertz or more from the centre.
 */
function samplesPerSymbol(inPerSymbol: number, ds: number): number {
  const min = MIN_SAMPLES_PER_SYMBOL * ds;
  const n = Math.round(inPerSymbol);
  if (Math.abs(inPerSymbol - n) < 1e-9) {
    for (let d = min; d <= n; d++) if (n % d === 0) return d;
  }
  return min;
}

export class ThorDemodulator {
  private readonly fs: number;
  private readonly baud: number;
  private readonly ds: number;
  private centreHz: number;
  private readonly squelch: number;
  private readonly varicode = new ThorVaricodeDecoder();
  private utf8 = new TextDecoder("utf-8");
  private readonly rxinlv: Interleaver;
  private readonly dec: ViterbiDecoder;

  /** Decimated samples per symbol, and per cycle of the twiddle table. */
  private readonly M: number;
  private readonly P: number;
  /** Input samples per decimated sample: fractional for the 11025 Hz submodes. */
  private readonly decim: number;
  /** The mixer sits this far from the centre so the tones fall on filters: half a baud down when they are a baud apart. */
  private readonly mixShiftHz: number;
  /** Filters run from -Q0 to Q0, a fifth of a baud apart. */
  private readonly Q0: number;
  private readonly K: number;
  /** Filters per tone spacing. */
  private readonly W: number;
  private readonly twRe: Float64Array;
  private readonly twIm: Float64Array;

  private loPhase = 0;
  private accI = 0;
  private accQ = 0;
  private accN = 0;
  private clock = 0;

  private readonly xr: Float64Array;
  private readonly xi: Float64Array;
  private head = 0;
  private filled = 0;
  private nMod = 0;
  private readonly sRe: Float64Array;
  private readonly sIm: Float64Array;
  private readonly mag: Float64Array;
  private readonly hist: Float64Array;
  private readonly curLP: Float64Array;
  private readonly prevLP: Float64Array;

  private readonly timing: Float64Array;
  private phaseIndex = 0;
  private samplePhase = 0;
  private sinceLast = 0;

  /** The last symbol's filter, or -1 before the first. */
  private prevBin = -1;
  /** One bit a symbol, newest lowest: whether its likeliest value was 0. */
  private zeroBits = 0;
  private inPreamble = false;
  private preambleHoldoff = 0;
  private readonly soft = new Uint8Array(4);
  private readonly lli = new Float64Array(16);
  /** The tone's energy above the noise, averaged: the signal amplitude the soft bits are scaled by. */
  private ampE = 0;
  private symbolpair0 = 0;
  private symbolpair1 = 0;
  private symcounter = 0;
  private met = 0;
  private fastMet = 0;
  private bitCount = 0;
  /** Each decoded bit's own path metric, the last BIT_HISTORY of them. */
  private readonly bitMetric = new Float64Array(BIT_HISTORY);
  /** The bit the last code ended on. */
  private lastEnd = 0;
  /** Between overs: nothing prints until an over starts (see decodePair). */
  private muted = true;
  /** Clean characters heard while muted, waiting for CLEAN_RUN of them. */
  private cleanRun: number[] = [];
  /** Decoded bits in a row with the squelch shut. */
  private quietBits = 0;
  /** Per symbol over the decoder's span: whether a signal stood clear of the noise. */
  private readonly presentRing: Uint8Array;
  private presentHead = 0;
  private presentCount = 0;
  private pending: { ch: number; from: number; at: number; sym: number }[] = [];
  private symbolCount = 0;
  /** The bit the over's own bits start at, after a preamble (see decodePair), and whether its first character is still to be dropped. */
  private startBit = 0;
  private dropFirst = false;
  private readonly depth: number;
  private readonly traceback: number;
  /** The last symbol with a signal on it. */
  private lastPresentAt = 0;
  private fastRatio = 0;
  private prevPresentAt = 0;
  private strongRatio = 0;
  private endStrength = 0;
  /** Symbols after the last signal past which a character is from the over's unsent tail (see decodePair). */
  private readonly goneAfter: number;
  private secondary = "";

  private readonly afcRing: Float64Array;
  private afcCount = 0;
  private afcHead = 0;

  private readonly stats: ThorDemodStats = { chars: 0, errors: 0, quality: 0, afcHz: 0, open: false, level: 0 };

  constructor(opts: ThorDemodOptions) {
    const p = thorParams(opts.mode);
    this.fs = opts.sampleRate;
    this.baud = p.baud;
    this.ds = p.doubleSpaced;
    this.centreHz = opts.centreHz;
    this.squelch = Math.max(0, Math.min(1, opts.squelch ?? 0.15));
    this.M = samplesPerSymbol(this.fs / this.baud, this.ds);
    this.P = PATHS * this.M;
    this.decim = this.fs / (this.M * this.baud);
    if (this.decim < 1) throw new Error(`Thor ${opts.mode} needs a higher sample rate than ${this.fs}`);
    // Tone n sits (n - 8.5) spacings from the centre. A baud apart that is a half-integer
    // number of bauds, so the mixer moves half a baud down and the tones land on whole
    // filters; two or four bauds apart it is already a whole number of bauds.
    this.mixShiftHz = this.ds === 1 ? -this.baud / 2 : 0;
    this.W = this.ds * PATHS;
    this.Q0 = (THOR_TONES / 2 + EXTRA_TONES) * this.W;
    this.K = 2 * this.Q0 + 1;
    this.twRe = new Float64Array(this.P);
    this.twIm = new Float64Array(this.P);
    for (let m = 0; m < this.P; m++) {
      this.twRe[m] = Math.cos((2 * Math.PI * m) / this.P);
      this.twIm[m] = -Math.sin((2 * Math.PI * m) / this.P);
    }
    this.xr = new Float64Array(this.M);
    this.xi = new Float64Array(this.M);
    this.sRe = new Float64Array(this.K);
    this.sIm = new Float64Array(this.K);
    this.mag = new Float64Array(this.K);
    this.hist = new Float64Array(this.K);
    this.curLP = new Float64Array(this.K);
    this.prevLP = new Float64Array(this.K);
    this.timing = new Float64Array(this.M);
    this.afcRing = new Float64Array(AFC_SYMBOLS);
    // Rxinlv = new interleave(4, idepth, INTERLEAVE_REV); Dec with settraceback and
    // setchunksize(1): a bit out for every pair in (thor.cxx:398-410).
    this.depth = p.depth;
    this.traceback = p.traceback;
    this.rxinlv = new Interleaver(4, p.depth, "rev");
    this.dec = new ViterbiDecoder(p.k, p.poly1, p.poly2);
    this.dec.setTraceback(p.traceback);
    this.dec.setChunkSize(1);
    // The span from a symbol on the air to its bits out of the decoder: the interleaver's
    // 3 x depth symbols and the traceback's bits, two to a symbol, and the hold.
    // The last text character leaves the decoder at most the traceback, less the slack -
    // how far the over's end (CR EOT CR and the flush idles, in symbols) outlasts the
    // interleaver - after the signal ends; the junk at least the traceback after. Split the
    // difference.
    const endBits = 2 * (8 + 11 + 8 + 11 * p.flushLength);
    const slack = endBits / 4 - 3 * p.depth;
    this.goneAfter = Math.floor((Math.max(0, p.traceback / 2 - slack) + p.traceback / 2) / 2);
    this.presentRing = new Uint8Array(3 * p.depth + Math.ceil((p.traceback + HOLD_BITS) / 2));
  }

  get statistics(): Readonly<ThorDemodStats> {
    return this.stats;
  }

  /** The secondary-alphabet text heard lately (fldigi's idle text: usually its version), newest last. */
  get secondaryText(): string {
    return this.secondary;
  }

  /**
   * Move the tone set while running. The offset estimate and the tone-position prior start
   * over (the tones are on other filters now), and so does the IFK+ reference.
   */
  retune(centreHz: number): void {
    this.centreHz = centreHz;
    this.hist.fill(0);
    this.prevBin = -1;
    this.afcCount = 0;
    this.afcHead = 0;
    this.stats.afcHz = 0;
  }

  /** Forget everything heard: front end, timing, de-interleaver, decoder, Varicode, squelch, held text. */
  reset(): void {
    this.loPhase = 0;
    this.accI = this.accQ = this.accN = 0;
    this.clock = 0;
    this.xr.fill(0);
    this.xi.fill(0);
    this.head = 0;
    this.filled = 0;
    this.nMod = 0;
    this.sRe.fill(0);
    this.sIm.fill(0);
    this.timing.fill(0);
    this.phaseIndex = 0;
    this.samplePhase = 0;
    this.sinceLast = 0;
    this.prevBin = -1;
    this.zeroBits = 0;
    this.inPreamble = false;
    this.preambleHoldoff = 0;
    this.mag.fill(0);
    this.hist.fill(0);
    this.curLP.fill(0);
    this.prevLP.fill(0);
    this.ampE = 0;
    this.presentRing.fill(0);
    this.presentHead = 0;
    this.presentCount = 0;
    this.symbolCount = 0;
    this.lastPresentAt = 0;
    this.fastRatio = 0;
    this.prevPresentAt = 0;
    this.strongRatio = 0;
    this.endStrength = 0;
    this.flushDecoder();
    this.startBit = 0;
    this.dropFirst = false;
    this.muted = true;
    this.cleanRun = [];
    this.quietBits = 0;
    this.met = 0;
    this.fastMet = 0;
    this.bitCount = 0;
    this.bitMetric.fill(0);
    this.lastEnd = 0;
    this.pending = [];
    this.secondary = "";
    this.utf8 = new TextDecoder("utf-8");
    this.afcCount = 0;
    this.afcHead = 0;
    this.afcRing.fill(0);
    this.soft.fill(0);
    this.lli.fill(0);
    this.stats.quality = 0;
    this.stats.afcHz = 0;
    this.stats.open = false;
    this.stats.level = 0;
  }

  /** softflushrx's effect: the de-interleaver full of erasures, the decoder and the Varicode from scratch. */
  private flushDecoder(): void {
    this.rxinlv.flush();
    this.dec.reset();
    this.varicode.reset();
    this.muted = false;
    this.cleanRun = [];
    this.quietBits = 0;
    this.symbolpair0 = this.symbolpair1 = 0;
    this.symcounter = 0;
    this.pending = [];
    // The decoder's first bits after this are the far end's interleaver fill, read
    // through erasures (see decodePair): the over's own bits start this many bits on.
    this.startBit = this.bitCount + 6 * this.depth + this.traceback;
    this.dropFirst = true;
  }

  feed(samples: ArrayLike<number>): string {
    let out = "";
    const dphi = (2 * Math.PI * (this.centreHz + this.mixShiftHz)) / this.fs;
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i]!;
      this.accI += x * Math.cos(this.loPhase);
      this.accQ -= x * Math.sin(this.loPhase);
      this.accN++;
      this.loPhase += dphi;
      if (this.loPhase > 2 * Math.PI) this.loPhase -= 2 * Math.PI;
      this.clock += 1;
      if (this.clock < this.decim - 1e-9) continue;
      this.clock -= this.decim;
      const dI = this.accI / this.accN;
      const dQ = this.accQ / this.accN;
      this.accI = this.accQ = this.accN = 0;
      out += this.decimated(dI, dQ);
    }
    return out;
  }

  /** One decimated sample: slide the filters, the timing average, and a symbol when it is time. */
  private decimated(xI: number, xQ: number): string {
    const { M, P, K, Q0 } = this;
    const oldI = this.xr[this.head]!;
    const oldQ = this.xi[this.head]!;
    this.xr[this.head] = xI;
    this.xi[this.head] = xQ;
    this.head = (this.head + 1) % M;
    const n = this.nMod;
    const nOld = (((n - M) % P) + P) % P;
    let ia = (((-Q0 * n) % P) + P) % P;
    let io = (((-Q0 * nOld) % P) + P) % P;
    for (let k = 0; k < K; k++) {
      const ar = this.twRe[ia]!;
      const ai = this.twIm[ia]!;
      const or = this.twRe[io]!;
      const oi = this.twIm[io]!;
      this.sRe[k] = this.sRe[k]! + (xI * ar - xQ * ai) - (oldI * or - oldQ * oi);
      this.sIm[k] = this.sIm[k]! + (xI * ai + xQ * ar) - (oldI * oi + oldQ * or);
      ia += n;
      if (ia >= P) ia -= P;
      io += nOld;
      if (io >= P) io -= P;
    }
    this.nMod = (n + 1) % P;
    if (this.nMod === 0) this.recompute();
    if (this.filled < M) {
      this.filled++;
      return "";
    }

    let peakE = 0;
    for (let k = 0; k < K; k++) {
      const e = this.sRe[k]! * this.sRe[k]! + this.sIm[k]! * this.sIm[k]!;
      if (e > peakE) peakE = e;
    }
    const thisPhase = this.phaseIndex;
    this.timing[thisPhase] = this.timing[thisPhase]! + TIMING_ALPHA * (Math.sqrt(peakE) - this.timing[thisPhase]!);
    this.phaseIndex = (this.phaseIndex + 1) % M;
    this.sinceLast++;
    if (thisPhase !== this.samplePhase || this.sinceLast < M / 2) return "";
    this.sinceLast = 0;
    const out = this.symbol();
    let best = 0;
    for (let ph = 1; ph < M; ph++) if (this.timing[ph]! > this.timing[best]!) best = ph;
    if (this.timing[best]! > this.timing[this.samplePhase]! * 1.02) this.samplePhase = best;
    return out;
  }

  /** The filters from the window itself, so rounding in the sliding sums cannot accumulate. nMod is 0 here. */
  private recompute(): void {
    const { M, P, K, Q0 } = this;
    this.sRe.fill(0);
    this.sIm.fill(0);
    for (let j = 0; j < M; j++) {
      const slot = (this.head + j) % M;
      const xI = this.xr[slot]!;
      const xQ = this.xi[slot]!;
      if (xI === 0 && xQ === 0) continue;
      const idx = P - M + j;
      let it = (((-Q0 * idx) % P) + P) % P;
      for (let k = 0; k < K; k++) {
        const ar = this.twRe[it]!;
        const ai = this.twIm[it]!;
        this.sRe[k] = this.sRe[k]! + (xI * ar - xQ * ai);
        this.sIm[k] = this.sIm[k]! + (xI * ai + xQ * ar);
        it += idx;
        if (it >= P) it -= P;
      }
    }
  }

  /** One symbol: the tone, the soft bits, the preamble, and on into the decoder. */
  private symbol(): string {
    const { K, M, W } = this;
    let allMag = 0;
    for (let k = 0; k < K; k++) {
      const m = Math.hypot(this.sRe[k]!, this.sIm[k]!);
      this.mag[k] = m;
      allMag += m;
    }
    // The hard tone, for the offset estimate and the level: the strongest filter, but
    // not at the last symbol's tone - IFK+ never sends the same tone twice, so a peak there
    // is the last symbol's tail or a carrier (the simplest of fldigi's softdecode rules,
    // thor.cxx:836).
    let peakK = 0;
    let peak = -1;
    const prev = this.prevBin;
    for (let k = 0; k < K; k++) {
      if (prev >= 0 && Math.abs(k - prev) <= W / 2) continue;
      if (this.mag[k]! > peak) {
        peak = this.mag[k]!;
        peakK = k;
      }
    }
    // The noise: the mean energy away from the tone (two tones either side left out, where
    // its filter skirts are).
    const guard = 2 * W;
    let sumE = 0;
    let nOther = 0;
    for (let k = 0; k < K; k++) {
      if (Math.abs(k - peakK) <= guard) continue;
      sumE += this.mag[k]! * this.mag[k]!;
      nOther++;
    }
    const meanE = nOther > 0 ? sumE / nOther : 0;
    const staticBurst = peak < STATIC_BURST * (allMag / K);
    // Under -80 dBFS is no signal at all: digital silence goes to the decoder as erasures.
    const level = (2 * peak) / M;
    const silent = level < 1e-4 || meanE <= 0;
    this.stats.level = level;
    const ratioDb = silent ? 0 : 10 * Math.log10((peak * peak) / meanE);

    // How likely a tone is at each filter: the Rician likelihood ratio ln I0(2 A r / N) for
    // a tone of amplitude A in noise of energy N (the common factor exp(-A^2/N) drops out,
    // since every hypothesis has one tone), plus the prior - where tones have been lately.
    // A signal's 18 tones fall on the same 18 filters symbol after symbol; noise does not.
    // The prior is uniform until a signal has been heard, and it is what keeps a noise peak
    // somewhere no tone has been from being read as one.
    if (!silent) this.ampE += (Math.max(0, peak * peak - meanE) - this.ampE) / AMP_WEIGHT;
    const a = silent ? 0 : (2 * Math.sqrt(this.ampE)) / meanE;
    let maxH = 0;
    for (let k = 0; k < K; k++) maxH = Math.max(maxH, this.hist[k]!);
    const floor = PRIOR_FLOOR * Math.max(maxH, 1e-9);
    for (let k = 0; k < K; k++) this.curLP[k] = lnI0(a * this.mag[k]!) + Math.log(Math.max(this.hist[k]!, 0) + floor);
    if (!silent) for (let k = 0; k < K; k++) this.hist[k] = this.hist[k]! + ((this.mag[k]! * this.mag[k]!) / meanE - 1 - this.hist[k]!) / PRIOR_WEIGHT;

    if (prev < 0) {
      this.prevBin = peakK;
      this.prevLP.set(this.curLP);
      return "";
    }

    // Soft: the likelihood of each value 0-15, summed over every place the last tone could
    // have been: the last tone at j and this one v + 2 tones up from it, or 18 - (v + 2)
    // down, the way the step wraps round the tone set. Then each bit's log-likelihood
    // ratio, the values with it set against those with it clear, scaled into the decoder's
    // 0-255 (fldigi's soft bits are the same scale: 128 no idea, 0 and 255 sure).
    for (let v = 0; v < 16; v++) {
      const up = (v + 2) * W;
      const down = (v + 2 - THOR_TONES) * W;
      let acc = -Infinity;
      for (let j = 0; j < K; j++) {
        const u = j + up;
        const d = j + down;
        let c = -Infinity;
        if (u < K) c = this.curLP[u]!;
        if (d >= 0) c = logAdd(c, this.curLP[d]!);
        if (c !== -Infinity) acc = logAdd(acc, this.prevLP[j]! + c);
      }
      this.lli[v] = acc;
    }
    this.prevLP.set(this.curLP);
    for (let i = 0; i < 4; i++) {
      const bit = 8 >> i;
      let l1 = -Infinity;
      let l0 = -Infinity;
      for (let v = 0; v < 16; v++) {
        if (v & bit) l1 = logAdd(l1, this.lli[v]!);
        else l0 = logAdd(l0, this.lli[v]!);
      }
      this.soft[i] = silent || staticBurst ? PUNCTURE : Math.round(Math.max(0, Math.min(255, PUNCTURE + SOFT_SCALE * (l1 - l0))));
    }
    this.prevBin = peakK;

    if (!silent && !staticBurst && ratioDb >= AFC_RATIO_DB) this.trackOffset(peakK);
    // Whether a signal is on the air now, for the mute (see decodePair).
    // A symbol has a signal on it when its strongest filter stands PRESENT_DB over the rest
    // and the last few have too, on average: noise alone averages 7 dB, passes 10 about one
    // symbol in thirty, and its few-symbol average stays under 9.
    const r = silent || staticBurst ? 0 : Math.min(ratioDb, RATIO_CAP_DB);
    this.fastRatio += (r - this.fastRatio) / FAST_RATIO_WEIGHT;
    const present = r >= PRESENT_DB && this.fastRatio >= PRESENT_AVG_DB ? 1 : 0;
    this.strongRatio += (r - this.strongRatio) / STRONG_WEIGHT;
    this.presentCount += present - this.presentRing[this.presentHead]!;
    this.presentRing[this.presentHead] = present;
    this.presentHead = (this.presentHead + 1) % this.presentRing.length;
    this.symbolCount++;
    // The end of the signal, for the end-of-over rule (see decodePair): the last of two
    // present symbols within three, which a lone noise spike is not.
    if (present && this.symbolCount - this.prevPresentAt <= 2) {
      this.lastPresentAt = this.symbolCount;
      this.endStrength = this.strongRatio;
    }
    if (present) this.prevPresentAt = this.symbolCount;

    // The preamble: steps of two tones, value 0, PREAMBLE_HITS of the last PREAMBLE_SPAN
    // (a misread or two in it, at the edge of copy or while the clock is still settling, does
    // not hide it). Each such step clears the decoder and is not fed to it; the first other
    // value ends it and is the over's first symbol. The likeliest value is the one with the
    // most likelihood, which is surer than the strongest filter.
    let likeliest = 0;
    for (let v = 1; v < 16; v++) if (this.lli[v]! > this.lli[likeliest]!) likeliest = v;
    const zero = likeliest === 0 && !silent && !staticBurst;
    this.zeroBits = ((this.zeroBits << 1) | (zero ? 1 : 0)) & ((1 << PREAMBLE_SPAN) - 1);
    let hits = 0;
    for (let b = this.zeroBits; b; b &= b - 1) hits++;
    if (zero && hits >= PREAMBLE_HITS && this.symbolCount > this.preambleHoldoff) {
      this.inPreamble = true;
      this.flushDecoder();
      return "";
    }
    if (!zero && this.inPreamble) {
      // Over. For the next 3 x depth symbols every symbol on the air carries filler in all
      // but its first bit (the far end's interleaver was full of it), so they are mostly
      // value 0 or 8 and as often as not look like more preamble: none is taken for it.
      this.inPreamble = false;
      this.zeroBits = 0;
      this.preambleHoldoff = this.symbolCount + 3 * this.depth;
    }

    this.rxinlv.symbols(this.soft);
    let out = "";
    for (let i = 0; i < 4; i++) out += this.decodePair(this.soft[i]!);
    return out;
  }

  /** decodePairs (thor.cxx:525-563): soft bits two at a time into the decoder, its bits into the Varicode. */
  private decodePair(sym: number): string {
    this.symbolpair0 = this.symbolpair1;
    this.symbolpair1 = sym;
    this.symcounter = this.symcounter ? 0 : 1;
    if (this.symcounter) return "";
    const c = this.dec.decode(this.symbolpair0, this.symbolpair1);
    if (c === -1) return "";
    const metric = this.dec.metric;
    this.met = decayavg(this.met, metric, SLOW_WEIGHT);
    this.fastMet = decayavg(this.fastMet, metric, FAST_WEIGHT);
    const quality = this.scaleMetric(this.met);
    const fast = this.scaleMetric(this.fastMet);
    this.stats.quality = quality;
    const open = this.squelch === 0 || (quality >= this.squelch && fast >= Math.max(this.squelch * FAST_OF_SQUELCH, quality * FAST_OF_SLOW));
    this.stats.open = open;
    this.bitMetric[this.bitCount % BIT_HISTORY] = metric;
    this.bitCount++;

    // The far end's interleaver starts an over full of filler (clearbits, thor.cxx:1281),
    // which comes out ahead of the over's first bits: 3 x depth symbols of it, two bits a
    // symbol, and the traceback's worth more out of a decoder just cleared. Read through
    // the erasures the flush left, three bits in four unknown, it decodes as whatever the
    // decoder's tie-breaks give, which can be letters. It is not fed to the Varicode, and
    // the first character after it - the idle fldigi starts every over with, or a part of
    // it if the preamble was placed a symbol out - is dropped.
    if (this.bitCount <= this.startBit) {
      if (this.bitCount === this.startBit) this.varicode.reset();
      return "";
    }
    let ch = this.varicode.push(c);
    if (ch !== null && this.dropFirst) {
      this.dropFirst = false;
      ch = -2;
    }
    if (ch !== null && ch !== -2) {
      // The code ran from the bit after the last one completed to the bit before this.
      if (open && ch < 0) this.stats.errors++;
      else if (ch >= 0) this.pending.push({ ch, from: this.lastEnd, at: this.bitCount, sym: this.symbolCount });
      this.lastEnd = this.bitCount - 1;
    }
    let out = "";
    // A long stretch with the squelch shut - twice the decoder's span, so not the start of
    // an over, while the de-interleaver fills - and whatever comes next is a new signal.
    if (quality < this.squelch * FAST_OF_SQUELCH) {
      if (++this.quietBits >= 4 * this.presentRing.length) this.muted = true;
    } else this.quietBits = 0;
    while (this.pending.length > 0 && this.pending[0]!.at + HOLD_BITS <= this.bitCount) {
      const held = this.pending.shift()!;
      if (this.squelch === 0) {
        out += this.deliver(held.ch);
        continue;
      }
      const own = this.ownQuality(held.from);
      // The squelch: open on the slow average, and the character's own bits and the
      // HOLD_BITS after it, averaged, read as signal. The second stops the noise after an
      // over: the slow average takes a second or two to fall, the character's bits are
      // noise from the first.
      if (quality < this.squelch * FAST_OF_SQUELCH || own < Math.max(this.squelch, quality * FAST_OF_SLOW)) {
        this.cleanRun = [];
        continue;
      }
      const ch = held.ch;
      if (this.endStrength >= STRONG_DB && held.sym - this.lastPresentAt > this.goneAfter) {
        // The signal ended so long before this character came out of the decoder that some
        // of its bits were never sent: the far end's interleaver still held them when it
        // stopped. Every bit leaves the far end's interleaver 3 x depth symbols after it
        // enters, and leaves this decoder the traceback after its last symbol arrives, so a
        // character out more than the traceback after the last signal is from that tail -
        // the flush, or junk. In Thor 4, 5 and 8 the flush is shorter than the interleaver
        // and the EOT itself can be lost there, so this, not the EOT, is what ends the over.
        // Only for a signal well clear of the noise, whose end is sharp: a weak one's last
        // symbols can read as noise, and its junk does not pass the squelch anyway.
        this.muted = true;
        this.cleanRun = [];
        continue;
      }
      if (this.muted) {
        // Between overs. What follows an EOT is the flush and then the stretch the far
        // end's interleaver never finished sending, and what precedes an over is the noise
        // still in this end's de-interleaver mixed with the over's first symbols: half real
        // bits and half noise, which the decoder reads with a middling metric and turns into
        // a line of junk - the more, the deeper the interleaver. fldigi prints it. Here
        // nothing prints until the over's preamble (see symbol), or a clean STX (the over's
        // start, when the preamble was missed), or CLEAN_RUN printable characters running as
        // clean as only a real signal gives - a station picked up mid-over - which then
        // print - and in either case only with a signal on the air over the decoder's whole
        // span (PRESENT_DB). The junk reads a control character as often as any other, so an
        // STX or an SOH alone is not enough.
        const onAir = this.presentCount >= PRESENT_FRACTION * this.presentRing.length;
        if (ch === 2 && own >= CLEAN_QUALITY && onAir) {
          this.muted = false;
          this.cleanRun = [];
        } else if (ch >= 32 && ch < 256 && own >= CLEAN_QUALITY && onAir) {
          this.cleanRun.push(ch);
          if (this.cleanRun.length < CLEAN_RUN) continue;
          this.muted = false;
          for (const c of this.cleanRun.slice(0, -1)) out += this.deliver(c);
          this.cleanRun = [];
        } else {
          this.cleanRun = [];
          continue;
        }
      }
      out += this.deliver(ch);
      if (ch === 4) this.muted = true;
    }
    return out;
  }

  /** The quality of the bits from `from` to now: a held character's own and the hold after it. */
  private ownQuality(from: number): number {
    const first = Math.max(from, this.bitCount - BIT_HISTORY);
    let sum = 0;
    for (let b = first; b < this.bitCount; b++) sum += this.bitMetric[b % BIT_HISTORY]!;
    const n = this.bitCount - first;
    return n > 0 ? this.scaleMetric(sum / n) : 0;
  }

  /**
   * A path metric as 0 to 1: 0 at what noise averages, 1 at a clean signal (254, both soft
   * bits of every pair at the rail), as MFSK's receiver scales it.
   */
  private scaleMetric(metric: number): number {
    return Math.max(0, Math.min(1, (metric - NOISE_METRIC) / (254 - NOISE_METRIC)));
  }

  /** The offset estimate: the middle of the tone positions seen lately, once they span most of the set. */
  private trackOffset(peakK: number): void {
    const hz = this.mixShiftHz + ((peakK - this.Q0) * this.baud) / PATHS;
    this.afcRing[this.afcHead] = hz;
    this.afcHead = (this.afcHead + 1) % AFC_SYMBOLS;
    this.afcCount = Math.min(AFC_SYMBOLS, this.afcCount + 1);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < this.afcCount; i++) {
      lo = Math.min(lo, this.afcRing[i]!);
      hi = Math.max(hi, this.afcRing[i]!);
    }
    const spacing = this.ds * this.baud;
    if (hi - lo >= 14 * spacing) this.stats.afcHz = (lo + hi) / 2;
  }

  /** A held character, out: secondary to its own text, primary as printable text. */
  private deliver(ch: number): string {
    if (ch >= 256) {
      const c = ch - 256;
      if (c >= 32 && c < 127) this.secondary = (this.secondary + String.fromCharCode(c)).slice(-80);
      return "";
    }
    return this.printable(ch);
  }

  /** A primary byte as text: CR is silent and LF the newline, STX, EOT and the other controls are framing, bytes over 127 are UTF-8. */
  private printable(byte: number): string {
    if (byte === 10) {
      this.stats.chars++;
      return "\n";
    }
    if (byte < 32 || byte === 127) return "";
    const s = this.utf8.decode(Uint8Array.of(byte), { stream: true }).replace(/�/g, "");
    this.stats.chars += s.length;
    return s;
  }
}
