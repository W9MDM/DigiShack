// A DominoEX demodulator: audio in, text out, as a stream.
//
// The receive side of fldigi's DominoEX (src/dominoex/dominoex.cxx, rx_process and what it
// calls), in the same shape: a bank of matched filters a symbol long, spaced a fraction of
// the baud apart across the tone set and a margin either side; at each symbol the
// strongest filter is the tone; the step from the last symbol's tone, in tone spacings,
// less two, is the nibble (IFK+); the nibbles go through the Varicode. Three things are
// worked out from the signal itself:
//
//   FREQUENCY does not need tracking at all. The filters run five to a baud ("paths" in
//   fldigi) across the 18 tones and nine tones either side, and only the difference
//   between consecutive tones is read, so a signal anywhere in that margin - about 100 Hz
//   either way in DominoEX 11 - or drifting slowly within it reads the same. The offset
//   is still reported, from the spread of tones seen, so the operator can centre it.
//
//   SYMBOL TIMING. The strongest filter is strongest when its symbol-long window covers
//   exactly one symbol, and weaker when it straddles two tones. The demodulator keeps the
//   strongest filter's magnitude at every one of the decimated sampling phases across a
//   symbol, averaged over the last dozen or so symbols, and decides at the phase with the
//   largest. IFK+ never repeats a tone, so every symbol boundary teaches it something. This
//   is where it differs from fldigi, whose loop (synchronize, dominoex.cxx:513-540) moves
//   the clock an eighteenth of the error a symbol and takes seconds to settle at the slow
//   speeds; the over's preamble is only ten symbols, so the first line was lost.
//
//   WHETHER THERE IS A SIGNAL. On a signal one filter stands well clear of the rest; on
//   noise the strongest of a few hundred is only a few times the average. The ratio of the
//   strongest to the mean of the filters away from it, averaged in dB over a few symbols,
//   is the quality, scaled so noise sits near 0 and a clean signal at 1, and the squelch
//   is a floor on it. Below the floor symbols are still clocked and decoded, so nothing has
//   to catch up when it opens, but no character is printed. A character also waits six
//   symbols and prints only if the squelch is still open then, so the few symbols of noise
//   the average takes to notice an over has ended do not print.
//
// The audio is mixed to complex baseband at the centre and decimated by a box average to a
// fixed number of samples a symbol (48, or 96 for the double-spaced submodes), on a
// fractional clock so the 11025 Hz submodes land exactly on 12, 24 or 48 kHz. Box
// decimation keeps white noise at the same density, so it costs nothing in sensitivity.
// The matched filters are sliding DFTs over the last symbol of that, recomputed from
// scratch once a cycle so rounding cannot build up. Chunks of any size give the same text
// as one call: nothing here depends on a chunk boundary.
//
// Not ported: fldigi's CW-interference blanker in harddecode (its loop indexes the wrong
// pipe entry, so it never did much), the FFT pre-filter, and the MultiPSK FEC. The static
// burst test - the strongest filter barely above the average, as an impulse that lights
// every bin looks - is kept and stops that symbol printing.
//
// scripts/check-dominoex.ts runs it clean, offset, in noise, chunked and on noise alone.

import {
  DOMINOEX_TONES,
  DominoexVaricodeDecoder,
  dominoexParams,
  type DominoexMode,
} from "@/lib/digital/dominoex";

export interface DominoexDemodOptions {
  sampleRate: number;
  /** Centre of the tone set, Hz audio. */
  centreHz: number;
  mode: DominoexMode;
  /**
   * Squelch, 0 to 1: the quality (see above) below which characters are not printed.
   * Noise reads 0 to 0.1, a signal at the edge of copy about 0.25, a clean one
   * 0.5 and up. 0 disables it. Default 0.2.
   */
  squelch?: number;
}

export interface DominoexDemodStats {
  /** Characters delivered, including spaces and newlines. */
  chars: number;
  /** Varicodes no character has, counted while the squelch is open. */
  errors: number;
  /** 0 to 1: how far the strongest filter stands above the rest, averaged. */
  quality: number;
  /** Where the tone set appears to sit relative to the centre asked for, Hz. */
  afcHz: number;
  /** Whether the squelch is open: the quality over the squelch at the last symbol. */
  open: boolean;
  /** The strongest tone's amplitude at the last symbol, in the input's units, for a level display. */
  level: number;
}

/** Matched filters per baud: fldigi's `paths` (dominoex.cxx:108). */
const PATHS = 5;
/** Tones searched either side of the tone set: fldigi's `extones`, NUMTONES / 2. */
const EXTRA_TONES = 9;
/** Decimated samples per symbol per unit of tone spacing: room for the search span below Nyquist. */
const SAMPLES_PER_SYMBOL = 48;
/** The timing average, per symbol. */
const TIMING_ALPHA = 1 / 12;
/** The quality average, per symbol, rising: a few symbols, so the squelch opens inside the over's preamble. */
const QUALITY_ALPHA = 1 / 6;
/**
 * And falling: twice as fast, so a strong signal's quality is back to the noise inside the
 * six symbols a character is held (below) once the over ends.
 */
const QUALITY_ALPHA_DOWN = 1 / 3;
/**
 * Quality scale, dB of strongest-over-the-rest: the floor reads 0 and 12 dB more reads 1.
 * The floor is where noise alone sits: the strongest of a few hundred filters averages
 * 6.9 dB over their mean, and 7.4 dB in the double-spaced submodes, which search twice as
 * many. Two minutes of noise peaked at 8.6 dB; copy starts to fail around 10.5 dB.
 */
const QUALITY_FLOOR_DB = 7.2;
const QUALITY_FLOOR_DOUBLE_DB = 7.7;
const QUALITY_SPAN_DB = 12;
/** A static burst: the strongest filter under this many times the average magnitude (harddecode, dominoex.cxx:466). */
const STATIC_BURST = 1.2;
/**
 * Symbols a character waits before it prints, and prints only if the squelch is still
 * open then. The quality average lags the end of a signal by a few symbols, and in them
 * the noise after an over printed a letter or three. An over always ends with CR EOT CR
 * and four idles, eighteen symbols after its last character completes, so the wait never
 * holds back what was sent.
 */
const HOLD_SYMBOLS = 6;
/** Symbols of tone positions the offset estimate is taken over. */
const AFC_SYMBOLS = 48;

export class DominoexDemodulator {
  private readonly fs: number;
  private readonly baud: number;
  private readonly ds: number;
  private centreHz: number;
  private readonly squelch: number;
  private readonly varicode = new DominoexVaricodeDecoder();
  private utf8 = new TextDecoder("utf-8");

  /** Decimated samples per symbol, and per cycle of the twiddle table. */
  private readonly M: number;
  private readonly P: number;
  /** Input samples per decimated sample: fractional. */
  private readonly decim: number;
  /** The mixer sits this far from the centre so the tones fall on filters: half a baud down when they are a baud apart. */
  private readonly mixShiftHz: number;
  /** Filters run from -Q0 to Q0, a fifth of a baud apart. */
  private readonly Q0: number;
  private readonly K: number;
  private readonly twRe: Float64Array;
  private readonly twIm: Float64Array;

  private loPhase = 0;
  private accI = 0;
  private accQ = 0;
  private accN = 0;
  private clock = 0;

  // The last symbol of decimated baseband.
  private readonly xr: Float64Array;
  private readonly xi: Float64Array;
  private head = 0;
  private filled = 0;
  /** Decimated sample count modulo P: the twiddle index base. */
  private nMod = 0;
  private readonly sRe: Float64Array;
  private readonly sIm: Float64Array;

  private readonly timing: Float64Array;
  private phaseIndex = 0;
  private samplePhase = 0;
  private sinceLast = 0;

  /** The last symbol's filter, or -1 before the first: there is no step to read until there are two. */
  private prevBin = -1;
  private qualDb = 0;
  private readonly afcRing: Float64Array;
  private afcCount = 0;
  private afcHead = 0;
  private secondary = "";
  /** Characters completed and waiting HOLD_SYMBOLS before they print, with the symbol they completed on. */
  private pending: { ch: number; at: number }[] = [];
  private symbolCount = 0;

  private readonly stats: DominoexDemodStats = { chars: 0, errors: 0, quality: 0, afcHz: 0, open: false, level: 0 };

  constructor(opts: DominoexDemodOptions) {
    const p = dominoexParams(opts.mode);
    this.fs = opts.sampleRate;
    this.baud = p.baud;
    this.ds = p.doubleSpaced;
    this.centreHz = opts.centreHz;
    this.squelch = Math.max(0, Math.min(1, opts.squelch ?? 0.2));
    this.M = SAMPLES_PER_SYMBOL * this.ds;
    this.P = PATHS * this.M;
    this.decim = this.fs / (this.M * this.baud);
    if (this.decim < 1) throw new Error(`DominoEX ${opts.mode} needs a higher sample rate than ${this.fs}`);
    // Tone n sits (n - 8.5) spacings from the centre. A baud apart that is a half-integer
    // number of bauds, so the mixer moves half a baud down and the tones land on whole
    // filters; two bauds apart it is already an odd whole number of bauds.
    this.mixShiftHz = this.ds === 1 ? -this.baud / 2 : 0;
    this.Q0 = (DOMINOEX_TONES / 2 + EXTRA_TONES) * this.ds * PATHS;
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
    this.timing = new Float64Array(this.M);
    this.afcRing = new Float64Array(AFC_SYMBOLS);
  }

  get statistics(): Readonly<DominoexDemodStats> {
    return this.stats;
  }

  /** The secondary-alphabet text heard lately (fldigi's idle text: usually its version), newest last. */
  get secondaryText(): string {
    return this.secondary;
  }

  /** Move the tone set while running. The offset estimate starts over: the operator chose a new centre. */
  retune(centreHz: number): void {
    this.centreHz = centreHz;
    this.afcCount = 0;
    this.afcHead = 0;
    this.stats.afcHz = 0;
  }

  reset(): void {
    this.varicode.reset();
    this.utf8 = new TextDecoder("utf-8");
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
    this.qualDb = 0;
    this.afcCount = 0;
    this.afcHead = 0;
    this.secondary = "";
    this.pending = [];
    this.symbolCount = 0;
    this.stats.quality = 0;
    this.stats.afcHz = 0;
    this.stats.open = false;
    this.stats.level = 0;
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
    const { M, P, K, Q0 } = this;
    // The sample leaving the window was taken M samples ago, at index nMod - M.
    const oldI = this.xr[this.head]!;
    const oldQ = this.xi[this.head]!;
    this.xr[this.head] = xI;
    this.xi[this.head] = xQ;
    this.head = (this.head + 1) % M;
    const n = this.nMod;
    const nOld = (((n - M) % P) + P) % P;
    // Filter q's twiddle at sample n is index q * n mod P; step it bin by bin.
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

    // Timing: the strongest filter's magnitude at this phase, averaged.
    let peakE = 0;
    let peakK = 0;
    for (let k = 0; k < K; k++) {
      const e = this.sRe[k]! * this.sRe[k]! + this.sIm[k]! * this.sIm[k]!;
      if (e > peakE) {
        peakE = e;
        peakK = k;
      }
    }
    const mag = Math.sqrt(peakE);
    const thisPhase = this.phaseIndex;
    this.timing[thisPhase] = this.timing[thisPhase]! + TIMING_ALPHA * (mag - this.timing[thisPhase]!);
    this.phaseIndex = (this.phaseIndex + 1) % M;
    this.sinceLast++;
    // A decision at the sampling phase - unless the phase moved and the last decision was
    // less than half a symbol ago, which would read the same symbol twice.
    if (thisPhase !== this.samplePhase || this.sinceLast < M / 2) return "";
    this.sinceLast = 0;
    const out = this.symbol(peakK, peakE);
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
    // The newest sample is index -1 (that is, P - 1), the oldest -M.
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

  /** One symbol: the tone, the nibble, the quality, and a character if one completed. */
  private symbol(peakK: number, peakE: number): string {
    const { K, M } = this;
    // The mean away from the peak, by magnitude and by energy: two tones' worth either side
    // is left out, where the peak's own filter skirts are.
    const guard = 2 * this.ds * PATHS;
    let sumE = 0;
    let nOther = 0;
    let allMag = 0;
    for (let k = 0; k < K; k++) {
      const e = this.sRe[k]! * this.sRe[k]! + this.sIm[k]! * this.sIm[k]!;
      const m = Math.sqrt(e);
      allMag += m;
      if (Math.abs(k - peakK) <= guard) continue;
      sumE += e;
      nOther++;
    }
    const meanE = nOther > 0 ? sumE / nOther : 0;
    const staticBurst = Math.sqrt(peakE) < STATIC_BURST * (allMag / K);
    // Digital silence (a FlexRadio's DAX between overs is exact zeros) has nothing away
    // from the peak either, and read as a perfect 60 dB: the squelch opened on it and the
    // end of every over printed a letter or two. Under -80 dBFS is no signal at all.
    const silent = (2 * Math.sqrt(peakE)) / M < 1e-4;
    const ratioDb = silent ? 0 : meanE > 0 ? 10 * Math.log10(peakE / meanE) : 60;
    const target = Math.min(60, ratioDb);
    this.qualDb += (target < this.qualDb ? QUALITY_ALPHA_DOWN : QUALITY_ALPHA) * (target - this.qualDb);
    const quality = Math.max(0, Math.min(1, (this.qualDb - (this.ds === 2 ? QUALITY_FLOOR_DOUBLE_DB : QUALITY_FLOOR_DB)) / QUALITY_SPAN_DB));
    this.stats.quality = quality;
    this.stats.level = (2 * Math.sqrt(peakE)) / M;
    const open = this.squelch === 0 || quality >= this.squelch;
    this.stats.open = open;

    // IFK+: the step in filters, over the filters per tone spacing, rounded, less two.
    const first = this.prevBin < 0;
    const steps = Math.round((peakK - this.prevBin) / (this.ds * PATHS));
    this.prevBin = peakK;
    this.symbolCount++;
    if (!first) this.nibble((((steps - 2) % DOMINOEX_TONES) + DOMINOEX_TONES) % DOMINOEX_TONES, peakK, open, staticBurst);
    // Release what has waited long enough, if the squelch is still open now.
    let out = "";
    while (this.pending.length > 0 && this.pending[0]!.at + HOLD_SYMBOLS <= this.symbolCount) {
      const ch = this.pending.shift()!.ch;
      if (open) out += this.deliver(ch);
    }
    return out;
  }

  /** One nibble: the offset estimate, and the Varicode. A completed character waits in pending. */
  private nibble(nibble: number, peakK: number, open: boolean, staticBurst: boolean): void {

    if (open && !staticBurst) {
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
      // Only once the tones seen span most of the set is the middle of them the middle of it.
      const p = this.ds * this.baud;
      if (hi - lo >= 14 * p) this.stats.afcHz = (lo + hi) / 2;
    }

    const ch = this.varicode.push(nibble);
    if (ch === null || staticBurst || !open) return;
    if (ch < 0) {
      this.stats.errors++;
      return;
    }
    this.pending.push({ ch, at: this.symbolCount });
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
    // A byte that cannot start or continue a UTF-8 character is a misread symbol far more
    // often than an old Latin-1 sender: it is dropped rather than printed as a mark.
    const s = this.utf8.decode(Uint8Array.of(byte), { stream: true }).replace(/\uFFFD/g, "");
    this.stats.chars += s.length;
    return s;
  }
}
