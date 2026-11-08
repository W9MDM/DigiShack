// PSK-R: BPSK with forward error correction, fldigi's PSK125R, PSK250R and PSK500R.
//
// PSK-R is plain BPSK on the air - one carrier, a reversal or not each symbol, the G3PLX
// envelope - but the bits it keys are not Varicode straight. The text goes as MFSK16's
// Varicode (lib/digital/mfsk-varicode.ts), through the NASA K=7 rate-1/2 convolutional code
// (two code bits for each data bit, so a character takes twice the symbols it would at plain
// BPSK at the same baud), and through a diagonal interleaver that spreads each pair of code
// bits over a second or two, so a burst of noise or a fade reaches the decoder as scattered
// single errors the code can correct. The receiver runs a soft-decision Viterbi decoder.
// What that buys is copy a few dB below where plain BPSK at the same baud fails, at half
// the typing speed.
//
// The bits on the air, from fldigi 4.2.13 (W1HKJ and others, GPL), src/psk/psk.cxx:
//   - The code: K = 7, POLY1 = 0x6d, POLY2 = 0x4f (psk.cxx:72-74), encoder(PSKR_K,
//     PSKR_POLY1, PSKR_POLY2) (psk.cxx:990): the same code as MFSK, lib/digital/fec.ts.
//   - The interleaver: size 2 (one row per code bit), depth 40 at PSK125R, 80 at PSK250R,
//     160 at PSK500R (psk.cxx:378, :660-685), so every speed spreads a bit over the same
//     time. Interleave(isize, idepth, INTERLEAVE_FWD) to send (psk.cxx:1038).
//   - tx_bit (psk.cxx:2324-2345): the data bit through the encoder, the two code bits through
//     the interleaver's bits() (which takes the second polynomial's bit as its first row),
//     and then sent "low bit first": the interleaved bit 0, then bit 1. Each is one BPSK
//     symbol, tx_symbol(2) for a 1 (0 degrees: no change) and tx_symbol(0) for a 0 (a
//     reversal), the same sense as PSK31's Varicode bits (psk.cxx:2196-2214, 2252-2255).
//   - tx_char (psk.cxx:2470-2490): MFSK Varicode, varienc(c), and no separator - each code
//     ends in its own 00. UTF-8 bytes, CR LF for a newline, as the keyboard sends them.
//   - The preamble (tx_process, psk.cxx:2553-2574): the encoder cleared and the interleaver
//     filled with 0s (clearbits, psk.cxx:2546-2551); then dcdbits / 2 pairs of the data
//     bits 1, 0 (dcdbits is 128, 256 and 512, psk.cxx:660-685; 64 at PSK63F, :450-455, and
//     so at PSK63R here): dcdbits data bits, twice as
//     many symbols, about two seconds at every speed; then a NUL character, whose Varicode
//     (11101011100) ends in 00 and so marks where the first character starts.
//   - The postamble (tx_flush, psk.cxx:2496-2507): dcdbits / 2 pairs of 1 bits. A run of 1s
//     through this code is 1s out (both polynomials have an odd number of taps), so the end
//     of an over is a steady carrier, and a run of 1s is never MFSK Varicode, so it prints
//     nothing while it pushes the last character out through the interleaver and decoder.
//
// The receiver (rx_pskr, psk.cxx:1220-1289). The receiver cannot tell which of two
// consecutive symbols is a pair's first: a symbol is a symbol. fldigi does not search for
// it; it decodes both ways at once. Every symbol it pairs with the one before and hands the
// pair, alternately, to one of two de-interleavers and Viterbi decoders, so one of them sees
// the pairs as sent and the other sees them one symbol out. Each keeps a running average of
// its decoder's path metric (fecmet, decayavg over 20 tracebacks), and each character is
// printed from whichever decoder's average is the higher at that moment (rx_bit, rx_bit2,
// psk.cxx:1116-1185): the decoder fed the true pairs fits the code and the other does not.
// The pair goes to the de-interleaver as [this symbol, the one before] and comes out
// reversed into the decoder (psk.cxx:1254-1263), which undoes the transmitter's ordering
// above. Both decoders trace back four bits at a time (setchunksize(4), psk.cxx:992-995,
// because a Varicode can be as short as three bits) over fldigi's default 84 steps.
//
// MODE_PSK63F (Multipsk's PSK63 FEC, psk.cxx:450-455) is the same with no interleaver
// (every Txinlv / Rxinlv call skips it, psk.cxx:1257, :1279, :2340): depth 0 here. fldigi
// has no single-carrier PSK63R - its PSK63R modes are the multi-carrier 4X to 32X - so
// "PSK63R" here is the series continued downward as psk.cxx:1033-1036 describes it
// ("2x2x20 for BPSK63+FEC"): depth 20. It talks to another DigiShack, not to fldigi;
// PSK63F does.
//
// lib/digital/psk31.ts sends it (option pskr), lib/digital/psk31demod.ts receives it (the
// same option) and uses PskrReceiver below for everything after the soft decision;
// scripts/check-pskr.ts checks both.

import { ConvEncoder, Interleaver, PUNCTURE, ViterbiDecoder } from "@/lib/digital/fec";
import { MFSK_MAX_CODE_BITS, MfskVaricodeDecoder, mfskVaricodeFor, mfskEncodeText } from "@/lib/digital/mfsk-varicode";

/** Constraint length and polynomials (psk/psk.cxx:72-74). Output bit 0 is POLY1's parity. */
export const PSKR_K = 7;
export const PSKR_POLY1 = 0x6d;
export const PSKR_POLY2 = 0x4f;
/** The interleaver's rows: one per code bit (psk/psk.cxx:378, isize = 2). */
export const PSKR_INTERLEAVE_SIZE = 2;
/** Bits per traceback (psk/psk.cxx:992): a Varicode can be three bits long. */
export const PSKR_CHUNK = 4;

/** The speeds PSK-R runs at here. 63 is not fldigi's; see the header. */
export type PskrSpeed = 63 | 125 | 250 | 500;
export const PSKR_SPEEDS: readonly PskrSpeed[] = [63, 125, 250, 500];

export function isPskrSpeed(n: unknown): n is PskrSpeed {
  return typeof n === "number" && (PSKR_SPEEDS as readonly number[]).includes(n);
}

/**
 * The interleaver depth for a speed: 40, 80, 160 at 125, 250, 500 (psk/psk.cxx:664, :671,
 * :678), and 20 at 63 by the rule psk.cxx:1033-1036 states. Throws for a speed PSK-R has
 * no depth for (31): a caller that asks for it has a bug, and a guess would key a signal
 * no one can read.
 */
export function pskrDepth(speed: number): number {
  switch (speed) {
    case 63:
      return 20;
    case 125:
      return 40;
    case 250:
      return 80;
    case 500:
      return 160;
    default:
      throw new RangeError(`PSK-R has no ${speed}-baud mode (63, 125, 250 or 500)`);
  }
}

/** fldigi's dcdbits for a speed (psk/psk.cxx:384-447, :660-685): 64 at 63 baud, doubling. */
export function pskrDcdBits(speed: number): number {
  return speed === 63 ? 64 : speed === 125 ? 128 : speed === 250 ? 256 : speed === 500 ? 512 : 32;
}

/** fldigi's RSID codes (src/rsid/rsid_defs.cxx:46-48, :67). PSK63R has none. */
export const PSKR_RSID: Readonly<Record<string, number>> = { PSK125R: 183, PSK250R: 186, PSK500R: 187, PSK63F: 22 };

/**
 * The interleaver depth the app sends and listens with: fldigi's at 125, 250 and 500, and
 * none at 63, because fldigi's only single-carrier FEC mode at 63 baud is PSK63F (the same
 * code, no interleaver). A PSK63R with depth 20 would copy only between DigiShacks.
 */
export function appPskrDepth(speed: number): number {
  return speed === 63 ? 0 : pskrDepth(speed);
}

/** The mode's name as fldigi and ADIF have it: PSK63F, PSK125R, PSK250R, PSK500R. */
export function pskrName(speed: number): string {
  return speed === 63 ? "PSK63F" : `PSK${speed}R`;
}

export interface PskrSymbolOptions {
  speed: PskrSpeed;
  /** Interleaver depth; default pskrDepth(speed). 0 is no interleaver: PSK63F at speed 63. */
  depth?: number;
  /** Preamble length in symbols, rounded to whole 1-0 bit pairs (four symbols). Default 2 x dcdbits, fldigi's. */
  preambleSymbols?: number;
  /** Postamble length in symbols, rounded to whole bits (two symbols). Default 2 x dcdbits, fldigi's. */
  tailSymbols?: number;
}

/**
 * The PSK-R transmitter's bit path: data bits in, BPSK symbol bits out (1 = no change,
 * 0 = reversal), two a data bit. A fresh one is fldigi's after clearbits().
 */
export class PskrEncoder {
  private readonly enc = new ConvEncoder(PSKR_K, PSKR_POLY1, PSKR_POLY2);
  private readonly inlv: Interleaver;

  constructor(depth: number) {
    this.inlv = new Interleaver(PSKR_INTERLEAVE_SIZE, depth, "fwd");
  }

  /** tx_bit (psk/psk.cxx:2324-2345): the two symbols for one data bit, the order they are sent. */
  bit(b: number): [number, number] {
    const e = this.inlv.bits(this.enc.encode(b));
    return [e & 1, (e >> 1) & 1];
  }
}

/** A line as PSK-R symbol bits: preamble, NUL, the text, postamble. See the header. */
export function pskrSymbols(text: string, opts: PskrSymbolOptions): number[] {
  const dcd = pskrDcdBits(opts.speed);
  const depth = opts.depth ?? pskrDepth(opts.speed);
  const prePairs = Math.max(0, Math.round((opts.preambleSymbols ?? 2 * dcd) / 4));
  const tailBits = Math.max(0, Math.round((opts.tailSymbols ?? 2 * dcd) / 2));
  const enc = new PskrEncoder(depth);
  const out: number[] = [];
  const send = (b: number) => out.push(...enc.bit(b));
  for (let i = 0; i < prePairs; i++) {
    send(1);
    send(0);
  }
  for (const c of mfskVaricodeFor(0)) send(c === "1" ? 1 : 0);
  for (const b of mfskEncodeText(text)) send(b);
  for (let i = 0; i < tailBits; i++) send(1);
  return out;
}

/** The Viterbi decoder's traceback: fldigi's default, twelve constraint lengths (filters/viterbi.cxx viterbi::init). */
const PSKR_TRACEBACK = PSKR_K * 12;

/**
 * Symbols from a data bit's first code bit on the air to the decoder handing the bit out:
 * the de-interleaver holds the first-sent row `depth` pairs (fec.ts Interleaver) and the
 * decoder looks `PSKR_TRACEBACK` pairs further on. 2 x (40 + 84) = 248 at PSK125R, about
 * two seconds; 2 x (160 + 84) = 488 at PSK500R, about one.
 */
export function pskrDelaySymbols(depth: number): number {
  return 2 * (depth + PSKR_TRACEBACK);
}

/**
 * The end of an over. fldigi's postamble is a steady carrier (see the header) for at least
 * 74 symbols (PSK63R) and up to 690 (PSK500R) once the interleaver has emptied of text; text
 * through the code and interleaver never keys more than 22 in a row (random bytes, every
 * speed). A score that gains 1 for each no-change symbol and loses 3 for anything else
 * reaches this only on the postamble, and still does with one symbol in ten wrong.
 */
const CARRIER_SCORE = 48;
const CARRIER_PENALTY = 3;
/**
 * Symbols the squelch must stay shut before a postamble stops holding it: as the phase
 * average falls through the threshold after a carrier, noise flicks it back over for a
 * symbol or two, and each flick printed a character.
 */
const END_RELEASE = 64;

/** One of fldigi's two decoders: a de-interleaver, a Viterbi decoder and a Varicode register. */
class Lane {
  readonly inlv: Interleaver;
  readonly dec = new ViterbiDecoder(PSKR_K, PSKR_POLY1, PSKR_POLY2);
  readonly varicode = new MfskVaricodeDecoder();
  /** fldigi's fecmet / fecmet2: the path metric per traceback, decayavg over 20 (psk.cxx:1267, :1286). */
  fecmet = 0;
  private readonly pair = new Uint8Array(2);
  /** Bits since the last code ended, counting the 1 that began this one. */
  private codeBits = 0;
  private utf8 = new TextDecoder("utf-8");

  constructor(depth: number) {
    this.inlv = new Interleaver(PSKR_INTERLEAVE_SIZE, depth, "rev");
    this.dec.setTraceback(PSKR_TRACEBACK);
    this.dec.setChunkSize(PSKR_CHUNK);
  }

  reset(): void {
    this.inlv.flush();
    this.dec.reset();
    this.varicode.reset();
    this.fecmet = 0;
    this.codeBits = 0;
    this.utf8 = new TextDecoder("utf-8");
  }

  /**
   * One decoded bit through the Varicode register: the text it completes, "" for none, or
   * null for a code no character has. A "code" longer than any is not counted: it is the
   * preamble's 1 0 1 0 (with the NUL that ends it), which no character was ever sent as -
   * fldigi's varidec() finds nothing for it and prints nothing (psk.cxx:1121-1131).
   */
  bit(b: number): string | null {
    this.codeBits++;
    const c = this.varicode.pushBitByte(b);
    if (c === -1) return "";
    const len = this.codeBits - 1;
    this.codeBits = 1;
    if (c === -2) return len > MFSK_MAX_CODE_BITS ? "" : null;
    // As MfskVaricodeDecoder: LF is the newline, other control characters print nothing.
    if (c === 10) return "\n";
    if (c < 32 || c === 127) return "";
    return this.utf8.decode(Uint8Array.of(c), { stream: true });
  }

  /**
   * A pair of soft symbols, the later first as psk.cxx:1254-1255 and 1276-1277 hold them.
   * Returns the four bits decoded (oldest in bit 3) or -1.
   */
  feed(later: number, earlier: number): number {
    const p = this.pair;
    p[0] = later;
    p[1] = earlier;
    this.inlv.symbols(p);
    // Reversed into the decoder (psk.cxx:1259-1261): the first polynomial's bit is p[1].
    const c = this.dec.decode(p[1]!, p[0]!);
    if (c >= 0) this.fecmet += (this.dec.metric - this.fecmet) / 20;
    return c;
  }
}

/**
 * Everything after the soft decision: soft symbols in (0 surely a reversal, 255 surely no
 * change, 128 nothing known), characters out, through fldigi's two de-interleavers and
 * decoders and the vote between them (see the header), and the squelch.
 *
 * THE SQUELCH. A character comes out of the decoder a second or two after its bits were on
 * the air (pskrDelaySymbols), so whether the squelch was open NOW says little about it: at
 * the start of a signal the decoder first hands out bits from before the transmission (the
 * de-interleaver starts empty), and at the end it hands out noise for a second or two after
 * the carrier has gone while a quality average is still falling. fldigi prints both when its
 * DCD is open. Here the squelch's verdict for each symbol is kept for exactly that delay and
 * a character prints if the squelch was open when its bits were sent. The postamble's long
 * steady carrier closes it for everything after (fldigi's BPSK DCD-off, which it does not
 * use for PSK-R, moved to where the bits are), until the squelch has stayed closed on its own or a
 * preamble starts (fldigi's PSK-R DCD-on patterns, 0x0A0A0A0A and its shifts, psk.cxx:1624-
 * 1633: the 1100 cycle the 1-0 preamble keys, sixteen symbols of it).
 */
export class PskrReceiver {
  private readonly lanes: [Lane, Lane];
  private prevSym = PUNCTURE;
  /** fldigi's rxbitstate: which decoder this symbol completes a pair for. */
  private state = 0;
  private dropped = 0;
  /** The squelch's verdict for each of the last `delay` symbols, as they were on the air. */
  private readonly line: Uint8Array;
  private head = 0;
  /** Since the last symbol that was not part of a steady run; see CARRIER_SCORE. */
  private carrierScore = 0;
  /** Symbols in all, and the count at which the current steady run began. */
  private count = 0;
  private carrierFrom = 0;
  /** A postamble has been seen: closed until the squelch stays closed or a preamble starts. */
  private ended = false;
  private closedRun = 0;
  /** The last sixteen hard decisions, newest in bit 0, 1 for no change. */
  private hard = 0;
  private hardCount = 0;
  private gate = false;

  constructor(readonly depth: number) {
    // [0] is fldigi's dec / Rxinlv / rx_bit, [1] its dec2 / Rxinlv2 / rx_bit2.
    this.lanes = [new Lane(depth), new Lane(depth)];
    this.line = new Uint8Array(pskrDelaySymbols(depth));
  }

  reset(): void {
    for (const l of this.lanes) l.reset();
    this.prevSym = PUNCTURE;
    this.state = 0;
    this.dropped = 0;
    this.line.fill(0);
    this.head = 0;
    this.carrierScore = 0;
    this.count = 0;
    this.carrierFrom = 0;
    this.ended = false;
    this.closedRun = 0;
    this.hard = 0;
    this.hardCount = 0;
    this.gate = false;
  }

  /** Codes dropped as unknown, counted while the characters around them were printing. */
  get errors(): number {
    return this.dropped;
  }

  /** Whether a character decoded now would print: the squelch as it was when its bits were sent. */
  get open(): boolean {
    return this.gate;
  }

  /** The decoder the vote favours: fldigi prints dec's characters when fecmet >= fecmet2. */
  private get winner(): Lane {
    return this.lanes[0].fecmet >= this.lanes[1].fecmet ? this.lanes[0] : this.lanes[1];
  }

  /** The squelch's verdict for this symbol, given whether the demodulator's squelch is open. */
  private verdict(s: number, squelchOpen: boolean, holdEnd: boolean): number {
    const n = this.line.length;
    // Steady carrier: the postamble. Once its score is reached, close back to where it began.
    if (s > PUNCTURE) {
      if (this.carrierScore === 0) this.carrierFrom = this.count;
      this.carrierScore++;
    } else {
      this.carrierScore = Math.max(0, this.carrierScore - CARRIER_PENALTY);
    }
    if (holdEnd && this.carrierScore >= CARRIER_SCORE && !this.ended) {
      this.ended = true;
      const back = Math.min(n, this.count - this.carrierFrom);
      for (let i = 1; i <= back; i++) this.line[(this.head - i + n) % n] = 0;
    }
    // The preamble: sixteen symbols of the 1100 cycle, in any of its four phases.
    if (s !== PUNCTURE) {
      this.hard = ((this.hard << 1) | (s > PUNCTURE ? 1 : 0)) & 0xffff;
      this.hardCount++;
    } else {
      this.hardCount = 0;
    }
    const preamble = this.hardCount >= 16 && (this.hard === 0xcccc || this.hard === 0x6666 || this.hard === 0x3333 || this.hard === 0x9999);
    this.closedRun = squelchOpen ? 0 : this.closedRun + 1;
    if (this.ended && (preamble || this.closedRun >= END_RELEASE)) this.ended = false;
    this.count++;
    return squelchOpen && !this.ended && s !== PUNCTURE ? 1 : 0;
  }

  /**
   * One soft symbol, and whether the squelch is open on it (the demodulator's quality against
   * its setting). `holdEnd` false lets everything after a postamble through: the squelch
   * switched off. Returns the text completed, "" for none.
   */
  push(soft: number, squelchOpen: boolean, holdEnd = true): string {
    const s = Math.max(0, Math.min(255, Math.round(soft)));
    // The verdict from `delay` symbols ago is read before this one overwrites it.
    this.gate = this.line[this.head] === 1;
    this.line[this.head] = this.verdict(s, squelchOpen, holdEnd);
    this.head = (this.head + 1) % this.line.length;
    const earlier = this.prevSym;
    this.prevSym = s;
    // rx_pskr: state 0 feeds dec2, state 1 dec, alternately (psk.cxx:1239-1286).
    const idx = this.state === 0 ? 1 : 0;
    this.state ^= 1;
    const lane = this.lanes[idx]!;
    const c = lane.feed(s, earlier);
    if (c < 0) return "";
    let out = "";
    for (let b = PSKR_CHUNK - 1; b >= 0; b--) {
      const ch = lane.bit((c >> b) & 1);
      // Voting at the character level (rx_bit / rx_bit2): this decoder's character prints
      // only while its average is the better. The other decoder's register keeps running.
      if (lane !== this.winner || !this.gate) continue;
      if (ch === null) this.dropped++;
      else out += ch;
    }
    return out;
  }
}
