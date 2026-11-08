// PSK31: the code and the waveform.
//
// PSK31 (Peter Martinez G3PLX, 1998) is binary phase-shift keying at 31.25 baud: one
// carrier, a phase reversal for a 0 and no change for a 1, so a receiver needs only the
// difference between consecutive symbols and never the absolute phase. The envelope is
// shaped so a reversal happens at zero amplitude - between two symbol centres of opposite
// phase the amplitude follows a half cosine through zero - which is what keeps a PSK31
// signal inside about 60 Hz, and why an idle line (all 0s, a reversal every symbol) looks
// like two tones 31.25 Hz apart. Characters are Varicode: every code starts and ends with
// a 1 and never holds two 0s in a row, so "00" is the separator and the common letters
// get the short codes. 62.5 to 500 baud (BPSK63, 125, 250, 500) are the same thing faster.
//
// QPSK (option qpsk) sends the same Varicode through a K=5 convolutional code, one of four
// phase changes a symbol; the code and its decoder are lib/digital/qpsk.ts.
//
// PSK-R (option pskr) is BPSK on the air keyed by MFSK Varicode through a K=7 code and an
// interleaver, fldigi's PSK125R, 250R and 500R; the bit path is lib/digital/pskr.ts.
//
// The decoder is lib/digital/psk31demod.ts; scripts/check-psk31.ts runs the one through
// the other on generated signals, clean, offset and in noise.

import { PSK31_VARICODE } from "@/lib/digital/psk31-varicode";
import { QpskEncoder, qpskPhaseChange } from "@/lib/digital/qpsk";
import { isPskrSpeed, pskrDcdBits, pskrSymbols } from "@/lib/digital/pskr";

export const PSK31_BAUD = 31.25;
/** The audio centre the mode chip tunes the decoder to. 1000 Hz, the long-standing convention. */
export const PSK31_CENTRE_HZ = 1000;
/** The longest Varicode is twelve bits; a run longer than that between separators is noise. */
export const PSK31_MAX_CODE_BITS = 12;

/**
 * The speed by its name: BPSK31, 63, 125, 250, 500 (or QPSK at the same baud). fldigi
 * runs them all at 8 kHz with 256, 128, 64, 32 and 16 samples a symbol (psk/psk.cxx:384-447),
 * which is 31.25, 62.5, 125, 250 and 500 baud. Everything here takes any of them.
 */
export type AnyPskSpeed = 31 | 63 | 125 | 250 | 500;

/** Every speed, as the app plumbs it: the picker, the bridge, the pipeline and the transmit request. */
export type PskSpeed = AnyPskSpeed;

export const PSK_SPEEDS: readonly AnyPskSpeed[] = [31, 63, 125, 250, 500];

export function pskBaud(speed: AnyPskSpeed = 31): number {
  switch (speed) {
    case 500:
      return 500;
    case 250:
      return 250;
    case 125:
      return 125;
    case 63:
      return 62.5;
    default:
      return PSK31_BAUD;
  }
}

/** Whether a number from a setting or a request is one of the speeds. */
export function isPskSpeed(n: unknown): n is AnyPskSpeed {
  return typeof n === "number" && (PSK_SPEEDS as readonly number[]).includes(n);
}

const UTF8 = new TextEncoder();

const BY_CODE = new Map<string, number>();
for (let i = 0; i < PSK31_VARICODE.length; i++) BY_CODE.set(PSK31_VARICODE[i]!, i);

/** The Varicode bits for one character, or null for one the table does not have. */
export function psk31CodeFor(ch: string): string | null {
  const c = ch.charCodeAt(0);
  if (!Number.isFinite(c) || c > 255) return null;
  return PSK31_VARICODE[c] ?? null;
}

/** The character for a Varicode, or null when no character has it. */
export function psk31CharFor(code: string): string | null {
  const i = BY_CODE.get(code);
  return i === undefined ? null : String.fromCharCode(i);
}

/**
 * A line of text as the bit stream a PSK31 transmitter sends: each character's code and
 * then the "00" separator. A newline goes as CR LF, as the keyboard programs send it;
 * characters outside the table are left out.
 */
export function psk31EncodeText(text: string): number[] {
  const bits: number[] = [];
  const push = (code: string) => {
    for (const b of code) bits.push(b === "1" ? 1 : 0);
    bits.push(0, 0);
  };
  for (const ch of text) {
    if (ch === "\n") {
      push(PSK31_VARICODE[13]!);
      push(PSK31_VARICODE[10]!);
      continue;
    }
    if (ch === "\r") continue;
    // As UTF-8 bytes, which is what fldigi sends: an accented letter is two codes. ASCII
    // is one byte and its own code, as before.
    for (const byte of UTF8.encode(ch)) {
      const code = PSK31_VARICODE[byte];
      if (code) push(code);
    }
  }
  return bits;
}

/**
 * Bits in, characters out. The separator is two 0s; a run of 1s and single 0s between
 * separators is a code. A code no character has is dropped and counted, which is what an
 * empty channel produces in quantity; a run of 1s longer than any code is a steady
 * carrier and is simply not a character.
 */
export class Psk31VaricodeDecoder {
  private code = "";
  private lastZero = false;
  /** Inside a run of 1s longer than any code: a steady carrier, dropped until the next separator. */
  private carrier = false;
  private dropped = 0;
  /** Bytes to characters: fldigi sends UTF-8, so "é" arrives as two codes. */
  private utf8 = new TextDecoder("utf-8");

  /** Codes dropped as too long or unknown. */
  get errors(): number {
    return this.dropped;
  }

  reset(): void {
    this.code = "";
    this.lastZero = false;
    this.carrier = false;
    this.utf8 = new TextDecoder("utf-8");
  }

  /** One bit in; the character it completed, "" otherwise. CR is silent and LF is the newline. */
  push(bit: number): string {
    if (bit) {
      this.lastZero = false;
      if (this.carrier) return "";
      this.code += "1";
      // Longer than any code: a steady carrier, which is how a transmission ends and how
      // some operators idle. Not an error; it just is not a character, and nor is the
      // rest of the run up to the next separator.
      if (this.code.length > PSK31_MAX_CODE_BITS + 1) {
        this.code = "";
        this.carrier = true;
      }
      return "";
    }
    if (!this.lastZero) {
      // A single 0 may be inside a code; it is only a separator if another follows.
      this.lastZero = true;
      return "";
    }
    // Two 0s: whatever came before them (without the first 0) is the code.
    const code = this.code;
    this.code = "";
    this.lastZero = false;
    if (this.carrier) {
      this.carrier = false;
      return "";
    }
    if (code === "") return "";
    const i = BY_CODE.get(code);
    if (i === undefined) {
      this.dropped++;
      return "";
    }
    if (i === 13) return "";
    if (i === 10) return "\n";
    // A half-received UTF-8 character gives "" until its last byte; a byte that cannot
    // start or continue one (an old Latin-1 sender) prints as the replacement mark.
    return this.utf8.decode(Uint8Array.of(i), { stream: true });
  }

  /** As push, with the single 0 inside a code kept: this is the bit before a 1 arrives. */
  pushBit(bit: number): string {
    if (bit && this.lastZero) {
      // The 0 before this 1 was inside the code - unless the code has not begun, when it
      // was the tail of the idle between characters: no code starts with 0.
      if (this.code !== "" && !this.carrier) this.code += "0";
      this.lastZero = false;
    }
    return this.push(bit);
  }
}

export interface Psk31WaveformOptions {
  sampleRate: number;
  /** Carrier, Hz audio. Default 1000. */
  centreHz?: number;
  speed?: AnyPskSpeed;
  /** QPSK rather than BPSK: the Varicode through the K=5 code, four phases. Default false. */
  qpsk?: boolean;
  /** QPSK only: fldigi's "reverse", the phase changes mirrored, for a sideband that mirrors the audio. Default false. */
  reverse?: boolean;
  /**
   * PSK-R rather than plain BPSK: MFSK Varicode through the K=7 code and the interleaver,
   * keyed as BPSK (lib/digital/pskr.ts). Speeds 63, 125, 250 and 500; 31 throws. Default false.
   */
  pskr?: boolean;
  /** PSK-R only: the interleaver depth, default fldigi's for the speed. 0 at speed 63 is fldigi's PSK63F. */
  pskrDepth?: number;
  /**
   * Idle (reversals) before the first character, in symbols, so the far end locks. Default
   * fldigi's dcdbits: 32 at PSK31, 64, 128, 256, 512 at PSK500. PSK-R: 1-0 data bits through
   * the code, default twice dcdbits (two symbols a bit).
   */
  preambleSymbols?: number;
  /** After the last character, in symbols: steady carrier for BPSK, the encoder flushed with 0s (reversals) for QPSK, 1 bits through the code (steady carrier) for PSK-R. Default as the preamble. */
  tailSymbols?: number;
  /** Peak amplitude. Default 1. */
  amplitude?: number;
}

/**
 * The symbols a line sends. BPSK: one bit a symbol, 1 for no change and 0 for a reversal -
 * preamble 0s, the text, tail 1s (steady carrier). QPSK: one dibit a symbol, the phase
 * change being 180 + 90 d degrees (see lib/digital/qpsk.ts) - preamble reversals (dibit 0,
 * not through the encoder), then the text and tail 0 bits through the encoder.
 */
export function psk31Symbols(text: string, opts: Partial<Psk31WaveformOptions> = {}): number[] {
  // fldigi's dcdbits, the preamble and the postamble alike (psk/psk.cxx:384-447, tx_process,
  // tx_flush): 32 symbols at PSK31, doubling with the speed to 512 at PSK500 - the same
  // time on the air at every speed. A fixed 32 was a quarter of a second at PSK125, too
  // short for fldigi to open its squelch and settle before the first character.
  if (opts.pskr) {
    // Two symbols a data bit, and fldigi sends dcdbits data bits at each end (pskr.ts).
    const speed = opts.speed ?? 31;
    if (!isPskrSpeed(speed)) throw new RangeError(`PSK-R has no ${speed}-baud mode (63, 125, 250 or 500)`);
    return pskrSymbols(text, {
      speed,
      depth: opts.pskrDepth,
      preambleSymbols: opts.preambleSymbols ?? 2 * pskrDcdBits(speed),
      tailSymbols: opts.tailSymbols ?? 2 * pskrDcdBits(speed),
    });
  }
  const scale = pskBaud(opts.speed ?? 31) / PSK31_BAUD;
  const pre = opts.preambleSymbols ?? Math.round(32 * scale);
  const tail = opts.tailSymbols ?? Math.round(32 * scale);
  const out: number[] = [];
  const bits = psk31EncodeText(text);
  if (opts.qpsk) {
    // Preamble: tx_symbol(0) straight, a reversal (psk/psk.cxx tx_process). The text and
    // the postamble go through the encoder, which starts at zero (see qpsk.ts).
    for (let i = 0; i < pre; i++) out.push(0);
    const enc = new QpskEncoder();
    for (const b of bits) out.push(enc.encode(b));
    for (let i = 0; i < tail; i++) out.push(enc.encode(0));
    return out;
  }
  for (let i = 0; i < pre; i++) out.push(0);
  out.push(...bits);
  for (let i = 0; i < tail; i++) out.push(1);
  return out;
}

/**
 * The audio for a line of text.
 *
 * Differential: symbol k has phase s_k = s_{k-1} for a 1 and -s_{k-1} for a 0, with s = +1
 * before the first. Between the centres of two consecutive symbols the baseband is the
 * constant s when they agree and s_k cos(pi t / T) when they differ, which passes through
 * zero at the boundary and arrives at s_{k+1} - the G3PLX envelope. The first half symbol
 * and the last ramp from and to zero so the carrier never starts or stops with a click.
 *
 * QPSK is the same envelope on a complex baseband: between centres the vector moves from
 * one symbol's to the next's with the same raised-cosine weight (fldigi's tx_shape,
 * psk/psk.cxx tx_carriers), so a reversal still passes through zero and a quarter turn
 * dips to 0.71. The audio is Re(z e^{jwt}): its phase is the symbol's.
 */
export function psk31Waveform(text: string, opts: Psk31WaveformOptions): Float32Array {
  const fs = opts.sampleRate;
  const baud = pskBaud(opts.speed ?? 31);
  const T = fs / baud;
  const fc = opts.centreHz ?? PSK31_CENTRE_HZ;
  const amp = opts.amplitude ?? 1;
  const syms = psk31Symbols(text, opts);
  const n = syms.length;

  // The symbol vector, unit length. BPSK (and PSK-R): +1 / -1. QPSK: the phase turned by each dibit.
  const sI = new Float64Array(n);
  const sQ = new Float64Array(n);
  if (opts.qpsk) {
    let theta = 0;
    for (let k = 0; k < n; k++) {
      theta += qpskPhaseChange(syms[k]!, opts.reverse);
      // Snap to the exact quarter so 0 and 180 stay exactly real over a long line.
      const q = ((Math.round(theta / (Math.PI / 2)) % 4) + 4) % 4;
      sI[k] = [1, 0, -1, 0][q]!;
      sQ[k] = [0, 1, 0, -1][q]!;
    }
  } else {
    let p = 1;
    for (let k = 0; k < n; k++) {
      if (!syms[k]) p = -p;
      sI[k] = p;
    }
  }

  const total = Math.round(n * T);
  const out = new Float32Array(total);
  const dphi = (2 * Math.PI * fc) / fs;
  let phase = 0;
  for (let i = 0; i < total; i++) {
    // Which pair of symbol centres is this sample between? Centre k is at (k + 0.5) T.
    const u = i / T - 0.5;
    const k = Math.floor(u);
    const frac = u - k;
    let bI: number;
    let bQ: number;
    if (k < 0) {
      // Rising half cosine from zero into the first symbol's centre.
      const g = u < -0.5 ? 0 : Math.sin((Math.PI / 2) * (1 + u * 2));
      bI = sI[0]! * g;
      bQ = sQ[0]! * g;
    } else if (k >= n - 1) {
      // Falling half cosine from the last centre to zero.
      const g = frac <= 0.5 ? Math.cos(Math.PI * frac) : 0;
      bI = sI[n - 1]! * g;
      bQ = sQ[n - 1]! * g;
    } else {
      // From centre k to centre k+1: weight w rises 0 to 1 as a raised cosine. For BPSK
      // this is the old a cos(pi frac) between opposite symbols and a constant otherwise.
      const w = 0.5 - 0.5 * Math.cos(Math.PI * frac);
      bI = sI[k]! * (1 - w) + sI[k + 1]! * w;
      bQ = sQ[k]! * (1 - w) + sQ[k + 1]! * w;
    }
    // Re((bI + j bQ) e^{j phase}).
    out[i] = amp * (bI * Math.cos(phase) - bQ * Math.sin(phase));
    phase += dphi;
    if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
  }
  return out;
}

export function psk31DurationMs(text: string, opts: Partial<Psk31WaveformOptions> = {}): number {
  const baud = pskBaud(opts.speed ?? 31);
  return (psk31Symbols(text, opts).length / baud) * 1000;
}
