// An Olivia demodulator: audio in, text out, as a stream.
//
// A port of the receive side of pj_mfsk.h (Pawel Jalocha, GPL, as carried in fldigi): the
// FFT demodulator, the soft decoder and the synchroniser, with the same arithmetic.
//
//   THE DEMODULATOR takes a Hann-windowed FFT of the last symbol length of audio twice per
//   symbol (two "slices", half a symbol apart) and keeps the energy in the bins around the
//   tone set: the tones' own bins and a margin either side, for tuning error.
//
//   THE SOFT DECODE of one slice at one frequency offset turns the energies at the tone
//   bins into one soft bit per tone bit: each tone votes with its energy squared for the
//   bits of its (Gray-decoded) index, positive for a 0 and negative for a 1, normalised by
//   the total. The FEC decoder (lib/digital/olivia.ts) collects 64 of those per block,
//   undoes the spreading and the scrambling, and reads each character off the peak of a
//   fast Hadamard transform.
//
//   THE SYNCHRONISER does not know where a block starts or exactly where the tones sit,
//   so it runs a decoder for every slice and every frequency offset in the margin, at
//   every one of the 128 block phases (two slices times 64 symbols), and low-pass filters
//   each one's signal (the Hadamard peak) and noise (what is left) over a few blocks. The
//   phase and offset with the largest filtered signal is the sync; half a block after it,
//   that decoder's block from the integration window is printed when its signal over its
//   noise clears the threshold, and otherwise nothing is - which is the squelch.
//
// Departures from the reference: no input processor (its spectral equaliser and peak
// limiter; the soft decode's normalisation carries the level), the symbol is scaled to
// the rate the audio comes at rather than resampled to 8 kHz (768 samples at 12 kHz,
// 1536 at 24 kHz, the same 15.625 Hz bin), and the noise the threshold is measured
// against is the best decoder's own rather than the reference's next-row quirk.
// Chunks of any size give the same text as one call. scripts/check-olivia.ts runs it on
// generated signals clean, off frequency, in noise and on noise alone.

import { fftMixed } from "@/lib/dsp/fft-mixed";
import {
  binaryCode,
  OLIVIA_REF_RATE,
  oliviaCharsToText,
  oliviaCode,
  oliviaDecodeBlock,
  oliviaFirstCarrierBin,
  oliviaParams,
  type OliviaCode,
  type OliviaMode,
} from "@/lib/digital/olivia";

export interface OliviaDemodOptions extends OliviaMode {
  sampleRate: number;
  /** Centre of the tone set, Hz audio. */
  centreHz: number;
  /** Tuning margin searched, in tone-spacing bins (15.625 Hz at the reference rate). Default 8. */
  syncMargin?: number;
  /** The synchroniser's integration, in blocks. Default 4. */
  syncIntegLen?: number;
  /** Signal over noise below which a block is not printed. Noise alone reads about 3; default 4. */
  syncThreshold?: number;
  /** Diagnostics: each slice, with the hard tone decision at the centre offset and its share of the energy. */
  onSlice?: (slice: number, hardSymbol: number, share: number) => void;
  /** Diagnostics: every sync decision, printed or not. */
  onBlock?: (chars: number[], snr: number, phase: number, offset: number, open: boolean) => void;
  /** Diagnostics: every decoder run, with the block it read. */
  onDecode?: (phase: number, offset: number, chars: number[], signal: number, noise: number, soft: Float64Array) => void;
}

export interface OliviaDemodStats {
  /** Characters delivered, including spaces and newlines. */
  chars: number;
  /** Blocks printed. */
  blocks: number;
  /** The synchroniser's signal over noise at the last decision. */
  snr: number;
  /** Where the tones were found relative to the centre asked for, Hz. */
  freqOffsetHz: number;
  /** Whether the last decision printed. */
  open: boolean;
}

/** The reference's three-stage averaging filter: weight is one over the peaking time. */
class LowPass3 {
  out1 = 0;
  out2 = 0;
  output = 0;
  process(inp: number, weight: number, feedback = 0.1): void {
    weight *= 2;
    let d = (inp - this.out1) * weight;
    this.out1 += d;
    d = (this.out1 - this.out2) * weight;
    this.out2 += d;
    d = (this.output - this.output) * 0 + (this.out2 - this.output) * weight;
    this.output += d;
    this.out2 += d * feedback;
  }
}

const SLICES = 2;

export class OliviaDemodulator {
  private readonly fs: number;
  private readonly bits: number;
  private readonly tones: number;
  private readonly symbolLen: number;
  private readonly separ: number;
  private readonly halfSepar: number;
  private firstCarrier: number;
  private readonly margin: number;
  private readonly decodeWidth: number;
  private readonly freqOffsets: number;
  private readonly blockPhases: number;
  private readonly integLen: number;
  private readonly threshold: number;
  private readonly binHz: number;
  private readonly code: OliviaCode;
  private readonly symbolsPerBlock: number;
  private centreHz: number;

  // Input: the last symbol of audio, and the chunk being filled.
  private readonly tap: Float64Array;
  private tapPtr = 0;
  private readonly chunk: Float64Array;
  private chunkFill = 0;
  private readonly window: Float64Array;
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  private readonly energy: [Float64Array, Float64Array];

  // One soft-bit ring per (slice, offset).
  private readonly softRings: Float64Array[];
  private readonly softPtr: Int32Array;
  // Per block phase and offset: the filtered signal and noise.
  private readonly syncSignal: LowPass3[][];
  private readonly syncNoise: LowPass3[][];
  // Per block phase: integLen rows of decoded characters per offset.
  private readonly pipe: { chars: number[]; signal: number; noise: number }[][][];
  private readonly pipePtr: Int32Array;
  private blockPhase = 0;
  private bestSignal = 0;
  private bestPhase = 0;
  private bestOffset = 0;

  private readonly stats: OliviaDemodStats = { chars: 0, blocks: 0, snr: 0, freqOffsetHz: 0, open: false };
  private readonly onSlice?: (slice: number, hardSymbol: number, share: number) => void;
  private readonly onBlock?: (chars: number[], snr: number, phase: number, offset: number, open: boolean) => void;
  private readonly onDecode?: (phase: number, offset: number, chars: number[], signal: number, noise: number, soft: Float64Array) => void;

  constructor(opts: OliviaDemodOptions) {
    const p = oliviaParams(opts);
    this.fs = opts.sampleRate;
    const scale = this.fs / OLIVIA_REF_RATE;
    this.symbolLen = Math.round(p.refSymbolLen * scale);
    if (Math.abs(this.symbolLen - p.refSymbolLen * scale) > 1e-9 || this.symbolLen % 4 !== 0) {
      throw new Error(`Olivia needs a sample rate that scales the symbol to a multiple of four: ${this.fs} does not`);
    }
    this.separ = this.symbolLen / 2;
    this.halfSepar = this.separ / 2;
    this.bits = p.bitsPerSymbol;
    this.tones = p.tones;
    this.binHz = p.binHz;
    this.code = opts.code ?? "olivia";
    this.symbolsPerBlock = oliviaCode(this.code).symbolsPerBlock;
    this.centreHz = opts.centreHz;
    this.firstCarrier = oliviaFirstCarrierBin(p, opts.centreHz);
    this.margin = Math.max(2, Math.min(opts.syncMargin ?? 8, this.firstCarrier));
    this.decodeWidth = this.tones * 2 - 1 + 2 * this.margin;
    this.freqOffsets = 2 * this.margin + 1;
    this.blockPhases = SLICES * this.symbolsPerBlock;
    this.integLen = Math.max(2, opts.syncIntegLen ?? 4);
    this.threshold = Math.max(1, opts.syncThreshold ?? 4);
    this.onSlice = opts.onSlice;
    this.onBlock = opts.onBlock;
    this.onDecode = opts.onDecode;

    this.tap = new Float64Array(this.symbolLen);
    this.chunk = new Float64Array(this.separ);
    this.window = new Float64Array(this.symbolLen);
    for (let t = 0; t < this.symbolLen; t++) this.window[t] = (1 - Math.cos((2 * Math.PI * t) / this.symbolLen)) / this.symbolLen;
    this.re = new Float64Array(this.symbolLen);
    this.im = new Float64Array(this.symbolLen);
    this.energy = [new Float64Array(this.decodeWidth), new Float64Array(this.decodeWidth)];

    const nDec = SLICES * this.freqOffsets;
    this.softRings = Array.from({ length: nDec }, () => new Float64Array(this.symbolsPerBlock * this.bits));
    this.softPtr = new Int32Array(nDec);
    this.syncSignal = Array.from({ length: this.blockPhases }, () => Array.from({ length: this.freqOffsets }, () => new LowPass3()));
    this.syncNoise = Array.from({ length: this.blockPhases }, () => Array.from({ length: this.freqOffsets }, () => new LowPass3()));
    this.pipe = Array.from({ length: this.blockPhases }, () =>
      Array.from({ length: this.integLen }, () =>
        Array.from({ length: this.freqOffsets }, () => ({ chars: [] as number[], signal: 0, noise: 0 })),
      ),
    );
    this.pipePtr = new Int32Array(this.blockPhases);
  }

  get statistics(): Readonly<OliviaDemodStats> {
    return this.stats;
  }

  /** Move the tone set while running. The sync starts over. */
  retune(centreHz: number): void {
    this.centreHz = centreHz;
    this.firstCarrier = oliviaFirstCarrierBin(oliviaParams({ tones: this.tones as OliviaMode["tones"], bandwidth: this.bandwidthOf(), code: this.code }), centreHz);
    this.reset();
  }

  private bandwidthOf(): OliviaMode["bandwidth"] {
    return (this.tones * this.binHz * 2) as OliviaMode["bandwidth"];
  }

  reset(): void {
    this.tap.fill(0);
    this.tapPtr = 0;
    for (const r of this.softRings) r.fill(0);
    this.softPtr.fill(0);
    for (const row of this.syncSignal) for (const f of row) f.out1 = f.out2 = f.output = 0;
    for (const row of this.syncNoise) for (const f of row) f.out1 = f.out2 = f.output = 0;
    this.pipePtr.fill(0);
    this.blockPhase = 0;
    this.bestSignal = 0;
    this.bestPhase = 0;
    this.bestOffset = 0;
    this.stats.snr = 0;
    this.stats.open = false;
  }

  feed(samples: ArrayLike<number>): string {
    let out = "";
    for (let i = 0; i < samples.length; i++) {
      this.chunk[this.chunkFill++] = samples[i]!;
      if (this.chunkFill < this.separ) continue;
      this.chunkFill = 0;
      out += this.symbol();
    }
    return out;
  }

  /** One symbol spacing of audio has arrived: two slices, their soft decodes, the sync. */
  private symbol(): string {
    const N = this.symbolLen;
    // Slice 0: the window ending a quarter symbol in; slice 1: ending three quarters in.
    let idx = 0;
    for (; idx < this.halfSepar; idx++) this.push(this.chunk[idx]!);
    for (let t = 0; t < N; t++) this.re[t] = this.tap[(this.tapPtr + t) % N]! * this.window[t]!;
    for (; idx < this.separ; idx++) this.push(this.chunk[idx]!);
    for (let t = 0; t < N; t++) this.im[t] = this.tap[(this.tapPtr + t) % N]! * this.window[t]!;
    fftMixed(this.re, this.im, -1);
    // Two real inputs in one complex FFT: X1[k] = (Z[k] + conj Z[N-k]) / 2, X2[k] = (Z[k] - conj Z[N-k]) / 2j.
    const lo = this.firstCarrier - this.margin;
    for (let w = 0; w < this.decodeWidth; w++) {
      const k = lo + w;
      const kk = (N - k) % N;
      const ar = this.re[k]!;
      const ai = this.im[k]!;
      const br = this.re[kk]!;
      const bi = -this.im[kk]!;
      const x1r = (ar + br) / 2;
      const x1i = (ai + bi) / 2;
      const x2r = (ai - bi) / 2;
      const x2i = -(ar - br) / 2;
      this.energy[0][w] = x1r * x1r + x1i * x1i;
      this.energy[1][w] = x2r * x2r + x2i * x2i;
    }
    let out = "";
    const soft = new Float64Array(this.bits);
    const weight = 1 / this.integLen;
    for (let slice = 0; slice < SLICES; slice++) {
      if (this.onSlice) {
        const e = this.energy[slice]!;
        let best = 0;
        let total = 0;
        let bi = 0;
        for (let idx = 0; idx < this.tones; idx++) {
          const v = e[this.margin + 2 * idx] ?? 0;
          total += v;
          if (v > best) {
            best = v;
            bi = idx;
          }
        }
        this.onSlice(slice, binaryCode(bi), total > 0 ? best / total : 0);
      }
      const phase = this.blockPhase;
      let bestSliceSignal = 0;
      let bestSliceOffset = 0;
      const row = this.pipe[phase]![this.pipePtr[phase]!]!;
      for (let off = 0; off < this.freqOffsets; off++) {
        this.softDecode(soft, slice, off - this.margin);
        const d = slice * this.freqOffsets + off;
        const ring = this.softRings[d]!;
        let ptr = this.softPtr[d]!;
        for (let b = 0; b < this.bits; b++) ring[ptr++] = soft[b]!;
        if (ptr >= ring.length) ptr = 0;
        this.softPtr[d] = ptr;
        // The block is the last 64 symbols: read from the oldest, which is where ptr points.
        const view = ptr === 0 ? ring : this.rotated(ring, ptr);
        const r = oliviaDecodeBlock(view, this.bits, this.code);
        this.onDecode?.(phase, off, r.chars, r.signal, r.noiseEnergy, view);
        row[off] = { chars: r.chars, signal: r.signal, noise: r.noiseEnergy };
        this.syncNoise[phase]![off]!.process(r.noiseEnergy, weight);
        const sig = this.syncSignal[phase]![off]!;
        sig.process(r.signal, weight);
        if (sig.output > bestSliceSignal) {
          bestSliceSignal = sig.output;
          bestSliceOffset = off;
        }
      }
      this.pipePtr[phase] = (this.pipePtr[phase]! + 1) % this.integLen;
      if (phase === this.bestPhase) {
        this.bestSignal = bestSliceSignal;
        this.bestOffset = bestSliceOffset;
      } else if (bestSliceSignal > this.bestSignal) {
        this.bestSignal = bestSliceSignal;
        this.bestPhase = phase;
        this.bestOffset = bestSliceOffset;
      }
      let dist = phase - this.bestPhase;
      if (dist < 0) dist += this.blockPhases;
      if (dist === this.blockPhases / 2) {
        const snr = this.ratio(this.bestSignal, this.syncNoise[this.bestPhase]![this.bestOffset]!.output);
        this.stats.snr = snr;
        this.stats.freqOffsetHz = (this.bestOffset - this.margin) * this.binHz;
        // The oldest row of the best phase: the block decoded integLen writes ago, from
        // inside the integration window the decision was made on. It is printed when the
        // integrated signal over noise clears the threshold AND its own does: the row at
        // the edge of a transmission holds a sliver of signal and a strong filtered SNR
        // from the blocks after it, and the reference prints that sliver as junk.
        const best = this.pipe[this.bestPhase]![this.pipePtr[this.bestPhase]!]![this.bestOffset]!;
        const rowSnr = this.ratio(best.signal, best.noise);
        const open = snr >= this.threshold && rowSnr >= this.threshold;
        this.stats.open = open;
        this.onBlock?.(best.chars, snr, this.bestPhase, this.bestOffset, open);
        if (open) {
          const text = oliviaCharsToText(best.chars);
          if (best.chars.length > 0) this.stats.blocks++;
          this.stats.chars += text.length;
          out += text;
        }
      }
      this.blockPhase = (this.blockPhase + 1) % this.blockPhases;
    }
    return out;
  }

  /** Signal over the root of the noise energy, capped: a clean generated signal has no noise at all. */
  private ratio(signal: number, noiseEnergy: number): number {
    const noise = Math.sqrt(Math.max(0, noiseEnergy));
    if (noise === 0) return signal > 0 ? 100 : 0;
    return Math.min(100, signal / noise);
  }

  private push(x: number): void {
    this.tap[this.tapPtr] = x;
    this.tapPtr = (this.tapPtr + 1) % this.symbolLen;
  }

  private rotated(ring: Float64Array, ptr: number): Float64Array {
    const out = new Float64Array(ring.length);
    out.set(ring.subarray(ptr), 0);
    out.set(ring.subarray(0, ptr), ring.length - ptr);
    return out;
  }

  /** The reference's SoftDecode: energies squared, voting per bit of the Gray-decoded tone index. */
  private softDecode(out: Float64Array, slice: number, freqOffset: number): void {
    out.fill(0);
    const e = this.energy[slice]!;
    const base = this.margin + freqOffset;
    let total = 0;
    for (let idx = 0; idx < this.tones; idx++) {
      const sym = binaryCode(idx);
      let v = e[base + 2 * idx] ?? 0;
      v *= v;
      total += v;
      for (let b = 0; b < this.bits; b++) {
        if (sym & (1 << b)) out[b] = out[b]! - v;
        else out[b] = out[b]! + v;
      }
    }
    if (total > 0) for (let b = 0; b < this.bits; b++) out[b] = out[b]! / total;
  }
}
