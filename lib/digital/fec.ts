// Forward error correction as fldigi's keyboard modes use it: a rate-1/2 convolutional
// code, a soft-decision Viterbi decoder for it, and the diagonal interleaver.
//
// MFSK16 and its relatives (and, later, Thor and the PSK-R modes) protect their Varicode
// bit stream the same way. Each data bit goes into a shift register K bits long; two
// parity checks over it (the two polynomials) are sent for every bit in, so the stream on
// the air is twice as long as the data. The receiver runs the Viterbi algorithm over the
// 2^(K-1) states the register can be in, keeping for each the best-scoring path into it,
// and reads each bit off a path a few constraint lengths back, by which time all the
// survivors agree. Soft decisions - how sure the demodulator was of each received bit,
// 0 to 255 with 128 for "no idea" - are worth about 2 dB over hard 0s and 1s.
//
// The interleaver spreads each symbol's bits over many symbols so that a burst of noise or
// a fade, which wipes out whole symbols, arrives at the decoder as scattered single-bit
// errors, which the code corrects.
//
// Ported from fldigi 4.2.13 (W1HKJ, GPL, itself from Tomi Manninen OH2BNS's gMFSK):
// src/filters/viterbi.cxx and src/include/viterbi.h for the encoder and decoder,
// src/mfsk/interleave.cxx and src/include/interleave.h for the interleaver. The arithmetic
// is the same, including the decoder's metric table and traceback, so a stream from
// fldigi decodes here and the other way round; scripts/check-mfsk.ts checks the round
// trips and the correction of injected errors.

/** The NASA standard K=7 code, as fldigi's mfsk.h names it: POLY1 0x6d, POLY2 0x4f. */
export const NASA_K = 7;
export const NASA_POLY1 = 0x6d;
export const NASA_POLY2 = 0x4f;

/** fldigi's PATHMEM: how many steps of survivor history the decoder keeps. */
export const VITERBI_PATHMEM = 256;
/** fldigi's PUNCTURE: the soft value that says nothing either way. */
export const PUNCTURE = 128;

export function parity(x: number): number {
  x ^= x >>> 16;
  x ^= x >>> 8;
  x ^= x >>> 4;
  x ^= x >>> 2;
  x ^= x >>> 1;
  return x & 1;
}

/**
 * The two parity bits for each value of a K-bit register, newest bit lowest: bit 0 from
 * the first polynomial, bit 1 from the second. Shared by the encoder and the decoder, as
 * in fldigi, so the two cannot disagree on which output is which.
 */
function outputTable(k: number, poly1: number, poly2: number): Uint8Array {
  const size = 1 << k;
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = parity(poly1 & i) | (parity(poly2 & i) << 1);
  return out;
}

/**
 * The convolutional encoder (fldigi's `encoder`). encode() takes one data bit and returns
 * the two code bits as a number 0-3: bit 0 is the first polynomial's parity and is sent
 * first, bit 1 the second's.
 */
export class ConvEncoder {
  private readonly output: Uint8Array;
  private readonly mask: number;
  private shreg = 0;

  constructor(
    readonly k = NASA_K,
    readonly poly1 = NASA_POLY1,
    readonly poly2 = NASA_POLY2,
  ) {
    this.output = outputTable(k, poly1, poly2);
    this.mask = (1 << k) - 1;
  }

  encode(bit: number): number {
    this.shreg = ((this.shreg << 1) | (bit ? 1 : 0)) >>> 0;
    return this.output[this.shreg & this.mask]!;
  }

  reset(): void {
    this.shreg = 0;
  }
}

/**
 * The soft-decision Viterbi decoder (fldigi's `viterbi`). Feed it the two soft code bits
 * for each data bit, 0 (surely a 0) to 255 (surely a 1), in the order they were sent;
 * every `chunkSize` pairs it traces back `traceback` steps from the best state and
 * returns that many decoded bits, packed oldest first. `metric` after a decode is the
 * best path's score over the bits returned: the decoder's own measure of how well the
 * stream fits the code, which the modes use as their signal quality.
 */
export class ViterbiDecoder {
  private readonly nstates: number;
  private readonly output: Uint8Array;
  private readonly metrics: Float64Array[];
  private readonly history: Int32Array[];
  private readonly sequence = new Int32Array(VITERBI_PATHMEM);
  private ptr = 0;
  private tracebackLen: number;
  private chunk: number;
  /** The path metric over the last decoded chunk; see the class comment. */
  metric = 0;

  constructor(
    readonly k = NASA_K,
    readonly poly1 = NASA_POLY1,
    readonly poly2 = NASA_POLY2,
  ) {
    this.nstates = 1 << (k - 1);
    this.output = outputTable(k, poly1, poly2);
    this.metrics = Array.from({ length: VITERBI_PATHMEM }, () => new Float64Array(this.nstates));
    this.history = Array.from({ length: VITERBI_PATHMEM }, () => new Int32Array(this.nstates));
    // fldigi's defaults: twelve constraint lengths, enough to settle from an arbitrary
    // state even through punctures, and eight bits a traceback.
    this.tracebackLen = k * 12;
    this.chunk = 8;
  }

  /** How far back a bit is read. fldigi's MFSK sets 45. */
  setTraceback(n: number): void {
    if (n >= 0 && n <= VITERBI_PATHMEM - 1) this.tracebackLen = n;
  }

  /** Bits per traceback. fldigi's MFSK sets 1: a bit out for every pair in. */
  setChunkSize(n: number): void {
    if (n >= 1 && n <= this.tracebackLen) this.chunk = n;
  }

  reset(): void {
    for (let i = 0; i < VITERBI_PATHMEM; i++) {
      this.metrics[i]!.fill(0);
      this.history[i]!.fill(0);
    }
    this.ptr = 0;
    this.metric = 0;
  }

  /** fldigi's mettab: 128 - s for a 0, s - 128 for a 1. */
  private static met(bit: number, s: number): number {
    return bit ? s - 128 : 128 - s;
  }

  /**
   * One pair of soft code bits: `s0` for the first polynomial's bit, `s1` the second's.
   * Returns the decoded bits (chunkSize of them, oldest in the high bit) when a traceback
   * falls due, otherwise -1.
   */
  decode(s0: number, s1: number): number {
    const P = VITERBI_PATHMEM;
    const currptr = this.ptr;
    const prevptr = (currptr - 1 + P) % P;
    const met = [
      ViterbiDecoder.met(0, s1) + ViterbiDecoder.met(0, s0),
      ViterbiDecoder.met(0, s1) + ViterbiDecoder.met(1, s0),
      ViterbiDecoder.met(1, s1) + ViterbiDecoder.met(0, s0),
      ViterbiDecoder.met(1, s1) + ViterbiDecoder.met(1, s0),
    ];
    const prev = this.metrics[prevptr]!;
    const cur = this.metrics[currptr]!;
    const hist = this.history[currptr]!;
    const ns = this.nstates;
    for (let n = 0; n < ns; n++) {
      // The register value s is the state's K-1 bits with one more, older, bit on top:
      // the two predecessors differ only in that oldest bit. On a tie the second wins, as
      // in fldigi.
      const s0r = n;
      const s1r = n + ns;
      const p0 = s0r >> 1;
      const p1 = s1r >> 1;
      const m0 = prev[p0]! + met[this.output[s0r]!]!;
      const m1 = prev[p1]! + met[this.output[s1r]!]!;
      if (m0 > m1) {
        cur[n] = m0;
        hist[n] = p0;
      } else {
        cur[n] = m1;
        hist[n] = p1;
      }
    }
    this.ptr = (this.ptr + 1) % P;
    // fldigi lets an int run until it nears overflow and then shifts every row; a double
    // has room for years of decoding, but keep the numbers small all the same. Shifting
    // every row by the same amount changes no decision and no metric difference.
    if (Math.abs(cur[0]!) > 1e12) {
      const shift = cur[0]!;
      for (const row of this.metrics) for (let j = 0; j < ns; j++) row[j] = row[j]! - shift;
    }
    if (this.ptr % this.chunk === 0) return this.traceback();
    return -1;
  }

  private traceback(): number {
    const P = VITERBI_PATHMEM;
    let p = (this.ptr - 1 + P) % P;
    let bestmetric = -Infinity;
    let beststate = 0;
    const row = this.metrics[p]!;
    for (let i = 0; i < this.nstates; i++) {
      if (row[i]! > bestmetric) {
        bestmetric = row[i]!;
        beststate = i;
      }
    }
    this.sequence[p] = beststate;
    for (let i = 0; i < this.tracebackLen; i++) {
      const prev = (p - 1 + P) % P;
      this.sequence[prev] = this.history[p]![this.sequence[p]!]!;
      p = prev;
    }
    const start = this.metrics[p]![this.sequence[p]!]!;
    let c = 0;
    for (let i = 0; i < this.chunk; i++) {
      // The low bit of a state is the data bit that entered it.
      c = (c << 1) | (this.sequence[p]! & 1);
      p = (p + 1) % P;
    }
    this.metric = this.metrics[p]![this.sequence[p]!]! - start;
    return c;
  }
}

export type InterleaveDirection = "fwd" | "rev";

/**
 * fldigi's interleaver: `depth` square stages of `size` x `size`, one row per bit of a
 * symbol. Each call takes one symbol's worth of bits and shifts every row one place; the
 * transmitter ("fwd") reads bit i from i places back and the receiver ("rev") from
 * size - 1 - i places back, so every bit is delayed size - 1 symbols a stage in all and
 * the bits of one symbol on the air come from symbols spread over depth x (size - 1).
 * The receiver starts full of punctures (128, no information), the transmitter of 0s.
 */
export class Interleaver {
  private readonly table: Uint8Array;
  private readonly syms: Uint8Array;

  constructor(
    readonly size: number,
    readonly depth: number,
    readonly direction: InterleaveDirection,
  ) {
    this.table = new Uint8Array(size * size * depth);
    this.syms = new Uint8Array(size);
    this.flush();
  }

  private at(k: number, i: number, j: number): number {
    return this.size * this.size * k + this.size * i + j;
  }

  /** One symbol's soft (or hard) bits, in place: `psyms[i]` for bit i, the first-sent bit at 0. */
  symbols(psyms: Uint8Array | number[]): void {
    const size = this.size;
    const t = this.table;
    for (let k = 0; k < this.depth; k++) {
      for (let i = 0; i < size; i++) {
        for (let j = 0; j < size - 1; j++) t[this.at(k, i, j)] = t[this.at(k, i, j + 1)]!;
      }
      for (let i = 0; i < size; i++) t[this.at(k, i, size - 1)] = psyms[i]!;
      for (let i = 0; i < size; i++) {
        psyms[i] = this.direction === "fwd" ? t[this.at(k, i, size - i - 1)]! : t[this.at(k, i, i)]!;
      }
    }
  }

  /** One symbol as a number, most significant bit first-sent: fldigi's bits(). */
  bits(value: number): number {
    const size = this.size;
    const s = this.syms;
    for (let i = 0; i < size; i++) s[i] = (value >>> (size - i - 1)) & 1;
    this.symbols(s);
    let out = 0;
    for (let i = 0; i < size; i++) out = (out << 1) | s[i]!;
    return out;
  }

  flush(): void {
    this.table.fill(this.direction === "rev" ? PUNCTURE : 0);
  }
}
