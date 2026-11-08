// DominoEX: the code and the waveform.
//
// DominoEX (Murray Greenman ZL1BPU and Con Wassilieff ZL2AFP, 2004) is 18-tone MFSK keyed
// by incremental frequency keying, IFK+: a symbol is not a tone but a step from the last
// tone, and the step is the four-bit nibble plus two, wrapping round the 18 tones. The
// receiver reads the difference between consecutive tones, so the absolute frequency does
// not matter - a station a few hertz off, or drifting, reads the same - and the step is
// never 0 or 1, so consecutive symbols are always at least two tones apart, which keeps a
// tone from smearing into the next one on a path with multipath delay. Characters are a
// nibble Varicode: one to three nibbles, the first with its top bit clear and any that
// follow with it set, so the start of the next character ends the last. The common
// letters are one nibble. A second alphabet of the same shape carries the "secondary
// text" (fldigi sends its version string there while the operator is not typing), which
// a receiver shows in a status field, not in the conversation.
//
// The submodes differ only in speed and spacing. fldigi works each one at its own
// internal rate, 8000 Hz or 11025 Hz, with a symbol of a power-of-two samples there
// (dominoex.cxx, the constructor's switch), so the baud rates are 8000/2048 = 3.906,
// 11025/2048 = 5.383, 8000/1024 = 7.8125, 11025/1024 = 10.77, 8000/512 = 15.625 and
// 11025/512 = 21.53. The tones are one baud apart, except in DominoEX 4, 5 and 8, which
// are "double spaced" at two baud apart so a slow signal is not crowded into a few tens of
// hertz. This port generates and reads at the rate it is given (12, 24 or 48 kHz); the
// symbol is a fractional number of samples there and is laid out on an exact time grid.
//
// Ported from fldigi 4.2.13 (W1HKJ and others, GPL): src/dominoex/dominoex.cxx for the
// transmit sequence and the tone arithmetic, src/dominoex/dominovar.cxx for the Varicode,
// src/include/dominoex.h for the constants. The MultiPSK-compatible FEC option fldigi has
// (off by default there) is not ported.
//
// The decoder is lib/digital/dominoexdemod.ts; scripts/check-dominoex.ts runs one through
// the other on generated signals, clean, offset and in noise, and checks the tone
// arithmetic against sequences worked by hand from fldigi's code.

/** NUMTONES, dominoex.h:46. */
export const DOMINOEX_TONES = 18;
/** The longest Varicode, in nibbles: MAX_VARICODE_LEN, dominovar.h:27. */
export const DOMINOEX_MAX_NIBBLES = 3;
/** The audio centre the mode chip tunes the decoder to: fldigi's PSK sweet spot. */
export const DOMINOEX_CENTRE_HZ = 1500;

export type DominoexMode = 4 | 5 | 8 | 11 | 16 | 22;

/** The submodes, slowest first: what the mode picker offers. */
export const DOMINOEX_MODES: readonly DominoexMode[] = [4, 5, 8, 11, 16, 22];

export interface DominoexParams {
  mode: DominoexMode;
  /** fldigi's internal sample rate for this submode, Hz. */
  baseRate: 8000 | 11025;
  /** Symbol length at that rate, samples. */
  symbolLen: number;
  /** 1, or 2 for the double-spaced submodes: the tone spacing in baud. */
  doubleSpaced: 1 | 2;
  baud: number;
  toneSpacingHz: number;
  /** Eighteen tone spacings: fldigi's `bandwidth`, which is also how the tone set is placed. */
  bandwidthHz: number;
}

/** The constructor's switch, dominoex.cxx:223-278. */
const TABLE: Record<DominoexMode, { baseRate: 8000 | 11025; symbolLen: number; doubleSpaced: 1 | 2 }> = {
  4: { baseRate: 8000, symbolLen: 2048, doubleSpaced: 2 },
  5: { baseRate: 11025, symbolLen: 2048, doubleSpaced: 2 },
  8: { baseRate: 8000, symbolLen: 1024, doubleSpaced: 2 },
  11: { baseRate: 11025, symbolLen: 1024, doubleSpaced: 1 },
  16: { baseRate: 8000, symbolLen: 512, doubleSpaced: 1 },
  22: { baseRate: 11025, symbolLen: 512, doubleSpaced: 1 },
};

export function dominoexParams(mode: DominoexMode): DominoexParams {
  const t = TABLE[mode];
  if (!t) throw new Error(`DominoEX ${mode} is not a submode`);
  const baud = t.baseRate / t.symbolLen;
  // tonespacing and bandwidth, dominoex.cxx:280-282.
  const toneSpacingHz = baud * t.doubleSpaced;
  return { mode, ...t, baud, toneSpacingHz, bandwidthHz: DOMINOEX_TONES * toneSpacingHz };
}

/**
 * The frequency of tone 0 to 17 for a signal on `centreHz`. fldigi's sendtone
 * (dominoex.cxx:658) puts tone n at (n + 0.5) spacings above the frequency minus half the
 * bandwidth: the tone set is centred on the operator's frequency, with tones 8 and 9 half
 * a spacing either side of it, not started from it.
 */
export function dominoexToneHz(tone: number, centreHz: number, mode: DominoexMode): number {
  const p = dominoexParams(mode);
  return centreHz + (tone + 0.5) * p.toneSpacingHz - p.bandwidthHz / 2;
}

/**
 * The Varicode, dominovar.cxx:27-95: 256 primary characters and then the same 256 again
 * in the secondary alphabet, each as three hex nibbles. A second or third nibble is sent
 * only when its top bit is set (sendchar, dominoex.cxx:688-696), so "2c0" is the two
 * nibbles 2, 12 and "100" is the single nibble 1.
 */
const VARICODE_HEX = [
  "1f9 1fa 1fb 1fc 1fd 1fe 1ff 288 2c0 289 28a 28b 28c 2d0 28d 28e",
  "28f 298 299 29a 29b 29c 29d 29e 29f 2a8 2a9 2aa 2ab 2ac 2ad 2ae",
  "000 7b0 08e 0ab 09a 099 08f 7a0 08c 08b 09d 088 2b0 7e0 7d0 089",
  "3f0 4a0 4f0 590 680 5c0 5e0 6c0 6b0 6e0 08a 08d 0a8 7f0 09f 7c0",
  "098 390 4e0 3c0 3e0 380 4c0 580 5a0 3a0 780 6a0 4b0 480 4d0 3b0",
  "490 6f0 3d0 2f0 2e0 5b0 6d0 5d0 5f0 690 790 0ae 0a9 0af 0aa 09c",
  "09b 400 1b0 0c0 0b0 100 0f0 190 0a0 500 2a0 1e0 090 0e0 600 300",
  "180 280 700 080 200 0d0 1d0 1c0 1f0 1a0 290 0ac 09e 0ad 0b8 2af",
  "2b8 2b9 2ba 2bb 2bc 2bd 2be 2bf 2c8 2c9 2ca 2cb 2cc 2cd 2ce 2cf",
  "2d8 2d9 2da 2db 2dc 2dd 2de 2df 2e8 2e9 2ea 2eb 2ec 2ed 2ee 2ef",
  "0b9 0ba 0bb 0bc 0bd 0be 0bf 0c8 0c9 0ca 0cb 0cc 0cd 0ce 0cf 0d8",
  "0d9 0da 0db 0dc 0dd 0de 0df 0e8 0e9 0ea 0eb 0ec 0ed 0ee 0ef 0f8",
  "0f9 0fa 0fb 0fc 0fd 0fe 0ff 188 189 18a 18b 18c 18d 18e 18f 198",
  "199 19a 19b 19c 19d 19e 19f 1a8 1a9 1aa 1ab 1ac 1ad 1ae 1af 1b8",
  "1b9 1ba 1bb 1bc 1bd 1be 1bf 1c8 1c9 1ca 1cb 1cc 1cd 1ce 1cf 1d8",
  "1d9 1da 1db 1dc 1dd 1de 1df 1e8 1e9 1ea 1eb 1ec 1ed 1ee 1ef 1f8",
  // Secondary alphabet.
  "6f9 6fa 6fb 6fc 6fd 6fe 6ff 788 4ac 789 78a 78b 78c 4ad 78d 78e",
  "78f 798 799 79a 79b 79c 79d 79e 79f 7a8 7a9 7aa 7ab 7ac 7ad 7ae",
  "388 4fb 58e 5ab 59a 599 58f 4fa 58c 58b 59d 588 4ab 4fe 4fd 589",
  "4bf 4ca 4cf 4d9 4e8 4dc 4de 4ec 4eb 4ee 58a 58d 5a8 4ff 59f 4fc",
  "598 4b9 4ce 4bc 4be 4b8 4cc 4d8 4da 4ba 4f8 4ea 4cb 4c8 4cd 4bb",
  "4c9 4ef 4bd 4af 4ae 4db 4ed 4dd 4df 4e9 4f9 5ae 5a9 5af 5aa 59c",
  "59b 38c 49b 48c 48b 389 48f 499 48a 38d 4aa 49e 489 48e 38e 38b",
  "498 4a8 38f 488 38a 48d 49d 49c 49f 49a 4a9 5ac 59e 5ac 5b8 7af",
  "7b8 7b9 7ba 7bb 7bc 7bd 7be 7bf 7c8 7c9 7ca 7cb 7cc 7cd 7ce 7cf",
  "7d8 7d9 7da 7db 7dc 7dd 7de 7df 7e8 7e9 7ea 7eb 7ec 7ed 7ee 7ef",
  "5b9 5ba 5bb 5bc 5bd 5be 5bf 5c8 5c9 5ca 5cb 5cc 5cd 5ce 5cf 5d8",
  "5d9 5da 5db 5dc 5dd 5de 5df 5e8 5e9 5ea 5eb 5ec 5ed 5ee 5ef 5f8",
  "5f9 5fa 5fb 5fc 5fd 5fe 5ff 688 689 68a 68b 68c 68d 68e 68f 698",
  "699 69a 69b 69c 69d 69e 69f 6a8 6a9 6aa 6ab 6ac 6ad 6ae 6af 6b8",
  "6b9 6ba 6bb 6bc 6bd 6be 6bf 6c8 6c9 6ca 6cb 6cc 6cd 6ce 6cf 6d8",
  "6d9 6da 6db 6dc 6dd 6de 6df 6e8 6e9 6ea 6eb 6ec 6ed 6ee 6ef 6f8",
];

/** The nibbles each of the 512 codes sends. */
const CODES: number[][] = [];
/**
 * Decoding: the 1-3 nibbles of a code read as one number, oldest nibble highest (as
 * decodeDomino builds it, dominoex.cxx:380-383), to the character: 0-255 primary, 256-511
 * secondary, -1 for none. fldigi keeps this as a second hand-written table (varidecode,
 * dominovar.cxx:105); building it by inverting the encoder, later entries winning,
 * reproduces that table entry for entry - including its one quirk: secondary "{" and "}"
 * share a code, and it reads as "}".
 */
const DECODE = new Int16Array(4096).fill(-1);
for (const row of VARICODE_HEX) {
  for (const hex of row.split(" ")) {
    const n = [parseInt(hex[0]!, 16), parseInt(hex[1]!, 16), parseInt(hex[2]!, 16)];
    const code = [n[0]!];
    if (n[1]! & 8) {
      code.push(n[1]!);
      if (n[2]! & 8) code.push(n[2]!);
    }
    let sym = 0;
    for (const x of code) sym = (sym << 4) | x;
    DECODE[sym] = CODES.length;
    CODES.push(code);
  }
}

/** The nibbles for one byte, primary or secondary alphabet: dominoex_varienc. */
export function dominoexCodeFor(byte: number, secondary = false): number[] {
  return [...(CODES[(byte & 0xff) + (secondary ? 256 : 0)] ?? [])];
}

/**
 * The character a run of nibbles is: 0-255 primary, 256-511 secondary (the 0x100 bit is
 * fldigi's flag for the secondary alphabet), -1 when no character has that code.
 * dominoex_varidec.
 */
export function dominoexCharForCode(nibbles: readonly number[]): number {
  let sym = 0;
  for (const x of nibbles) sym = (sym << 4) | (x & 0xf);
  return DECODE[sym & 0xfff] ?? -1;
}

const UTF8 = new TextEncoder();

/**
 * A line of text as the bytes the transmitter sends: UTF-8, as fldigi sends it, with a
 * newline as CR LF.
 */
export function dominoexTextBytes(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    if (ch === "\n") {
      out.push(13, 10);
      continue;
    }
    if (ch === "\r") continue;
    for (const b of UTF8.encode(ch)) out.push(b);
  }
  return out;
}

/** Primary-alphabet bytes to the nibble stream. */
export function dominoexEncodeBytes(bytes: readonly number[], secondary = false): number[] {
  const out: number[] = [];
  for (const b of bytes) out.push(...dominoexCodeFor(b, secondary));
  return out;
}

/** The idle: a secondary-alphabet NUL (sendidle, dominoex.cxx:702-705). */
const IDLE = (): number[] => dominoexCodeFor(0, true);

/**
 * The nibbles a whole over sends, as fldigi's tx_process (dominoex.cxx:726-771) sends
 * them: one idle (the preamble state), CR STX CR, the text, CR EOT CR, and four idles to
 * flush the far end's Varicode decoder - a character is only complete when the first
 * nibble of the next one arrives, so without them the last character would never print.
 */
export function dominoexNibbles(text: string): number[] {
  return [
    ...IDLE(),
    ...dominoexEncodeBytes([13, 2, 13]),
    ...dominoexEncodeBytes(dominoexTextBytes(text)),
    ...dominoexEncodeBytes([13, 4, 13]),
    ...IDLE(),
    ...IDLE(),
    ...IDLE(),
    ...IDLE(),
  ];
}

/**
 * IFK+: each nibble to a tone, the last tone plus the nibble plus two, modulo 18
 * (sendsymbol, dominoex.cxx:676). fldigi starts every over from tone 0 (tx_init).
 */
export function dominoexTones(nibbles: readonly number[], startTone = 0): number[] {
  const out: number[] = [];
  let prev = startTone;
  for (const n of nibbles) {
    prev = (prev + 2 + n) % DOMINOEX_TONES;
    out.push(prev);
  }
  return out;
}

/**
 * The nibble IFK+ carried between two tones: the inverse of dominoexTones, as decodesymbol
 * (dominoex.cxx:403-425) reads it. 16 and 17 are steps no transmitter makes (0 and 1 tone).
 */
export function dominoexNibbleBetween(prevTone: number, tone: number): number {
  let c = tone - prevTone - 2;
  while (c < 0) c += DOMINOEX_TONES;
  return c % DOMINOEX_TONES;
}

/**
 * Nibbles in, characters out: decodeDomino (dominoex.cxx:374-401). A nibble with its top
 * bit clear starts a character and so completes the one before, which is read if it was
 * three nibbles or fewer. A 16 or 17 from a misread symbol has bit 3 clear as well and
 * breaks a character the same way, as it does in fldigi.
 *
 * One departure: continuation nibbles with no start nibble before them - what the
 * receiver hears when it picks a signal up mid-character - are dropped. fldigi reads them
 * as a code, and since a leading 0 nibble vanishes from the number it builds, a lone 9
 * reads as the code 0 9, "l": a stray letter at the start of every over.
 */
export class DominoexVaricodeDecoder {
  /** Newest first, as fldigi keeps symbolbuf. */
  private readonly buf: number[] = [0, 0, 0];
  private count = 0;
  /** Whether the nibbles in the buffer began with a start nibble. */
  private started = false;

  reset(): void {
    this.buf.fill(0);
    this.count = 0;
    this.started = false;
  }

  /**
   * One nibble in. Returns null when no character was completed, otherwise what the
   * completed code is: 0-255 primary, 256-511 secondary, -1 a code no character has.
   */
  push(nibble: number): number | null {
    let result: number | null = null;
    if (!(nibble & 0x8)) {
      if (this.started && this.count > 0 && this.count <= DOMINOEX_MAX_NIBBLES) {
        let sym = 0;
        for (let i = 0; i < this.count; i++) sym |= this.buf[i]! << (4 * i);
        result = DECODE[sym & 0xfff] ?? -1;
      }
      this.count = 0;
      this.started = true;
    }
    for (let i = DOMINOEX_MAX_NIBBLES - 1; i > 0; i--) this.buf[i] = this.buf[i - 1]!;
    this.buf[0] = nibble;
    // Clamped at one past the longest code, as fldigi does: a run that long is no character.
    this.count = Math.min(this.count + 1, DOMINOEX_MAX_NIBBLES + 1);
    return result;
  }
}

export interface DominoexWaveformOptions {
  sampleRate: number;
  /** Centre of the tone set, Hz audio. */
  centreHz: number;
  mode: DominoexMode;
  /** Peak amplitude. Default 1. */
  amplitude?: number;
}

/** Samples at `fs` before symbol k starts: the symbol is fractional at 12/24/48 kHz for the 11025 Hz submodes. */
function symbolStart(k: number, fs: number, p: DominoexParams): number {
  return Math.round((k * p.symbolLen * fs) / p.baseRate);
}

/** Raised-cosine ramp at each end, s: short against any symbol, and it removes the key click. */
const RAMP_S = 0.004;

/**
 * The audio for a line of text: the whole over (see dominoexNibbles), one tone per
 * symbol, phase-continuous across tone changes as fldigi's sendtone is. The first and
 * last few milliseconds are ramped so the carrier does not start or stop with a click.
 */
export function dominoexWaveform(text: string, opts: DominoexWaveformOptions): Float32Array {
  const fs = opts.sampleRate;
  const p = dominoexParams(opts.mode);
  const amp = opts.amplitude ?? 1;
  const tones = dominoexTones(dominoexNibbles(text));
  const total = symbolStart(tones.length, fs, p);
  const out = new Float32Array(total);
  const ramp = Math.max(1, Math.round(RAMP_S * fs));
  let phase = 0;
  for (let k = 0; k < tones.length; k++) {
    const dphi = (2 * Math.PI * dominoexToneHz(tones[k]!, opts.centreHz, opts.mode)) / fs;
    const end = symbolStart(k + 1, fs, p);
    for (let i = symbolStart(k, fs, p); i < end; i++) {
      let env = 1;
      if (i < ramp) env = 0.5 - 0.5 * Math.cos((Math.PI * i) / ramp);
      else if (i >= total - ramp) env = 0.5 - 0.5 * Math.cos((Math.PI * (total - 1 - i)) / ramp);
      out[i] = amp * env * Math.cos(phase);
      phase += dphi;
      if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
    }
  }
  return out;
}

export function dominoexDurationMs(text: string, opts: Pick<DominoexWaveformOptions, "mode">): number {
  const p = dominoexParams(opts.mode);
  return (dominoexNibbles(text).length / p.baud) * 1000;
}
