// FSQ: the code and the waveform.
//
// FSQ ("Fast Simple QSO", Murray Greenman ZL1BPU and Con Wassilieff ZL2AFP, 2015) is the
// slow end of the IFK family: 33 tones, keyed by incremental frequency keying like
// DominoEX, but with the step rule cut down to "the last tone plus the nibble plus one,
// modulo 33". A nibble here is 0 to 31, so a step is 1 to 32 tones and never 0: the tone
// always moves, and the receiver reads only the difference between consecutive tones, so
// where the signal sits within a few tens of hertz does not matter. The tone set wraps -
// tone 32 plus a step of 2 is tone 1 - so 33 tones carry 32 steps.
//
// Characters are a two-level Varicode of those nibbles: the 29 commonest characters (space,
// a to z, full stop, newline) are one nibble, 0 to 28, and everything else is a first
// nibble 0 to 28 followed by a second of 29, 30 or 31. A character is only known to be a
// single-nibble one when the next nibble starts something new, which is why every over
// ends with a few characters of framing.
//
// The speeds differ only in symbol length. fldigi works FSQ at 12000 Hz with the tones on
// the bins of a 4096-point FFT three bins apart (fsq.h:41-43, `spacing = 3` at
// fsq.cxx:185), so the tones are 3 x 12000 / 4096 = 8.789 Hz apart at every speed, and the
// symbol is 8192, 6144, 4096, 3072 or 2048 samples (adjust_for_speed, fsq.cxx:322-338).
// The speeds are named by FSQCALL's nominal baud - 1.5, 2, 3, 4.5, 6 - but the true rates
// are 12000 over those: 1.46, 1.95, 2.93, 3.91 and 5.86 baud. This port generates and reads
// at the rate it is given (12, 24 or 48 kHz), where every one of those symbols is a whole
// number of samples.
//
// Tone placement follows set_freq (fsq.cxx:297-306): the lowest tone is the bin at or just
// above the operator's frequency less half the 290 Hz bandwidth, rounded down to a
// multiple of three bins, so the tones always fall on a fixed 8.789 Hz grid and the middle
// tone (16) sits 1.5 to 10 Hz below the frequency. On 1500 Hz the tones run from 1353.5 to
// 1634.8 Hz, the middle one on 1494.1.
//
// Ported from fldigi 4.2.13 (W1HKJ and others, GPL): src/fsq/fsq.cxx for the transmit
// sequence and the tone arithmetic, src/fsq/fsq_varicode.cxx for the Varicode,
// src/include/fsq.h for the constants. Image transfer (FSQ-pic) and the directed-message
// command layer (the `?`, `#`, `$` triggers and the rest) are not ported: the receiver
// prints what arrives, header and all.
//
// The decoder is lib/digital/fsqdemod.ts; scripts/check-fsq.ts runs one through the other.

/** 33 tones: `% 33` in send_symbol, fsq.cxx:1370. */
export const IFK33_TONES = 33;
/** fldigi's FSQ sample rate and the FFT length that sets the tone spacing: SR and FSQ_SYMLEN, fsq.h:41-43. */
export const FSQ_BASE_RATE = 12_000;
const FSQ_FFT = 4096;
/** Tones three FFT bins apart: `spacing = 3`, fsq.cxx:185. */
const FSQ_BIN_SPACING = 3;
/** 3 x 12000 / 4096 Hz. */
export const FSQ_TONE_SPACING_HZ = (FSQ_BIN_SPACING * FSQ_BASE_RATE) / FSQ_FFT;
/**
 * `bandwidth = 33 * spacing * samplerate / FSQ_SYMLEN` (rx_init, fsq.cxx:260), all ints in
 * fldigi, so 1188000 / 4096 truncates to 290. The tone set itself spans 32 spacings, 281 Hz.
 */
export const FSQ_BANDWIDTH_HZ = Math.trunc((IFK33_TONES * FSQ_BIN_SPACING * FSQ_BASE_RATE) / FSQ_FFT);
/** fldigi's default FSQ frequency: modem::set_freq(1500) in the constructor, and `txcenterfreq`. */
export const FSQ_CENTRE_HZ = 1500;

export type FsqSpeed = "1.5" | "2" | "3" | "4.5" | "6";

/** The speeds, slowest first: fldigi's five buttons (confdialog.cxx:14286-14306). */
export const FSQ_SPEEDS: readonly FsqSpeed[] = ["1.5", "2", "3", "4.5", "6"];

/** adjust_for_speed, fsq.cxx:322-338. */
const SYMLEN: Record<FsqSpeed, number> = { "1.5": 8192, "2": 6144, "3": 4096, "4.5": 3072, "6": 2048 };

export interface FsqParams {
  speed: FsqSpeed;
  /** Symbol length at 12000 Hz, samples. */
  symbolLen: number;
  /** The true rate: 12000 / symbolLen. */
  baud: number;
  toneSpacingHz: number;
  bandwidthHz: number;
}

export function fsqParams(speed: FsqSpeed): FsqParams {
  const symbolLen = SYMLEN[speed];
  if (!symbolLen) throw new Error(`FSQ ${speed} is not a speed`);
  return { speed, symbolLen, baud: FSQ_BASE_RATE / symbolLen, toneSpacingHz: FSQ_TONE_SPACING_HZ, bandwidthHz: FSQ_BANDWIDTH_HZ };
}

/**
 * The FFT bin of tone 0 for an operator's frequency: set_freq, fsq.cxx:297-306 -
 * ceil((f - bandwidth / 2) * 4096 / 12000), less its remainder modulo 3.
 */
export function fsqBaseBin(centreHz: number): number {
  const b = Math.ceil(((centreHz - FSQ_BANDWIDTH_HZ / 2) * FSQ_FFT) / FSQ_BASE_RATE);
  return b - (b % FSQ_BIN_SPACING);
}

/** The frequency of tone 0 to 32 for a signal on `centreHz`: send_tone, fsq.cxx:1349. */
export function fsqToneHz(tone: number, centreHz: number): number {
  return ((fsqBaseBin(centreHz) + tone * FSQ_BIN_SPACING) * FSQ_BASE_RATE) / FSQ_FFT;
}

/**
 * The FSQ Varicode, decoding side: fsq_varicode.cxx:46-76 (`wsq_varidecode`), which is
 * indexed by `prev * 32 + curr`. Only two parts of that 928-entry table are ever read:
 * entries 0-28, the single-nibble characters (read when a nibble under 29 follows one under
 * 29), and columns 29-31 of each row, the two-nibble ones. -1 is a code no character has;
 * 0 is NUL, which is what the idle (28 30) decodes to.
 */
const FSQ_SINGLE: readonly number[] = [
  32, 97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 122, 46, 10,
];
/** [prev] -> the characters for a second nibble of 29, 30 and 31. */
const FSQ_DOUBLE: readonly (readonly [number, number, number])[] = [
  [64, 126, 61], [65, 49, 91], [66, 50, 92], [67, 51, 93], [68, 52, 94], [69, 53, 95], [70, 54, 123], [71, 55, 124],
  [72, 56, 125], [73, 57, 96], [74, 48, 177], [75, 33, 247], [76, 34, 176], [77, 35, 215], [78, 36, 163], [79, 37, -1],
  [80, 38, -1], [81, 39, -1], [82, 40, -1], [83, 41, -1], [84, 42, -1], [85, 43, -1], [86, 45, -1], [87, 47, -1],
  [88, 58, -1], [89, 59, -1], [90, 60, -1], [44, 62, 8], [63, 0, 127],
];

/** A two-level IFK Varicode: the single-nibble characters and the two-nibble ones, as above. */
export interface Ifk33Varicode {
  single: readonly number[];
  double: readonly (readonly [number, number, number])[];
  /** The nibbles of the idle, sent for "no character". */
  idle: readonly number[];
}

export const FSQ_VARICODE: Ifk33Varicode = { single: FSQ_SINGLE, double: FSQ_DOUBLE, idle: [28, 30] };

/**
 * The encoding side, built by inverting the decoding tables. fldigi keeps it as its own
 * hand-written table (fsq_varicode[][2], fsq_varicode.cxx:1-34); for FSQ every entry that
 * table has for a character the decoder knows is exactly the inverse, which
 * scripts/check-fsq.ts checks against entries copied from it. Characters the decoder does
 * not know (CR, TAB, the other controls) are {0, 0} there - a space - and are not sent
 * here at all.
 */
export function ifk33EncodeTable(v: Ifk33Varicode): Map<number, number[]> {
  const m = new Map<number, number[]>();
  v.double.forEach((row, prev) => row.forEach((ch, i) => { if (ch > 0) m.set(ch, [prev, 29 + i]); }));
  v.single.forEach((ch, n) => { if (ch > 0) m.set(ch, [n]); });
  return m;
}

const FSQ_ENCODE = ifk33EncodeTable(FSQ_VARICODE);

/** The nibbles for one character code, or [] for one FSQ cannot send. 0 is the idle. */
export function fsqCodeFor(code: number): number[] {
  if (code === 0) return [...FSQ_VARICODE.idle];
  return [...(FSQ_ENCODE.get(code) ?? [])];
}

/**
 * Nibbles in, characters out: process_symbol, fsq.cxx:1029-1129 (and its twin in ifkp.cxx).
 * A nibble under 29 after one under 29 completes the earlier one as a single-nibble
 * character; a 29, 30 or 31 after one under 29 completes a two-nibble character; anything
 * else (two second-nibbles in a row, which only a misread makes) completes nothing.
 *
 * One departure: fldigi starts with the "previous nibble" at 0, so the first nibble of a
 * session completes a phantom single-nibble character - a space, in FSQ. This starts with
 * no previous nibble.
 */
export class Ifk33VaricodeDecoder {
  /** 32: no previous nibble that can start a character. */
  private prev = 32;

  constructor(private readonly v: Ifk33Varicode) {}

  reset(): void {
    this.prev = 32;
  }

  /** One nibble, 0 to 31. Null when nothing completed; otherwise the character, 0 for NUL, -1 for a code no character has. */
  push(nibble: number): number | null {
    const prev = this.prev;
    this.prev = nibble;
    if (prev >= 29) return null;
    if (nibble < 29) return this.v.single[prev] ?? -1;
    if (nibble < 32) return this.v.double[prev]?.[nibble - 29] ?? -1;
    return null;
  }
}

/**
 * Text to the character codes FSQ sends: a newline is LF, as fldigi wants ("Do NOT use CR
 * as a line feed", fsq_varicode.cxx:40); printable ASCII is itself; the five Latin-1 signs
 * the Varicode has (£ ° ± × ÷) are their Latin-1 codes, as are BS and DEL (FSQ's end of
 * transmission is built from BS); anything the Varicode has no code for is dropped.
 */
export function ifk33TextCodes(text: string, encode: Map<number, number[]>): number[] {
  const out: number[] = [];
  for (const ch of text) {
    if (ch === "\r") continue;
    const c = ch === "\n" ? 10 : ch.codePointAt(0)!;
    if (c > 0 && c < 256 && encode.has(c)) out.push(c);
  }
  return out;
}

/** Characters for a received code: printable ASCII, LF, and the five Latin-1 signs, or "" for anything else. */
export function ifk33Printable(code: number): string {
  if (code === 10) return "\n";
  if (code >= 32 && code < 127) return String.fromCharCode(code);
  if (code === 163 || code === 176 || code === 177 || code === 215 || code === 247) return String.fromCharCode(code);
  return "";
}

/**
 * fldigi's CRC8 (crc8.h): polynomial 0x07, initial 0, no reflection, as two lower-case hex
 * digits. FSQ's directed mode puts it after the colon of the header, computed over the
 * calling station's callsign as sent, so a receiver can tell a real header from noise.
 */
export function fsqCrc8(s: string): string {
  let crc = 0;
  for (let i = 0; i < s.length; i++) {
    crc ^= s.charCodeAt(i) & 0xff;
    for (let b = 0; b < 8; b++) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
  }
  return crc.toString(16).padStart(2, "0");
}

/** FSQBOL, FSQEOL and FSQEOT, fsq.cxx:73-75. */
const FSQBOL = " \n";
const FSQEOL = "\n ";
const FSQEOT = "  \b  ";

export interface FsqOverOptions {
  /**
   * The sending station's callsign. fldigi always starts an over "mycall:" (tx_process,
   * fsq.cxx:1503); when this is given the header is added here, otherwise the text is
   * sent as it is and the caller supplies any header.
   */
  mycall?: string;
  /**
   * fldigi's "directed" mode (FSQDIRECTED, off by default): the header carries the CRC8 of
   * the callsign after the colon, and the over ends with FSQEOT (SP SP BS SP SP) instead of
   * FSQEOL (LF SP). Only used with `mycall`.
   */
  directed?: boolean;
}

/**
 * The characters a whole over sends, as fldigi's tx_process sends them (fsq.cxx:1497-1540):
 * a space and FSQBOL (space, LF), the header, the text, then FSQEOL - or FSQEOT in directed
 * mode. The trailing characters are what makes the last character of the text complete at
 * the far end.
 */
export function fsqOverText(text: string, opts: FsqOverOptions = {}): string {
  let head = " " + FSQBOL;
  const directed = !!opts.mycall && !!opts.directed;
  if (opts.mycall) head += `${opts.mycall}:${directed ? fsqCrc8(opts.mycall) : ""}`;
  return head + text.replace(/\r\n?/g, "\n") + (directed ? FSQEOT : FSQEOL);
}

/** The nibbles of a whole over. */
export function fsqNibbles(text: string, opts: FsqOverOptions = {}): number[] {
  return ifk33TextCodes(fsqOverText(text, opts), FSQ_ENCODE).flatMap((c) => fsqCodeFor(c));
}

/**
 * IFK: each nibble to a tone, the last tone plus the nibble plus one, modulo 33
 * (send_symbol, fsq.cxx:1367-1372; ifkp.cxx:711-715 with IFKP_OFFSET 1). fldigi starts
 * every over from tone 0 (tx_init), so the first tone is the first nibble plus one.
 */
export function ifk33Tones(nibbles: readonly number[], startTone = 0): number[] {
  const out: number[] = [];
  let prev = startTone;
  for (const n of nibbles) {
    prev = (prev + n + 1) % IFK33_TONES;
    out.push(prev);
  }
  return out;
}

/**
 * The nibble between two tones: the inverse of ifk33Tones, as fldigi's nibbles[] table
 * reads it (init_nibbles, fsq.cxx:116-130). -1 is a step of 0, which no transmitter makes.
 */
export function ifk33NibbleBetween(prevTone: number, tone: number): number {
  const step = (((tone - prevTone) % IFK33_TONES) + IFK33_TONES) % IFK33_TONES;
  return step - 1;
}

export interface FsqWaveformOptions extends FsqOverOptions {
  sampleRate: number;
  /** The operator's frequency, Hz audio: the tones are placed from it as fldigi places them. */
  centreHz: number;
  speed: FsqSpeed;
  /** Peak amplitude. Default 1. */
  amplitude?: number;
}

/** Raised-cosine ramp at each end, s: short against any symbol, and it removes the key click. */
const RAMP_S = 0.004;

/**
 * Tones to audio, one tone per symbol, phase-continuous across tone changes as fldigi's
 * send_tone is, with the first and last few milliseconds ramped. Shared with IFKP.
 */
export function ifk33Audio(tones: readonly number[], toneHz: (t: number) => number, samplesPerSymbol: number, sampleRate: number, amplitude = 1): Float32Array {
  const total = Math.round(tones.length * samplesPerSymbol);
  const out = new Float32Array(total);
  const ramp = Math.max(1, Math.round(RAMP_S * sampleRate));
  let phase = 0;
  for (let k = 0; k < tones.length; k++) {
    const dphi = (2 * Math.PI * toneHz(tones[k]!)) / sampleRate;
    const end = Math.round((k + 1) * samplesPerSymbol);
    for (let i = Math.round(k * samplesPerSymbol); i < end; i++) {
      let env = 1;
      if (i < ramp) env = 0.5 - 0.5 * Math.cos((Math.PI * i) / ramp);
      else if (i >= total - ramp) env = 0.5 - 0.5 * Math.cos((Math.PI * (total - 1 - i)) / ramp);
      out[i] = amplitude * env * Math.cos(phase);
      phase += dphi;
      if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
    }
  }
  return out;
}

/** The audio for a line of text: the whole over (fsqOverText), at the rate asked for. */
export function fsqWaveform(text: string, opts: FsqWaveformOptions): Float32Array {
  const p = fsqParams(opts.speed);
  const tones = ifk33Tones(fsqNibbles(text, opts));
  return ifk33Audio(tones, (t) => fsqToneHz(t, opts.centreHz), (p.symbolLen * opts.sampleRate) / FSQ_BASE_RATE, opts.sampleRate, opts.amplitude ?? 1);
}

export function fsqDurationMs(text: string, opts: FsqOverOptions & { speed: FsqSpeed }): number {
  const p = fsqParams(opts.speed);
  return (fsqNibbles(text, opts).length / p.baud) * 1000;
}
