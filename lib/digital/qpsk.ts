// QPSK31/63/125: the convolutional code and its Viterbi decoder.
//
// QPSK is BPSK's Varicode sent through a rate-1/2 convolutional code of constraint length 5
// (G3PLX's choice, kept by fldigi): each Varicode bit goes into a five-bit shift register,
// two parities of the register come out, and the pair picks one of four phase changes. So
// a QPSK symbol carries one data bit, at the same baud as BPSK and in the same bandwidth;
// what it buys is the code's redundancy, which a Viterbi decoder uses to correct the odd
// wrong symbol. This file is the code on its own: lib/digital/psk31.ts sends it and
// lib/digital/psk31demod.ts receives it.
//
// The bits on the air, from fldigi 4.2.13:
//   - K = 5, POLY1 = 0x17, POLY2 = 0x19 (psk/psk.cxx:66-68), and new QPSK encoders are
//     encoder(K, POLY1, POLY2) (psk/psk.cxx:982).
//   - The register shifts left with the new bit in bit 0; output bit 0 is the parity of
//     POLY1 & register, output bit 1 the parity of POLY2 & register
//     (filters/viterbi.cxx:236 encoder::encode, :252 encoder::init). It starts at zero, and every
//     fldigi transmission ends with dcdbits 0 bits through it (psk/psk.cxx tx_flush), so
//     the next one starts at zero too.
//   - The dibit d turns the carrier by 180 + 90 d degrees, in the audio's own phase
//     (cos(wt + theta)): psk/psk.cxx tx_carriers maps the symbol to (4 - d) & 3 when not
//     reversed, then to sym_vec_pos[4 (4 - d)], which is 180 + 90 (4 - d) degrees, and
//     writes I cos + Q sin, which is the conjugate - so the audio turns the other way,
//     180 + 90 d. "Reverse" (fldigi's CAP_REV, for a sideband that mirrors the audio)
//     skips the (4 - d) and so turns it by 180 - 90 d. Dibit 0 is a reversal, which is
//     why the preamble (reversals, psk/psk.cxx tx_process) and the postamble (zeros
//     through the encoder, tx_flush) look the same on the air.
//
// fldigi's own decoder (psk/psk.cxx rx_qpsk) feeds hard decisions to a 60-deep traceback.
// The decoder here takes soft ones - how far each of the four phase changes the symbol
// is - which is worth a dB or two at the copy threshold and changes nothing on the air.

/** Constraint length (psk/psk.cxx:66). */
export const QPSK_K = 5;
/** Generator polynomials (psk/psk.cxx:67-68). Output bit 0 is POLY1's parity, bit 1 POLY2's. */
export const QPSK_POLY1 = 0x17;
export const QPSK_POLY2 = 0x19;

const REG_MASK = (1 << QPSK_K) - 1;
const STATES = 1 << (QPSK_K - 1);

function parity(x: number): number {
  let p = 0;
  while (x) {
    p ^= x & 1;
    x >>>= 1;
  }
  return p;
}

/** The dibit for every value of the five-bit register: filters/viterbi.cxx encoder::init. */
const OUTPUT = new Uint8Array(1 << QPSK_K);
for (let i = 0; i < OUTPUT.length; i++) OUTPUT[i] = parity(QPSK_POLY1 & i) | (parity(QPSK_POLY2 & i) << 1);

/** The K=5 rate-1/2 encoder, as fldigi's: one bit in, one dibit (0 to 3) out. */
export class QpskEncoder {
  private reg = 0;

  reset(): void {
    this.reg = 0;
  }

  encode(bit: number): number {
    this.reg = ((this.reg << 1) | (bit ? 1 : 0)) & REG_MASK;
    return OUTPUT[this.reg]!;
  }
}

/** A bit string through a fresh encoder: the dibits, in order. */
export function qpskEncodeBits(bits: readonly number[]): number[] {
  const enc = new QpskEncoder();
  return bits.map((b) => enc.encode(b));
}

/**
 * The phase change a dibit makes, in radians, in the audio (cos(wt + theta)) as fldigi
 * sends it: 180 + 90 d degrees, or 180 - 90 d reversed. See the header.
 */
export function qpskPhaseChange(dibit: number, reverse = false): number {
  const q = reverse ? -dibit : dibit;
  return Math.PI + (Math.PI / 2) * q;
}

/**
 * How far back the decoder looks before it commits a bit. Five or six constraint lengths
 * is the textbook depth for K=5; fldigi uses twelve (filters/viterbi.cxx viterbi::init),
 * but its postamble is only 32 bits at QPSK31 (dcdbits, psk/psk.cxx:416-418), and a depth
 * longer than that leaves the last character waiting in the decoder after the carrier
 * has gone. 30 decides every bit while the postamble is still on the air.
 */
export const QPSK_TRACEBACK = 30;

/**
 * A Viterbi decoder for the K=5 code, a bit at a time. Each step takes a metric for each
 * of the four dibits (larger is likelier) and returns the bit decided QPSK_TRACEBACK steps
 * ago, or -1 until that many steps have been taken.
 *
 * The state is the last four input bits, newest in bit 0, as fldigi's (viterbi::decode):
 * state n is reached from (n >> 1) and (n >> 1) | 8, by the five-bit registers n and n | 16.
 */
export class QpskViterbi {
  private metrics = new Float64Array(STATES);
  private next = new Float64Array(STATES);
  /** The predecessor chosen for each state at each of the last TRACEBACK + 1 steps. */
  private readonly history: Uint8Array[];
  private head = 0;
  private steps = 0;
  /**
   * The last step's gain on the best path over the largest single metric, at most 1. A
   * coded signal keeps it near 1; on noise the code cannot follow every symbol's best guess.
   */
  fit = 0;

  constructor(private readonly depth = QPSK_TRACEBACK) {
    this.history = Array.from({ length: depth + 1 }, () => new Uint8Array(STATES));
  }

  reset(): void {
    // Every state equally likely: a receiver starts in the middle of a transmission.
    this.metrics.fill(0);
    this.head = 0;
    this.steps = 0;
  }

  /** One symbol. met[d] is how well the symbol fits dibit d. */
  step(met: ArrayLike<number>): number {
    const hist = this.history[this.head]!;
    let best = -Infinity;
    let bestState = 0;
    for (let n = 0; n < STATES; n++) {
      const p0 = n >> 1;
      const p1 = p0 | (STATES >> 1);
      const m0 = this.metrics[p0]! + met[OUTPUT[n]!]!;
      const m1 = this.metrics[p1]! + met[OUTPUT[n | STATES]!]!;
      if (m0 >= m1) {
        this.next[n] = m0;
        hist[n] = p0;
      } else {
        this.next[n] = m1;
        hist[n] = p1;
      }
      if (this.next[n]! > best) {
        best = this.next[n]!;
        bestState = n;
      }
    }
    // The best path's gain this step (the old best was normalised to 0), against the most
    // any dibit could have gained: near 1 when the symbols fit the code.
    let most = -Infinity;
    for (let d = 0; d < 4; d++) if (met[d]! > most) most = met[d]!;
    this.fit = most > 0 ? best / most : 0;
    // Keep the numbers small: only the differences between states matter.
    for (let n = 0; n < STATES; n++) this.next[n]! -= best;
    const t = this.metrics;
    this.metrics = this.next;
    this.next = t;

    const len = this.history.length;
    this.head = (this.head + 1) % len;
    this.steps++;
    if (this.steps <= this.depth) return -1;
    // Back from the best state to the step `depth` ago; its low bit is the bit that went in then.
    let s = bestState;
    let h = (this.head - 1 + len) % len;
    for (let i = 0; i < this.depth; i++) {
      s = this.history[h]![s]!;
      h = (h - 1 + len) % len;
    }
    return s & 1;
  }
}
