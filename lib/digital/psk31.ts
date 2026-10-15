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
// get the short codes. 62.5 and 125 baud (BPSK63, BPSK125) are the same thing faster.
//
// The decoder is lib/digital/psk31demod.ts; scripts/check-psk31.ts runs the one through
// the other on generated signals, clean, offset and in noise.

import { PSK31_VARICODE } from "@/lib/digital/psk31-varicode";

export const PSK31_BAUD = 31.25;
/** The audio centre the mode chip tunes the decoder to. 1000 Hz, the long-standing convention. */
export const PSK31_CENTRE_HZ = 1000;
/** The longest Varicode is twelve bits; a run longer than that between separators is noise. */
export const PSK31_MAX_CODE_BITS = 12;

export type PskSpeed = 31 | 63 | 125;

export function pskBaud(speed: PskSpeed = 31): number {
  return speed === 125 ? 125 : speed === 63 ? 62.5 : PSK31_BAUD;
}

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
    const code = psk31CodeFor(ch);
    if (code) push(code);
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

  /** Codes dropped as too long or unknown. */
  get errors(): number {
    return this.dropped;
  }

  reset(): void {
    this.code = "";
    this.lastZero = false;
    this.carrier = false;
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
    return String.fromCharCode(i);
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
  speed?: PskSpeed;
  /** Idle (reversals) before the first character, in symbols, so the far end locks. Default 32. */
  preambleSymbols?: number;
  /** Steady carrier after the last character, in symbols. Default 32. */
  tailSymbols?: number;
  /** Peak amplitude. Default 1. */
  amplitude?: number;
}

/** The symbols a line sends, idle to steady carrier: preamble 0s, the text, a separator, tail 1s. */
export function psk31Symbols(text: string, opts: Partial<Psk31WaveformOptions> = {}): number[] {
  const pre = opts.preambleSymbols ?? 32;
  const tail = opts.tailSymbols ?? 32;
  const bits: number[] = [];
  for (let i = 0; i < pre; i++) bits.push(0);
  bits.push(...psk31EncodeText(text));
  for (let i = 0; i < tail; i++) bits.push(1);
  return bits;
}

/**
 * The audio for a line of text.
 *
 * Differential: symbol k has phase s_k = s_{k-1} for a 1 and -s_{k-1} for a 0, with s = +1
 * before the first. Between the centres of two consecutive symbols the baseband is the
 * constant s when they agree and s_k cos(pi t / T) when they differ, which passes through
 * zero at the boundary and arrives at s_{k+1} - the G3PLX envelope. The first half symbol
 * and the last ramp from and to zero so the carrier never starts or stops with a click.
 */
export function psk31Waveform(text: string, opts: Psk31WaveformOptions): Float32Array {
  const fs = opts.sampleRate;
  const baud = pskBaud(opts.speed ?? 31);
  const T = fs / baud;
  const fc = opts.centreHz ?? PSK31_CENTRE_HZ;
  const amp = opts.amplitude ?? 1;
  const bits = psk31Symbols(text, opts);
  const n = bits.length;

  // Phase per symbol, +1 / -1.
  const s = new Int8Array(n);
  let p = 1;
  for (let k = 0; k < n; k++) {
    if (!bits[k]) p = -p;
    s[k] = p;
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
    let base: number;
    if (k < 0) {
      // Rising half cosine from zero into the first symbol's centre.
      base = s[0]! * Math.sin((Math.PI / 2) * (1 + u * 2)) ;
      if (u < -0.5) base = 0;
    } else if (k >= n - 1) {
      // Falling half cosine from the last centre to zero.
      base = frac <= 0.5 ? s[n - 1]! * Math.cos(Math.PI * frac) : 0;
    } else {
      const a = s[k]!;
      const b = s[k + 1]!;
      base = a === b ? a : a * Math.cos(Math.PI * frac);
    }
    out[i] = amp * base * Math.cos(phase);
    phase += dphi;
    if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
  }
  return out;
}

export function psk31DurationMs(text: string, opts: Partial<Psk31WaveformOptions> = {}): number {
  const baud = pskBaud(opts.speed ?? 31);
  return (psk31Symbols(text, opts).length / baud) * 1000;
}
