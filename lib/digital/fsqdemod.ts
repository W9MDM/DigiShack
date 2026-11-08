// An FSQ demodulator: audio in, text out, as a stream - and the 33-tone IFK receiver it is
// built on, which IFKP (lib/digital/ifkpdemod.ts) shares.
//
// fldigi's FSQ receiver (rx_process and process_tones, fsq.cxx:1131-1330) runs a 4096-point
// FFT every 256 samples, smooths each bin over a few frames, takes the strongest bin, and
// counts a new symbol when the strongest bin has moved and then stayed put for three frames
// (`fsqhits`). It never needs symbol timing at all: IFK always moves the tone, so a move is
// a symbol. That is robust on a clean signal, but the FFT is 341 ms long whatever the
// speed - two to three symbols at 6 baud - and the "stayed put" rule is a guess at
// timing that noise breaks easily. This receiver keeps fldigi's idea - the strongest tone,
// and only the step from the last one - and reads it the way the DominoEX receiver here
// does (lib/digital/dominoexdemod.ts):
//
//   A bank of matched filters exactly one symbol long, across the 33 tones and eight tones
//   either side, packed no more than half a baud apart (4, 6 or 12 to a tone spacing,
//   depending on how many baud apart the tones are). At each symbol the strongest filter is
//   the tone; the step from the last symbol's tone, in tone spacings, less one, modulo 33,
//   is the nibble (init_nibbles, fsq.cxx:116-130); the nibbles go through the Varicode.
//
//   FREQUENCY needs no tracking: only differences are read, so a signal anywhere within the
//   eight-tone margin - about 70 Hz either way in FSQ, 94 Hz in IFKP - reads the same. The
//   offset is still reported, from the spread of tones seen.
//
//   SYMBOL TIMING. The strongest filter is strongest when its window covers exactly one
//   symbol. Its magnitude at every one of the decimated sampling phases across a symbol is
//   averaged over the last few symbols, and the decision is taken at the phase with the
//   largest - a symbol late, from what the filters held then, with the phase chosen half a
//   symbol before that, so the timing has seen a symbol and a half past the one it reads.
//   FSQ's preamble is three symbols, and the first of them must already be read right. A
//   step is never 0, so every symbol boundary teaches the timing something.
//
//   WHETHER A CHARACTER IS REAL. On a signal one filter stands well clear of the rest; on
//   noise the strongest of a few hundred is only a few times their mean. That ratio, in dB,
//   is worked out at every symbol; averaged, it is the quality (noise near 0, a clean signal
//   1). A character is held two symbols after it completes and then prints only if
//     (a) the middle value of the ratios over the seven symbols from four before it to two
//         after clears the squelch - a majority vote: the last character of an over has five
//         symbols of signal in its seven and prints, one completed by noise two symbols
//         after the over has three and does not;
//     (b) every symbol it was read from - including the one before its first nibble, since
//         a nibble is a step between two tones - reads 1.5 dB over the noise floor and no
//         more than 6 dB under that middle value: a window that held only part of a tone,
//         or none, has no business in a character;
//     (c) where the signal stops just after it, its last symbol reads within 3 dB of the
//         signal, and where the signal starts just before it, its first symbol does. These
//         are the two characters (a) cannot see: the one the first symbol of noise after an
//         over completes, and the one the first symbol of an over completes from the noise
//         before it.
//   FSQ's preamble is three characters, so a squelch that had to average its way open would
//   lose the callsign; this one decides each character from the symbols around it.
//
// The audio is mixed to complex baseband at the middle tone and box-averaged down to 64
// samples a tone spacing (562.5 Hz for FSQ, 750 Hz for IFKP), on a fractional clock; the
// symbol is then a whole number of samples at every speed (96 to 384), because the tones
// are 1.5, 2.25, 3, 4.5 or 6 baud apart and 64 times any of those is whole. The matched
// filters are sliding DFTs, recomputed from the window now and then so rounding cannot
// build up. Chunks of any size give the same text as one call: nothing here depends on a
// chunk boundary.
//
// scripts/check-fsq.ts and scripts/check-ifkp.ts run it clean, offset, in noise, chunked,
// on noise alone and on digital silence.

import {
  FSQ_CENTRE_HZ,
  FSQ_TONE_SPACING_HZ,
  IFK33_TONES,
  Ifk33VaricodeDecoder,
  FSQ_VARICODE,
  fsqParams,
  fsqToneHz,
  ifk33Printable,
  type FsqSpeed,
  type Ifk33Varicode,
} from "@/lib/digital/fsq";

/** What every demodulator here reports: the shape lib/radio/modems.ts reads. */
export interface Ifk33DemodStats {
  /** Characters delivered, including spaces and newlines. */
  chars: number;
  /** Varicodes no character has, counted when they would have printed. */
  errors: number;
  /** 0 to 1: how far the strongest filter stands above the rest, averaged. */
  quality: number;
  /** Where the tone set appears to sit relative to where it was expected, Hz. */
  afcHz: number;
  /** Whether the squelch is open: the quality over the squelch at the last symbol. */
  open: boolean;
  /** The strongest tone's amplitude at the last symbol, in the input's units, for a level display. */
  level: number;
}

export interface Ifk33ReceiverConfig {
  sampleRate: number;
  /** The true symbol rate, baud. */
  baud: number;
  toneSpacingHz: number;
  /** Where tone 0 to 32 sits for an operator's frequency: fsqToneHz or ifkpToneHz. */
  toneHz: (tone: number, centreHz: number) => number;
  centreHz: number;
  varicode: Ifk33Varicode;
  /** A received character code to text. */
  printable: (code: number) => string;
  /** 0 to 1; see the demodulator options. */
  squelch?: number;
}

/**
 * Matched filters per tone spacing, at most: the filters have to sit no more than about half a
 * baud apart, or a tone that falls between two of them (any station not exactly on the
 * receiver's frequency) loses up to 10 dB and the timing locks onto windows that straddle
 * two symbols. Tones six baud apart (FSQ 1.5, IFKP 0.5) take all twelve; the others take
 * 6 or 4, which divide it, so one twiddle table serves every speed.
 */
const R_MAX = 12;
/** Tones searched either side of the tone set. */
const MARGIN_TONES = 8;
/** Decimated samples per tone spacing: the search span, ±24.5 spacings, fits under Nyquist at ±32. */
const D = 64;
/** The twiddle table: one step is 1 / P of the decimated rate, a twelfth of a tone spacing. */
const P = D * R_MAX;
/** The middle tone, where the mixer sits. */
const MID_TONE = (IFK33_TONES - 1) / 2;
/** The timing average, per symbol. */
const TIMING_ALPHA = 1 / 4;
/** The quality average, per symbol. */
const QUALITY_ALPHA = 1 / 4;
/**
 * Quality scale, dB of strongest-over-the-rest: the floor reads 0 and QUALITY_SPAN_DB more
 * reads 1. The floor is where noise alone sits, which depends on how closely the filters are
 * packed: over two minutes of generated noise the average ran 8.0 dB with four filters a
 * spacing, 8.2 to 8.3 with six and 8.5 to 8.6 with twelve, at every speed of both modes, and
 * never passed 9.7. The floor is a quarter of a dB above the average.
 */
const QUALITY_FLOOR_DB: Record<number, number> = { 4: 8.25, 6: 8.5, 12: 8.75 };
/** Quality scale: this many dB over the noise floor reads 1. */
const QUALITY_SPAN_DB = 12;
/** Symbols a character is held after it completes: the window of (a) above runs this far after it... */
const HOLD = 2;
/** ...and this far before. */
const BEFORE = 4;
/** (b) above: every symbol a character is read from must have a ratio this far over the floor... */
const SYMBOL_FLOOR_DB = 1.5;
/**
 * ...and no further than this under the middle of the ratios around it. A window that straddles
 * the start of an over holds only part of the first tone and reads several dB under the full
 * symbols after it; its tone is wrong as often as not.
 */
const SYMBOL_DIP_DB = 6;
/** (c) in the header: the last symbol before the signal stops, this close to the ratios before it. */
const END_DIP_DB = 3;
/** Symbols of tone positions the offset estimate is taken over. */
const AFC_SYMBOLS = 64;
/** Recompute the filters from the window every this many decimated samples. */
const RECOMPUTE = 4 * P;

export class Ifk33Receiver {
  private readonly fs: number;
  private readonly cfg: Ifk33ReceiverConfig;
  private centreHz: number;
  private mixHz: number;
  private readonly squelch: number;
  private readonly varicode: Ifk33VaricodeDecoder;
  /** dB of strongest-over-the-rest where noise alone sits: quality 0. */
  private readonly floorDb: number;

  /** Decimated samples per symbol. */
  private readonly M: number;
  private readonly decim: number;
  /** Filters per tone spacing, twiddle steps per filter, and the filters either side of the strongest left out of the noise mean (two tones). */
  private readonly R: number;
  private readonly S: number;
  private readonly guard: number;
  private readonly Q0: number;
  private readonly K: number;
  private readonly twRe: Float64Array;
  private readonly twIm: Float64Array;

  private loPhase = 0;
  private accI = 0;
  private accQ = 0;
  private accN = 0;
  private clock = 0;

  // The last symbol of decimated baseband, with each sample's time index modulo P.
  private readonly xr: Float64Array;
  private readonly xi: Float64Array;
  private readonly xt: Int32Array;
  private head = 0;
  private filled = 0;
  private nMod = 0;
  private sinceRecompute = 0;
  private readonly sRe: Float64Array;
  private readonly sIm: Float64Array;

  private readonly timing: Float64Array;
  /** The strongest filter, its energy and the mean away from it, at each phase over the last symbol; -1 for none yet. */
  private readonly histK: Int32Array;
  private readonly histE: Float64Array;
  private readonly histMean: Float64Array;
  private phaseIndex = 0;
  private samplePhase = 0;
  /** Decimated samples since the last decision: starts high, so the first full window is read. */
  private sinceLast = Number.MAX_SAFE_INTEGER;

  /** The last symbol's filter, or -1 when there is none to step from. */
  private prevBin = -1;
  private qualDb = 0;
  /** Each symbol's ratio, dB, by symbol number modulo the ring. */
  private readonly ratios: Float64Array;
  private symbolCount = 0;
  private pending: { ch: number; at: number; from: number }[] = [];
  /** The symbol the last nibble was read at. */
  private lastNibbleAt = -1;
  private readonly afcRing: Float64Array;
  private afcCount = 0;
  private afcHead = 0;

  private readonly stats: Ifk33DemodStats = { chars: 0, errors: 0, quality: 0, afcHz: 0, open: false, level: 0 };

  constructor(cfg: Ifk33ReceiverConfig) {
    this.cfg = cfg;
    this.fs = cfg.sampleRate;
    this.centreHz = cfg.centreHz;
    this.mixHz = cfg.toneHz(MID_TONE, cfg.centreHz);
    this.squelch = Math.max(0, Math.min(1, cfg.squelch ?? 0.2));
    this.varicode = new Ifk33VaricodeDecoder(cfg.varicode);
    const fsd = D * cfg.toneSpacingHz;
    this.M = Math.round(fsd / cfg.baud);
    if (Math.abs(this.M - fsd / cfg.baud) > 1e-6) throw new Error(`${fsd / cfg.baud} decimated samples a symbol is not whole`);
    this.decim = this.fs / fsd;
    if (this.decim < 1) throw new Error(`sample rate ${this.fs} is too low`);
    const spacingInBaud = cfg.toneSpacingHz / cfg.baud;
    this.R = [4, 6, 12].find((r) => r >= 2 * spacingInBaud - 1e-9) ?? R_MAX;
    this.S = R_MAX / this.R;
    this.guard = 2 * this.R;
    this.Q0 = Math.ceil((MID_TONE + 0.5 + MARGIN_TONES) * this.R);
    this.K = 2 * this.Q0 + 1;
    this.twRe = new Float64Array(P);
    this.twIm = new Float64Array(P);
    for (let m = 0; m < P; m++) {
      this.twRe[m] = Math.cos((2 * Math.PI * m) / P);
      this.twIm[m] = -Math.sin((2 * Math.PI * m) / P);
    }
    this.xr = new Float64Array(this.M);
    this.xi = new Float64Array(this.M);
    this.xt = new Int32Array(this.M);
    this.sRe = new Float64Array(this.K);
    this.sIm = new Float64Array(this.K);
    this.timing = new Float64Array(this.M);
    this.histK = new Int32Array(this.M).fill(-1);
    this.histE = new Float64Array(this.M);
    this.histMean = new Float64Array(this.M);
    this.ratios = new Float64Array(32);
    this.afcRing = new Float64Array(AFC_SYMBOLS);
    this.floorDb = QUALITY_FLOOR_DB[this.R]!;
  }

  get statistics(): Readonly<Ifk33DemodStats> {
    return this.stats;
  }

  /** The averaged ratio, dB, for calibration. */
  get qualityDb(): number {
    return this.qualDb;
  }

  /** Move to a new operator frequency while running. The offset estimate starts over. */
  retune(centreHz: number): void {
    this.centreHz = centreHz;
    this.mixHz = this.cfg.toneHz(MID_TONE, centreHz);
    this.afcCount = 0;
    this.afcHead = 0;
    this.stats.afcHz = 0;
  }

  /** Everything back to a fresh start, as after an RSID burst. The character count stays. */
  reset(): void {
    this.varicode.reset();
    this.loPhase = 0;
    this.accI = this.accQ = this.accN = 0;
    this.clock = 0;
    this.xr.fill(0);
    this.xi.fill(0);
    this.xt.fill(0);
    this.head = 0;
    this.filled = 0;
    this.nMod = 0;
    this.sinceRecompute = 0;
    this.sRe.fill(0);
    this.sIm.fill(0);
    this.timing.fill(0);
    this.histK.fill(-1);
    this.histE.fill(0);
    this.histMean.fill(0);
    this.phaseIndex = 0;
    this.samplePhase = 0;
    this.sinceLast = Number.MAX_SAFE_INTEGER;
    this.prevBin = -1;
    this.qualDb = 0;
    this.ratios.fill(0);
    this.symbolCount = 0;
    this.pending = [];
    this.lastNibbleAt = -1;
    this.afcCount = 0;
    this.afcHead = 0;
    this.stats.quality = 0;
    this.stats.afcHz = 0;
    this.stats.open = false;
    this.stats.level = 0;
  }

  feed(samples: ArrayLike<number>): string {
    let out = "";
    const dphi = (2 * Math.PI * this.mixHz) / this.fs;
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i]!;
      this.accI += x * Math.cos(this.loPhase);
      this.accQ -= x * Math.sin(this.loPhase);
      this.accN++;
      this.loPhase += dphi;
      if (this.loPhase > 2 * Math.PI) this.loPhase -= 2 * Math.PI;
      this.clock += 1;
      if (this.clock < this.decim) continue;
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
    const { M, K, Q0, S } = this;
    const oldI = this.xr[this.head]!;
    const oldQ = this.xi[this.head]!;
    const tOld = this.xt[this.head]!;
    const n = this.nMod;
    this.xr[this.head] = xI;
    this.xi[this.head] = xQ;
    this.xt[this.head] = n;
    this.head = (this.head + 1) % M;
    // Filter q's twiddle at time t is index q S t mod P; step it filter by filter.
    const da = (S * n) % P;
    const dO = (S * tOld) % P;
    let ia = (((-Q0 * da) % P) + P) % P;
    let io = (((-Q0 * dO) % P) + P) % P;
    for (let k = 0; k < K; k++) {
      const ar = this.twRe[ia]!;
      const ai = this.twIm[ia]!;
      const or = this.twRe[io]!;
      const oi = this.twIm[io]!;
      this.sRe[k] = this.sRe[k]! + (xI * ar - xQ * ai) - (oldI * or - oldQ * oi);
      this.sIm[k] = this.sIm[k]! + (xI * ai + xQ * ar) - (oldI * oi + oldQ * or);
      ia += da;
      if (ia >= P) ia -= P;
      io += dO;
      if (io >= P) io -= P;
    }
    this.nMod = (n + 1) % P;
    if (++this.sinceRecompute >= RECOMPUTE) this.recompute();
    if (this.filled < M) {
      this.filled++;
      return "";
    }

    let peakE = 0;
    let peakK = 0;
    let allE = 0;
    for (let k = 0; k < K; k++) {
      const e = this.sRe[k]! * this.sRe[k]! + this.sIm[k]! * this.sIm[k]!;
      allE += e;
      if (e > peakE) {
        peakE = e;
        peakK = k;
      }
    }
    // The mean away from the peak: two tones either side are left out, where the peak's own
    // filter skirts are.
    let nearE = 0;
    let nNear = 0;
    for (let k = Math.max(0, peakK - this.guard); k <= Math.min(K - 1, peakK + this.guard); k++) {
      nearE += this.sRe[k]! * this.sRe[k]! + this.sIm[k]! * this.sIm[k]!;
      nNear++;
    }
    const meanE = Math.max(0, allE - nearE) / (K - nNear);

    const ph = this.phaseIndex;
    this.timing[ph] = this.timing[ph]! + TIMING_ALPHA * (Math.sqrt(peakE) - this.timing[ph]!);
    this.phaseIndex = (ph + 1) % M;
    this.sinceLast++;
    // The decision is taken a symbol late, from what the filters held a symbol ago at this
    // phase, and the phase is chosen half a symbol before it: so the timing has seen a symbol
    // and a half past the one being read, which is what gets the first symbols of an over
    // right while the timing is still finding the signal. No decision if the phase moved
    // and the last one was under half a symbol ago, which would read the same symbol twice.
    if (ph === (this.samplePhase + (M >> 1)) % M) {
      let best = 0;
      for (let q = 1; q < M; q++) if (this.timing[q]! > this.timing[best]!) best = q;
      if (this.timing[best]! > this.timing[this.samplePhase]! * 1.02) this.samplePhase = best;
    }
    let out = "";
    if (ph === this.samplePhase && this.sinceLast >= M / 2 && this.histK[ph]! >= 0) {
      this.sinceLast = 0;
      out = this.symbol(this.histK[ph]!, this.histE[ph]!, this.histMean[ph]!);
    }
    this.histK[ph] = peakK;
    this.histE[ph] = peakE;
    this.histMean[ph] = meanE;
    return out;
  }

  /** The filters from the window itself, so rounding in the sliding sums cannot accumulate. */
  private recompute(): void {
    const { M, K, Q0, S } = this;
    this.sinceRecompute = 0;
    this.sRe.fill(0);
    this.sIm.fill(0);
    for (let j = 0; j < M; j++) {
      const xI = this.xr[j]!;
      const xQ = this.xi[j]!;
      if (xI === 0 && xQ === 0) continue;
      const dt = (S * this.xt[j]!) % P;
      let it = (((-Q0 * dt) % P) + P) % P;
      for (let k = 0; k < K; k++) {
        const ar = this.twRe[it]!;
        const ai = this.twIm[it]!;
        this.sRe[k] = this.sRe[k]! + (xI * ar - xQ * ai);
        this.sIm[k] = this.sIm[k]! + (xI * ai + xQ * ar);
        it += dt;
        if (it >= P) it -= P;
      }
    }
  }

  /** The ratio-derived quality, 0 to 1, of a level in dB. */
  private qualityOf(db: number): number {
    return Math.max(0, Math.min(1, (db - this.floorDb) / QUALITY_SPAN_DB));
  }

  /** One symbol: the tone, the nibble, the ratio, and any held character whose time has come. */
  private symbol(peakK: number, peakE: number, meanE: number): string {
    const { M } = this;
    const level = (2 * Math.sqrt(peakE)) / M;
    // Digital silence (a FlexRadio's DAX between overs is exact zeros) has nothing away from
    // the peak either, and would read as a perfect signal. Under -80 dBFS is no signal.
    const silent = level < 1e-4;
    const ratioDb = silent ? 0 : meanE > 0 ? Math.min(60, 10 * Math.log10(peakE / meanE)) : 60;
    // Silence is certainly no signal: the average drops to it at once rather than decaying.
    this.qualDb = silent ? 0 : this.qualDb + QUALITY_ALPHA * (ratioDb - this.qualDb);
    const quality = this.qualityOf(this.qualDb);
    this.stats.quality = quality;
    this.stats.level = level;
    this.stats.open = this.squelch === 0 || quality >= this.squelch;
    this.ratios[this.symbolCount % this.ratios.length] = ratioDb;

    if (silent) {
      // Nothing to step from into the next tone, and no character runs across silence.
      this.prevBin = -1;
      this.varicode.reset();
    } else {
      if (this.prevBin >= 0) {
        // IFK: the step in filters over the filters per spacing, rounded; less one, mod 33.
        const step = (((Math.round((peakK - this.prevBin) / this.R)) % IFK33_TONES) + IFK33_TONES) % IFK33_TONES;
        // A step of 0 is the same tone read twice; no transmitter sends it (fldigi only
        // counts a symbol when the peak moves, process_tones, fsq.cxx:1181-1193).
        if (step !== 0) {
          const ch = this.varicode.push(step - 1);
          if (ch !== null) this.pending.push({ ch, at: this.symbolCount, from: this.lastNibbleAt - 1 });
          this.lastNibbleAt = this.symbolCount;
        }
      }
      this.prevBin = peakK;
      if (this.stats.open) this.trackOffset(peakK);
    }
    this.symbolCount++;

    let out = "";
    while (this.pending.length > 0 && this.pending[0]!.at + HOLD < this.symbolCount) {
      const p = this.pending.shift()!;
      if (this.squelch > 0 && !this.heard(p.from, p.at)) continue;
      if (p.ch < 0) {
        this.stats.errors++;
        continue;
      }
      const s = this.cfg.printable(p.ch);
      this.stats.chars += s.length;
      out += s;
    }
    return out;
  }

  /** Whether a character read from symbols from..at was signal: (a) and (b) in the header. */
  private heard(from: number, at: number): boolean {
    const middle = this.medianRatio(at);
    if (this.qualityOf(middle) < this.squelch) return false;
    // The dip is measured only up to a clean signal: past that, the ratio swings by several dB
    // with how much of each tone leaks into the filters of the others, and means nothing.
    const top = Math.min(middle, this.floorDb + QUALITY_SPAN_DB);
    if (this.minRatio(from, at) < Math.max(this.floorDb + SYMBOL_FLOOR_DB, top - SYMBOL_DIP_DB)) return false;
    // (c) Where the signal stops - the two symbols after this character's last both read as
    // noise - that last symbol must look like the signal before it, not like what follows.
    // It is the one a nibble of noise completes: the first symbol after an over makes a step
    // from the over's last tone, and a step into 29-31 completes a character. And the same
    // where the signal starts: the first symbol of an over is a step from a symbol of noise.
    const n = this.ratios.length;
    const noise = this.floorDb + SYMBOL_FLOOR_DB;
    const r = (s: number) => (s < 0 ? 0 : this.ratios[s % n]!);
    if (Math.max(r(at + 1), r(at + 2)) < noise && r(at) < top - END_DIP_DB) return false;
    const first = Math.max(from, at - 16);
    if (Math.max(r(first - 1), r(first - 2)) < noise && r(first) < top - END_DIP_DB) return false;
    return true;
  }

  /** The middle of the ratios over the symbols from BEFORE before `at` to HOLD after it. */
  private medianRatio(at: number): number {
    const w: number[] = [];
    const n = this.ratios.length;
    for (let s = at - BEFORE; s <= at + HOLD; s++) w.push(s < 0 ? 0 : this.ratios[s % n]!);
    w.sort((a, b) => a - b);
    return w[(w.length - 1) >> 1]!;
  }

  /** The lowest ratio over symbols from..to: every symbol a character was read from. */
  private minRatio(from: number, to: number): number {
    const n = this.ratios.length;
    let m = Infinity;
    for (let s = Math.max(0, from, to - 16); s <= to; s++) m = Math.min(m, this.ratios[s % n]!);
    return m;
  }

  private trackOffset(peakK: number): void {
    const hz = ((peakK - this.Q0) * this.cfg.toneSpacingHz) / this.R;
    this.afcRing[this.afcHead] = hz;
    this.afcHead = (this.afcHead + 1) % AFC_SYMBOLS;
    this.afcCount = Math.min(AFC_SYMBOLS, this.afcCount + 1);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < this.afcCount; i++) {
      lo = Math.min(lo, this.afcRing[i]!);
      hi = Math.max(hi, this.afcRing[i]!);
    }
    // Only once the tones seen span nearly the whole set is their middle the set's middle.
    if (hi - lo >= 30 * this.cfg.toneSpacingHz) this.stats.afcHz = (lo + hi) / 2;
  }
}

export interface FsqDemodOptions {
  sampleRate: number;
  /** The operator's frequency, Hz audio, as in fldigi: the tones are placed from it (fsqToneHz). */
  centreHz: number;
  speed: FsqSpeed;
  /**
   * Squelch, 0 to 1: characters print only when the signal around them reads at least this
   * quality. Noise reads under 0.1, a signal at the edge of copy about 0.4, one that copies
   * every time 0.5 to 0.65, a clean one 1. 0 disables it. Default 0.2.
   */
  squelch?: number;
}

/**
 * FSQ's received characters as text: printable ASCII, LF, the five Latin-1 signs - and the
 * BS in the middle of FSQEOT (SP SP BS SP SP, the end of a directed over) as a line break,
 * so a directed over ends its line the way an undirected one's LF does.
 */
function fsqPrintable(code: number): string {
  if (code === 8) return "\n";
  return ifk33Printable(code);
}

export class FsqDemodulator {
  private readonly rx: Ifk33Receiver;

  constructor(opts: FsqDemodOptions) {
    const p = fsqParams(opts.speed);
    this.rx = new Ifk33Receiver({
      sampleRate: opts.sampleRate,
      baud: p.baud,
      toneSpacingHz: FSQ_TONE_SPACING_HZ,
      toneHz: fsqToneHz,
      centreHz: opts.centreHz ?? FSQ_CENTRE_HZ,
      varicode: FSQ_VARICODE,
      printable: fsqPrintable,
      squelch: opts.squelch,
    });
  }

  get statistics(): Readonly<Ifk33DemodStats> {
    return this.rx.statistics;
  }

  get qualityDb(): number {
    return this.rx.qualityDb;
  }

  feed(samples: ArrayLike<number>): string {
    return this.rx.feed(samples);
  }

  retune(centreHz: number): void {
    this.rx.retune(centreHz);
  }

  reset(): void {
    this.rx.reset();
  }
}
