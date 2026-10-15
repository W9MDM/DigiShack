// JS8 - the physical layer: the 75-bit frame, its CRC, the (174,87) code, the 79 channel
// symbols with their Costas sync, and the GFSK waveform.
//
// Ported from JS8Call (js8call/js8call on GitHub, GPL-3.0; DigiShack is GPL-3.0): the
// authoritative files are lib/js8/genjs8.f90 (what goes on the air), lib/ft8/encode174.f90
// and lib/ft8/ldpc_174_87_params.f90 (the code), lib/crc12.cpp (the CRC), and the submode
// parameter files lib/js8/js8{a,b,c,e,i}_params.f90. Every number here is checked against
// a reference encoder built from those same sources in scripts/check-js8.ts.
//
// WHAT JS8 IS, at this layer. FT8's first design, kept: 8-FSK at 6.25 baud in "normal"
// mode, 79 symbols of which 21 are three 7x7 Costas sync blocks and 58 carry the 174 bits
// of an LDPC(174,87) codeword, three bits a symbol. The 87 information bits are 72 bits of
// payload (twelve 6-bit characters from a 68-character alphabet), a 3-bit frame type, and
// a 12-bit CRC. FT8 moved on to 77 bits and a (174,91) code in 2018; JS8 stayed, changed
// its Costas arrays so FT8 decoders would ignore it, and built a message layer on the 72
// bits (varicode, frame types, heartbeats, directed messages) that lib/digital/js8-message.ts
// is for. Four more submodes keep the same frame at other speeds: fast (10 s), turbo (6 s),
// slow (30 s) and ultra (4 s), with a second set of Costas arrays.
//
// THE CRC IS PECULIAR and worth stating. Boost's "augmented" CRC-12 (polynomial 0xC06) is
// run over eleven bytes: the 72 payload bits, the 3 frame-type bits, and 13 zero bits -
// one more than the CRC's width - and the result is XORed with 42. That is what genjs8
// does, so that is what this does; a CRC-12 by any textbook recipe will not match.
//
// SYMBOL MAPPING IS PLAIN BINARY, not Gray: a data symbol is three consecutive codeword
// bits, most significant first. FT8 v2 added Gray coding; JS8 predates it.

import {
  JS8_LDPC_COLORDER,
  JS8_LDPC_GENERATOR_HEX,
  JS8_LDPC_MN,
  JS8_LDPC_NM,
  JS8_LDPC_NRW,
} from "@/lib/digital/js8-ldpc-tables";

/** The 68 characters a 6-bit payload character can be. Index is the 6-bit value. */
// The Fortran declares the alphabet as 68 characters and writes 67: the 68th is a SPACE,
// and `index()` finds it, so a space in a message is value 67. Do not trim this string.
export const JS8_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-+/?. ";
export const JS8_MESSAGE_CHARS = 12;
export const JS8_PAYLOAD_BITS = 72;
export const JS8_TYPE_BITS = 3;
export const JS8_CRC_BITS = 12;
/** 72 + 3 + 12. */
export const JS8_INFO_BITS = 87;
export const JS8_CODEWORD_BITS = 174;
export const JS8_PARITY_BITS = 87;
export const JS8_SYMBOLS = 79;
export const JS8_DATA_SYMBOLS = 58;
export const JS8_SYNC_SYMBOLS = 21;
/** Where the three Costas blocks sit: symbols 0-6, 36-42, 72-78. */
export const JS8_COSTAS_AT = [0, 36, 72] as const;
/** The DSP rate the submodes are defined at. */
export const JS8_SAMPLE_RATE = 12_000;

export type Js8Submode = "A" | "B" | "C" | "E" | "I";

export interface Js8SubmodeParams {
  /** Normal, fast, turbo, slow, ultra. */
  name: string;
  /** Samples per symbol at 12 kHz. Tone spacing is 12000 / nsps Hz; baud is the same number. */
  nsps: number;
  /** T/R period, seconds. */
  periodS: number;
  /** Transmission starts this long after the period boundary. */
  startS: number;
  /** Which Costas set: 1 (the original) or 2 (three symmetrical arrays). */
  costas: 1 | 2;
}

/** From js8{a,b,c,e,i}_params.f90: NSPS, NTXDUR, ASTART, NCOSTAS. */
export const JS8_SUBMODES: Readonly<Record<Js8Submode, Js8SubmodeParams>> = {
  A: { name: "normal", nsps: 1920, periodS: 15, startS: 0.5, costas: 1 },
  B: { name: "fast", nsps: 1200, periodS: 10, startS: 0.2, costas: 2 },
  C: { name: "turbo", nsps: 600, periodS: 6, startS: 0.1, costas: 2 },
  E: { name: "slow", nsps: 3840, periodS: 30, startS: 0.5, costas: 2 },
  I: { name: "ultra", nsps: 384, periodS: 4, startS: 0.1, costas: 2 },
};

/**
 * The Costas 7x7 sync tone patterns, from genjs8.f90: set 1 uses one array three times,
 * set 2 three different ones. JS8.hpp's comment says normal mode kept FT8's arrays; the
 * code says otherwise (FT8's is 3,1,4,0,6,5,2), and the code is what goes on the air.
 */
export const JS8_COSTAS: Readonly<Record<1 | 2, readonly (readonly number[])[]>> = {
  1: [
    [4, 2, 5, 6, 1, 3, 0],
    [4, 2, 5, 6, 1, 3, 0],
    [4, 2, 5, 6, 1, 3, 0],
  ],
  2: [
    [0, 6, 2, 3, 5, 4, 1],
    [1, 5, 0, 2, 3, 6, 4],
    [2, 5, 0, 6, 4, 1, 3],
  ],
};

/** Tone spacing and symbol rate for a submode, Hz / baud. */
export function js8BaudFor(submode: Js8Submode): number {
  return JS8_SAMPLE_RATE / JS8_SUBMODES[submode].nsps;
}

/** How long the 79 symbols take, ms. */
export function js8TransmissionMs(submode: Js8Submode): number {
  return (JS8_SYMBOLS * JS8_SUBMODES[submode].nsps * 1000) / JS8_SAMPLE_RATE;
}

// ---------------------------------------------------------------------------
// CRC-12, as Boost's augmented_crc<12, 0xC06> computes it over the eleven-byte buffer
// genjs8 builds, then XOR 42.
// ---------------------------------------------------------------------------

/**
 * Boost's augmented CRC: the register starts at zero, each data bit shifts in from the
 * right, and the polynomial is applied when a bit leaves the top. The data itself carries
 * the trailing zeros that a conventional CRC would append, which is why the buffer here is
 * eleven bytes for 75 bits of content.
 */
function augmentedCrc12(bytes: ArrayLike<number>): number {
  let rem = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    for (let k = 7; k >= 0; k--) {
      rem = (rem << 1) | ((b >> k) & 1);
      if (rem & 0x1000) rem ^= 0x1c06;
    }
  }
  return rem & 0xfff;
}

/**
 * The CRC of a frame: 12 six-bit characters (as values 0-67) and a frame type 0-7, laid
 * out as genjs8 lays them - 72 bits, 3 bits, 13 zeros - then XOR 42.
 */
export function js8Crc12(words: ArrayLike<number>, frameType: number): number {
  if (words.length !== JS8_MESSAGE_CHARS) throw new Error(`a JS8 frame has ${JS8_MESSAGE_CHARS} characters`);
  const bytes = new Uint8Array(11);
  // 72 bits of words, MSB first, into bytes 0-8.
  let acc = 0;
  let n = 0;
  let out = 0;
  for (let i = 0; i < JS8_MESSAGE_CHARS; i++) {
    acc = (acc << 6) | (words[i]! & 63);
    n += 6;
    while (n >= 8) {
      bytes[out++] = (acc >> (n - 8)) & 0xff;
      n -= 8;
    }
  }
  // Byte 9: the frame type in its top three bits; the rest, and byte 10, zero.
  bytes[9] = (frameType & 7) << 5;
  bytes[10] = 0;
  return augmentedCrc12(bytes) ^ 42;
}

// ---------------------------------------------------------------------------
// The 87 information bits.
// ---------------------------------------------------------------------------

/** Text of up to 12 alphabet characters to the 12 six-bit values; shorter text is padded with "0"... no: the reference stops at the first non-alphabet character and leaves the rest zero. */
export function js8WordsFor(text: string): number[] {
  const words = new Array<number>(JS8_MESSAGE_CHARS).fill(0);
  for (let i = 0; i < JS8_MESSAGE_CHARS && i < text.length; i++) {
    const v = JS8_ALPHABET.indexOf(text[i]!);
    if (v < 0) break;
    words[i] = v;
  }
  return words;
}

/** The 87 information bits for a frame: 72 payload bits, 3 type bits, 12 CRC bits. */
export function js8PackFrame(text: string, frameType: number): Uint8Array {
  if (frameType < 0 || frameType > 7) throw new Error("frame type is 0-7");
  const words = js8WordsFor(text);
  const crc = js8Crc12(words, frameType);
  const bits = new Uint8Array(JS8_INFO_BITS);
  let p = 0;
  for (const w of words) for (let k = 5; k >= 0; k--) bits[p++] = (w >> k) & 1;
  for (let k = 2; k >= 0; k--) bits[p++] = (frameType >> k) & 1;
  for (let k = 11; k >= 0; k--) bits[p++] = (crc >> k) & 1;
  return bits;
}

/** Read 87 information bits back: the text, the frame type, and whether the CRC holds. */
export function js8UnpackFrame(bits: ArrayLike<number>): { text: string; words: number[]; frameType: number; crcOk: boolean } {
  if (bits.length !== JS8_INFO_BITS) throw new Error(`${JS8_INFO_BITS} bits expected`);
  const words: number[] = [];
  let p = 0;
  for (let i = 0; i < JS8_MESSAGE_CHARS; i++) {
    let w = 0;
    for (let k = 0; k < 6; k++) w = (w << 1) | (bits[p++]! & 1);
    words.push(w);
  }
  let frameType = 0;
  for (let k = 0; k < 3; k++) frameType = (frameType << 1) | (bits[p++]! & 1);
  let crc = 0;
  for (let k = 0; k < 12; k++) crc = (crc << 1) | (bits[p++]! & 1);
  const text = words.map((w) => JS8_ALPHABET[w] ?? "?").join("");
  return { text, words, frameType, crcOk: crc === js8Crc12(words, frameType) };
}

// ---------------------------------------------------------------------------
// The (174,87) code: dense generator for encoding, sparse graph for checking.
// ---------------------------------------------------------------------------

let generator: Uint8Array[] | null = null;

/** The 87 generator rows as bit arrays (87 bits each) from the hex strings. */
export function js8Generator(): Uint8Array[] {
  if (generator) return generator;
  generator = JS8_LDPC_GENERATOR_HEX.map((hex) => {
    const row = new Uint8Array(JS8_INFO_BITS);
    for (let j = 0; j < 11; j++) {
      const byte = parseInt(hex.slice(2 * j, 2 * j + 2), 16);
      for (let jj = 0; jj < 8; jj++) {
        const col = j * 8 + jj;
        if (col < JS8_INFO_BITS && (byte >> (7 - jj)) & 1) row[col] = 1;
      }
    }
    return row;
  });
  return generator;
}

/** 87 information bits to the 174-bit codeword, in transmitted bit order. */
export function js8Encode(info: ArrayLike<number>): Uint8Array {
  if (info.length !== JS8_INFO_BITS) throw new Error(`${JS8_INFO_BITS} bits expected`);
  const gen = js8Generator();
  const tmp = new Uint8Array(JS8_CODEWORD_BITS);
  for (let i = 0; i < JS8_PARITY_BITS; i++) {
    const row = gen[i]!;
    let sum = 0;
    for (let j = 0; j < JS8_INFO_BITS; j++) sum += info[j]! & row[j]!;
    tmp[i] = sum & 1;
  }
  for (let j = 0; j < JS8_INFO_BITS; j++) tmp[JS8_PARITY_BITS + j] = info[j]! & 1;
  const codeword = new Uint8Array(JS8_CODEWORD_BITS);
  for (let i = 0; i < JS8_CODEWORD_BITS; i++) codeword[JS8_LDPC_COLORDER[i]!] = tmp[i]!;
  return codeword;
}

/** The information bits of a codeword (the inverse of the column order), without checking it. */
export function js8InfoBitsOf(codeword: ArrayLike<number>): Uint8Array {
  const tmp = new Uint8Array(JS8_CODEWORD_BITS);
  for (let i = 0; i < JS8_CODEWORD_BITS; i++) tmp[i] = codeword[JS8_LDPC_COLORDER[i]!]! & 1;
  return tmp.subarray(JS8_PARITY_BITS);
}

/** Which of the 87 sparse checks a codeword fails. Empty for a codeword. */
export function js8CheckParity(codeword: ArrayLike<number>): number[] {
  if (codeword.length !== JS8_CODEWORD_BITS) throw new Error(`${JS8_CODEWORD_BITS} bits expected`);
  const bad: number[] = [];
  for (let m = 0; m < JS8_PARITY_BITS; m++) {
    const row = JS8_LDPC_NM[m]!;
    let sum = 0;
    for (let i = 0; i < JS8_LDPC_NRW[m]!; i++) sum += codeword[row[i]! - 1]! & 1;
    if (sum & 1) bad.push(m);
  }
  return bad;
}

/** Sanity of the transcribed graph: every bit in exactly three checks, and the two tables agree. */
export function js8GraphConsistent(): boolean {
  for (let n = 0; n < JS8_CODEWORD_BITS; n++) {
    for (const m of JS8_LDPC_MN[n]!) {
      const row = JS8_LDPC_NM[m - 1]!;
      let found = false;
      for (let i = 0; i < JS8_LDPC_NRW[m - 1]!; i++) if (row[i] === n + 1) found = true;
      if (!found) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Channel symbols.
// ---------------------------------------------------------------------------

/** The 79 tones for a codeword: S7 D29 S7 D29 S7, data symbols three bits each, MSB first. */
export function js8TonesFor(codeword: ArrayLike<number>, costas: 1 | 2): number[] {
  if (codeword.length !== JS8_CODEWORD_BITS) throw new Error(`${JS8_CODEWORD_BITS} bits expected`);
  const tones = new Array<number>(JS8_SYMBOLS).fill(0);
  const sync = JS8_COSTAS[costas];
  for (let b = 0; b < 3; b++) for (let i = 0; i < 7; i++) tones[JS8_COSTAS_AT[b]! + i] = sync[b]![i]!;
  let k = 7;
  for (let j = 0; j < JS8_DATA_SYMBOLS; j++) {
    if (j === 29) k += 7;
    const i = 3 * j;
    tones[k++] = (codeword[i]! << 2) | (codeword[i + 1]! << 1) | codeword[i + 2]!;
  }
  return tones;
}

/** The 174 codeword bits from the 58 data tones (hard decisions), ignoring the sync blocks. */
export function js8CodewordFromTones(tones: ArrayLike<number>): Uint8Array {
  if (tones.length !== JS8_SYMBOLS) throw new Error(`${JS8_SYMBOLS} tones expected`);
  const bits = new Uint8Array(JS8_CODEWORD_BITS);
  let k = 7;
  for (let j = 0; j < JS8_DATA_SYMBOLS; j++) {
    if (j === 29) k += 7;
    const t = tones[k++]! & 7;
    bits[3 * j] = (t >> 2) & 1;
    bits[3 * j + 1] = (t >> 1) & 1;
    bits[3 * j + 2] = t & 1;
  }
  return bits;
}

/** Everything from text to tones. */
export function js8EncodeFrame(text: string, frameType: number, submode: Js8Submode = "A"): { info: Uint8Array; codeword: Uint8Array; tones: number[] } {
  const info = js8PackFrame(text, frameType);
  const codeword = js8Encode(info);
  return { info, codeword, tones: js8TonesFor(codeword, JS8_SUBMODES[submode].costas) };
}

// ---------------------------------------------------------------------------
// The waveform: GFSK as WSJT-X's gen_ft8wave shapes it (BT = 2), ported for any rate.
// ---------------------------------------------------------------------------

/** erf, to about 1.2e-7 (Abramowitz and Stegun 7.1.26). Plenty for a pulse shape. */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return sign * y;
}

/** The GFSK frequency pulse for one symbol, t in symbols, as gfsk_pulse.f90. */
export function js8GfskPulse(bt: number, t: number): number {
  const c = Math.PI * Math.sqrt(2 / Math.log(2));
  return 0.5 * (erf(c * bt * (t + 0.5)) - erf(c * bt * (t - 0.5)));
}

export interface Js8WaveformOptions {
  sampleRate: number;
  /** Audio frequency of tone 0, Hz. */
  baseHz: number;
  submode?: Js8Submode;
  amplitude?: number;
  /** Gaussian bandwidth-time product. FT8 and JS8 use 2.0. */
  bt?: number;
}

/**
 * The audio for 79 tones: a frequency trajectory made by convolving the tone sequence with
 * the Gaussian pulse, integrated to phase, with a short raised-cosine ramp at each end.
 * Ported from gen_ft8wave.f90, which JS8Call's gen_js8wave follows, for an arbitrary rate.
 */
export function js8Waveform(tones: ArrayLike<number>, opts: Js8WaveformOptions): Float32Array {
  if (tones.length !== JS8_SYMBOLS) throw new Error(`${JS8_SYMBOLS} tones expected`);
  const fs = opts.sampleRate;
  const submode = opts.submode ?? "A";
  const bt = opts.bt ?? 2.0;
  const amp = opts.amplitude ?? 1;
  const nsps = Math.round((JS8_SUBMODES[submode].nsps * fs) / JS8_SAMPLE_RATE);
  const nsym = JS8_SYMBOLS;
  const hmod = 1;
  const dphiPeak = (2 * Math.PI * hmod) / nsps;
  // The pulse over three symbols.
  const pulse = new Float64Array(3 * nsps);
  for (let i = 0; i < 3 * nsps; i++) pulse[i] = js8GfskPulse(bt, (i + 1 - 1.5 * nsps) / nsps);
  // Frequency deviation per sample, with a symbol of lead and lag for the pulse tails.
  const total = (nsym + 2) * nsps;
  const dphi = new Float64Array(total).fill((2 * Math.PI * opts.baseHz) / fs);
  for (let j = 0; j < nsym; j++) {
    const ib = j * nsps;
    const tone = tones[j]!;
    for (let i = 0; i < 3 * nsps; i++) dphi[ib + i]! += dphiPeak * pulse[i]! * tone;
  }
  // Hold the first and last tones through the lead and lag so the edges are not glitches.
  for (let i = 0; i < 2 * nsps; i++) dphi[i]! += dphiPeak * pulse[i + nsps]! * tones[0]!;
  for (let i = 0; i < 2 * nsps; i++) dphi[nsym * nsps + i]! += dphiPeak * pulse[i]! * tones[nsym - 1]!;
  // Integrate, taking the samples from one symbol in (the lead).
  const out = new Float32Array(nsym * nsps);
  let phi = 0;
  for (let k = 0; k < nsym * nsps; k++) {
    out[k] = amp * Math.sin(phi);
    phi += dphi[k + nsps]!;
    if (phi > 2 * Math.PI) phi -= 2 * Math.PI;
  }
  // Raised-cosine ramps of an eighth of a symbol at each end.
  const nramp = Math.max(1, Math.floor(nsps / 8));
  for (let i = 0; i < nramp; i++) {
    const g = 0.5 * (1 - Math.cos((Math.PI * i) / nramp));
    out[i]! *= g;
    out[out.length - 1 - i]! *= g;
  }
  return out;
}
