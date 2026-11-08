// Thor: the code and the waveform.
//
// Thor (Dave Freese W1HKJ, with John Douyere VK2ETA and John Phelps KL4YFD, 2008) is
// DominoEX's keying with error correction underneath. The tones are DominoEX's: 18 of
// them, keyed by incremental frequency keying (IFK+), where a symbol is the step from the
// last tone, the four-bit value plus two, wrapping round the 18 - so tuning hardly matters
// and an echo of the last tone is never this one. What the four bits carry is different.
// The text is MFSK's Varicode (lib/digital/mfsk-varicode.ts) extended with a second
// alphabet in the twelve-bit codes MFSK leaves unused; the Varicode bits go through a
// rate-1/2 convolutional code and fldigi's diagonal interleaver (lib/digital/fec.ts), four
// code bits to a symbol. A symbol lost to static costs scattered code bits the Viterbi
// decoder puts back, which DominoEX cannot do; the price is half the text speed at the
// same baud.
//
// The submodes, from fldigi's constructor (thor.cxx:217-351):
//
//   Thor 4, 5, 8, 11, 16, 22 have DominoEX's speeds and spacing - 4, 5 and 8 "double
//   spaced", their tones two baud apart - and the NASA K=7 code (thor.h:43-45: 0x6d, 0x4f,
//   the same pair MFSK uses) with a ten-stage interleaver. NBEMS uses Thor 22 and 11.
//
//   Thor 25x4, 50x1, 50x2 and 100 are VK2ETA's fast modes for ARQ: 25 to 100 baud, the
//   tones one, two or four baud apart, a K=15 code (thor.h:49-51: 044735, 063057) and a
//   fifty-stage interleaver, about two seconds at 25 baud.
//
// fldigi works each one at 8000 or 11025 Hz with a whole number of samples a symbol. This
// port generates and reads at the rate it is given (12, 24 or 48 kHz) on an exact time
// grid, so the 11025 Hz submodes' fractional symbols do not drift.
//
// What goes on the air, per tx_process (thor.cxx:1313-1393), with fldigi's defaults:
// sixteen raw symbols of value 0 (the preamble: a ladder of steps of two tones, which the
// receiver recognises and clears its decoder on), an idle (a NUL), CR STX CR, the text,
// CR EOT CR, then `flushlength` idles - enough to push the last bits out of the far end's
// interleaver - and, with "soft start/stop" on (softTHOR, on by default), a tail of the
// lowest tone faded out. The level rises over the first ~100 ms the same way, and every
// symbol has 4 ms raised-cosine edges (THOR_RISETIME, sendtone, thor.cxx:1206-1231). The
// tone set is centred on the operator's frequency, as DominoEX's is.
//
// The decoder is lib/digital/thordemod.ts; scripts/check-thor.ts runs one through the
// other and checks the first tones against a sequence worked by hand from fldigi's code.

import { ConvEncoder, Interleaver, NASA_K, NASA_POLY1, NASA_POLY2 } from "@/lib/digital/fec";
import { MFSK_VARICODE, mfskTextBytes, mfskVaricodeFor } from "@/lib/digital/mfsk-varicode";

/** THORNUMTONES, thor.h:59. */
export const THOR_TONES = 18;
/** The audio centre the mode chip tunes the decoder to: fldigi's PSK sweet spot. */
export const THOR_CENTRE_HZ = 1500;
/** The long code of the fast submodes: THOR_K15, K15_POLY1, K15_POLY2 (thor.h:49-51). */
export const THOR_K15 = 15;
export const THOR_K15_POLY1 = 0o44735;
export const THOR_K15_POLY2 = 0o63057;

export type ThorMode = "4" | "5" | "8" | "11" | "16" | "22" | "25x4" | "50x1" | "50x2" | "100";

/** The submodes, slowest first: what the mode picker offers. */
export const THOR_MODES: readonly ThorMode[] = ["4", "5", "8", "11", "16", "22", "25x4", "50x1", "50x2", "100"];

export interface ThorParams {
  mode: ThorMode;
  /** fldigi's internal sample rate for this submode, Hz. */
  baseRate: 8000 | 11025;
  /** Symbol length at that rate, samples. */
  symbolLen: number;
  /** The tone spacing in baud: 1, 2 or 4 (fldigi's `doublespaced`). */
  doubleSpaced: 1 | 2 | 4;
  /** Interleaver stages (idepth). Its size is always 4: one row per bit of a symbol. */
  depth: number;
  /** Idles sent after the over to flush the far end (flushlength). */
  flushLength: number;
  /** The convolutional code: constraint length and the two polynomials. */
  k: number;
  poly1: number;
  poly2: number;
  /** How far back the receiver's Viterbi decoder reads (settraceback). */
  traceback: number;
  baud: number;
  toneSpacingHz: number;
  /** Eighteen tone spacings: fldigi's `bandwidth`, which is also how the tone set is placed. */
  bandwidthHz: number;
}

interface Row {
  baseRate: 8000 | 11025;
  symbolLen: number;
  doubleSpaced: 1 | 2 | 4;
  depth: number;
  flushLength: number;
  long: boolean;
}

/**
 * The constructor's switch, thor.cxx:223-335. The defaults set before it (thor.cxx:223-225)
 * are an interleaver of size 4 and depth 10 and a flush of 4 idles; each case overrides
 * what it lists. Thor 25x4, 50x1, 50x2 and 100 take the K=15 code (thor.cxx:398-407).
 */
const TABLE: Record<ThorMode, Row> = {
  "4": { baseRate: 8000, symbolLen: 2048, doubleSpaced: 2, depth: 10, flushLength: 4, long: false }, // thor.cxx:267-271
  "5": { baseRate: 11025, symbolLen: 2048, doubleSpaced: 2, depth: 10, flushLength: 4, long: false }, // :229-234
  "8": { baseRate: 8000, symbolLen: 1024, doubleSpaced: 2, depth: 10, flushLength: 4, long: false }, // :273-277
  "11": { baseRate: 11025, symbolLen: 1024, doubleSpaced: 1, depth: 10, flushLength: 8, long: false }, // :236-242
  "16": { baseRate: 8000, symbolLen: 512, doubleSpaced: 1, depth: 10, flushLength: 8, long: false }, // :279-286
  "22": { baseRate: 11025, symbolLen: 512, doubleSpaced: 1, depth: 10, flushLength: 16, long: false }, // :244-250
  "25x4": { baseRate: 8000, symbolLen: 320, doubleSpaced: 4, depth: 50, flushLength: 40, long: true }, // :305-311
  "50x1": { baseRate: 8000, symbolLen: 160, doubleSpaced: 1, depth: 50, flushLength: 40, long: true }, // :313-319
  "50x2": { baseRate: 8000, symbolLen: 160, doubleSpaced: 2, depth: 50, flushLength: 40, long: true }, // :321-327
  "100": { baseRate: 8000, symbolLen: 80, doubleSpaced: 1, depth: 50, flushLength: 40, long: true }, // :329-335
};

export function thorParams(mode: ThorMode): ThorParams {
  const t = TABLE[mode];
  if (!t) throw new Error(`Thor ${mode} is not a submode`);
  const baud = t.baseRate / t.symbolLen;
  // tonespacing and bandwidth, thor.cxx:351-353.
  const toneSpacingHz = baud * t.doubleSpaced;
  return {
    mode,
    baseRate: t.baseRate,
    symbolLen: t.symbolLen,
    doubleSpaced: t.doubleSpaced,
    depth: t.depth,
    flushLength: t.flushLength,
    k: t.long ? THOR_K15 : NASA_K,
    poly1: t.long ? THOR_K15_POLY1 : NASA_POLY1,
    poly2: t.long ? THOR_K15_POLY2 : NASA_POLY2,
    // settraceback(15 * 12) for the long code, 45 otherwise (thor.cxx:402, 406).
    traceback: t.long ? 15 * 12 : 45,
    baud,
    toneSpacingHz,
    bandwidthHz: THOR_TONES * toneSpacingHz,
  };
}

/**
 * The frequency of tone 0 to 17 for a signal on `centreHz`. sendtone (thor.cxx:1209) puts
 * tone n at (n + 0.5) spacings above the frequency minus half the bandwidth: the tone set
 * is centred on the operator's frequency, tones 8 and 9 half a spacing either side of it.
 */
export function thorToneHz(tone: number, centreHz: number, mode: ThorMode): number {
  const p = thorParams(mode);
  return centreHz + (tone + 0.5) * p.toneSpacingHz - p.bandwidthHz / 2;
}

// ---------------------------------------------------------------------------------------
// The Varicode.

/**
 * The secondary alphabet, thorvaricode.cxx:39-131: twelve-bit codes for space to "z" in
 * the range MFSK's Varicode leaves free (every MFSK code reads below 0xB80 as a number).
 * fldigi sends it while the operator is not typing: usually its version string.
 */
const SECONDARY: readonly string[] = [
  "101110000000", "101110100000", "101110101000", "101110101100", "101110110000", "101110110100",
  "101110111000", "101110111100", "101111000000", "101111010000", "101111010100", "101111011000",
  "101111011100", "101111100000", "101111101000", "101111101100", "101111110000", "101111110100",
  "101111111000", "101111111100", "110000000000", "110100000000", "110101000000", "110101010100",
  "110101011000", "110101011100", "110101100000", "110101101000", "110101101100", "110101110000",
  "110101110100", "110101111000", "110101111100", "110110000000", "110110100000", "110110101000",
  "110110101100", "110110110000", "110110110100", "110110111000", "110110111100", "110111000000",
  "110111010000", "110111010100", "110111011000", "110111011100", "110111100000", "110111101000",
  "110111101100", "110111110000", "110111110100", "110111111000", "110111111100", "111000000000",
  "111010000000", "111010100000", "111010101100", "111010110000", "111010110100", "111010111000",
  "111010111100", "111011000000", "111011010000", "111011010100", "111011011000", "111011011100",
  "111011100000", "111011101000", "111011101100", "111011110000", "111011110100", "111011111000",
  "111011111100", "111100000000", "111101000000", "111101010000", "111101010100", "111101011000",
  "111101011100", "111101100000", "111101101000", "111101101100", "111101110000", "111101110100",
  "111101111000", "111101111100", "111110000000", "111110100000", "111110101000", "111110101100",
  "111110110000",
];
/** thorvaridec's dividing line (thorvaricode.cxx:185): below it, the MFSK table. */
const SECONDARY_FLOOR = 0xb80;

/** Code value to character: 0-255 primary, 256 + c for secondary c (fldigi's 0x100 flag). */
const BY_VALUE = new Map<number, number>();
for (let i = 0; i < MFSK_VARICODE.length; i++) BY_VALUE.set(parseInt(MFSK_VARICODE[i]!, 2), i);
for (let i = 0; i < SECONDARY.length; i++) BY_VALUE.set(parseInt(SECONDARY[i]!, 2), 0x100 + 32 + i);

/**
 * The Varicode bits for a byte: thorvarienc (thorvaricode.cxx:170-179). The primary
 * alphabet is MFSK's; the secondary covers space to "z", and anything else goes as a NUL.
 */
export function thorVaricodeFor(byte: number, secondary = false): string {
  const b = byte & 0xff;
  if (!secondary) return mfskVaricodeFor(b);
  if (b >= 32 && b <= 122) return SECONDARY[b - 32]!;
  return mfskVaricodeFor(0);
}

/**
 * A code read as a number to its character: 0-255 primary, 256-511 secondary, -1 for a
 * code no character has. thorvaridec (thorvaricode.cxx:181-193).
 */
export function thorCharForCode(value: number): number {
  return BY_VALUE.get(value) ?? -1;
}

/** A line of text as the bytes the transmitter sends: UTF-8 as fldigi sends it, a newline as CR LF. */
export function thorTextBytes(text: string): number[] {
  return mfskTextBytes(text);
}

/**
 * Bits in, characters out, as decodePairs reads them (thor.cxx:554-560): a register that
 * starts at 1, and whenever its last three bits are 001 everything before the final 1 is
 * a code. That 1 is the next code's first bit, so the register restarts at 1. A run of 0s
 * empties it (the code read is then 0, which no character has and is not counted).
 */
export class ThorVaricodeDecoder {
  private shreg = 1;

  reset(): void {
    this.shreg = 1;
  }

  /** One bit in. null: nothing completed; otherwise 0-511 as thorCharForCode, or -1 for a code no character has. */
  push(bit: number): number | null {
    // An unsigned int in fldigi: a run longer than 32 bits loses its top, as there.
    this.shreg = ((this.shreg << 1) | (bit ? 1 : 0)) >>> 0;
    if ((this.shreg & 7) !== 1) return null;
    const value = this.shreg >>> 1;
    this.shreg = 1;
    if (value === 0) return null;
    return thorCharForCode(value);
  }
}

// ---------------------------------------------------------------------------------------
// The transmitter.

/**
 * fldigi's transmit side with the audio left out: Varicode bits through the encoder, two
 * code bits a data bit (first polynomial first) gathered four to a symbol, through the
 * interleaver, and IFK+ on to a tone (sendchar, sendsymbol: thor.cxx:1233-1268).
 */
class ThorSymbolWriter {
  private readonly enc: ConvEncoder;
  private readonly inlv: Interleaver;
  private bitshreg = 0;
  private bitstate = 0;
  private prevTone = 0;
  readonly tones: number[] = [];

  constructor(p: ThorParams) {
    this.enc = new ConvEncoder(p.k, p.poly1, p.poly2);
    // Txinlv = new interleave(isize = 4, idepth, INTERLEAVE_FWD), thor.cxx:408.
    this.inlv = new Interleaver(4, p.depth, "fwd");
  }

  /** sendsymbol: the next tone is the last plus two plus the four-bit value, mod 18. */
  sendsymbol(sym: number): void {
    this.prevTone = (this.prevTone + 2 + sym) % THOR_TONES;
    this.tones.push(this.prevTone);
  }

  private pushCoded(data: number, send: boolean): void {
    for (let i = 0; i < 2; i++) {
      this.bitshreg = ((this.bitshreg << 1) | ((data >> i) & 1)) >>> 0;
      this.bitstate++;
      if (this.bitstate === 4) {
        const sym = this.inlv.bits(this.bitshreg & 0xf);
        if (send) this.sendsymbol(sym);
        this.bitstate = 0;
        this.bitshreg = 0;
      }
    }
  }

  sendchar(byte: number, secondary = false): void {
    for (const c of thorVaricodeFor(byte, secondary)) this.pushCoded(this.enc.encode(c === "1" ? 1 : 0), true);
  }

  /**
   * Clearbits (thor.cxx:1281-1295): the encoder's output for one 0, pushed 1400 times
   * through the interleaver without being sent. From a fresh start that fills it with 0s.
   * (fldigi keeps one encoder for the life of the modem, so from the second over on the
   * fill is whatever pair the encoder's state then gives; the receiver flushes on the
   * preamble either way, so it cannot tell.)
   */
  clearbits(): void {
    const data = this.enc.encode(0);
    for (let k = 0; k < 1400; k++) this.pushCoded(data, false);
  }

  /** flushtx's end: a part-filled symbol is dropped (bitstate = 0, thor.cxx:1308). */
  dropPartial(): void {
    this.bitstate = 0;
    this.bitshreg = 0;
  }
}

/** fldigi's SoftStart default, ms (configuration.h): the length of the soft start and stop. */
export const THOR_SOFT_START_MS = 100;
/** THOR_RISETIME's default, ms: the raised-cosine edge on every symbol. */
export const THOR_RISETIME_MS = 4;

export interface ThorSymbols {
  /** One tone (0-17) a symbol, from the first preamble symbol to the last flush symbol. */
  tones: number[];
  /** Symbols of the lowest tone sent after them while the level fades (softTHOR's tail). */
  tailSymbols: number;
}

/**
 * The tones a line sends, as fldigi's tx_process (thor.cxx:1313-1372) sends an over from a
 * fresh start: clearbits, sixteen symbols of value 0, an idle; CR STX CR; the text; CR EOT
 * CR; `flushLength` idles. fldigi's tx_init starts every over from tone 0 (thor.cxx:70),
 * so the preamble is the ladder 2 4 6 ... 16 0 2 ... 14.
 */
export function thorSymbols(text: string, opts: { mode: ThorMode }): ThorSymbols {
  const p = thorParams(opts.mode);
  const w = new ThorSymbolWriter(p);
  // TX_STATE_PREAMBLE
  w.clearbits();
  for (let j = 0; j < 16; j++) w.sendsymbol(0);
  w.sendchar(0); // sendidle: a primary NUL
  // TX_STATE_START
  w.sendchar(13);
  w.sendchar(2);
  w.sendchar(13);
  // TX_STATE_DATA
  for (const b of thorTextBytes(text)) w.sendchar(b);
  // TX_STATE_END
  w.sendchar(13);
  w.sendchar(4);
  w.sendchar(13);
  // TX_STATE_FLUSH: flushtx (thor.cxx:1297-1309)
  for (let i = 0; i < p.flushLength; i++) w.sendchar(0);
  w.dropPartial();
  // The softTHOR tail: sendtone(0, (samplerate * SoftStart / 1000) / symlen + 1), in
  // fldigi's integer arithmetic.
  const tailSymbols = Math.floor(Math.floor((p.baseRate * THOR_SOFT_START_MS) / 1000) / p.symbolLen) + 1;
  return { tones: w.tones, tailSymbols };
}

export interface ThorWaveformOptions {
  sampleRate: number;
  /** Centre of the tone set, Hz audio: the operator's frequency in fldigi. */
  centreHz: number;
  mode: ThorMode;
  /** Peak amplitude. Default 1. */
  amplitude?: number;
}

/** Samples at `fs` before symbol k starts: the symbol is fractional at 12/24/48 kHz for the 11025 Hz submodes. */
function symbolStart(k: number, fs: number, p: ThorParams): number {
  return Math.round((k * p.symbolLen * fs) / p.baseRate);
}

/**
 * The audio for a sequence of tones, followed by `tailSymbols` of tone 0: phase-continuous
 * (one oscillator whose rate changes, as sendtone's txphase), each symbol's first and last
 * 4 ms raised-cosine shaped (sendtone with THOR_RISETIME; the tail is one sendtone call, so
 * it is shaped only at its ends), the level rising over fldigi's soft-start length at the
 * start and falling over the tail (modem::ModulateXmtr's sig_start and sig_stop,
 * modem.cxx:611-636). Exported for tests that alter the tones.
 */
export function thorTonesWaveform(tones: readonly number[], tailSymbols: number, opts: ThorWaveformOptions): Float32Array {
  const fs = opts.sampleRate;
  const p = thorParams(opts.mode);
  const amp = opts.amplitude ?? 1;
  const nSym = tones.length + tailSymbols;
  const total = symbolStart(nSym, fs, p);
  const out = new Float32Array(total);
  // Lengths in fldigi's samples, converted to time: the rise is round(rate * 4 ms), and the
  // soft start and stop are ((rate * SoftStart / 1000) / symlen + 1) whole symbols.
  const riseS = Math.round((p.baseRate * THOR_RISETIME_MS) / 1000) / p.baseRate;
  const softSymbols = Math.floor(Math.floor((p.baseRate * THOR_SOFT_START_MS) / 1000) / p.symbolLen) + 1;
  const softS = (softSymbols * p.symbolLen) / p.baseRate;
  const symS = p.symbolLen / p.baseRate;
  const tailStartS = tones.length * symS;
  const tailEndS = nSym * symS;
  const edge = (x: number): number => 0.5 * (1 - Math.cos(Math.PI * x));
  let phase = 0;
  for (let k = 0; k < nSym; k++) {
    const tone = k < tones.length ? tones[k]! : 0;
    const dphi = (2 * Math.PI * thorToneHz(tone, opts.centreHz, opts.mode)) / fs;
    // The span sendtone shapes: one symbol, or the whole tail.
    const inTail = k >= tones.length;
    const from = inTail ? tailStartS : k * symS;
    const to = inTail ? tailEndS : (k + 1) * symS;
    const end = symbolStart(k + 1, fs, p);
    for (let i = symbolStart(k, fs, p); i < end; i++) {
      const t = i / fs;
      let g = 1;
      if (t - from < riseS) g = edge((t - from) / riseS);
      else if (to - t < riseS) g = edge((to - t) / riseS);
      if (t < softS) g *= edge(t / softS);
      if (inTail) g *= 1 - edge(Math.min(1, (t - tailStartS) / softS));
      out[i] = amp * g * Math.cos(phase);
      phase += dphi;
      if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
    }
  }
  return out;
}

/** The audio for a line of text: the whole over, as thorSymbols lays it out. */
export function thorWaveform(text: string, opts: ThorWaveformOptions): Float32Array {
  const { tones, tailSymbols } = thorSymbols(text, { mode: opts.mode });
  return thorTonesWaveform(tones, tailSymbols, opts);
}

/** How long a line takes on the air, ms, tail included. */
export function thorDurationMs(text: string, opts: { mode: ThorMode }): number {
  const p = thorParams(opts.mode);
  const { tones, tailSymbols } = thorSymbols(text, opts);
  return ((tones.length + tailSymbols) / p.baud) * 1000;
}
