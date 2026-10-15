// JS8 demodulator: one T/R period of 12 kHz audio in, the frames it carried out.
//
// Ported from JS8Call (GPL-3.0; DigiShack is GPL-3.0): lib/js8/syncjs8.f90 finds candidates
// over the whole passband, lib/js8/js8_downsample.f90 brings one candidate to baseband at
// 32 samples a symbol, lib/js8/syncjs8d.f90 refines its time and frequency against the
// three Costas blocks, and lib/js8/js8dec.f90 turns 58 symbol spectra into soft bits for
// the (174,87) decoder in js8-bp.ts, in four passes of two metrics. The numbers below are
// the reference's; the code is written as this project's other demodulators are.
//
// THREE DEPARTURES, stated: there is no ordered-statistics decoder (the reference reaches
// for one at its deeper settings and it recovers some marginal frames), there is no
// subtraction of decoded signals before a second pass (two stations on one frequency
// decode one here), and the SNR is the reference's first estimate (signal against the
// off-tone bins) rather than its second (against a fitted baseline), so it will read a
// few dB from what JS8Call shows for the same signal. Each is a known next step.
//
// A note on DT: the reference's fine sync measures from the start of the period, so its
// "xdt" includes the submode's start delay; what this reports is relative to the nominal
// start, so a punctual station shows DT 0.

import { fftMixed, fftReal } from "@/lib/dsp/fft-mixed";
import { JS8_COSTAS, JS8_DATA_SYMBOLS, JS8_SAMPLE_RATE, JS8_SUBMODES, JS8_SYMBOLS, js8TonesFor, js8Encode, js8UnpackFrame, type Js8Submode } from "@/lib/digital/js8";
import { js8BpDecode } from "@/lib/digital/js8-bp";

/** Per-submode decoder parameters, from js8{a,b,c,e,i}_params.f90. */
const DEMOD_PARAMS: Record<Js8Submode, { ndownsps: number; ndd: number; jz: number }> = {
  A: { ndownsps: 32, ndd: 100, jz: 62 },
  B: { ndownsps: 20, ndd: 100, jz: 144 },
  C: { ndownsps: 12, ndd: 120, jz: 172 },
  E: { ndownsps: 32, ndd: 90, jz: 32 },
  I: { ndownsps: 12, ndd: 125, jz: 250 },
};

/** Search ±2.5 Hz in 0.5 Hz steps around a candidate (NFSRCH). */
const NFSRCH = 5;
/** Minimum normalised sync for a candidate (ASYNCMIN). */
const ASYNCMIN = 1.5;
const MAX_CANDIDATES = 60;
const LLR_SCALE = 2.83;

export interface Js8DemodOptions {
  sampleRate: number;
  submode?: Js8Submode;
  /** Passband to search, Hz audio. Default 200-3000. */
  minHz?: number;
  maxHz?: number;
  /** Minimum normalised sync for a candidate. Default 1.5, the reference's. */
  syncMin?: number;
  maxCandidates?: number;
}

export interface Js8Decode {
  /** Audio frequency of tone 0, Hz. */
  freqHz: number;
  /** Seconds relative to the nominal start of the transmission. */
  dtS: number;
  snrDb: number;
  /** The twelve payload characters. */
  text: string;
  frameType: number;
  /** The 87 information bits, for the message layer. */
  info: Uint8Array;
  /** Costas symbols that landed on their tone, of 21. */
  sync: number;
  hardErrors: number;
  /** Which of the four metric passes decoded it. */
  pass: number;
  candidateSync: number;
}

interface Candidate {
  hz: number;
  dtS: number;
  sync: number;
}

/** The Nuttall window WSJT-X uses for its symbol spectra (nuttal_window.f90). */
function nuttallWindow(n: number): Float64Array {
  const w = new Float64Array(n);
  const a0 = 0.3635819;
  const a1 = 0.4891775;
  const a2 = 0.1365995;
  const a3 = 0.0106411;
  for (let i = 0; i < n; i++) {
    const x = (2 * Math.PI * i) / n;
    w[i] = a0 - a1 * Math.cos(x) + a2 * Math.cos(2 * x) - a3 * Math.cos(3 * x);
  }
  return w;
}

/** syncjs8: the coarse search over frequency and time for Costas sync, giving candidates. */
function coarseSync(dd: Float64Array, submode: Js8Submode, minHz: number, maxHz: number, syncMin: number, maxCand: number): Candidate[] {
  const p = JS8_SUBMODES[submode];
  const dp = DEMOD_PARAMS[submode];
  const nsps = p.nsps;
  const nmax = dd.length;
  const nfft1 = 2 * nsps;
  const nh1 = nfft1 / 2;
  const nstep = nsps / 4;
  const nhsym = Math.floor(nmax / nstep) - 3;
  const costas = JS8_COSTAS[p.costas];

  // Windowed spectra every quarter symbol.
  const window = nuttallWindow(nfft1);
  let wsum = 0;
  for (let i = 0; i < nfft1; i++) wsum += window[i]!;
  const wscale = ((nsps * 2) / 300) / wsum;
  const s: Float64Array[] = [];
  const buf = new Float64Array(nfft1);
  for (let j = 0; j < nhsym; j++) {
    const ia = j * nstep;
    if (ia + nfft1 > nmax) break;
    for (let i = 0; i < nfft1; i++) buf[i] = dd[ia + i]! * window[i]! * wscale;
    const { re, im } = fftReal(buf);
    const row = new Float64Array(nh1);
    for (let i = 0; i < nh1; i++) row[i] = re[i]! * re[i]! + im[i]! * im[i]!;
    s.push(row);
  }
  const ncol = s.length;

  const df = JS8_SAMPLE_RATE / nfft1;
  const tstep = nstep / JS8_SAMPLE_RATE;
  const nfa = Math.max(100, minHz);
  const nfb = Math.min(4910, maxHz);
  const ia = Math.max(1, Math.round(nfa / df));
  const ib = Math.min(nh1 - 1 - 2 * 7, Math.round(nfb / df));
  const nssy = nsps / nstep;
  const nfos = nfft1 / nsps;
  const jstrt = Math.floor(p.startS / tstep);
  const jz = dp.jz;

  const red = new Float64Array(nh1);
  const jpeak = new Int32Array(nh1);
  const blockAt = [0, 36, 72];
  for (let i = ia; i <= ib; i++) {
    let best = -Infinity;
    let bestJ = 0;
    for (let j = -jz; j <= jz; j++) {
      const t = [0, 0, 0];
      const t0 = [0, 0, 0];
      for (let b = 0; b < 3; b++) {
        for (let n = 0; n < 7; n++) {
          const k = j + jstrt + nssy * n + nssy * blockAt[b]!;
          // Fortran's syoff is 1-based and valid in 1..NHSYM; column index is syoff-1.
          if (k >= 1 && k <= ncol) {
            const row = s[k - 1]!;
            t[b]! += row[i + nfos * costas[b]![n]!]!;
            let all = 0;
            for (let m = 0; m < 7; m++) all += row[i + nfos * m]!;
            t0[b]! += all;
          }
        }
      }
      const ratio = (a: number, a0: number) => a / ((a0 - a) / 6);
      const abc = ratio(t[0]! + t[1]! + t[2]!, t0[0]! + t0[1]! + t0[2]!);
      const ab = ratio(t[0]! + t[1]!, t0[0]! + t0[1]!);
      const bc = ratio(t[1]! + t[2]!, t0[1]! + t0[2]!);
      const v = Math.max(abc, ab, bc);
      if (v > best) {
        best = v;
        bestJ = j;
      }
    }
    red[i] = best;
    jpeak[i] = bestJ;
  }

  // Normalise by the 40th percentile across the searched bins.
  const bins: number[] = [];
  for (let i = ia; i <= ib; i++) bins.push(i);
  const sorted = bins.slice().sort((x, y) => red[x]! - red[y]!);
  const npct = Math.round(0.4 * sorted.length);
  if (npct < 1) return [];
  const base = red[sorted[npct - 1]!]!;
  if (!(base > 0)) return [];
  for (const i of bins) red[i]! /= base;

  // Strongest first, down to the threshold, then dedupe within AZ.
  const az = (JS8_SAMPLE_RATE / nsps) * (submode === "A" ? 0.64 : 0.8);
  const out: Candidate[] = [];
  for (let q = sorted.length - 1; q >= 0 && out.length < maxCand; q--) {
    const i = sorted[q]!;
    const r = red[i]!;
    if (!(r >= syncMin) || Number.isNaN(r)) break;
    out.push({ hz: i * df, dtS: (jpeak[i]! - 0.5) * tstep, sync: r });
  }
  const kept: Candidate[] = [];
  for (const c of out) {
    const dupe = kept.find((k) => Math.abs(k.hz - c.hz) < az);
    if (!dupe) kept.push(c);
  }
  return kept;
}

/** js8_downsample: one candidate frequency to baseband at ndownsps samples a symbol, via the period's spectrum. */
function downsample(spectrum: { re: Float64Array; im: Float64Array }, ndfft1: number, ndfft2: number, ndd: number, f0: number, baud: number): { re: Float64Array; im: Float64Array } {
  const df = JS8_SAMPLE_RATE / ndfft1;
  const i0 = Math.round(f0 / df);
  const it = Math.min(Math.round((f0 + 8.5 * baud) / df), ndfft1 / 2);
  const ib = Math.max(1, Math.round((f0 - 1.5 * baud) / df));
  const re = new Float64Array(ndfft2);
  const im = new Float64Array(ndfft2);
  let k = 0;
  for (let i = ib; i <= it && k < ndfft2; i++) {
    re[k] = spectrum.re[i]!;
    im[k] = spectrum.im[i]!;
    k++;
  }
  // Taper the band edges with a raised cosine over ndd bins.
  for (let i = 0; i <= ndd && i < k; i++) {
    const g = 0.5 * (1 + Math.cos(((ndd - i) * Math.PI) / ndd));
    re[i]! *= g;
    im[i]! *= g;
    const j = k - 1 - ndd + i;
    const g2 = 0.5 * (1 + Math.cos((i * Math.PI) / ndd));
    if (j >= 0 && j < k) {
      re[j]! *= g2;
      im[j]! *= g2;
    }
  }
  // Circular shift so bin i0 (tone 0) lands at DC.
  const shift = ((i0 - ib) % ndfft2 + ndfft2) % ndfft2;
  const sre = new Float64Array(ndfft2);
  const sim = new Float64Array(ndfft2);
  for (let i = 0; i < ndfft2; i++) {
    sre[i] = re[(i + shift) % ndfft2]!;
    sim[i] = im[(i + shift) % ndfft2]!;
  }
  fftMixed(sre, sim, 1);
  const fac = 1 / Math.sqrt(ndfft1 * ndfft2);
  for (let i = 0; i < ndfft2; i++) {
    sre[i]! *= fac;
    sim[i]! *= fac;
  }
  return { re: sre, im: sim };
}

/** syncjs8d: the Costas correlation at a start sample and frequency offset. */
function fineSync(cd: { re: Float64Array; im: Float64Array }, costas: readonly (readonly number[])[], ndownsps: number, i0: number, delfHz: number, fs2: number): number {
  // Bounded by the buffer, not by 79 symbols from sample zero as the reference is: its
  // bound drops the last sync block's tail for any station that starts after the period
  // boundary, which is every station.
  let sync = 0;
  for (let i = 0; i < 7; i++) {
    for (let b = 0; b < 3; b++) {
      const start = i0 + (i + [0, 36, 72][b]!) * ndownsps;
      if (start < 0 || start + ndownsps > cd.re.length) continue;
      const tone = costas[b]![i]!;
      let zr = 0;
      let zi = 0;
      for (let n = 0; n < ndownsps; n++) {
        // conj of the tone waveform, offset by delf.
        const ang = (2 * Math.PI * tone * n) / ndownsps + (2 * Math.PI * delfHz * n) / fs2;
        const c = Math.cos(ang);
        const s = -Math.sin(ang);
        const xr = cd.re[start + n]!;
        const xi = cd.im[start + n]!;
        zr += xr * c - xi * s;
        zi += xr * s + xi * c;
      }
      sync += zr * zr + zi * zi;
    }
  }
  return sync;
}

function normalise(bmet: Float64Array): void {
  let sum = 0;
  let sum2 = 0;
  for (let i = 0; i < bmet.length; i++) {
    sum += bmet[i]!;
    sum2 += bmet[i]! * bmet[i]!;
  }
  const mean = sum / bmet.length;
  const mean2 = sum2 / bmet.length;
  const v = mean2 - mean * mean;
  const sig = v > 0 ? Math.sqrt(v) : Math.sqrt(mean2);
  if (sig > 0) for (let i = 0; i < bmet.length; i++) bmet[i]! /= sig;
}

/** js8dec: one candidate to a frame, or null. */
function decodeCandidate(
  spectrum: { re: Float64Array; im: Float64Array },
  cand: Candidate,
  submode: Js8Submode,
): Js8Decode | null {
  const p = JS8_SUBMODES[submode];
  const dp = DEMOD_PARAMS[submode];
  const ndown = p.nsps / dp.ndownsps;
  const fs2 = JS8_SAMPLE_RATE / ndown;
  const baud = JS8_SAMPLE_RATE / p.nsps;
  const ndfft1 = p.nsps * dp.ndd;
  const ndfft2 = ndfft1 / ndown;
  const costas = JS8_COSTAS[p.costas];
  const nd = dp.ndownsps;
  const nq = Math.max(1, Math.floor(nd / 4));

  let f1 = cand.hz;
  const cd = downsample(spectrum, ndfft1, ndfft2, dp.ndd, f1, baud);

  // Time: a quarter symbol either side of the coarse estimate.
  const i0 = Math.round((cand.dtS + p.startS) * fs2);
  let ibest = i0;
  let smax = 0;
  for (let idt = i0 - nq; idt <= i0 + nq; idt++) {
    const v = fineSync(cd, costas, nd, idt, 0, fs2);
    if (v > smax) {
      smax = v;
      ibest = idt;
    }
  }
  // Frequency: ±2.5 Hz in half-hertz steps.
  let delfBest = 0;
  smax = 0;
  for (let ifr = -NFSRCH; ifr <= NFSRCH; ifr++) {
    const delf = ifr * 0.5;
    const v = fineSync(cd, costas, nd, ibest, delf, fs2);
    if (v > smax) {
      smax = v;
      delfBest = delf;
    }
  }
  if (delfBest !== 0) {
    const dphi = (-delfBest * 2 * Math.PI) / fs2;
    let wr = 1;
    let wi = 0;
    const sr = Math.cos(dphi);
    const si = Math.sin(dphi);
    for (let i = 0; i < cd.re.length; i++) {
      const nwr = wr * sr - wi * si;
      const nwi = wr * si + wi * sr;
      wr = nwr;
      wi = nwi;
      const xr = cd.re[i]!;
      const xi = cd.im[i]!;
      cd.re[i] = xr * wr - xi * wi;
      cd.im[i] = xr * wi + xi * wr;
    }
    f1 += delfBest;
  }
  const dtS = ibest / fs2 - p.startS;

  // Symbol spectra: an nd-point transform per symbol, tones in bins 0..7.
  const s2: Float64Array[] = [];
  const re = new Float64Array(nd);
  const im = new Float64Array(nd);
  for (let k = 0; k < JS8_SYMBOLS; k++) {
    const i1 = ibest + k * nd;
    re.fill(0);
    im.fill(0);
    if (i1 >= 0 && i1 + nd <= cd.re.length) {
      for (let n = 0; n < nd; n++) {
        re[n] = cd.re[i1 + n]!;
        im[n] = cd.im[i1 + n]!;
      }
    }
    fftMixed(re, im, -1);
    const col = new Float64Array(8);
    for (let t = 0; t < 8; t++) col[t] = Math.sqrt(re[t]! * re[t]! + im[t]! * im[t]!) / 1e3;
    s2.push(col);
  }

  // How many sync symbols sit on their tone.
  let nsync = 0;
  for (let b = 0; b < 3; b++) {
    for (let k = 0; k < 7; k++) {
      const col = s2[[0, 36, 72][b]! + k]!;
      let best = 0;
      for (let t = 1; t < 8; t++) if (col[t]! > col[best]!) best = t;
      if (best === costas[b]![k]) nsync++;
    }
  }
  if (nsync <= 6) return null;

  // Data symbols, normalised by their median.
  const s1: Float64Array[] = [];
  const all: number[] = [];
  for (let k = 0; k < JS8_SYMBOLS; k++) {
    if (k < 7 || (k >= 36 && k <= 42) || k > 71) continue;
    s1.push(s2[k]!);
    for (let t = 0; t < 8; t++) all.push(s2[k]![t]!);
  }
  all.sort((a, b) => a - b);
  const med = all[Math.round(0.5 * all.length) - 1]! || 1;
  for (const col of s1) for (let t = 0; t < 8; t++) col[t]! /= med;

  const n3 = 3 * JS8_DATA_SYMBOLS;
  const bmeta = new Float64Array(n3);
  const bmetb = new Float64Array(n3);
  const mx = (ps: ArrayLike<number>, idx: number[]) => Math.max(...idx.map((i) => ps[i]!));
  for (let j = 0; j < JS8_DATA_SYMBOLS; j++) {
    const ps = s1[j]!;
    const psl = Array.from(ps, (v) => Math.log(v + 1e-32));
    bmeta[3 * j] = mx(ps, [4, 5, 6, 7]) - mx(ps, [0, 1, 2, 3]);
    bmeta[3 * j + 1] = mx(ps, [2, 3, 6, 7]) - mx(ps, [0, 1, 4, 5]);
    bmeta[3 * j + 2] = mx(ps, [1, 3, 5, 7]) - mx(ps, [0, 2, 4, 6]);
    bmetb[3 * j] = mx(psl, [4, 5, 6, 7]) - mx(psl, [0, 1, 2, 3]);
    bmetb[3 * j + 1] = mx(psl, [2, 3, 6, 7]) - mx(psl, [0, 1, 4, 5]);
    bmetb[3 * j + 2] = mx(psl, [1, 3, 5, 7]) - mx(psl, [0, 2, 4, 6]);
  }
  normalise(bmeta);
  normalise(bmetb);

  for (let pass = 1; pass <= 4; pass++) {
    const llr = new Float64Array(n3);
    const src = pass === 2 ? bmetb : bmeta;
    for (let i = 0; i < n3; i++) llr[i] = LLR_SCALE * src[i]!;
    if (pass === 3) for (let i = 0; i < 24; i++) llr[i] = 0;
    if (pass === 4) for (let i = 0; i < 48; i++) llr[i] = 0;
    const r = js8BpDecode(llr, { maxIterations: 30 });
    if (!r.ok || !r.info) continue;
    if (r.hardErrors >= 60) continue;
    if (pass > 2 && r.hardErrors > 39) continue;
    if (pass === 4 && r.hardErrors > 30) continue;
    let zero = true;
    for (let i = 0; i < r.codeword.length; i++) if (r.codeword[i]) zero = false;
    if (zero) continue;
    const frame = js8UnpackFrame(r.info);
    if (!frame.crcOk) continue;
    // SNR from the decoded tones against the off-tone bins, the reference's first estimate.
    const tones = js8TonesFor(js8Encode(r.info), p.costas);
    let xsig = 0;
    let xnoi = 0;
    for (let i = 0; i < JS8_SYMBOLS; i++) {
      const col = s2[i]!;
      xsig += col[tones[i]!]! ** 2;
      const ios = (tones[i]! + 4) % 7;
      xnoi += col[ios]! ** 2;
    }
    let snr = 0.001;
    if (xnoi > 0 && xnoi < xsig) snr = xsig / xnoi - 1;
    let snrDb = 10 * Math.log10(snr) - 27;
    if (snrDb < -28) snrDb = -28;
    return {
      freqHz: f1,
      dtS,
      snrDb: Math.round(snrDb),
      text: frame.text,
      frameType: frame.frameType,
      info: r.info,
      sync: nsync,
      hardErrors: r.hardErrors,
      pass,
      candidateSync: cand.sync,
    };
  }
  return null;
}

/**
 * Decode one period of audio. The audio must be at 12 kHz (the pipeline decimates to it)
 * and is padded or cut to the submode's period.
 */
export function js8DecodeAudio(audio: ArrayLike<number>, opts: Js8DemodOptions): Js8Decode[] {
  if (opts.sampleRate !== JS8_SAMPLE_RATE) throw new Error(`js8DecodeAudio wants ${JS8_SAMPLE_RATE} Hz audio, got ${opts.sampleRate}`);
  const submode = opts.submode ?? "A";
  const p = JS8_SUBMODES[submode];
  const dp = DEMOD_PARAMS[submode];
  const nmax = p.periodS * JS8_SAMPLE_RATE;
  const dd = new Float64Array(nmax);
  for (let i = 0; i < nmax && i < audio.length; i++) dd[i] = audio[i]!;

  const candidates = coarseSync(dd, submode, opts.minHz ?? 200, opts.maxHz ?? 3000, opts.syncMin ?? ASYNCMIN, opts.maxCandidates ?? MAX_CANDIDATES);
  if (candidates.length === 0) return [];

  // One big transform of the period, shared by every candidate's downconversion.
  const ndfft1 = p.nsps * dp.ndd;
  const padded = new Float64Array(ndfft1);
  padded.set(dd.subarray(0, Math.min(nmax, ndfft1)));
  const spectrum = fftReal(padded);

  const out: Js8Decode[] = [];
  for (const cand of candidates) {
    const d = decodeCandidate(spectrum, cand, submode);
    if (!d) continue;
    const dupe = out.find((o) => o.text === d.text && o.frameType === d.frameType && Math.abs(o.freqHz - d.freqHz) < 2 * (JS8_SAMPLE_RATE / p.nsps));
    if (dupe) {
      if (d.sync > dupe.sync) out[out.indexOf(dupe)] = d;
      continue;
    }
    out.push(d);
  }
  return out;
}
