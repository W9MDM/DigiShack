// FT2 — parameters and waveform, from the reference implementation.
//
// Ported from wsjt-x_improved 3.1.0, `lib/ft2/` (GPL-3.0; DigiShack is GPL-3.0
// — see LICENSE). Authoritative files: `ft2_params.f90`, `genft2.f90`,
// `ft2_gfsk_iwave.f90`, `gfsk_pulse.f90`.
//
// IMPORTANT — the widely circulated FT2 "specification" is wrong.
//
// An earlier revision of this file encoded a description of FT2 as 4-GFSK with
// LDPC(174,91), CRC-14, a 79-symbol frame of 7+65+7 with FT8's Costas array,
// 24 ms symbols and 41.6667 Hz tone spacing. Essentially none of that matches
// the implementation. It was also internally impossible: 65 data symbols at
// 2 bits each carry 130 bits, and LDPC(174,91) emits 174.
//
// What FT2 actually is:
//
//   * BINARY GFSK, one bit per symbol — not 4-GFSK. `genft2` emits `i4tone`
//     values of 0 or 1 and the modulator maps them to ±1.
//   * Modulation index h = 0.8 (MSK would be 0.5, plain FSK 1.0).
//   * LDPC(128,90): 77 message bits + CRC-13 = 90, encoded to 128 bits.
//     Not LDPC(174,91), and CRC-13 not CRC-14.
//   * 144 channel symbols: a 16-bit sync pattern then the 128 codeword bits.
//     The sync is a plain bit pattern, not a Costas array.
//   * 160 samples per symbol at 12 kHz -> 75 baud, 13.333 ms per symbol.
//   * 144 x 160 = 23040 samples = 1.92 s of transmission.
//   * Occupied bandwidth 1.5 x baud = 112.5 Hz.
//
// FT2 descends from MSK144 rather than from FT4 — `genft2`'s own comment says
// "Encode an MSK144 message", which explains the binary keying and the MSK-family
// modulation index.

import { ft2AddCrc13, ft2CheckCrc13 } from "@/lib/digital/crc13";
import { checkParity, encode128_90 } from "@/lib/digital/ldpc12890";
import { HashCallBook, pack77, unpack77 } from "@/lib/digital/pack77";

/** DSP rate the mode is defined at. */
export const FT2_SAMPLE_RATE = 12_000;

/** Samples per symbol (`NSPS`). */
export const FT2_SAMPLES_PER_SYMBOL = 160;

/** Keying rate: 12000/160 = 75 baud. */
export const FT2_BAUD = FT2_SAMPLE_RATE / FT2_SAMPLES_PER_SYMBOL;

/** Symbol duration, seconds. */
export const FT2_SYMBOL_SEC = FT2_SAMPLES_PER_SYMBOL / FT2_SAMPLE_RATE;

/** Information bits carried (`KK`): 77 message + 13 CRC. */
export const FT2_INFO_BITS = 90;

/** Message bits before the CRC. */
export const FT2_MESSAGE_BITS = 77;

/** LDPC codeword length (`ND`). */
export const FT2_CODEWORD_BITS = 128;

/** Sync symbols (`NS`), as a 16-bit pattern. */
export const FT2_SYNC_SYMBOLS = 16;

/** Total channel symbols (`NN`). */
export const FT2_TOTAL_SYMBOLS = FT2_SYNC_SYMBOLS + FT2_CODEWORD_BITS;

/** Samples in the transmission proper (`NZ`). */
export const FT2_TX_SAMPLES = FT2_SAMPLES_PER_SYMBOL * FT2_TOTAL_SYMBOLS;

/** Transmission length, ms. */
export const FT2_TX_MS = (FT2_TX_SAMPLES / FT2_SAMPLE_RATE) * 1000;

/**
 * Modulation index. MSK is 0.5 and plain FSK 1.0; FT2 uses 0.8.
 *
 * This sets the peak phase advance per sample and therefore the tone separation,
 * so it is not a free parameter — a different value is a different mode.
 */
export const FT2_MOD_INDEX = 0.8;

/** Occupied bandwidth, Hz: 1.5 x baud. */
export const FT2_BANDWIDTH_HZ = 1.5 * FT2_BAUD;

/**
 * The 16-symbol sync pattern (`s16` in `genft2.f90`).
 *
 * Four zeros, eight ones, four zeros. Not a Costas array — FT2 is binary, so a
 * frequency-hopping sync sequence would not apply.
 */
export const FT2_SYNC: readonly number[] = [
  0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0,
];

/**
 * Gaussian frequency pulse (`gfsk_pulse.f90`).
 *
 *   0.5 * (erf(c*b*(t+0.5)) - erf(c*b*(t-0.5))),  c = pi*sqrt(2/ln 2)
 *
 * `t` is in symbol periods. The pulse spans three symbols, which is why adjacent
 * symbols overlap in the frequency waveform — that overlap is what makes the
 * spectrum compact enough for 112.5 Hz.
 */
export function ft2GfskPulse(t: number, b = 1.0): number {
  const c = Math.PI * Math.sqrt(2 / Math.LN2);
  return 0.5 * (erf(c * b * (t + 0.5)) - erf(c * b * (t - 0.5)));
}

/**
 * Error function, Abramowitz & Stegun 7.1.26.
 *
 * Accurate to about 1.5e-7, which is far below the 16-bit quantisation the
 * waveform ends up in — a more elaborate implementation would buy nothing here.
 */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-a * a);
  return sign * y;
}

/**
 * The 3-symbol pulse table the modulator convolves with.
 *
 * 480 samples at the native 12 kHz. `samplesPerSymbol` scales it for other rates
 * — the pulse is defined in SYMBOL periods, so its length in samples must follow
 * the rate. Leaving it fixed while the rate changes is the same class of mistake
 * that made an early FT8 transmitter emit a 6.32 s frame instead of 12.64 s.
 */
export function ft2PulseTable(samplesPerSymbol = FT2_SAMPLES_PER_SYMBOL): Float64Array {
  const n = 3 * samplesPerSymbol;
  const centre = n / 2 + 0.5;
  const pulse = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    // Fortran: tt = (i - 240.5)/160 for i = 1..480, i.e. centred on the middle.
    const tt = (i + 1 - centre) / samplesPerSymbol;
    pulse[i] = ft2GfskPulse(tt);
  }
  return pulse;
}

/**
 * Samples per symbol at a given rate.
 *
 * 160 at 12 kHz, 320 at DAX's 24 kHz. Throws rather than rounding: a
 * non-integer value would drift the symbol timing across the frame and produce a
 * transmission that decodes at the start and not at the end.
 */
export function ft2SamplesPerSymbol(sampleRate: number): number {
  const sps = (FT2_SAMPLES_PER_SYMBOL * sampleRate) / FT2_SAMPLE_RATE;
  if (!Number.isInteger(sps) || sps <= 0) {
    throw new Error(
      `FT2 needs a sample rate that is a whole multiple of ${FT2_SAMPLE_RATE / FT2_SAMPLES_PER_SYMBOL} Hz; ${sampleRate} gives ${sps} samples/symbol`,
    );
  }
  return sps;
}

/**
 * Build the 144-symbol channel vector: sync pattern then codeword bits.
 *
 * Takes the LDPC codeword rather than a message, because the encoder is a
 * separate concern — this is the framing step only.
 */
export function ft2ChannelSymbols(codeword: ArrayLike<number>): Uint8Array {
  if (codeword.length !== FT2_CODEWORD_BITS) {
    throw new Error(
      `FT2 codeword must be ${FT2_CODEWORD_BITS} bits, got ${codeword.length}`,
    );
  }
  const out = new Uint8Array(FT2_TOTAL_SYMBOLS);
  for (let i = 0; i < FT2_SYNC_SYMBOLS; i++) out[i] = FT2_SYNC[i]!;
  for (let i = 0; i < FT2_CODEWORD_BITS; i++) {
    out[FT2_SYNC_SYMBOLS + i] = codeword[i]! & 1;
  }
  return out;
}

/**
 * Generate the FT2 audio waveform for a symbol vector.
 *
 * Mirrors `ft2_gfsk_iwave.f90`: accumulate the Gaussian frequency pulses, add the
 * carrier, integrate to phase, then raised-cosine ramp the first and last symbol
 * so the transmission does not start and stop with a click.
 *
 * Returns float samples in roughly ±1, at 12 kHz.
 */
export function ft2GenerateWaveform(
  symbols: ArrayLike<number>,
  baseFrequencyHz: number,
  sampleRate: number = FT2_SAMPLE_RATE,
): Float32Array {
  if (symbols.length !== FT2_TOTAL_SYMBOLS) {
    throw new Error(
      `FT2 needs ${FT2_TOTAL_SYMBOLS} symbols, got ${symbols.length}`,
    );
  }
  if (!Number.isFinite(baseFrequencyHz) || baseFrequencyHz < 100 || baseFrequencyHz > 4000) {
    throw new Error(`FT2 base frequency ${baseFrequencyHz} Hz is out of range`);
  }

  const NSPS = ft2SamplesPerSymbol(sampleRate);
  // NWAVE = (NN + 2) * NSPS — two symbols of tail for the pulse overhang.
  const nwave = (FT2_TOTAL_SYMBOLS + 2) * NSPS;
  const pulse = ft2PulseTable(NSPS);
  const twoPi = 2 * Math.PI;
  const dphiPeak = (twoPi * (FT2_MOD_INDEX / 2)) / NSPS;

  const dphi = new Float64Array(nwave);
  for (let j = 0; j < FT2_TOTAL_SYMBOLS; j++) {
    const bit = symbols[j]! & 1;
    const sign = 2 * bit - 1; // 0 -> -1, 1 -> +1
    const base = j * NSPS;
    for (let k = 0; k < pulse.length; k++) {
      const idx = base + k;
      if (idx < nwave) dphi[idx] = dphi[idx]! + dphiPeak * pulse[k]! * sign;
    }
  }

  const carrier = (twoPi * baseFrequencyHz) / sampleRate;
  const out = new Float32Array(nwave);
  let phi = 0;
  for (let j = 0; j < nwave; j++) {
    // Unit peak, NOT sqrt(2).
    //
    // An earlier version multiplied by Math.SQRT2 because the Fortran reference
    // does, and the CHANGELOG recorded "amplitude comes out at sqrt(2) exactly as
    // the reference" as if that were a verification. It was circular: the
    // reference scales for its own int16 conversion, and sqrt(2) there is an RMS
    // normalisation, not a peak. Through our transmit path — which clamps to
    // int16 in tx.ts with no normalisation of its own — it meant a peak of 1.4142
    // and 49.7% of samples hard-clipped on every FT2 transmission, against 0.0%
    // for FT8 and 0.9% for FT4 through the same code. That is severe distortion
    // and splatter either side of the passband, not a level trim.
    out[j] = Math.sin(phi);
    phi = (phi + dphi[j]! + carrier) % twoPi;
  }

  // Ramp the first symbol up and symbol 146 down, as the reference does, then
  // silence the tail. Without this the transmission clicks at both ends and
  // splatters either side of the passband.
  for (let i = 0; i < NSPS; i++) {
    const w = (1 - Math.cos((twoPi * i) / (2 * NSPS))) / 2;
    out[i] = out[i]! * w;
  }
  const rampDownStart = 145 * NSPS;
  for (let i = 0; i < NSPS; i++) {
    const idx = rampDownStart + i;
    if (idx < nwave) {
      const w = (1 + Math.cos((twoPi * i) / (2 * NSPS))) / 2;
      out[idx] = out[idx]! * w;
    }
  }
  for (let i = 146 * NSPS; i < nwave; i++) out[i] = 0;


  return out;
}

// ---------------------------------------------------------------------------
// The complete transmit chain
// ---------------------------------------------------------------------------

/**
 * Encode a message into FT2 audio: text -> 77 bits -> CRC-13 -> LDPC(128,90)
 * -> 144 symbols -> GFSK waveform.
 *
 * This is the whole of `genft2.f90` apart from its fixed-tone and MSK40 special
 * cases. FT2 has no message format of its own — it reuses FT8's 77-bit payload,
 * so `pack77` is shared with the other digital modes rather than duplicated.
 */
export interface Ft2Encoded {
  /** 12 kHz float audio, roughly ±1.414. */
  audio: Float32Array;
  /** The 144 channel symbols (16 sync + 128 data), each 0 or 1. */
  symbols: Uint8Array;
  /** The 77 payload bits. */
  messageBits: Uint8Array;
  /**
   * The message as it will be RECEIVED.
   *
   * May differ from the input: a compound callsign can lose its prefix to the
   * base-call packing, and free text is cut to 13 characters. Show this to the
   * operator rather than what they typed — otherwise they learn about the
   * truncation from the other station.
   */
  sent: string;
  /** Payload type actually used (1, 2, 4, or 0 for free text). */
  i3: number;
}

export function ft2Encode(
  message: string,
  baseFrequencyHz = 1500,
  book?: HashCallBook,
  sampleRate: number = FT2_SAMPLE_RATE,
): Ft2Encoded {
  const packed = pack77(message, book);
  const info = ft2AddCrc13(packed.bits);
  const codeword = encode128_90(info);
  const symbols = ft2ChannelSymbols(codeword);
  return {
    audio: ft2GenerateWaveform(symbols, baseFrequencyHz, sampleRate),
    symbols,
    messageBits: packed.bits,
    sent: packed.sent,
    i3: packed.i3,
  };
}

/**
 * Recover a message from 144 hard-decided symbols.
 *
 * Checks the sync pattern, strips it, verifies the LDPC parity and the CRC, then
 * unpacks. Every stage can reject, and each rejection is reported separately —
 * "sync matched but the CRC failed" and "nothing looked like FT2" call for very
 * different responses from a decoder.
 *
 * This is hard-decision only. A real receiver runs belief propagation over soft
 * symbol metrics (`bpdecode128_90.f90`) and recovers frames this rejects; that
 * belongs with the demodulator, not here.
 */
export interface Ft2DecodeResult {
  ok: boolean;
  message?: string;
  i3?: number;
  /** Sync symbols that disagreed with the expected pattern, 0-16. */
  syncErrors: number;
  /** Parity checks that failed, 0-38. */
  parityErrors: number;
  reason?: string;
}

export function ft2DecodeSymbols(
  symbols: ArrayLike<number>,
  book?: HashCallBook,
): Ft2DecodeResult {
  if (symbols.length !== FT2_TOTAL_SYMBOLS) {
    return {
      ok: false,
      syncErrors: FT2_SYNC_SYMBOLS,
      parityErrors: 0,
      reason: `expected ${FT2_TOTAL_SYMBOLS} symbols, got ${symbols.length}`,
    };
  }

  let syncErrors = 0;
  for (let i = 0; i < FT2_SYNC_SYMBOLS; i++) {
    if ((symbols[i]! & 1) !== FT2_SYNC[i]!) syncErrors++;
  }

  const codeword = new Uint8Array(FT2_CODEWORD_BITS);
  for (let i = 0; i < FT2_CODEWORD_BITS; i++) {
    codeword[i] = symbols[FT2_SYNC_SYMBOLS + i]! & 1;
  }
  const parityErrors = checkParity(codeword).length;
  if (parityErrors > 0) {
    return { ok: false, syncErrors, parityErrors, reason: "LDPC parity failed" };
  }

  const info = codeword.subarray(0, FT2_INFO_BITS);
  if (!ft2CheckCrc13(info)) {
    return { ok: false, syncErrors, parityErrors, reason: "CRC-13 failed" };
  }

  const out = unpack77(info.subarray(0, FT2_MESSAGE_BITS), book);
  if (!out.ok) {
    return {
      ok: false,
      syncErrors,
      parityErrors,
      i3: out.i3,
      reason: out.i3 === 3 || out.i3 === 5 || (out.i3 === 0 && out.n3 > 0)
        ? `payload type ${out.i3}.${out.n3} is not supported`
        : "payload did not unpack to a valid message",
    };
  }
  return { ok: true, message: out.message, i3: out.i3, syncErrors, parityErrors };
}
