// An MT63 demodulator: audio in, text out, as a stream.
//
// A port of the receive side of fldigi 4.2.13's src/mt63/mt63base.cxx (MT63rx, Pawel
// Jalocha SP9VRC, GPL, as carried in fldigi by W1HKJ), with the same arithmetic:
//
//   THE FRONT END mixes the audio down so the 64 carriers sit around zero and decimates it
//   to the reference's complex baseband (1000, 2000 or 4000 Hz; see lib/digital/mt63.ts).
//   fldigi does the same from 8000 Hz with its own band-pass (dspQuadrSplit); here it is
//   done from 12, 24 or 48 kHz in one whole-number step.
//
//   THE SYNCHRONISER (SyncProcess, mt63base.cxx:1018-1296) looks four times a symbol. Each
//   look is a 512-point FFT under the symbol shape; each bin is squared (which takes the
//   BPSK flips out) and correlated with the same bin one symbol earlier, and those
//   correlations are averaged over the integration period (16 symbols, or 32 with long
//   integration). Where the window sits inside a symbol, the correlation is strong; where
//   it straddles a phase change, it is weak - so comparing the four looks gives the symbol
//   timing, as a phase. Summing over every carrier position gives where the carriers are,
//   to a fraction of a bin, and so the frequency offset: anything within the 8-carrier
//   search margin either side (+-125 Hz in MT63-1000). Timing and offset are smoothed by a
//   selective average over the integration period, and the lock is declared when they are
//   steady.
//
//   THE DATA DEMODULATOR (DataProcess, mt63base.cxx:1298-1447) goes back in the audio by
//   the integration period - so the synchroniser has seen what comes after - and takes two
//   FFTs at the symbol, half a symbol apart, for the even and the odd carriers, with the
//   frequency offset taken out. Each carrier's phase against its previous symbol, with the
//   phase a steady tone gains in that time removed, is its soft bit: +1 kept, -1 flipped.
//   That is done for every carrier position in the margin too.
//
//   THE DECODER (Mt63FecDecoder in lib/digital/mt63.ts) deinterleaves, takes the Walsh
//   transform at every carrier offset, and prints the character at the offset with the
//   best smoothed signal-to-noise.
//
// Departures from the reference, none of which touch what is on the air:
//   - the front end (above);
//   - the squelch is applied per character, not per batch of audio as fldigi's rx_process
//     does (mt63.cxx:197-203), so chunks of any size give the same text as one call;
//   - a noiseless Walsh peak reads as a strong signal, not 0 (see Mt63FecDecoder);
//   - DoCorrelSum is ported with its sign as written (mt63base.cxx:1010,1012: the imaginary
//     part of the entering term is subtracted), because that is the synchroniser fldigi
//     users have; a bin index the frequency refinement could read past the end of its
//     array (mt63base.cxx:1168) is clamped.
//
// scripts/check-mt63.ts runs it on generated signals clean, chunked, off frequency, in
// noise and on noise alone.

import {
  lowPass2,
  MT63_CARRIER_SEPAR,
  MT63_CARRIERS,
  MT63_MIX_BIN_ABOVE_FIRST,
  MT63_SYMBOL_LEN,
  MT63_SYMBOL_SEPAR,
  MT63_SYMBOL_SHAPE,
  Mt63FecDecoder,
  Mt63Fft,
  mt63FirstCarrierBin,
  mt63MixerTable,
  mt63Params,
  mt63RateFactor,
  mt63RateFilter,
  Mt63TextDecoder,
  type Mt63Mode,
  type Mt63Params,
} from "@/lib/digital/mt63";

export interface Mt63DemodOptions {
  sampleRate: number;
  /** fldigi's cursor frequency, Hz audio (lib/digital/mt63.ts, WHERE IT SITS). */
  centreHz: number;
  mode: Mt63Mode;
  /**
   * The FEC signal-to-noise (fldigi's "s/n" before it is put in dB) below which characters
   * are not printed. Noise alone reads 2.9 to 3.1 at the best of the 17 offsets (60 s of
   * it never passed 3.13); MT63-1000 still copies at 3.4 (-8 dB in 2.5 kHz). Default 3.6.
   * 0 prints everything, as fldigi does with its squelch off.
   */
  squelch?: number;
  /** fldigi's "long receive integration": 32 symbols instead of 16, for weak signals; the text comes later. */
  longIntegration?: boolean;
  /** 8-bit characters (escape code 127), as fldigi's default. Default true. */
  eightBit?: boolean;
}

export interface Mt63DemodStats {
  /** Characters delivered, including spaces and newlines. */
  chars: number;
  /** Codes printed through an open squelch that were not printable: misreads. */
  errors: number;
  /** The synchroniser's confidence, 0..1 (SYNC_Confidence, mt63base.cxx:1453). */
  quality: number;
  /** Where the carriers were found against where they were expected, Hz (TotalFreqOffset, mt63base.cxx:1477). */
  afcHz: number;
  /** Whether the last character was printed: the squelch was open. */
  open: boolean;
  /** RMS of the input audio over the last half second or so, linear. */
  level: number;
  /** The FEC signal-to-noise at the last character, linear (fldigi shows 10 log10 of it). */
  snr: number;
  /** The synchroniser's lock (SYNC_LockStatus). */
  locked: boolean;
}

const W = MT63_SYMBOL_LEN;
const MASK = W - 1;
const SEPAR = MT63_SYMBOL_SEPAR;
/** Looks per symbol: "don't change this" (mt63base.cxx:790). */
const DIV = 4;
const STEP = SEPAR / DIV;
/** Carriers searched either side, by the synchroniser and the decoder (mt63base.cxx:791, 806). */
const MARGIN = 8;
const CS = MT63_CARRIER_SEPAR;
const NC = MT63_CARRIERS;
const SCAN_LEN = (NC + 2 * MARGIN) * CS;
const FIT_LEN = 2 * MARGIN * CS;
const DATA_SCAN_LEN = NC + 2 * MARGIN;

/** The reference's "selective" average (dspSelFitAver, dsp.h:446-541): drop outliers past `thres` RMS and average again, `loops` times. */
function selFitAver(re: Float64Array, im: Float64Array | null, len: number, thres: number, loops: number, out: { re: number; im: number; rms: number }): void {
  let sr = 0;
  let si = 0;
  let err = 0;
  for (let i = 0; i < len; i++) {
    const a = re[i]!;
    const b = im ? im[i]! : 0;
    sr += a;
    si += b;
    err += a * a + b * b;
  }
  let lr = sr / len;
  let li = si / len;
  err = err / len - (lr * lr + li * li);
  // The complex version compares against half the threshold squared (dsp.h:518).
  const k = im ? 0.5 : 1;
  for (let loop = 0; loop < loops; loop++) {
    const th = k * thres * thres * err;
    sr = si = 0;
    let e = 0;
    let incl = 0;
    for (let i = 0; i < len; i++) {
      const a = re[i]!;
      const b = im ? im[i]! : 0;
      const d = (a - lr) * (a - lr) + (b - li) * (b - li);
      if (d <= th) {
        sr += a;
        si += b;
        e += d;
        incl++;
      }
    }
    // The reference divides by zero here when rounding leaves the spread a hair below
    // zero; keep the last average instead.
    if (incl === 0) break;
    const dr = sr / incl - lr;
    const di = si / incl - li;
    err = Math.abs(e / incl - (dr * dr + di * di));
    lr += dr;
    li += di;
  }
  out.re = lr;
  out.im = li;
  out.rms = Math.sqrt(Math.max(0, err));
}

export class Mt63Demodulator {
  private readonly p: Mt63Params;
  private readonly fs: number;
  private readonly factor: number;
  private readonly squelch: number;
  private readonly integLen: number;
  private readonly procDelay: number;
  private readonly eightBit: boolean;
  private centreHz: number;

  // Front end: the mixer, the decimating filter and its input history.
  private mixCos!: Float64Array;
  private mixSin!: Float64Array;
  private mixPh = 0;
  private readonly h: Float64Array;
  private readonly firRe: Float64Array;
  private readonly firIm: Float64Array;
  private firPos = 0;
  private decCount = 0;
  private levelAcc = 0;
  private readonly levelAlpha: number;

  // The baseband, kept far enough back for the data demodulator (ProcLine).
  private readonly ringRe: Float64Array;
  private readonly ringIm: Float64Array;
  private readonly ringMask: number;
  private count = 0;
  private syncPos = 0;
  private dataPos = 0;

  private readonly fft = new Mt63Fft(W);
  private readonly fRe = new Float64Array(W);
  private readonly fIm = new Float64Array(W);
  private readonly f2Re = new Float64Array(W);
  private readonly f2Im = new Float64Array(W);

  // The synchroniser.
  private firstCarr = 0;
  private scanFirst = 0;
  private dataScanFirst = 0;
  private readonly syncPipeRe = Array.from({ length: DIV }, () => new Float64Array(SCAN_LEN));
  private readonly syncPipeIm = Array.from({ length: DIV }, () => new Float64Array(SCAN_LEN));
  private readonly syncPhRe = new Float64Array(SCAN_LEN);
  private readonly syncPhIm = new Float64Array(SCAN_LEN);
  private readonly corMidRe = Array.from({ length: DIV }, () => new Float64Array(SCAN_LEN));
  private readonly corMidIm = Array.from({ length: DIV }, () => new Float64Array(SCAN_LEN));
  private readonly corOutRe = Array.from({ length: DIV }, () => new Float64Array(SCAN_LEN));
  private readonly corOutIm = Array.from({ length: DIV }, () => new Float64Array(SCAN_LEN));
  private readonly powMid = new Float64Array(SCAN_LEN);
  private readonly powOut = new Float64Array(SCAN_LEN);
  private readonly normRe = Array.from({ length: DIV }, () => new Float64Array(SCAN_LEN));
  private readonly normIm = Array.from({ length: DIV }, () => new Float64Array(SCAN_LEN));
  private readonly averRe = Array.from({ length: DIV }, () => new Float64Array(FIT_LEN));
  private readonly averIm = Array.from({ length: DIV }, () => new Float64Array(FIT_LEN));
  private readonly fitRe = new Float64Array(FIT_LEN);
  private readonly fitIm = new Float64Array(FIT_LEN);
  private readonly symbPipeRe: Float64Array;
  private readonly symbPipeIm: Float64Array;
  private readonly freqPipe: Float64Array;
  private trackPtr = 0;
  private readonly w1: number;
  private readonly w2: number;
  private readonly w5: number;
  private readonly w1p: number;
  private readonly w2p: number;
  private readonly w5p: number;
  private readonly lockThres: number;
  private readonly holdThres: number;
  private syncPtr = 0;
  private symbPtr = 0;
  private symbFitPos = MARGIN * CS;
  private syncLocked = false;
  private syncSymbConf = 0;
  private syncFreqOfs = 0;
  private syncFreqDev = 0;
  private syncSymbShift = 0;
  private averFreq = 0;
  private averSymbRe = 0;
  private averSymbIm = 0;
  private readonly avg = { re: 0, im: 0, rms: 0 };

  // The data demodulator.
  private readonly refRe = new Float64Array(DATA_SCAN_LEN);
  private readonly refIm = new Float64Array(DATA_SCAN_LEN);
  private readonly vecRe = new Float64Array(DATA_SCAN_LEN);
  private readonly vecIm = new Float64Array(DATA_SCAN_LEN);
  private readonly dataPipeRe: Float64Array[];
  private readonly dataPipeIm: Float64Array[];
  private dataPipePtr = 0;
  private readonly dataPwrMid = new Float64Array(DATA_SCAN_LEN);
  private readonly dataPwrOut = new Float64Array(DATA_SCAN_LEN);
  private readonly dataPhase = new Float64Array(DATA_SCAN_LEN);
  private readonly dw1: number;
  private readonly dw2: number;
  private readonly dw5: number;
  private readonly decoder: Mt63FecDecoder;
  private text: Mt63TextDecoder;
  private out = "";

  private readonly stats: Mt63DemodStats = { chars: 0, errors: 0, quality: 0, afcHz: 0, open: false, level: 0, snr: 0, locked: false };

  constructor(opts: Mt63DemodOptions) {
    this.p = mt63Params(opts.mode);
    this.fs = opts.sampleRate;
    this.factor = mt63RateFactor(this.p, this.fs);
    this.squelch = Math.max(0, opts.squelch ?? 3.6);
    this.integLen = opts.longIntegration ? 32 : 16;
    this.procDelay = this.integLen * SEPAR;
    this.eightBit = opts.eightBit ?? true;
    this.centreHz = opts.centreHz;

    this.h = mt63RateFilter(this.factor);
    this.firRe = new Float64Array(2 * this.h.length);
    this.firIm = new Float64Array(2 * this.h.length);
    this.levelAlpha = 1 / (0.5 * this.fs);

    let ring = 1;
    while (ring < this.procDelay + 2 * W + SEPAR + DIV * STEP) ring <<= 1;
    this.ringRe = new Float64Array(ring);
    this.ringIm = new Float64Array(ring);
    this.ringMask = ring - 1;

    this.symbPipeRe = new Float64Array(this.integLen);
    this.symbPipeIm = new Float64Array(this.integLen);
    this.freqPipe = new Float64Array(this.integLen);
    this.w1 = 1 / this.integLen;
    this.w2 = 2 / this.integLen;
    this.w5 = 5 / this.integLen;
    const ip = this.integLen * DIV;
    this.w1p = 1 / ip;
    this.w2p = 2 / ip;
    this.w5p = 5 / ip;
    // mt63base.cxx:891-892.
    this.holdThres = 1.5 * Math.sqrt(1 / (this.integLen * NC));
    this.lockThres = 1.5 * this.holdThres;

    const pipeLen = this.integLen / 2;
    this.dataPipeRe = Array.from({ length: pipeLen }, () => new Float64Array(DATA_SCAN_LEN));
    this.dataPipeIm = Array.from({ length: pipeLen }, () => new Float64Array(DATA_SCAN_LEN));
    this.dw1 = 1 / this.integLen;
    this.dw2 = 2 / this.integLen;
    this.dw5 = 5 / this.integLen;
    this.decoder = new Mt63FecDecoder(this.p.interleave, MARGIN, this.integLen);
    this.text = new Mt63TextDecoder(this.eightBit);

    this.tune(opts.centreHz);
    this.reset();
  }

  get statistics(): Readonly<Mt63DemodStats> {
    return this.stats;
  }

  /** Move to another cursor frequency. As fldigi's set_freq does (mt63.cxx:405-416), the receiver starts over. */
  retune(centreHz: number): void {
    this.tune(centreHz);
    this.reset();
  }

  private tune(centreHz: number): void {
    this.centreHz = centreHz;
    const first = mt63FirstCarrierBin(this.p, centreHz);
    const mixBin = first + MT63_MIX_BIN_ABOVE_FIRST;
    const mix = mt63MixerTable(mixBin, this.factor);
    this.mixCos = mix.cos;
    this.mixSin = mix.sin;
    // In the baseband the first carrier is 126 bins below zero; the reference works
    // with bins modulo the FFT length, so that is bin 386.
    this.firstCarr = (first - mixBin) & MASK;
    this.scanFirst = this.firstCarr - MARGIN * CS;
    if (this.scanFirst < 0) this.scanFirst += W;
    this.dataScanFirst = this.scanFirst;
    // The phase a steady tone in each scanned bin gains in a symbol, doubled because the
    // synchroniser works on squared samples (mt63base.cxx:844-849).
    for (let c = (this.scanFirst * SEPAR) & MASK, i = 0; i < SCAN_LEN; i++) {
      const tr = this.fft.twRe[c]!;
      const ti = this.fft.twIm[c]!;
      this.syncPhRe[i] = tr * tr - ti * ti;
      this.syncPhIm[i] = 2 * tr * ti;
      c = (c + SEPAR) & MASK;
    }
  }

  reset(): void {
    this.mixPh = 0;
    this.firRe.fill(0);
    this.firIm.fill(0);
    this.firPos = 0;
    this.decCount = 0;
    this.levelAcc = 0;
    this.ringRe.fill(0);
    this.ringIm.fill(0);
    this.count = 0;
    this.syncPos = 0;
    this.dataPos = -this.procDelay;
    for (let s = 0; s < DIV; s++) {
      this.syncPipeRe[s]!.fill(0);
      this.syncPipeIm[s]!.fill(0);
      this.corMidRe[s]!.fill(0);
      this.corMidIm[s]!.fill(0);
      this.corOutRe[s]!.fill(0);
      this.corOutIm[s]!.fill(0);
    }
    this.powMid.fill(0);
    this.powOut.fill(0);
    this.symbPipeRe.fill(0);
    this.symbPipeIm.fill(0);
    this.freqPipe.fill(0);
    this.trackPtr = 0;
    this.syncPtr = 0;
    this.symbPtr = 0;
    this.symbFitPos = MARGIN * CS;
    this.syncLocked = false;
    this.syncSymbConf = 0;
    this.syncFreqOfs = 0;
    this.syncFreqDev = 0;
    this.syncSymbShift = 0;
    this.averFreq = 0;
    this.averSymbRe = 0;
    this.averSymbIm = 0;
    this.refRe.fill(0);
    this.refIm.fill(0);
    for (const r of this.dataPipeRe) r.fill(0);
    for (const r of this.dataPipeIm) r.fill(0);
    this.dataPipePtr = 0;
    this.dataPwrMid.fill(0);
    this.dataPwrOut.fill(0);
    this.decoder.reset();
    this.text = new Mt63TextDecoder(this.eightBit);
    this.stats.quality = 0;
    this.stats.afcHz = 0;
    this.stats.open = false;
    this.stats.level = 0;
    this.stats.snr = 0;
    this.stats.locked = false;
  }

  feed(samples: ArrayLike<number>): string {
    this.out = "";
    const h = this.h;
    const L = h.length;
    const period = this.mixCos.length;
    for (let n = 0; n < samples.length; n++) {
      const x = samples[n]!;
      this.levelAcc += (x * x - this.levelAcc) * this.levelAlpha;
      // Mix down: the carriers' middle to zero.
      const ph = this.mixPh;
      const xr = x * this.mixCos[ph]!;
      const xi = -x * this.mixSin[ph]!;
      this.mixPh = ph + 1 === period ? 0 : ph + 1;
      // Written twice, so the last L samples are always contiguous at firPos + 1.
      const pos = this.firPos;
      this.firRe[pos] = this.firRe[pos + L] = xr;
      this.firIm[pos] = this.firIm[pos + L] = xi;
      this.firPos = pos + 1 === L ? 0 : pos + 1;
      if (++this.decCount < this.factor) continue;
      this.decCount = 0;
      // One baseband sample: the filter is symmetric, so its order against the history does not matter.
      const base = this.firPos;
      let sr = 0;
      let si = 0;
      for (let k = 0; k < L; k++) {
        sr += h[k]! * this.firRe[base + k]!;
        si += h[k]! * this.firIm[base + k]!;
      }
      this.pushBaseband(sr, si);
    }
    this.stats.level = Math.sqrt(this.levelAcc);
    return this.out;
  }

  /**
   * What fldigi's rx_flush does before it transmits (mt63.cxx:244-295): feed silence while
   * the synchroniser holds its lock, so the characters still in the pipeline print. Not
   * needed on a live stream, where the audio after a signal does the same.
   */
  flush(): string {
    const chunk = new Float32Array(SEPAR * this.factor);
    let text = "";
    const most = Math.ceil(this.procDelay / SEPAR) + this.integLen + 4;
    for (let i = 0; i < most && this.syncLocked; i++) text += this.feed(chunk);
    return text;
  }

  private pushBaseband(re: number, im: number): void {
    const at = this.count & this.ringMask;
    this.ringRe[at] = re;
    this.ringIm[at] = im;
    this.count++;
    // MT63rx::Process (mt63base.cxx:967-982), on an absolute sample count.
    while (this.syncPos + W < this.count) {
      this.syncProcess(this.syncPos);
      if (this.syncPtr === this.symbPtr) {
        const s1 = this.syncPos - this.procDelay + (Math.trunc(this.syncSymbShift) - this.symbPtr * STEP);
        const s2 = s1 + SEPAR / 2;
        this.dataProcess(s1, s2, this.syncFreqOfs, s1 - this.dataPos);
        this.dataPos = s1;
      }
      this.syncPos += STEP;
    }
  }

  /** One windowed FFT of the baseband from absolute sample `at`, the frequency offset `freqOfs` (bins) taken out. */
  private windowedFft(at: number, re: Float64Array, im: Float64Array, freqOfs: number): void {
    const shape = MT63_SYMBOL_SHAPE;
    const rev = this.fft.bitRev;
    const m = this.ringMask;
    if (freqOfs === 0) {
      for (let i = 0; i < W; i++) {
        const r = rev[i]!;
        const idx = (at + i) & m;
        re[r] = this.ringRe[idx]! * shape[i]!;
        im[r] = this.ringIm[idx]! * shape[i]!;
      }
    } else {
      const P = (-2 * Math.PI * freqOfs) / W;
      const fr = Math.cos(P);
      const fi = Math.sin(P);
      let pr = 1;
      let pi = 0;
      for (let i = 0; i < W; i++) {
        const r = rev[i]!;
        const idx = (at + i) & m;
        const a = this.ringRe[idx]!;
        const b = this.ringIm[idx]!;
        re[r] = (a * pr - b * pi) * shape[i]!;
        im[r] = (a * pi + b * pr) * shape[i]!;
        const t = pr * fr - pi * fi;
        pi = pr * fi + pi * fr;
        pr = t;
      }
    }
    this.fft.coreProc(re, im);
  }

  /** SyncProcess (mt63base.cxx:1018-1296). */
  private syncProcess(at: number): void {
    this.syncPtr = (this.syncPtr + 1) & (DIV - 1);
    const fRe = this.fRe;
    const fIm = this.fIm;
    this.windowedFft(at, fRe, fIm, 0);
    const prevRe = this.syncPipeRe[this.syncPtr]!;
    const prevIm = this.syncPipeIm[this.syncPtr]!;
    const cmr = this.corMidRe[this.syncPtr]!;
    const cmi = this.corMidIm[this.syncPtr]!;
    const cor = this.corOutRe[this.syncPtr]!;
    const coi = this.corOutIm[this.syncPtr]!;
    const { w1, w2, w5, w1p, w2p, w5p } = this;
    for (let i = 0; i < SCAN_LEN; i++) {
      const k = (this.scanFirst + i) & MASK;
      const I = fRe[k]!;
      const Q = fIm[k]!;
      const P = I * I + Q * Q;
      let dI = 0;
      let dQ = 0;
      if (P > 0) {
        const A = Math.sqrt(P);
        dI = (I * I - Q * Q) / A;
        dQ = (2 * I * Q) / A;
      }
      lowPass2(P, this.powMid, this.powOut, i, w1p, w2p, w5p);
      const pI = prevRe[i]! * this.syncPhRe[i]! - prevIm[i]! * this.syncPhIm[i]!;
      const pQ = prevRe[i]! * this.syncPhIm[i]! + prevIm[i]! * this.syncPhRe[i]!;
      lowPass2(dQ * pQ + dI * pI, cmr, cor, i, w1, w2, w5);
      lowPass2(dQ * pI - dI * pQ, cmi, coi, i, w1, w2, w5);
      prevRe[i] = dI;
      prevIm[i] = dQ;
    }
    if (this.syncPtr === (this.symbPtr ^ 2)) this.syncFit();
  }

  /** The once-a-symbol half of SyncProcess: where the symbols and the carriers are (mt63base.cxx:1083-1294). */
  private syncFit(): void {
    // Normalise the correlations by the carrier power.
    for (let s = 0; s < DIV; s++) {
      const nr = this.normRe[s]!;
      const ni = this.normIm[s]!;
      const cr = this.corOutRe[s]!;
      const ci = this.corOutIm[s]!;
      for (let i = 0; i < SCAN_LEN; i++) {
        const po = this.powOut[i]!;
        if (po > 0) {
          nr[i] = cr[i]! / po;
          ni[i] = ci[i]! / po;
        } else nr[i] = ni[i] = 0;
      }
    }
    // A sum for each possible carrier position: the even carriers from one look and the
    // odd from the look half a symbol later.
    for (let s = 0; s < DIV; s++) {
      const s2 = (s + DIV / 2) & (DIV - 1);
      for (let k = 0; k < 2 * CS; k++) this.correlSum(s, k, s2, k + CS, k);
    }
    // Symbol-shift phase fitting.
    for (let i = 0; i < FIT_LEN; i++) {
      this.fitRe[i] = Math.hypot(this.averRe[0]![i]!, this.averIm[0]![i]!) - Math.hypot(this.averRe[2]![i]!, this.averIm[2]![i]!);
      this.fitIm[i] = Math.hypot(this.averRe[1]![i]!, this.averIm[1]![i]!) - Math.hypot(this.averRe[3]![i]!, this.averIm[3]![i]!);
    }
    const fr = this.fitRe;
    const fi = this.fitIm;
    let P = fr[2]! * fr[2]! + fi[2]! * fi[2]!;
    let j = 0;
    for (let i = 1; i < FIT_LEN - 4; i++) {
      const pw = fr[i + 2]! * fr[i + 2]! + fi[i + 2]! * fi[i + 2]!;
      if (pw > P) {
        P = pw;
        j = i;
      }
    }
    j += 2;
    const kk = Math.trunc((j - this.symbFitPos) / CS);
    if (kk > 1) j -= (kk - 1) * CS;
    else if (kk < -1) j -= (kk + 1) * CS;
    this.symbFitPos = j;

    let symbRe = 0;
    let symbIm = 0;
    let freqOfs = 0;
    if (P > 0) {
      const I = fr[j]! + 0.5 * (fr[j - 1]! + fr[j + 1]!);
      const Q = fi[j]! + 0.5 * (fi[j - 1]! + fi[j + 1]!);
      symbRe = I;
      symbIm = Q;
      const symbShiftDiv = ((Math.atan2(Q, I) / (2 * Math.PI)) * DIV + DIV) % DIV;
      const sp = (a: number) => I * fr[a]! + Q * fi[a]!;
      const pI = sp(j) + 0.7 * sp(j - 1) + 0.7 * sp(j + 1);
      const pQ = 0.7 * sp(j + 1) - 0.7 * sp(j - 1) + 0.5 * sp(j + 2) - 0.5 * sp(j - 2);
      freqOfs = j + Math.atan2(pQ, pI) / ((2 * Math.PI) / 8);
      // Refine the offset from the correlation phase between the two nearest looks.
      const i = Math.min(FIT_LEN - 1, Math.max(0, Math.floor(freqOfs + 0.5)));
      const s = Math.floor(symbShiftDiv) & (DIV - 1);
      const s2 = (s + 1) & (DIV - 1);
      const wa = s + 1 - symbShiftDiv;
      const wb = symbShiftDiv - Math.floor(symbShiftDiv);
      const A = (0.5 * W) / SEPAR;
      const cI = wa * this.averRe[s]![i]! + wb * this.averRe[s2]![i]!;
      const cQ = wa * this.averIm[s]![i]! + wb * this.averIm[s2]![i]!;
      const F0 = i + (Math.atan2(cQ, cI) / (2 * Math.PI)) * A - freqOfs;
      const Fl = F0 - A;
      const Fu = F0 + A;
      if (Math.abs(Fl) < Math.abs(F0)) freqOfs += Math.abs(Fu) < Math.abs(Fl) ? Fu : Fl;
      else freqOfs += Math.abs(Fu) < Math.abs(F0) ? Fu : F0;
    }

    if (this.syncLocked) {
      // Flip the timing vector if it disagrees with the average.
      if (symbRe * this.averSymbRe + symbIm * this.averSymbIm < 0) {
        symbRe = -symbRe;
        symbIm = -symbIm;
        freqOfs -= CS;
      }
      // Bring the offset towards the average offset.
      let A = 2 * CS;
      const k = Math.floor((freqOfs - this.averFreq) / A + 0.5);
      freqOfs -= k * A;
      A = (0.5 * W) / SEPAR;
      const F0 = freqOfs - this.averFreq;
      const Fl = F0 - A;
      const Fu = F0 + A;
      if (Math.abs(Fl) < Math.abs(F0)) freqOfs += Math.abs(Fu) < Math.abs(Fl) ? A : -A;
      else freqOfs += Math.abs(Fu) < Math.abs(F0) ? A : 0;
    } else {
      // Flip the timing vector if it disagrees with the previous one.
      if (symbRe * this.symbPipeRe[this.trackPtr]! + symbIm * this.symbPipeIm[this.trackPtr]! < 0) {
        symbRe = -symbRe;
        symbIm = -symbIm;
        freqOfs -= CS;
      }
      // Bring the offset towards zero. (A stays 2 x the carrier spacing here, as written.)
      const A = 2 * CS;
      const k = Math.floor(freqOfs / A + 0.5);
      freqOfs -= k * A;
      const F0 = freqOfs - this.freqPipe[this.trackPtr]!;
      const Fl = F0 - A;
      const Fu = F0 + A;
      if (Math.abs(Fl) < Math.abs(F0)) freqOfs += Math.abs(Fu) < Math.abs(Fl) ? A : -A;
      else freqOfs += Math.abs(Fu) < Math.abs(F0) ? A : 0;
    }

    this.trackPtr = (this.trackPtr + 1) % this.integLen;
    this.symbPipeRe[this.trackPtr] = symbRe;
    this.symbPipeIm[this.trackPtr] = symbIm;
    this.freqPipe[this.trackPtr] = freqOfs;

    selFitAver(this.symbPipeRe, this.symbPipeIm, this.integLen, 3.0, 4, this.avg);
    this.averSymbRe = this.avg.re;
    this.averSymbIm = this.avg.im;
    selFitAver(this.freqPipe, null, this.integLen, 2.5, 4, this.avg);
    this.averFreq = this.avg.re;
    this.syncFreqDev = this.avg.rms;

    const conf = Math.hypot(this.averSymbRe, this.averSymbIm);
    this.syncSymbConf = conf;
    this.syncFreqOfs = this.averFreq;
    if (conf > 0) {
      const ph = Math.atan2(this.averSymbIm, this.averSymbRe) / (2 * Math.PI);
      let shift = ph * SEPAR;
      if (shift < 0) shift += SEPAR;
      let ptr = Math.floor(ph * DIV);
      if (ptr < 0) ptr += DIV;
      this.symbPtr = ptr & (DIV - 1);
      this.syncSymbShift = shift;
    }
    if (this.syncLocked) {
      if (this.syncSymbConf < this.holdThres || this.syncFreqDev > 0.25) this.syncLocked = false;
    } else if (this.syncSymbConf > this.lockThres && this.syncFreqDev < 0.125) this.syncLocked = true;
    this.syncSymbConf *= 0.5;
  }

  /**
   * DoCorrelSum (mt63base.cxx:988-1016): a sliding sum over every other carrier position,
   * even carriers from look `s` and odd from look `s2`, at each fine offset. The entering
   * terms' imaginary parts are subtracted, as the reference has it.
   */
  private correlSum(s: number, o1: number, s2: number, o2: number, oa: number): void {
    const c1r = this.normRe[s]!;
    const c1i = this.normIm[s]!;
    const c2r = this.normRe[s2]!;
    const c2i = this.normIm[s2]!;
    const ar = this.averRe[s]!;
    const ai = this.averIm[s]!;
    const st = 2 * CS;
    const d = NC * CS;
    let sr = 0;
    let si = 0;
    for (let i = 0; i < d; i += st) {
      sr += c1r[o1 + i]! + c2r[o2 + i]!;
      si += c1i[o1 + i]! + c2i[o2 + i]!;
    }
    ar[oa] = sr / NC;
    ai[oa] = si / NC;
    for (let i = 0; i < FIT_LEN - st; ) {
      sr -= c1r[o1 + i]! + c2r[o2 + i]!;
      si -= c1i[o1 + i]! + c2i[o2 + i]!;
      sr += c1r[o1 + i + d]! + c2r[o2 + i + d]!;
      si -= c1i[o1 + i + d]! + c2i[o2 + i + d]!;
      i += st;
      ar[oa + i] = sr / NC;
      ai[oa + i] = si / NC;
    }
  }

  /** DataProcess (mt63base.cxx:1298-1447): one symbol's soft bits, then the decoder. */
  private dataProcess(s1: number, s2: number, freqOfs: number, timeDist: number): void {
    const e = { re: this.fRe, im: this.fIm };
    const o = { re: this.f2Re, im: this.f2Im };
    this.windowedFft(s1, e.re, e.im, freqOfs);
    this.windowedFft(s2, o.re, o.im, freqOfs);
    const twRe = this.fft.twRe;
    const twIm = this.fft.twIm;
    // Take out the phase a steady tone in each bin gains over timeDist samples.
    const incr = (timeDist * CS) & MASK;
    let p = (timeDist * this.dataScanFirst) & MASK;
    let c = this.dataScanFirst;
    for (let i = 0; i < DATA_SCAN_LEN; i++) {
      const buf = i & 1 ? o : e;
      const xr = buf.re[c]!;
      const xi = buf.im[c]!;
      const tr = twRe[p]!;
      const ti = twIm[p]!;
      const dr = this.refRe[i]! * tr - this.refIm[i]! * ti;
      const di = this.refRe[i]! * ti + this.refIm[i]! * tr;
      this.vecRe[i] = xr * dr + xi * di;
      this.vecIm[i] = xi * dr - xr * di;
      lowPass2(xr * xr + xi * xi, this.dataPwrMid, this.dataPwrOut, i, this.dw1, this.dw2, this.dw5);
      this.refRe[i] = xr;
      this.refIm[i] = xi;
      c = (c + CS) & MASK;
      p = (p + incr) & MASK;
    }
    // And the phase the frequency offset adds over the same time; then through the pipe,
    // which holds the vectors back half the integration period.
    const P = (-timeDist * 2 * Math.PI * freqOfs) / W;
    const fr = Math.cos(P);
    const fi = Math.sin(P);
    const pr = this.dataPipeRe[this.dataPipePtr]!;
    const pim = this.dataPipeIm[this.dataPipePtr]!;
    for (let i = 0; i < DATA_SCAN_LEN; i++) {
      const tr = this.vecRe[i]! * fr - this.vecIm[i]! * fi;
      const ti = this.vecRe[i]! * fi + this.vecIm[i]! * fr;
      this.vecRe[i] = pr[i]!;
      this.vecIm[i] = pim[i]!;
      pr[i] = tr;
      pim[i] = ti;
    }
    this.dataPipePtr = (this.dataPipePtr + 1) % this.dataPipeRe.length;
    for (let i = 0; i < DATA_SCAN_LEN; i++) {
      const po = this.dataPwrOut[i]!;
      if (po > 0) this.dataPhase[i] = Math.max(-1, Math.min(1, this.vecRe[i]! / po));
      else this.dataPhase[i] = 0;
    }
    const code = this.decoder.process(this.dataPhase);
    const snr = this.decoder.signalToNoise;
    const open = snr >= this.squelch;
    this.stats.snr = snr;
    this.stats.open = open;
    this.stats.locked = this.syncLocked;
    this.stats.quality = Math.min(1, this.syncSymbConf);
    // Where the carriers are, said only while there is a signal to say it of. The squelch
    // stays open a few seconds after a transmission (the s/n is smoothed and looks ahead)
    // while the synchroniser has already let go and wanders; the lock says when it has.
    // The lock is not a gate on printing: weak signals drop in and out of it mid-line.
    if (open && this.syncLocked) this.stats.afcHz = (this.syncFreqOfs + CS * this.decoder.carrOfs) * this.p.binHz;
    if (open) {
      const before = this.text.errors;
      const s = this.text.push(code);
      this.stats.errors += this.text.errors - before;
      this.stats.chars += [...s].length;
      this.out += s;
    }
  }
}
