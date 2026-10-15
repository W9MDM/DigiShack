// WSPR — the demodulator, from the reference implementation.
//
// Ported from WSJT-X `lib/wsprd/wsprd.c` (K9AN and K1JT, GPL-3.0; DigiShack is GPL-3.0 —
// see LICENSE): the candidate search over an averaged spectrum, the coarse sync on a
// spectrogram, `sync_and_demodulate` for the fine lag and frequency search,
// `noncoherent_sequence_detection` for the soft symbols, `subtract_signal2` so a decoded
// signal stops hiding the ones under it, and the three-pass schedule that ties them
// together. The thresholds, step sizes and search ranges are the reference's: a WSPR
// decoder's sensitivity IS those numbers, and the reference's were tuned over a decade on
// real spots. Checked in scripts/check-wsprdemod.ts against the decodes the reference
// binary (built from the same sources) pulls from the one recording WSJT-X publishes.
//
// Two deliberate departures, both stated:
//
//   * The 12 kHz audio is brought to a 375 Hz complex baseband with a mixer and an FIR
//     low-pass rather than the reference's single enormous FFT (1,474,560 points, which
//     needs FFTW's mixed radix). The passband is the same ±187.5 Hz; what differs is the
//     edge of the filter, which lies outside the ±110 Hz the search ever looks at.
//   * A decoded signal is re-encoded for subtraction from its 50 decoded BITS, not from
//     its printed text. The reference re-packs the text, and for a type 3 message whose
//     hash nobody has resolved that text is "<...>", which it cannot pack - so it `break`s
//     out of the candidate loop and never subtracts. The bits are what was decoded; they
//     re-encode whether or not the callsign is known.
//
// Not ported: the ordered-statistics decoder (`osdwspr`, Fortran) the reference can run
// after a Fano timeout at its deepest setting, and the Jelinek stack decoder, which is an
// alternative to Fano rather than an improvement on it. Both are sensitivity at the margin;
// the recording check says how much.

import {
  WSPR_SYNC,
  WSPR_SYMBOLS,
  WsprHashTable,
  channelSymbolsFor,
  deinterleave,
  fanoDecode,
  unpackWsprMessage,
  wsprMetricTable,
  type WsprMessage,
} from "@/lib/digital/wspr";
import { WSPR_METRIC_TABLE } from "@/lib/digital/wspr-metric";

/** The baseband rate the whole decoder works at: 12000 / 32. */
export const WSPR_BASEBAND_RATE = 375;
/** Samples per symbol at the baseband rate: 8192 / 32. */
const SPS = 256;
/** The decoder's buffer: 46080 baseband samples, 122.88 s, as the reference sizes it. */
export const WSPR_BASEBAND_SAMPLES = 46_080;
/** The reference reads 114 s of the 120 s period. */
export const WSPR_CAPTURE_SECONDS = 114;
const DT = 1 / WSPR_BASEBAND_RATE;
const DF = WSPR_BASEBAND_RATE / SPS; // 1.4648 Hz, the tone spacing
const TWO_PI = 2 * Math.PI;

export interface WsprDecode {
  /** The message as the reference prints it. */
  message: string;
  callsign: string;
  grid: string | null;
  /** dBm. */
  power: number;
  type: 1 | 2 | 3;
  /** Signal-to-noise in 2500 Hz, as WSPR reports it. */
  snrDb: number;
  /** Seconds relative to the nominal start, 1 s into the period. */
  dtS: number;
  /** Audio frequency, Hz: 1500 plus the offset the search found. */
  audioHz: number;
  /** Hz of drift over the transmission. */
  driftHz: number;
  /** The sync quality in [0, 1] the reference gates on. */
  sync: number;
  /** Which of the three passes found it. */
  pass: number;
  /** Fano cycles spent, for the curious. */
  cycles: number;
}

export interface WsprDemodOptions {
  /** 12000 unless the caller resampled; anything else is refused. */
  sampleRate?: number;
  /** The reference's -w: search ±150 Hz instead of ±110. */
  wide?: boolean;
  /** The reference's -d: every bin above the floor is a candidate, not only the peaks. */
  moreCandidates?: boolean;
  /** The reference's -q: no time jitter. Faster, less sensitive. */
  quick?: boolean;
  /** The reference's -s: one pass, no subtraction. */
  singlePass?: boolean;
  /** Hashed callsigns learned so far; a type 3 message needs its station's type 2. */
  hashes?: WsprHashTable;
  /** Where the search stands, pass by pass - for the check and for debugging, never for the log. */
  trace?: (line: string) => void;
}

// ---------------------------------------------------------------------------
// Downconversion: 12 kHz real audio to 375 Hz complex baseband around 1500 Hz
// ---------------------------------------------------------------------------

const DECIMATION = 32;
const FIR_TAPS = 1025;
const FIR_CUTOFF_HZ = 170;

/** A Blackman-windowed sinc low-pass, built once. */
let firCache: Float64Array | null = null;
function fir(): Float64Array {
  if (firCache) return firCache;
  const h = new Float64Array(FIR_TAPS);
  const fc = FIR_CUTOFF_HZ / 12_000;
  const mid = (FIR_TAPS - 1) / 2;
  let sum = 0;
  for (let n = 0; n < FIR_TAPS; n++) {
    const x = n - mid;
    const sinc = x === 0 ? 2 * fc : Math.sin(TWO_PI * fc * x) / (Math.PI * x);
    const w =
      0.42 - 0.5 * Math.cos((TWO_PI * n) / (FIR_TAPS - 1)) + 0.08 * Math.cos((2 * TWO_PI * n) / (FIR_TAPS - 1));
    h[n] = sinc * w;
    sum += h[n]!;
  }
  for (let n = 0; n < FIR_TAPS; n++) h[n] = h[n]! / sum;
  firCache = h;
  return h;
}

/**
 * Mix 1500 Hz to DC, low-pass, decimate by 32. Returns I and Q of exactly
 * WSPR_BASEBAND_SAMPLES samples, zero beyond the audio, the first 114 s of it used.
 */
export function wsprBaseband(audio: Float32Array): { i: Float32Array; q: Float32Array } {
  const h = fir();
  const mid = (FIR_TAPS - 1) >> 1;
  const n = Math.min(audio.length, WSPR_CAPTURE_SECONDS * 12_000);
  // Mix first, into a complex sequence at 12 kHz. The mixer's phase advances 1500/12000
  // of a turn per sample = exactly 1/8, so the local oscillator is an 8-entry table.
  const mi = new Float32Array(n);
  const mq = new Float32Array(n);
  const lo = [1, Math.SQRT1_2, 0, -Math.SQRT1_2, -1, -Math.SQRT1_2, 0, Math.SQRT1_2];
  for (let k = 0; k < n; k++) {
    const c = lo[k & 7]!;
    // -sin(2πk/8) = cos(2πk/8 + π/2), and π/2 is two steps of the eight-entry table.
    const s = lo[(k + 2) & 7]!;
    mi[k] = audio[k]! * c;
    mq[k] = audio[k]! * s;
  }
  const i = new Float32Array(WSPR_BASEBAND_SAMPLES);
  const q = new Float32Array(WSPR_BASEBAND_SAMPLES);
  const outCount = Math.min(WSPR_BASEBAND_SAMPLES, Math.ceil(n / DECIMATION));
  for (let m = 0; m < outCount; m++) {
    const centre = m * DECIMATION;
    let si = 0;
    let sq = 0;
    const lo0 = Math.max(0, centre - mid);
    const hi0 = Math.min(n - 1, centre + mid);
    for (let k = lo0; k <= hi0; k++) {
      const w = h[k - centre + mid]!;
      si += mi[k]! * w;
      sq += mq[k]! * w;
    }
    i[m] = si;
    q[m] = sq;
  }
  return { i, q };
}

// ---------------------------------------------------------------------------
// A 512-point complex FFT for the spectrogram
// ---------------------------------------------------------------------------

const NFFT = 512;
const fftCos = new Float64Array(NFFT / 2);
const fftSin = new Float64Array(NFFT / 2);
const fftRev = new Uint16Array(NFFT);
for (let k = 0; k < NFFT / 2; k++) {
  fftCos[k] = Math.cos((TWO_PI * k) / NFFT);
  fftSin[k] = -Math.sin((TWO_PI * k) / NFFT);
}
for (let k = 0; k < NFFT; k++) {
  let r = 0;
  for (let b = 0; b < 9; b++) r |= ((k >>> b) & 1) << (8 - b);
  fftRev[k] = r;
}
/** In place, forward, radix-2. */
function fft512(re: Float64Array, im: Float64Array): void {
  for (let k = 0; k < NFFT; k++) {
    const j = fftRev[k]!;
    if (j > k) {
      const tr = re[k]!;
      re[k] = re[j]!;
      re[j] = tr;
      const ti = im[k]!;
      im[k] = im[j]!;
      im[j] = ti;
    }
  }
  for (let size = 2; size <= NFFT; size <<= 1) {
    const half = size >> 1;
    const step = NFFT / size;
    for (let start = 0; start < NFFT; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = fftCos[k * step]!;
        const wi = fftSin[k * step]!;
        const a = start + k;
        const b = a + half;
        const xr = re[b]! * wr - im[b]! * wi;
        const xi = re[b]! * wi + im[b]! * wr;
        re[b] = re[a]! - xr;
        im[b] = im[a]! - xi;
        re[a] = re[a]! + xr;
        im[a] = im[a]! + xi;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Sync and demodulation (sync_and_demodulate, noncoherent_sequence_detection)
// ---------------------------------------------------------------------------

/** cos/sin of the four tones over one symbol, recomputed only when the frequency moves. */
class ToneTables {
  readonly c = [new Float64Array(SPS + 1), new Float64Array(SPS + 1), new Float64Array(SPS + 1), new Float64Array(SPS + 1)];
  readonly s = [new Float64Array(SPS + 1), new Float64Array(SPS + 1), new Float64Array(SPS + 1), new Float64Array(SPS + 1)];
  private last = Number.NaN;
  at(fp: number): void {
    if (fp === this.last) return;
    this.last = fp;
    for (let t = 0; t < 4; t++) {
      const dphi = TWO_PI * DT * (fp + (t - 1.5) * DF);
      const cd = Math.cos(dphi);
      const sd = Math.sin(dphi);
      const c = this.c[t]!;
      const s = this.s[t]!;
      c[0] = 1;
      s[0] = 0;
      for (let j = 1; j <= SPS; j++) {
        c[j] = c[j - 1]! * cd - s[j - 1]! * sd;
        s[j] = c[j - 1]! * sd + s[j - 1]! * cd;
      }
    }
  }
}

interface SyncResult {
  sync: number;
  shift: number;
  freq: number;
}

/**
 * The reference's `sync_and_demodulate`, modes 0 and 1: the sync metric over a grid of
 * lags (mode 0) or frequencies (mode 1), best returned. Mode 2 (soft symbols) is not here;
 * the reference itself uses `noncoherent_sequence_detection` for that now.
 */
function syncSearch(
  id: Float32Array,
  qd: Float32Array,
  np: number,
  tables: ToneTables,
  f1: number,
  ifmin: number,
  ifmax: number,
  fstep: number,
  shift1: number,
  lagmin: number,
  lagmax: number,
  lagstep: number,
  drift1: number,
  mode: 0 | 1,
): SyncResult {
  if (mode === 0) {
    ifmin = 0;
    ifmax = 0;
    fstep = 0;
  } else {
    lagmin = shift1;
    lagmax = shift1;
  }
  let syncmax = -1e30;
  let bestShift = 0;
  let fbest = 0;
  for (let ifreq = ifmin; ifreq <= ifmax; ifreq++) {
    const f0 = f1 + ifreq * fstep;
    for (let lag = lagmin; lag <= lagmax; lag += lagstep) {
      let ss = 0;
      let totp = 0;
      for (let i = 0; i < WSPR_SYMBOLS; i++) {
        const fp = f0 + (drift1 / 2) * (i - 81) / 81;
        tables.at(fp);
        let i0 = 0, q0 = 0, i1 = 0, q1 = 0, i2 = 0, q2 = 0, i3 = 0, q3 = 0;
        const base = lag + i * SPS;
        const c0 = tables.c[0]!, s0 = tables.s[0]!, c1 = tables.c[1]!, s1 = tables.s[1]!;
        const c2 = tables.c[2]!, s2 = tables.s[2]!, c3 = tables.c[3]!, s3 = tables.s[3]!;
        for (let j = 0; j < SPS; j++) {
          const k = base + j;
          if (k > 0 && k < np) {
            const x = id[k]!;
            const y = qd[k]!;
            i0 += x * c0[j]! + y * s0[j]!;
            q0 += -x * s0[j]! + y * c0[j]!;
            i1 += x * c1[j]! + y * s1[j]!;
            q1 += -x * s1[j]! + y * c1[j]!;
            i2 += x * c2[j]! + y * s2[j]!;
            q2 += -x * s2[j]! + y * c2[j]!;
            i3 += x * c3[j]! + y * s3[j]!;
            q3 += -x * s3[j]! + y * c3[j]!;
          }
        }
        const p0 = Math.sqrt(i0 * i0 + q0 * q0);
        const p1 = Math.sqrt(i1 * i1 + q1 * q1);
        const p2 = Math.sqrt(i2 * i2 + q2 * q2);
        const p3 = Math.sqrt(i3 * i3 + q3 * q3);
        totp += p0 + p1 + p2 + p3;
        const cmet = p1 + p3 - (p0 + p2);
        ss += WSPR_SYNC[i] === 1 ? cmet : -cmet;
      }
      ss /= totp;
      if (ss > syncmax) {
        syncmax = ss;
        bestShift = lag;
        fbest = f0;
      }
    }
  }
  return { sync: syncmax, shift: bestShift, freq: fbest };
}

/**
 * The reference's `noncoherent_sequence_detection`: soft symbols from a block of
 * `nblock` symbols demodulated together, which buys sensitivity when the channel holds
 * its phase that long. nblock = 1 is the classic symbol-by-symbol detector.
 */
function softSymbols(
  id: Float32Array,
  qd: Float32Array,
  np: number,
  tables: ToneTables,
  f1: number,
  shift1: number,
  drift1: number,
  symfac: number,
  nblock: number,
  bitByBit: boolean,
): Uint8Array {
  const nseq = 1 << nblock;
  const is = [new Float64Array(WSPR_SYMBOLS), new Float64Array(WSPR_SYMBOLS), new Float64Array(WSPR_SYMBOLS), new Float64Array(WSPR_SYMBOLS)];
  const qs = [new Float64Array(WSPR_SYMBOLS), new Float64Array(WSPR_SYMBOLS), new Float64Array(WSPR_SYMBOLS), new Float64Array(WSPR_SYMBOLS)];
  const cf = [new Float64Array(WSPR_SYMBOLS), new Float64Array(WSPR_SYMBOLS), new Float64Array(WSPR_SYMBOLS), new Float64Array(WSPR_SYMBOLS)];
  const sf = [new Float64Array(WSPR_SYMBOLS), new Float64Array(WSPR_SYMBOLS), new Float64Array(WSPR_SYMBOLS), new Float64Array(WSPR_SYMBOLS)];

  for (let i = 0; i < WSPR_SYMBOLS; i++) {
    const fp = f1 + (drift1 / 2) * (i - 81) / 81;
    tables.at(fp);
    const base = shift1 + i * SPS;
    for (let t = 0; t < 4; t++) {
      const c = tables.c[t]!;
      const s = tables.s[t]!;
      cf[t]![i] = c[SPS]!;
      sf[t]![i] = s[SPS]!;
      let ii = 0;
      let qq = 0;
      for (let j = 0; j < SPS; j++) {
        const k = base + j;
        if (k > 0 && k < np) {
          const x = id[k]!;
          const y = qd[k]!;
          ii += x * c[j]! + y * s[j]!;
          qq += -x * s[j]! + y * c[j]!;
        }
      }
      is[t]![i] = ii;
      qs[t]![i] = qq;
    }
  }

  const fsymb = new Float64Array(WSPR_SYMBOLS);
  const p = new Float64Array(nseq);
  for (let i = 0; i < WSPR_SYMBOLS; i += nblock) {
    for (let j = 0; j < nseq; j++) {
      let xi = 0;
      let xq = 0;
      let cm = 1;
      let sm = 0;
      for (let ib = 0; ib < nblock; ib++) {
        const b = (j & (1 << (nblock - 1 - ib))) >> (nblock - 1 - ib);
        const itone = WSPR_SYNC[i + ib]! + 2 * b;
        const si = is[itone]![i + ib]!;
        const sq = qs[itone]![i + ib]!;
        xi += si * cm + sq * sm;
        xq += sq * cm - si * sm;
        const cmp = cf[itone]![i + ib]! * cm - sf[itone]![i + ib]! * sm;
        const smp = sf[itone]![i + ib]! * cm + cf[itone]![i + ib]! * sm;
        cm = cmp;
        sm = smp;
      }
      p[j] = Math.sqrt(xi * xi + xq * xq);
    }
    for (let ib = 0; ib < nblock; ib++) {
      const imask = 1 << (nblock - 1 - ib);
      let xm1 = 0;
      let xm0 = 0;
      for (let j = 0; j < nseq; j++) {
        if ((j & imask) !== 0) {
          if (p[j]! > xm1) xm1 = p[j]!;
        } else if (p[j]! > xm0) xm0 = p[j]!;
      }
      fsymb[i + ib] = xm1 - xm0;
      if (bitByBit) fsymb[i + ib] = fsymb[i + ib]! / Math.max(xm1, xm0);
    }
  }

  let fsum = 0;
  let f2sum = 0;
  for (let i = 0; i < WSPR_SYMBOLS; i++) {
    fsum += fsymb[i]! / WSPR_SYMBOLS;
    f2sum += (fsymb[i]! * fsymb[i]!) / WSPR_SYMBOLS;
  }
  const fac = Math.sqrt(f2sum - fsum * fsum);
  const out = new Uint8Array(WSPR_SYMBOLS);
  for (let i = 0; i < WSPR_SYMBOLS; i++) {
    let v = (symfac * fsymb[i]!) / fac;
    if (v > 127) v = 127;
    if (v < -128) v = -128;
    out[i] = Math.trunc(v + 128);
  }
  return out;
}

/**
 * The reference's `subtract_signal2`: estimate the complex amplitude of a decoded signal
 * against its own regenerated waveform, low-pass it, and take it out of the data so the
 * next pass can find what it was covering.
 */
function subtractSignal(
  id: Float32Array,
  qd: Float32Array,
  np: number,
  f0: number,
  shift0: number,
  drift0: number,
  channelSymbols: Uint8Array,
): void {
  const nsig = WSPR_SYMBOLS * SPS;
  const nfilt = 360;
  const nc2 = 45_000;
  const refi = new Float64Array(nc2);
  const refq = new Float64Array(nc2);
  const ci = new Float64Array(nc2);
  const cq = new Float64Array(nc2);
  const cfi = new Float64Array(nc2);
  const cfq = new Float64Array(nc2);

  let phi = 0;
  for (let i = 0; i < WSPR_SYMBOLS; i++) {
    const cs = channelSymbols[i]!;
    const dphi = TWO_PI * DT * (f0 + (drift0 / 2) * (i - WSPR_SYMBOLS / 2) / (WSPR_SYMBOLS / 2) + (cs - 1.5) * DF);
    for (let j = 0; j < SPS; j++) {
      const ii = SPS * i + j;
      refi[ii] = Math.cos(phi);
      refq[ii] = Math.sin(phi);
      phi += dphi;
    }
  }

  const w = new Float64Array(nfilt);
  const partial = new Float64Array(nfilt);
  let norm = 0;
  for (let i = 0; i < nfilt; i++) {
    w[i] = Math.sin((Math.PI * i) / (nfilt - 1));
    norm += w[i]!;
  }
  for (let i = 0; i < nfilt; i++) w[i] = w[i]! / norm;
  for (let i = 1; i < nfilt; i++) partial[i] = partial[i - 1]! + w[i]!;

  for (let i = 0; i < nsig; i++) {
    const k = shift0 + i;
    if (k > 0 && k < np) {
      ci[i + nfilt] = id[k]! * refi[i]! + qd[k]! * refq[i]!;
      cq[i + nfilt] = qd[k]! * refi[i]! - id[k]! * refq[i]!;
    }
  }
  const half = nfilt / 2;
  for (let i = half; i < nc2 - half; i++) {
    let a = 0;
    let b = 0;
    for (let j = 0; j < nfilt; j++) {
      a += w[j]! * ci[i - half + j]!;
      b += w[j]! * cq[i - half + j]!;
    }
    cfi[i] = a;
    cfq[i] = b;
  }
  for (let i = 0; i < nsig; i++) {
    let nrm: number;
    if (i < half) nrm = partial[half + i]!;
    else if (i > nsig - 1 - half) nrm = partial[half + nsig - 1 - i]!;
    else nrm = 1;
    const k = shift0 + i;
    const j = i + nfilt;
    if (k > 0 && k < np) {
      id[k] = id[k]! - (cfi[j]! * refi[i]! - cfq[j]! * refq[i]!) / nrm;
      qd[k] = qd[k]! - (cfi[j]! * refq[i]! + cfq[j]! * refi[i]!) / nrm;
    }
  }
}

// ---------------------------------------------------------------------------
// The decoder
// ---------------------------------------------------------------------------

interface Candidate {
  freq: number;
  snr: number;
  shift: number;
  drift: number;
  sync: number;
}

/**
 * Decode one WSPR period of 12 kHz audio.
 *
 * The audio starts at the even minute; the first 114 s are used. Decodes come back
 * strongest-candidate first, duplicates (same callsign within 4 Hz) removed, as the
 * reference prints them.
 */
export function wsprDecodeAudio(audio: Float32Array, opts: WsprDemodOptions = {}): WsprDecode[] {
  const fs = opts.sampleRate ?? 12_000;
  if (fs !== 12_000) throw new Error(`WSPR decodes 12 kHz audio; got ${fs} Hz`);
  const hashes = opts.hashes ?? new WsprHashTable();
  const { i: idat, q: qdat } = wsprBaseband(audio);
  const np = WSPR_BASEBAND_SAMPLES;
  const mettab = wsprMetricTable(WSPR_METRIC_TABLE);
  const tables = new ToneTables();

  const fmin = opts.wide ? -150 : -110;
  const fmax = opts.wide ? 150 : 110;
  const npasses = opts.singlePass ? 1 : 3;
  const subtraction = !opts.singlePass;
  const minsync1 = 0.1;
  const iifac = 8;
  const symfac = 50;
  const minrms = 52 * (symfac / 64);
  const minSnrLinear = Math.pow(10, -8 / 10);
  const snrScaling = 26.3;

  const nffts = 4 * Math.floor(np / NFFT) - 1;
  const win = new Float64Array(NFFT);
  for (let i = 0; i < NFFT; i++) win[i] = Math.sin(0.006147931 * i);
  const ps = new Float32Array(NFFT * nffts); // ps[j*nffts + i]
  const re = new Float64Array(NFFT);
  const im = new Float64Array(NFFT);

  const decodes: WsprDecode[] = [];
  const uniques: { call: string; freq: number }[] = [];
  let decodesThisPass = 0;

  for (let ipass = 0; ipass < npasses; ipass++) {
    if (ipass === 1 && decodesThisPass === 0 && npasses > 2) ipass = 2;
    let nblocksize: number;
    let maxdrift: number;
    let minsync2: number;
    if (ipass < 2) {
      nblocksize = 1;
      maxdrift = 4;
      minsync2 = 0.12;
    } else {
      nblocksize = 4;
      maxdrift = 0;
      minsync2 = 0.1;
    }
    decodesThisPass = 0;

    // The spectrogram: 512-point FFTs every 128 samples, power, DC in the middle.
    for (let i = 0; i < nffts; i++) {
      for (let j = 0; j < NFFT; j++) {
        const k = i * 128 + j;
        // The last FFT reaches 255 samples past the buffer; the reference reads zeros
        // there from a larger calloc. Reading past a typed array here would be NaN.
        re[j] = k < np ? idat[k]! * win[j]! : 0;
        im[j] = k < np ? qdat[k]! * win[j]! : 0;
      }
      fft512(re, im);
      for (let j = 0; j < NFFT; j++) {
        let k = j + 256;
        if (k > 511) k -= 512;
        ps[j * nffts + i] = re[k]! * re[k]! + im[k]! * im[k]!;
      }
    }

    // The average spectrum, smoothed over 7 bins, limited to ±150 Hz.
    const psavg = new Float64Array(NFFT);
    for (let j = 0; j < NFFT; j++) {
      let s = 0;
      for (let i = 0; i < nffts; i++) s += ps[j * nffts + i]!;
      psavg[j] = s;
    }
    const smspec = new Float64Array(411);
    for (let i = 0; i < 411; i++) {
      let s = 0;
      for (let j = -3; j <= 3; j++) s += psavg[256 - 205 + i + j]!;
      smspec[i] = s;
    }
    const sorted = Float64Array.from(smspec).sort();
    const noiseLevel = sorted[122]!;
    for (let j = 0; j < 411; j++) {
      smspec[j] = smspec[j]! / noiseLevel - 1;
      if (smspec[j]! < minSnrLinear) smspec[j] = 0.1 * minSnrLinear;
    }

    // Candidates: local maxima, plus every bin above the floor if asked.
    let cands: Candidate[] = [];
    for (let j = 1; j < 410 && cands.length < 200; j++) {
      if (smspec[j]! > smspec[j - 1]! && smspec[j]! > smspec[j + 1]!) {
        cands.push({ freq: (j - 205) * (WSPR_BASEBAND_RATE / NFFT), snr: 10 * Math.log10(smspec[j]!) - snrScaling, shift: 0, drift: 0, sync: 0 });
      }
    }
    if (opts.moreCandidates) {
      for (let j = 0; j < 411 && cands.length < 200; j += 3) {
        if (smspec[j]! > minSnrLinear) {
          cands.push({ freq: (j - 205) * (WSPR_BASEBAND_RATE / NFFT), snr: 10 * Math.log10(smspec[j]!) - snrScaling, shift: 0, drift: 0, sync: 0 });
        }
      }
    }
    cands = cands.filter((c) => c.freq >= fmin && c.freq <= fmax);
    cands.sort((a, b) => b.snr - a.snr);
    opts.trace?.(
      `pass ${ipass}: noise ${noiseLevel.toExponential(2)}, ${cands.length} candidate(s)` +
        (cands.length ? `; best ${cands.slice(0, 5).map((c) => `${c.freq.toFixed(1)} Hz ${c.snr.toFixed(0)} dB`).join(", ")}` : ""),
    );

    // Coarse sync on the spectrogram: frequency ±2 bins, lag −10..21 half-symbols, drift.
    const binHz = WSPR_BASEBAND_RATE / NFFT;
    for (const c of cands) {
      let smax = -1e30;
      const if0 = Math.trunc(c.freq / binHz + 256);
      for (let ifr = if0 - 2; ifr <= if0 + 2; ifr++) {
        for (let k0 = -10; k0 < 22; k0++) {
          for (let idrift = -maxdrift; idrift <= maxdrift; idrift++) {
            let ss = 0;
            let pow = 0;
            for (let k = 0; k < WSPR_SYMBOLS; k++) {
              const ifd = Math.trunc(ifr + ((k - 81) / 81) * (idrift / (2 * binHz)));
              const kindex = k0 + 2 * k;
              if (kindex >= 0 && kindex < nffts) {
                const p0 = Math.sqrt(ps[(ifd - 3) * nffts + kindex]!);
                const p1 = Math.sqrt(ps[(ifd - 1) * nffts + kindex]!);
                const p2 = Math.sqrt(ps[(ifd + 1) * nffts + kindex]!);
                const p3 = Math.sqrt(ps[(ifd + 3) * nffts + kindex]!);
                ss += (2 * WSPR_SYNC[k]! - 1) * (p1 + p3 - (p0 + p2));
                pow += p0 + p1 + p2 + p3;
              }
            }
            const sync1 = ss / pow;
            if (sync1 > smax) {
              smax = sync1;
              c.shift = 128 * (k0 + 1);
              c.drift = idrift;
              c.freq = (ifr - 256) * binHz;
              c.sync = sync1;
            }
          }
        }
      }
    }

    // Fine sync: lag, then frequency, then drift, then finer lag and frequency.
    for (const c of cands) {
      let f1 = c.freq;
      let drift1 = c.drift;
      let shift1 = c.shift;
      let sync1 = c.sync;
      let r = syncSearch(idat, qdat, np, tables, f1, 0, 0, 0, shift1, shift1 - 128, shift1 + 128, 64, drift1, 0);
      shift1 = r.shift;
      sync1 = r.sync;
      r = syncSearch(idat, qdat, np, tables, f1, -2, 2, 0.25, shift1, shift1 - 128, shift1 + 128, 64, drift1, 1);
      f1 = r.freq;
      sync1 = r.sync;
      if (ipass < 2) {
        const rp = syncSearch(idat, qdat, np, tables, f1, 0, 0, 0, shift1, shift1 - 128, shift1 + 128, 64, drift1 + 0.5, 1);
        const rm = syncSearch(idat, qdat, np, tables, f1, 0, 0, 0, shift1, shift1 - 128, shift1 + 128, 64, drift1 - 0.5, 1);
        if (rp.sync > sync1) {
          drift1 += 0.5;
          sync1 = rp.sync;
        } else if (rm.sync > sync1) {
          drift1 -= 0.5;
          sync1 = rm.sync;
        }
      }
      if (sync1 > minsync1) {
        r = syncSearch(idat, qdat, np, tables, f1, 0, 0, 0, shift1, shift1 - 32, shift1 + 32, 16, drift1, 0);
        shift1 = r.shift;
        sync1 = r.sync;
        r = syncSearch(idat, qdat, np, tables, f1, -2, 2, 0.05, shift1, shift1 - 32, shift1 + 32, 16, drift1, 1);
        f1 = r.freq;
        sync1 = r.sync;
        c.freq = f1;
        c.shift = shift1;
        c.drift = drift1;
        c.sync = sync1;
      }
    }

    // Duplicates by frequency and lag; keep the better sync; drop the weak.
    const kept: Candidate[] = [];
    for (const c of cands) {
      let dupeOf = -1;
      for (let k = 0; k < kept.length; k++) {
        if (Math.abs(c.freq - kept[k]!.freq) < 0.05 && Math.abs(c.shift - kept[k]!.shift) < 16) {
          dupeOf = k;
          break;
        }
      }
      if (dupeOf >= 0) {
        if (c.sync > kept[dupeOf]!.sync) kept[dupeOf] = c;
      } else if (c.sync > minsync2) {
        kept.push(c);
      }
    }

    opts.trace?.(
      `pass ${ipass}: ${kept.length} past sync ${minsync2}` +
        (kept.length ? `; ${kept.slice(0, 5).map((c) => `${c.freq.toFixed(2)} Hz sync ${c.sync.toFixed(3)} shift ${c.shift} drift ${c.drift}`).join(", ")}` : ""),
    );

    // Decode: soft symbols over a jittered start, longer blocks on the last pass.
    for (const c of kept) {
      const f1 = c.freq;
      const shift1 = c.shift;
      const drift1 = c.drift;
      let decoded: { data: Uint8Array; cycles: number } | null = null;
      for (let ib = 1; ib <= nblocksize && !decoded; ib++) {
        const blocksize = ib < 4 ? ib : 1;
        const bitByBit = ib === 4;
        const maxJitter = opts.quick ? 0 : 128 / iifac;
        for (let idt = 0; idt <= maxJitter && !decoded; idt++) {
          let ii = Math.trunc((idt + 1) / 2);
          if (idt % 2 === 1) ii = -ii;
          ii *= iifac;
          const symbols = softSymbols(idat, qdat, np, tables, f1, shift1 + ii, drift1, symfac, blocksize, bitByBit);
          let sq = 0;
          for (let i = 0; i < WSPR_SYMBOLS; i++) {
            const y = symbols[i]! - 128;
            sq += y * y;
          }
          const rms = Math.sqrt(sq / WSPR_SYMBOLS);
          if (rms <= minrms) {
            opts.trace?.(`    ${f1.toFixed(2)} Hz ib=${ib} idt=${idt} jit=${ii} rms=${rms.toFixed(1)} below ${minrms.toFixed(1)}`);
            continue;
          }
          const r = fanoDecode(deinterleave(symbols), mettab);
          opts.trace?.(`    ${f1.toFixed(2)} Hz ib=${ib} idt=${idt} jit=${ii} rms=${rms.toFixed(1)} fano ${r.ok ? "ok" : "timeout"} cycles=${r.cycles} metric=${r.metric}`);
          if (r.ok) decoded = { data: r.data, cycles: r.cycles };
        }
      }
      if (!decoded) {
        opts.trace?.(`  ${f1.toFixed(2)} Hz sync ${c.sync.toFixed(3)}: no decode`);
        continue;
      }

      decodesThisPass++;
      const msg: WsprMessage | null = unpackWsprMessage(decoded.data, hashes);
      if (subtraction) {
        subtractSignal(idat, qdat, np, f1, shift1, drift1, channelSymbolsFor(decoded.data));
      }
      if (!msg) continue;
      const dupe = uniques.some((u) => u.call === msg.callsign && Math.abs(f1 - u.freq) < 4);
      if (dupe) continue;
      uniques.push({ call: msg.callsign, freq: f1 });
      decodes.push({
        message: msg.text,
        callsign: msg.callsign,
        grid: msg.grid,
        power: msg.power,
        type: msg.type,
        snrDb: Math.round(c.snr),
        dtS: Math.round((shift1 * DT - 1) * 10) / 10,
        audioHz: 1500 + f1,
        // Truncated toward zero as the reference prints it; the + 0 turns −0 into 0.
        driftHz: Math.trunc(drift1) + 0,
        sync: c.sync,
        pass: ipass,
        cycles: decoded.cycles,
      });
    }
  }

  decodes.sort((a, b) => a.audioHz - b.audioHz);
  return decodes;
}
