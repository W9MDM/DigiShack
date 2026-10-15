// Olivia: the code and the waveform.
//
// Olivia (Pawel Jalocha SP9VRC, 2003) is MFSK - one of 2 to 256 tones at a time, spaced by
// the baud rate so they are orthogonal over a symbol - with a forward error correction that
// makes it the keyboard mode that still copies when the band is poor. Every character is
// 7 bits; the FEC takes BitsPerSymbol characters at a time (five, for 32 tones) and makes a
// block of 64 symbols: each character becomes a 64-element Walsh function (a row of the
// Hadamard matrix, sign for the high bit), is scrambled by a fixed 64-bit code at a
// per-character offset, and its 64 bits are spread one per symbol across the block, each
// character's bit landing in a different tone bit of each symbol as the bit index rotates.
// The receiver undoes the rotation and the scrambling, takes the fast Hadamard transform
// of the 64 soft bits it collected, and reads the character off the peak - which is why a
// block survives a third of its symbols being wrong.
//
// Ported from pj_mfsk.h (Pawel Jalocha, GPL, as carried in fldigi by W1HKJ), the way
// lib/digital/js8.ts was ported from JS8Call: the same arithmetic, in TypeScript, checked
// against itself and on generated signals by scripts/check-olivia.ts. The internal sample
// rate the reference works at is 8000 Hz, where a 32-tone 1000 Hz block is 512 samples a
// symbol; this port scales the symbol to the rate it is given (768 at 12 kHz, 1536 at
// 24 kHz), so the tone spacing is the same 15.625 Hz bin and the FFT is the mixed-radix
// one from lib/dsp/fft-mixed.ts.
//
// Timing, for the sizes the air uses: 500/16 and 1000/32 are 31.25 baud, a 64-symbol block
// every 2.048 s, five or four characters a block - about 2.4 and 2 characters a second.
// 250/8 is half that; 500/8 is 62.5 baud.

import { fftMixed } from "@/lib/dsp/fft-mixed";

export const OLIVIA_SCRAMBLING_CODE = 0xe257e6d0291574ecn;
/** The reference's internal rate; symbol lengths below are quoted at it. */
export const OLIVIA_REF_RATE = 8000;
export const OLIVIA_BITS_PER_CHARACTER = 7;
/** 2^(7-1): the Walsh functions a 7-bit character maps onto, and the block length in symbols. */
export const OLIVIA_SYMBOLS_PER_BLOCK = 64;
/** Tones are two FFT bins apart, at the reference's 15.625 Hz bin. */
const CARRIER_SEPAR = 2;
/** The scramble offset step per character within a block: 13 for Olivia. */
const SCRAMBLE_SHIFT = 13;

export type OliviaTones = 2 | 4 | 8 | 16 | 32 | 64 | 128 | 256;
export type OliviaBandwidth = 125 | 250 | 500 | 1000 | 2000;

export interface OliviaMode {
  tones: OliviaTones;
  bandwidth: OliviaBandwidth;
}

/** The common sizes: what the mode picker offers. */
export const OLIVIA_MODES: readonly OliviaMode[] = [
  { tones: 8, bandwidth: 250 },
  { tones: 8, bandwidth: 500 },
  { tones: 16, bandwidth: 500 },
  { tones: 32, bandwidth: 1000 },
  { tones: 16, bandwidth: 1000 },
  { tones: 64, bandwidth: 2000 },
];

export function log2(x: number): number {
  let y = 0;
  while (x > 1) {
    x >>= 1;
    y++;
  }
  return y;
}

export interface OliviaParams extends OliviaMode {
  bitsPerSymbol: number;
  /** Symbol length at the reference rate, samples: a power of two. */
  refSymbolLen: number;
  /** Symbols overlap by half: the time between symbols at the reference rate. */
  refSymbolSepar: number;
  baud: number;
  /** Tone spacing, Hz: equal to the baud rate. */
  toneSpacingHz: number;
  /** The FFT bin at the reference rate. */
  binHz: number;
  charactersPerSecond: number;
  blockSeconds: number;
}

export function oliviaParams(mode: OliviaMode): OliviaParams {
  const bitsPerSymbol = log2(mode.tones);
  const refSymbolLen = 1 << (bitsPerSymbol + 7 - log2(mode.bandwidth / 125));
  const refSymbolSepar = refSymbolLen / 2;
  const baud = OLIVIA_REF_RATE / refSymbolSepar;
  const binHz = OLIVIA_REF_RATE / refSymbolLen;
  return {
    ...mode,
    bitsPerSymbol,
    refSymbolLen,
    refSymbolSepar,
    baud,
    toneSpacingHz: binHz * CARRIER_SEPAR,
    binHz,
    charactersPerSecond: (bitsPerSymbol * baud) / OLIVIA_SYMBOLS_PER_BLOCK,
    blockSeconds: OLIVIA_SYMBOLS_PER_BLOCK / baud,
  };
}

/**
 * The first carrier's FFT bin for a tone set centred on `centreHz`, as fldigi places it:
 * the first tone sits half the bandwidth below the centre, plus half a tone spacing.
 */
export function oliviaFirstCarrierBin(params: OliviaParams, centreHz: number): number {
  const fcOffset = (params.bandwidth * (1 - 0.5 / params.tones)) / 2;
  const multiplier = (centreHz - fcOffset) / 500;
  return Math.floor((params.refSymbolLen / 16) * multiplier) + 1;
}

export function grayCode(binary: number): number {
  return binary ^ (binary >> 1);
}

export function binaryCode(gray: number): number {
  gray ^= gray >> 4;
  gray ^= gray >> 2;
  gray ^= gray >> 1;
  return gray & 0xff;
}

/** Forward fast Hadamard transform, in place, in the reference's butterfly order. */
export function fht(data: Float64Array | Int8Array, len: number): void {
  for (let step = 1; step < len; step *= 2) {
    for (let ptr = 0; ptr < len; ptr += 2 * step) {
      for (let p2 = ptr; p2 - ptr < step; p2++) {
        const b1 = data[p2]!;
        const b2 = data[p2 + step]!;
        data[p2] = b2 + b1;
        data[p2 + step] = b2 - b1;
      }
    }
  }
}

/** Inverse fast Hadamard transform, in place, as the reference encoder uses it. */
export function ifht(data: Float64Array | Int8Array, len: number): void {
  for (let step = len / 2; step >= 1; step /= 2) {
    for (let ptr = 0; ptr < len; ptr += 2 * step) {
      for (let p2 = ptr; p2 - ptr < step; p2++) {
        const b1 = data[p2]!;
        const b2 = data[p2 + step]!;
        data[p2] = b1 - b2;
        data[p2 + step] = b1 + b2;
      }
    }
  }
}

/** Whether bit `codeBit` of the 64-bit scrambling code is set. */
function scrambleBit(codeBit: number): boolean {
  return ((OLIVIA_SCRAMBLING_CODE >> BigInt(codeBit & 63)) & 1n) === 1n;
}

/**
 * One FEC block: `bitsPerSymbol` characters (7-bit; the rest of a byte is dropped) to 64
 * symbols, each a tone index of `bitsPerSymbol` bits. EncodeBlock of the reference.
 */
export function oliviaEncodeBlock(chars: readonly number[], bitsPerSymbol: number): Uint8Array {
  const n = OLIVIA_SYMBOLS_PER_BLOCK;
  const out = new Uint8Array(n);
  const buf = new Int8Array(n);
  const mask = (n << 1) - 1;
  for (let freqBit = 0; freqBit < bitsPerSymbol; freqBit++) {
    const ch = (chars[freqBit] ?? 0) & mask;
    buf.fill(0);
    if (ch < n) buf[ch] = 1;
    else buf[ch - n] = -1;
    ifht(buf, n);
    // Scramble at this character's offset in the code.
    let codeBit = (freqBit * SCRAMBLE_SHIFT) & (n - 1);
    for (let t = 0; t < n; t++) {
      if (scrambleBit(codeBit)) buf[t] = -buf[t]!;
      codeBit = (codeBit + 1) & (n - 1);
    }
    // Spread: symbol t carries this character's bit t in tone bit (freqBit + t) mod bits.
    let rotate = 0;
    for (let t = 0; t < n; t++) {
      if (buf[t]! < 0) {
        let bit = freqBit + rotate;
        if (bit >= bitsPerSymbol) bit -= bitsPerSymbol;
        out[t] = out[t]! | (1 << bit);
      }
      rotate++;
      if (rotate >= bitsPerSymbol) rotate -= bitsPerSymbol;
    }
  }
  return out;
}

/**
 * The reference decoder's arithmetic on one block of soft bits: `soft[symbol * bits + bit]`,
 * positive for a 0 and negative for a 1, scaled however the demodulator likes. Returns the
 * characters, and a signal and noise figure per the reference: the peak's magnitude and
 * the energy left in the other 63 bins, averaged over the characters.
 */
export function oliviaDecodeBlock(
  soft: ArrayLike<number>,
  bitsPerSymbol: number,
): { chars: number[]; signal: number; noiseEnergy: number } {
  const n = OLIVIA_SYMBOLS_PER_BLOCK;
  const buf = new Float64Array(n);
  const chars: number[] = [];
  let signal = 0;
  let noise = 0;
  for (let freqBit = 0; freqBit < bitsPerSymbol; freqBit++) {
    let rotate = freqBit;
    let codeBit = (freqBit * SCRAMBLE_SHIFT) & (n - 1);
    let ptr = 0;
    for (let t = 0; t < n; t++) {
      let bit = soft[ptr + rotate] ?? 0;
      if (scrambleBit(codeBit)) bit = -bit;
      buf[t] = bit;
      codeBit = (codeBit + 1) & (n - 1);
      rotate++;
      if (rotate >= bitsPerSymbol) rotate -= bitsPerSymbol;
      ptr += bitsPerSymbol;
    }
    fht(buf, n);
    let peak = 0;
    let peakPos = 0;
    let sqr = 0;
    for (let t = 0; t < n; t++) {
      const v = buf[t]!;
      sqr += v * v;
      if (Math.abs(v) > Math.abs(peak)) {
        peak = v;
        peakPos = t;
      }
    }
    let ch = peakPos;
    if (peak < 0) ch += n;
    sqr -= peak * peak;
    chars.push(ch);
    noise += sqr / (n - 1);
    signal += Math.abs(peak);
  }
  return { chars, signal: signal / bitsPerSymbol, noiseEnergy: noise / bitsPerSymbol };
}

/** The text a block's characters print: 0 is idle, CR is silent, LF is the newline. */
export function oliviaCharsToText(chars: readonly number[]): string {
  let s = "";
  for (const c of chars) {
    if (c === 0 || c === 13) continue;
    if (c === 10) {
      s += "\n";
      continue;
    }
    if (c >= 32 && c < 127) s += String.fromCharCode(c);
  }
  return s;
}

/** A line of text as the characters the FEC takes: 7-bit, newline as CR LF, others dropped. */
export function oliviaTextToChars(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    if (ch === "\n") {
      out.push(13, 10);
      continue;
    }
    if (ch === "\r") continue;
    const c = ch.charCodeAt(0);
    if (c >= 32 && c < 127) out.push(c);
  }
  return out;
}

export interface OliviaWaveformOptions extends OliviaMode {
  sampleRate: number;
  /** Centre of the tone set, Hz audio. Default 1500. */
  centreHz?: number;
  /** Idle blocks (all-zero characters) before the text, so the far end syncs. Default 1. */
  preambleBlocks?: number;
  /** Idle blocks after the text. Default 1. */
  tailBlocks?: number;
  amplitude?: number;
}

/**
 * The tone symbols a line sends: idle blocks, the text in blocks of `bitsPerSymbol`
 * characters (the last padded with idle), idle blocks after.
 */
export function oliviaSymbols(text: string, opts: Partial<OliviaWaveformOptions> & OliviaMode): Uint8Array {
  const p = oliviaParams(opts);
  const chars = oliviaTextToChars(text);
  const blocks: number[][] = [];
  for (let i = 0; i < (opts.preambleBlocks ?? 1); i++) blocks.push([]);
  for (let i = 0; i < chars.length; i += p.bitsPerSymbol) blocks.push(chars.slice(i, i + p.bitsPerSymbol));
  for (let i = 0; i < (opts.tailBlocks ?? 1); i++) blocks.push([]);
  const out = new Uint8Array(blocks.length * OLIVIA_SYMBOLS_PER_BLOCK);
  blocks.forEach((b, i) => out.set(oliviaEncodeBlock(b, p.bitsPerSymbol), i * OLIVIA_SYMBOLS_PER_BLOCK));
  return out;
}

/**
 * The audio for a run of tone symbols: each symbol a Hann-shaped burst of its tone, twice
 * the symbol spacing long, overlapping its neighbours by half - the reference modulator's
 * shape, which keeps a tone's energy in its own bin and the next. Every tone keeps a
 * continuous phase of its own, so the overlap of a symbol with itself adds rather than
 * cancels. Scaled so the sum never exceeds `amplitude`.
 */
export function oliviaWaveform(symbols: ArrayLike<number>, opts: OliviaWaveformOptions): Float32Array {
  const p = oliviaParams(opts);
  const fs = opts.sampleRate;
  const scale = fs / OLIVIA_REF_RATE;
  const symbolLen = Math.round(p.refSymbolLen * scale);
  const separ = symbolLen / 2;
  const first = oliviaFirstCarrierBin(p, opts.centreHz ?? 1500);
  const amp = (opts.amplitude ?? 1) / 2;
  const total = symbols.length * separ + separ;
  const out = new Float32Array(total);
  const phase = new Float64Array(p.tones);
  const dphi = new Float64Array(p.tones);
  for (let k = 0; k < p.tones; k++) dphi[k] = (2 * Math.PI * (first + CARRIER_SEPAR * k) * p.binHz) / fs;
  // Each tone's phase runs continuously from sample 0; a symbol's burst samples it where it is.
  for (let s = 0; s < symbols.length; s++) {
    const tone = grayCode(symbols[s]! & (p.tones - 1));
    const start = s * separ;
    for (let t = 0; t < symbolLen; t++) {
      const shape = 1 - Math.cos((2 * Math.PI * t) / symbolLen);
      const i = start + t;
      if (i >= total) break;
      out[i] = out[i]! + amp * shape * Math.cos(phase[tone]! + dphi[tone]! * i);
    }
  }
  return out;
}

export function oliviaDurationMs(text: string, opts: Partial<OliviaWaveformOptions> & OliviaMode): number {
  const p = oliviaParams(opts);
  const symbols = oliviaSymbols(text, opts).length;
  return ((symbols + 1) / 2 / p.baud) * 1000 * 2;
}

/** Re-exported for the demodulator's FFT. */
export { fftMixed };
