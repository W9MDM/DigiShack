// FT2 demodulator: audio in, log-likelihood ratios out.
//
// Ported from wsjt-x_improved `lib/ft2/ft2_decode.f90` (GPL-3.0; DigiShack is
// GPL-3.0). This is the last link in the receive chain:
//
//   audio (12 kHz) -> mix down + decimate 16x -> sync search -> soft bits
//     -> LLRs -> bpDecode128_90 -> 77 bits -> unpack77 -> text
//
// The signal is CPM (continuous-phase GFSK), which is what makes this more than
// a pair of tone filters: each symbol's phase depends on every symbol before it.
// With h = 0.8 the phase advances by ±2*pi*h/2 = ±0.8*pi per symbol, so the
// matched filters have to carry that accumulated rotation forward or the sync
// correlation decoheres after a few symbols.
//
// Deliberate simplifications relative to the reference, both of which cost
// sensitivity rather than correctness:
//
//   * Only `nseq=1`, the noncoherent single-symbol detector. The reference then
//     retries with multi-symbol sequence estimation over 2^(2n-1) hypotheses,
//     which reclaims frames this rejects. Worth adding; not needed for a decode.
//   * The candidate search is a coarse-to-fine sweep of the sync correlation
//     itself rather than a port of `getcandidates2a`'s spectral detector. The
//     sync correlation is a sound detector — it is what the reference uses to
//     confirm a candidate anyway — and it avoids needing an FFT here.
//
// Both are noted in the CHANGELOG rather than hidden, because "FT2 receive
// works" and "FT2 receive is as sensitive as WSJT-X" are different claims.

import { bpDecode128_90 } from "@/lib/digital/bpdecode12890";
import {
  FT2_BAUD,
  FT2_MOD_INDEX,
  FT2_SAMPLE_RATE,
  FT2_SYNC,
  FT2_SYNC_SYMBOLS,
  FT2_TOTAL_SYMBOLS,
} from "@/lib/digital/ft2";
import { HashCallBook, unpack77 } from "@/lib/digital/pack77";

/** Decimation factor at the native 12 kHz (`NDOWN`). 12000/16 = 750 Hz. */
export const FT2_NDOWN = 16;

/**
 * Sample rate the detector works at, whatever the input rate.
 *
 * 750 Hz gives 10 samples per symbol, which is what the matched filters and the
 * sync search are built around. Decimating to a FIXED rate rather than by a fixed
 * factor is what lets the same demodulator read 12 kHz and DAX's 24 kHz: the
 * factor becomes 16 or 32 and nothing else changes.
 */
export const FT2_DOWN_RATE = FT2_SAMPLE_RATE / FT2_NDOWN; // 750

/**
 * Decimation factor for an input rate.
 *
 * Throws rather than rounding — a fractional factor would slide the symbol
 * timing across the frame.
 */
export function ft2Decimation(sampleRate: number): number {
  const n = sampleRate / FT2_DOWN_RATE;
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(
      `FT2 demodulation needs a sample rate that is a whole multiple of ${FT2_DOWN_RATE} Hz; got ${sampleRate}`,
    );
  }
  return n;
}

/** Samples per symbol after decimation: 160/16. */
export const FT2_DOWN_SPS = 10;

/**
 * Peak frequency deviation, Hz: h * baud / 2 = 0.8 * 75 / 2 = 30.
 *
 * The reference reaches the same number by a more roundabout route
 * (`dphi=twopi/2*baud*h*dt*16` with the pre-decimation NSPS), which cancels out
 * to exactly this.
 */
export const FT2_DEVIATION_HZ = (FT2_MOD_INDEX * FT2_BAUD) / 2; // 30

/** Phase advance per decimated sample for a +1 symbol. */
const DPHI = (2 * Math.PI * FT2_DEVIATION_HZ) / FT2_DOWN_RATE;

/** Accumulated phase per symbol: 2*pi*h/2. The CPM memory term. */
const THETA = (2 * Math.PI * FT2_MOD_INDEX) / 2;

/** Symbols of search range for the time offset: 0 to 0.5 s at 750 Hz. */
const DT_SEARCH_SAMPLES = 375;

interface Complex {
  re: Float64Array;
  im: Float64Array;
}

function makeComplex(n: number): Complex {
  return { re: new Float64Array(n), im: new Float64Array(n) };
}

/** Matched-filter references for a +1 and a −1 symbol, 10 samples each. */
function symbolReferences(): { c1: Complex; c0: Complex } {
  const c1 = makeComplex(FT2_DOWN_SPS);
  const c0 = makeComplex(FT2_DOWN_SPS);
  let phi1 = 0;
  let phi0 = 0;
  for (let i = 0; i < FT2_DOWN_SPS; i++) {
    c1.re[i] = Math.cos(phi1);
    c1.im[i] = Math.sin(phi1);
    c0.re[i] = Math.cos(phi0);
    c0.im[i] = Math.sin(phi0);
    phi1 += DPHI;
    phi0 -= DPHI;
  }
  return { c1, c0 };
}

const REFS = symbolReferences();

/**
 * Low-pass coefficients for the decimator.
 *
 * FT2 occupies about 112 Hz, so a 150 Hz cutoff passes the signal whole while
 * rejecting everything that would alias into the 750 Hz output band. A windowed
 * sinc rather than a boxcar: a boxcar's first sidelobe is only 13 dB down, which
 * lets a strong neighbouring signal 200 Hz away fold straight on top of a weak
 * one and present as noise that no amount of decoding effort can fix.
 */
function lowpassTaps(cutoffHz: number, taps: number, sampleRate: number): Float64Array {
  const h = new Float64Array(taps);
  const fc = cutoffHz / sampleRate;
  const mid = (taps - 1) / 2;
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const x = i - mid;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    // Blackman window: ~58 dB sidelobe rejection.
    const w =
      0.42 -
      0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) +
      0.08 * Math.cos((4 * Math.PI * i) / (taps - 1));
    h[i] = sinc * w;
    sum += h[i]!;
  }
  for (let i = 0; i < taps; i++) h[i] = h[i]! / sum;
  return h;
}

/**
 * Filters are per input rate. Cached, because designing a 129-tap windowed sinc
 * on every decode window would dominate the cost of decoding.
 */
const LPF_CACHE = new Map<number, Float64Array>();

function lowpassFor(sampleRate: number): Float64Array {
  let f = LPF_CACHE.get(sampleRate);
  if (!f) {
    // Taps scale with the decimation factor so the transition band stays the
    // same fraction of the OUTPUT bandwidth: a 129-tap filter that is right at
    // 12 kHz is half as sharp, in Hz, at 24 kHz.
    const taps = 2 * Math.round((129 * sampleRate) / FT2_SAMPLE_RATE / 2) + 1;
    f = lowpassTaps(150, taps, sampleRate);
    LPF_CACHE.set(sampleRate, f);
  }
  return f;
}

/**
 * Mix a real audio buffer down by `f0` and decimate by 16.
 *
 * Equivalent in intent to `ft2_downsample`, which does it via FFT. Time domain
 * here: the filter runs only at output sample positions, so the cost is
 * taps-per-output rather than taps-per-input — the same trick that makes a
 * polyphase decimator cheap.
 */
export function ft2Downsample(
  audio: ArrayLike<number>,
  f0: number,
  sampleRate: number = FT2_SAMPLE_RATE,
): Complex {
  const ndown = ft2Decimation(sampleRate);
  const LPF = lowpassFor(sampleRate);
  const nOut = Math.floor(audio.length / ndown);
  const out = makeComplex(nOut);
  const w = (-2 * Math.PI * f0) / sampleRate;
  const taps = LPF.length;
  const half = (taps - 1) / 2;

  // Mixing is cheap; do it into scratch buffers once rather than per filter tap.
  const mixRe = new Float64Array(audio.length);
  const mixIm = new Float64Array(audio.length);
  for (let n = 0; n < audio.length; n++) {
    const phase = w * n;
    const s = audio[n]!;
    mixRe[n] = s * Math.cos(phase);
    mixIm[n] = s * Math.sin(phase);
  }

  for (let k = 0; k < nOut; k++) {
    const centre = k * ndown;
    let re = 0;
    let im = 0;
    for (let t = 0; t < taps; t++) {
      const idx = centre + t - half;
      if (idx < 0 || idx >= audio.length) continue;
      const c = LPF[t]!;
      re += mixRe[idx]! * c;
      im += mixIm[idx]! * c;
    }
    out.re[k] = re;
    out.im[k] = im;
  }
  return out;
}

/** Rotate a decimated buffer by `df` Hz — the reference's `twkfreq1`. */
function tweakFrequency(c: Complex, df: number): Complex {
  const n = c.re.length;
  const out = makeComplex(n);
  const w = (-2 * Math.PI * df) / FT2_DOWN_RATE;
  for (let i = 0; i < n; i++) {
    const ca = Math.cos(w * i);
    const sa = Math.sin(w * i);
    out.re[i] = c.re[i]! * ca - c.im[i]! * sa;
    out.im[i] = c.re[i]! * sa + c.im[i]! * ca;
  }
  return out;
}

/**
 * Correlate the 16-symbol sync pattern at one time offset.
 *
 * The `cterm` rotation is the part that is easy to leave out and hard to notice:
 * because FT2 is continuous-phase, each sync symbol arrives rotated by the
 * accumulated phase of everything before it. Drop it and the correlation still
 * peaks — just far more weakly, so the decoder merely seems insensitive.
 */
function syncCorrelation(cb: Complex, offset: number): number {
  let sumRe = 0;
  let sumIm = 0;
  let termRe = 1;
  let termIm = 0;
  const cosT = Math.cos(THETA);
  const sinT = Math.sin(THETA);

  for (let ib = 0; ib < FT2_SYNC_SYMBOLS; ib++) {
    const base = ib * FT2_DOWN_SPS + offset;
    if (base + FT2_DOWN_SPS > cb.re.length) return 0;
    const one = FT2_SYNC[ib] === 1;
    const ref = one ? REFS.c1 : REFS.c0;

    // Correlate this symbol against its matched filter.
    let re = 0;
    let im = 0;
    for (let k = 0; k < FT2_DOWN_SPS; k++) {
      const ar = cb.re[base + k]!;
      const ai = cb.im[base + k]!;
      const br = ref.re[k]!;
      const bi = -ref.im[k]!; // conjugate
      re += ar * br - ai * bi;
      im += ar * bi + ai * br;
    }
    // Accumulate with the running CPM phase term.
    sumRe += re * termRe - im * termIm;
    sumIm += re * termIm + im * termRe;

    // cc1 = exp(-i*theta), cc0 = exp(+i*theta).
    const rot = one ? -sinT : sinT;
    const nr = termRe * cosT - termIm * rot;
    const ni = termRe * rot + termIm * cosT;
    termRe = nr;
    termIm = ni;
  }
  return Math.hypot(sumRe, sumIm);
}

export interface Ft2SyncResult {
  /** Frequency correction, Hz, relative to the candidate. */
  df: number;
  /** Time offset in decimated samples. */
  offset: number;
  /** Correlation magnitude at the peak. */
  magnitude: number;
}

/**
 * Two-dimensional sync search over frequency offset and time.
 *
 * Coarse-to-fine. The reference sweeps every one of 61 x 375 combinations, which
 * at 16 symbols x 10 samples each is 3.7 million complex multiplies per candidate
 * frequency — fine in Fortran, not fine in a browser-adjacent runtime doing this
 * every 1.92 seconds. Coarse steps of 3 Hz and 3 samples cut it about 9x, then a
 * local refinement recovers the exact peak. The sync correlation is smooth on
 * that scale, so the coarse pass does not step over the maximum.
 */
export function ft2SyncSearch(
  c2: Complex,
  opts: { maxDf?: number; coarseDf?: number; coarseDt?: number } = {},
): Ft2SyncResult {
  const maxDf = opts.maxDf ?? 30;
  const coarseDf = opts.coarseDf ?? 3;
  const coarseDt = opts.coarseDt ?? 3;

  let best: Ft2SyncResult = { df: 0, offset: 0, magnitude: -1 };
  const evaluate = (df: number, offset: number, cache: Map<number, Complex>) => {
    let cb = cache.get(df);
    if (!cb) {
      cb = tweakFrequency(c2, df);
      cache.set(df, cb);
    }
    const m = syncCorrelation(cb, offset);
    if (m > best.magnitude) best = { df, offset, magnitude: m };
  };

  const cache = new Map<number, Complex>();
  for (let df = -maxDf; df <= maxDf; df += coarseDf) {
    for (let is = 0; is < DT_SEARCH_SAMPLES; is += coarseDt) {
      evaluate(df, is, cache);
    }
  }

  // Refine around the coarse peak.
  const cdf = best.df;
  const cdt = best.offset;
  for (let df = cdf - coarseDf; df <= cdf + coarseDf; df += 1) {
    if (df < -maxDf || df > maxDf) continue;
    for (let is = Math.max(0, cdt - coarseDt); is <= cdt + coarseDt; is++) {
      if (is >= DT_SEARCH_SAMPLES) continue;
      evaluate(df, is, cache);
    }
  }
  return best;
}

/**
 * Noncoherent single-symbol soft bits — the reference's `nseq=1` branch.
 *
 * `|corr(+1)| - |corr(-1)|` per symbol. Noncoherent, so it throws away the CPM
 * phase relationship between symbols; that is exactly what the multi-symbol
 * detector reclaims.
 */
export function ft2SoftBits(cd: Complex): Float64Array {
  const sbits = new Float64Array(FT2_TOTAL_SYMBOLS);
  for (let ibit = 0; ibit < FT2_TOTAL_SYMBOLS; ibit++) {
    const base = ibit * FT2_DOWN_SPS;
    let r1 = 0;
    let i1 = 0;
    let r0 = 0;
    let i0 = 0;
    for (let k = 0; k < FT2_DOWN_SPS; k++) {
      const ar = cd.re[base + k]!;
      const ai = cd.im[base + k]!;
      r1 += ar * REFS.c1.re[k]! + ai * REFS.c1.im[k]!;
      i1 += ai * REFS.c1.re[k]! - ar * REFS.c1.im[k]!;
      r0 += ar * REFS.c0.re[k]! + ai * REFS.c0.im[k]!;
      i0 += ai * REFS.c0.re[k]! - ar * REFS.c0.im[k]!;
    }
    sbits[ibit] = Math.hypot(r1, i1) - Math.hypot(r0, i0);
  }
  return sbits;
}

/** Samples the sync correlation coherently sums: 16 symbols x 10 samples. */
const SYNC_SPAN = FT2_SYNC_SYMBOLS * FT2_DOWN_SPS;

/**
 * Signal-to-noise estimate in dB, referred to 2500 Hz as WSJT-X reports it.
 *
 * NOT the reference's `db(sybest*sybest) - 115`. That constant is calibrated to
 * `sybest` computed over un-normalised int16 samples; applied to the float audio
 * and unit-power normalisation used here it returns about −74 dB for a perfect
 * noiseless signal, which is worse than useless — an operator would read it as a
 * signal at the very edge of copy.
 *
 * Derived instead from the sync correlation recomputed on the NORMALISED frame,
 * where mean power is 1 so signal power Ps and noise power Pn sum to 1. The
 * correlation from the search pass cannot be used: it runs on the raw buffer,
 * whose scale follows the input level, and it stayed near-constant across a 13x
 * change in noise.
 * Coherent summing over `SYNC_SPAN` samples gives the signal amplitude gain
 * SYNC_SPAN while noise power grows only as SYNC_SPAN:
 *
 *     m^2 ~= SYNC_SPAN^2 * Ps + SYNC_SPAN * Pn,   Ps + Pn = 1
 *
 * which solves for Pn directly. The measurement bandwidth is the decimation
 * filter's two-sided 300 Hz, so referring to 2500 Hz subtracts 10log10(2500/300).
 *
 * An estimate, not a calibration: it has not been checked against WSJT-X's number
 * on the same recording, so treat it as a relative indication between decodes
 * rather than an absolute figure.
 */
function estimateSnrDb(magnitude: number): number {
  const m2 = magnitude * magnitude;
  const denom = SYNC_SPAN * SYNC_SPAN - SYNC_SPAN;
  let pn = (SYNC_SPAN * SYNC_SPAN - m2) / denom;
  // Clamp: a strong signal can push the estimate past the model's limits, and a
  // non-finite SNR in the decode list is worse than a saturated one.
  pn = Math.min(1, Math.max(1e-6, pn));
  const ps = Math.max(1e-6, 1 - pn);
  return 10 * Math.log10(ps / pn) - 10 * Math.log10(2500 / 300);
}

export interface Ft2Decode {
  message: string;
  /** Audio frequency of the signal, Hz. */
  frequencyHz: number;
  /** Time offset within the window, seconds. */
  dtSeconds: number;
  /** Rough signal-to-noise estimate, dB — the reference's `db(sybest^2) - 115`. */
  snrDb: number;
  /** Sync symbols matching the expected pattern, out of 16. */
  syncQuality: number;
  /** Bits the LDPC decoder had to correct. Lower is a cleaner signal. */
  hardErrors: number;
  /** Payload type. */
  i3: number;
}

export interface Ft2DecodeAudioOptions {
  /**
   * Candidate audio frequencies to try, Hz.
   *
   * Supply these from a waterfall when one is available — it is far cheaper than
   * sweeping. Omitted, a coarse grid across the passband is swept instead.
   */
  frequencies?: number[];
  /** Passband to sweep when `frequencies` is not given. */
  minFrequencyHz?: number;
  maxFrequencyHz?: number;
  /** Grid step for the sweep. Must be under 2x the ±30 Hz sync search range. */
  stepHz?: number;
  /** Reject a candidate whose sync pattern matches fewer than this many of 16. */
  minSyncQuality?: number;
  /** Learned callsigns, for resolving hashed calls in payload types 4 and 5. */
  book?: HashCallBook;
  maxDecodes?: number;
  /**
   * Input sample rate. 12 kHz is FT2's native rate; DAX supplies 24 kHz.
   *
   * Only the decimation factor and the anti-alias filter depend on it — the
   * detector always works at 750 Hz, so nothing downstream needs to know.
   */
  sampleRate?: number;
}

/**
 * Decode FT2 from a window of 12 kHz audio.
 *
 * Returns one entry per distinct message. Duplicates across candidate
 * frequencies are collapsed, since one signal will decode from several
 * neighbouring candidates.
 */
export function ft2DecodeAudio(
  audio: ArrayLike<number>,
  opts: Ft2DecodeAudioOptions = {},
): Ft2Decode[] {
  const minF = opts.minFrequencyHz ?? 400;
  const maxF = opts.maxFrequencyHz ?? 2800;
  const step = opts.stepHz ?? 50;
  const minSync = opts.minSyncQuality ?? 10;
  const maxDecodes = opts.maxDecodes ?? 20;
  const book = opts.book;

  const sampleRate = opts.sampleRate ?? FT2_SAMPLE_RATE;
  const ndown = ft2Decimation(sampleRate);
  const needed = (FT2_TOTAL_SYMBOLS * FT2_DOWN_SPS + DT_SEARCH_SAMPLES) * ndown;
  if (audio.length < needed) return [];

  const candidates =
    opts.frequencies ??
    (() => {
      const f: number[] = [];
      for (let x = minF; x <= maxF; x += step) f.push(x);
      return f;
    })();

  const out: Ft2Decode[] = [];
  const seen = new Set<string>();

  for (const f0 of candidates) {
    if (out.length >= maxDecodes) break;
    // The reference refuses candidates within 375 Hz of the band edges, where the
    // downsample filter would clip the signal.
    if (f0 <= 375 || f0 >= sampleRate / 2 - 375) continue;

    const c2 = ft2Downsample(audio, f0, sampleRate);
    const sync = ft2SyncSearch(c2);
    if (sync.magnitude <= 0) continue;

    const cb = tweakFrequency(c2, sync.df);
    const need = FT2_TOTAL_SYMBOLS * FT2_DOWN_SPS;
    if (sync.offset + need > cb.re.length) continue;

    // Normalise to unit mean power, so the LLR scaling below means the same
    // thing regardless of input level.
    const cd = makeComplex(need);
    let power = 0;
    for (let i = 0; i < need; i++) {
      const re = cb.re[sync.offset + i]!;
      const im = cb.im[sync.offset + i]!;
      cd.re[i] = re;
      cd.im[i] = im;
      power += re * re + im * im;
    }
    power /= need;
    if (!(power > 0)) continue;
    const norm = 1 / Math.sqrt(power);
    for (let i = 0; i < need; i++) {
      cd.re[i] = cd.re[i]! * norm;
      cd.im[i] = cd.im[i]! * norm;
    }

    // Re-correlate the sync on the NORMALISED data. `sync.magnitude` came from
    // the raw buffer, whose scale depends on the input level, so it cannot support
    // an SNR estimate — it stayed near-constant across a 13x change in noise.
    const syncMagNorm = syncCorrelation(cd, 0);

    const sbits = ft2SoftBits(cd);

    let syncQuality = 0;
    for (let i = 0; i < FT2_SYNC_SYMBOLS; i++) {
      const bit = sbits[i]! > 0 ? 1 : 0;
      if (bit === FT2_SYNC[i]) syncQuality++;
    }
    if (syncQuality < minSync) continue;

    // Standardise the data soft bits, then scale to LLRs. sigma = 0.80 is the
    // reference's value; it is a fixed assumption about the post-detection noise
    // distribution, not something measured per frame.
    const data = sbits.subarray(FT2_SYNC_SYMBOLS);
    let mean = 0;
    for (const v of data) mean += v;
    mean /= data.length;
    let variance = 0;
    for (const v of data) variance += (v - mean) * (v - mean);
    variance /= data.length;
    const sd = Math.sqrt(variance);
    if (!(sd > 0)) continue;

    const SIGMA = 0.8;
    const llr = new Float64Array(128);
    for (let i = 0; i < 128; i++) llr[i] = (2 * (data[i]! / sd)) / (SIGMA * SIGMA);

    const decoded = bpDecode128_90(llr, { maxIterations: 40 });
    if (!decoded.ok || !decoded.message) continue;

    // An all-zero payload is what a decoder returns when it has locked onto
    // nothing; the reference discards it explicitly.
    if (decoded.message.every((b) => b === 0)) continue;

    const text = unpack77(decoded.message, book);
    if (!text.ok || !text.message) continue;
    if (seen.has(text.message)) continue;
    seen.add(text.message);

    out.push({
      message: text.message,
      frequencyHz: f0 + sync.df,
      // The sync peak sits one symbol into the buffer: the modulator convolves
      // each symbol with a 3-symbol Gaussian pulse, so symbol 0's energy is
      // centred a symbol period after the transmission begins. Subtracting it
      // makes dtSeconds mean "when the transmission started", which is what an
      // operator reads it as. Verified against known placements: a signal put at
      // 0.200 s reports 0.197, one at 0.250 s reports 0.249.
      dtSeconds: (sync.offset - FT2_DOWN_SPS) / FT2_DOWN_RATE,
      snrDb: estimateSnrDb(syncMagNorm),
      syncQuality,
      hardErrors: decoded.hardErrors,
      i3: text.i3,
    });
  }

  return out;
}
