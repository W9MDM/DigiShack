// Throb and ThrobX: the code and the waveform.
//
// Throb (Lionel Sear G3PPT, 2000) sends each character as one "throb": a pulse a second,
// half a second or a quarter of a second long carrying one or two tones out of a small
// set at once. Throb has nine tones, and every pair of them (36) and every single tone (9)
// is a symbol, which makes 45; ThrobX (G3PPT's later extension, put into fldigi by Joe
// Veldhuis KD8ATU) has eleven tones and uses only the 55 pairs, so every symbol is two
// tones. The pulse is shaped - raised-cosine edges a fifth of the symbol long either side
// of a flat top at the two slow speeds, a full raised cosine at the fast one - so each
// throb rises and falls back to nothing, and the receiver can find the symbol boundaries
// from the envelope alone. It is slow (about one, two or four characters a second) and
// narrow, and copies well below the noise on a steady path.
//
// The two alphabets differ:
//
//   Throb has capital letters, digits, , . ' / ( ) and space, 45 symbols in all with an
//   idle and a SHIFT. ? @ - and newline go as SHIFT followed by the symbol of T, M, I and
//   the idle respectively (tx_process, throb.cxx:653-682). The idle prints nothing.
//
//   ThrobX adds # " + - ; : ? ! @ = and a newline (fldigi's own addition: the comment at
//   throb.cxx:832 calls it "COMPLETELY NONSTANDARD"), each a symbol of its own, no shift.
//   The space and the idle are two symbols that swap roles every time either is sent
//   (flip_syms, throb.cxx:96-114), so a run of spaces or idles never sends the same pair
//   twice running; the receiver treats both alike and prints a space for the first of a
//   run that follows a character (decodechar, throb.cxx:397-413). A pause in typing
//   therefore reads as a space, which is how ThrobX was meant to be read.
//
// The submodes, from fldigi's constructor (throb.cxx:141-220). fldigi works Throb at 8000
// Hz with symbols of 8192, 4096 and 2048 samples (throb.h:34-44):
//
//   Throb 1, 2:  1.024 s and 0.512 s, tones 8 Hz apart (ThrobToneFreqsNar, :941), semi pulse
//   Throb 4:     0.256 s, tones 16 Hz apart (ThrobToneFreqsWid, :942), full pulse
//   ThrobX 1, 2: 1.024 s and 0.512 s, tones 7.8125 Hz apart (ThrobXToneFreqsNar, :943), semi pulse
//   ThrobX 4:    0.256 s, tones 15.625 Hz apart (ThrobXToneFreqsWid, :944), full pulse
//
// The tone sets are symmetric about the operator's frequency: the middle tone (tone 4 of
// Throb's nine, tone 5 of ThrobX's eleven) is exactly on it (send, throb.cxx:609-610).
//
// What goes on the air for one over, per tx_init and tx_process (throb.cxx:47-52,
// 619-721): four idle symbols (the preamble), one symbol per character (two for Throb's
// shifted ones), and one closing idle. Every symbol is `pulse * (sin(w1 t) + sin(w2 t)) / 2`
// with the phase restarting at each symbol (send, throb.cxx:612-614); a single-tone Throb
// symbol is the same tone twice, so it goes at full amplitude on that one tone.
//
// Ported from fldigi 4.2.13 (W1HKJ, KD8ATU and others, GPL; itself adapted from gmfsk by
// OH2BNS): src/throb/throb.cxx and src/include/throb.h. fldigi's "reverse" (the tone set
// upside down, for a lower-sideband rig) is not ported: DigiShack always works upper
// sideband audio.
//
// The decoder is lib/digital/throbdemod.ts; scripts/check-throb.ts runs one through the
// other and checks the tone pairs against sequences worked by hand from fldigi's tables.

/** The audio centre the mode chip tunes the decoder to: fldigi's PSK sweet spot. */
export const THROB_CENTRE_HZ = 1500;
/** fldigi's internal sample rate for every Throb mode: THROB_SAMPLE_RATE, throb.h:34. */
export const THROB_BASE_RATE = 8000;
/** Idle symbols sent before the text: `preamble`, tx_init (throb.cxx:49). */
export const THROB_PREAMBLE = 4;

export type ThrobMode = "THROB1" | "THROB2" | "THROB4" | "THROBX1" | "THROBX2" | "THROBX4";

/** The submodes, Throb then ThrobX, slowest first: what the mode picker offers. */
export const THROB_MODES: readonly ThrobMode[] = ["THROB1", "THROB2", "THROB4", "THROBX1", "THROBX2", "THROBX4"];

export interface ThrobParams {
  mode: ThrobMode;
  /** As an operator says it: "Throb 2", "ThrobX 1". */
  label: string;
  /** ThrobX: eleven tones, pairs only, alternating space and idle. */
  x: boolean;
  tones: 9 | 11;
  /** Symbols in the alphabet: 45 or 55 (num_chars). */
  symbols: 45 | 55;
  /** Symbol length at fldigi's 8000 Hz: SYMLEN_1/2/4, throb.h:42-44. */
  symbolLen: 8192 | 4096 | 2048;
  /** Symbols a second. */
  baud: number;
  toneSpacingHz: number;
  /** Lowest tone to highest: fldigi's `bandwidth` (throb.cxx:243). */
  bandwidthHz: number;
  /** "semi": raised-cosine edges either side of a flat top; "full": a raised cosine the whole symbol. */
  pulse: "semi" | "full";
  /** Each tone's offset from the operator's frequency, Hz, lowest first. */
  toneOffsetsHz: readonly number[];
}

// The tone tables, throb.cxx:941-944.
const THROB_FREQS_NAR = [-32, -24, -16, -8, 0, 8, 16, 24, 32];
const THROB_FREQS_WID = [-64, -48, -32, -16, 0, 16, 32, 48, 64];
const THROBX_FREQS_NAR = [-39.0625, -31.25, -23.4375, -15.625, -7.8125, 0, 7.8125, 15.625, 23.4375, 31.25, 39.0625];
const THROBX_FREQS_WID = [-78.125, -62.5, -46.875, -31.25, -15.625, 0, 15.625, 31.25, 46.875, 62.5, 78.125];

/** The constructor's switch, throb.cxx:141-220. */
const TABLE: Record<ThrobMode, { label: string; x: boolean; symbolLen: 8192 | 4096 | 2048; pulse: "semi" | "full"; freqs: number[] }> = {
  THROB1: { label: "Throb 1", x: false, symbolLen: 8192, pulse: "semi", freqs: THROB_FREQS_NAR },
  THROB2: { label: "Throb 2", x: false, symbolLen: 4096, pulse: "semi", freqs: THROB_FREQS_NAR },
  THROB4: { label: "Throb 4", x: false, symbolLen: 2048, pulse: "full", freqs: THROB_FREQS_WID },
  THROBX1: { label: "ThrobX 1", x: true, symbolLen: 8192, pulse: "semi", freqs: THROBX_FREQS_NAR },
  THROBX2: { label: "ThrobX 2", x: true, symbolLen: 4096, pulse: "semi", freqs: THROBX_FREQS_NAR },
  THROBX4: { label: "ThrobX 4", x: true, symbolLen: 2048, pulse: "full", freqs: THROBX_FREQS_WID },
};

export function throbParams(mode: ThrobMode): ThrobParams {
  const t = TABLE[mode];
  if (!t) throw new Error(`${mode} is not a Throb mode`);
  const tones = t.freqs.length as 9 | 11;
  return {
    mode,
    label: t.label,
    x: t.x,
    tones,
    symbols: t.x ? 55 : 45,
    symbolLen: t.symbolLen,
    baud: THROB_BASE_RATE / t.symbolLen,
    toneSpacingHz: t.freqs[1]! - t.freqs[0]!,
    bandwidthHz: t.freqs[tones - 1]! - t.freqs[0]!,
    pulse: t.pulse,
    toneOffsetsHz: t.freqs,
  };
}

/** The audio frequency of tone 0 to 8 (or 10) for a signal on `centreHz`. */
export function throbToneHz(tone: number, centreHz: number, mode: ThrobMode): number {
  return centreHz + TABLE[mode].freqs[tone]!;
}

/**
 * ThrobTonePairs, throb.cxx:729-775: symbol i is tones [a, b], counted from 1 as fldigi
 * writes them. A pair with a = b is the single tone.
 */
export const THROB_TONE_PAIRS: readonly (readonly [number, number])[] = [
  [5, 5], [4, 5], [1, 2], [1, 3], [1, 4], [4, 6], [1, 5], [1, 6], [1, 7], [3, 7],
  [1, 8], [2, 3], [2, 4], [2, 8], [2, 5], [5, 6], [2, 6], [2, 9], [3, 4], [3, 5],
  [1, 9], [3, 6], [8, 9], [3, 8], [3, 3], [2, 2], [1, 1], [3, 9], [4, 7], [4, 8],
  [4, 9], [5, 7], [5, 8], [5, 9], [6, 7], [6, 8], [6, 9], [7, 8], [7, 9], [8, 8],
  [7, 7], [6, 6], [4, 4], [9, 9], [2, 7],
];

/**
 * ThrobCharSet, throb.cxx:835-881. Symbol 0 is the idle and 5 the SHIFT (it was E, which
 * moved to 43), both printing nothing; 44 is the space.
 */
export const THROB_CHARSET = "\0ABCD\0FGHIJKLMNOPQRSTUVWXYZ1234567890,.'/)(E ";

/** ThrobXTonePairs, throb.cxx:777-833. Symbols 0 and 1 are the idle and the space, and swap. */
export const THROBX_TONE_PAIRS: readonly (readonly [number, number])[] = [
  [6, 11], [1, 6], [2, 6], [2, 5], [2, 7], [2, 8], [5, 6], [2, 9], [2, 10], [4, 8],
  [4, 6], [2, 11], [3, 4], [3, 5], [3, 6], [6, 9], [6, 10], [3, 7], [3, 8], [3, 9],
  [6, 8], [6, 7], [3, 10], [3, 11], [4, 5], [4, 7], [4, 9], [4, 10], [1, 2], [1, 3],
  [1, 4], [1, 5], [1, 7], [1, 8], [1, 9], [1, 10], [2, 3], [2, 4], [4, 11], [5, 7],
  [5, 8], [5, 9], [5, 10], [5, 11], [7, 8], [7, 9], [7, 10], [7, 11], [8, 9], [8, 10],
  [8, 11], [9, 10], [9, 11], [10, 11], [1, 11],
];

/** ThrobXCharSet, throb.cxx:883-939. */
export const THROBX_CHARSET = "\0 ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890,.'/)(#\"+-;:?!@=\n";

// Throb's shifted characters, tx_process (throb.cxx:653-679): SHIFT then this symbol.
const THROB_SHIFT = 5;
const THROB_IDLE = 0;
const THROB_SPACE = 44;
const THROB_SHIFTED: Record<string, number> = { "?": 20, "@": 13, "-": 9, "\n": 0 };

const UTF8 = new TextEncoder();

/**
 * The symbols one over sends, as indices into the mode's tables, as tx_init and tx_process
 * (throb.cxx:47-52, 619-721) send them: the preamble, the text, the closing idle.
 *
 * Per character: CR is dropped (only Throb drops it in fldigi; ThrobX would send it as a
 * space, but DigiShack's lines never carry one), lower case goes up, Throb's ? @ - and
 * newline go shifted, and anything neither alphabet has goes as a space - one per UTF-8
 * byte, since fldigi reads its transmit buffer a byte at a time.
 */
export function throbSymbols(text: string, mode: ThrobMode): number[] {
  const x = TABLE[mode].x;
  const charset = x ? THROBX_CHARSET : THROB_CHARSET;
  // reset_syms (throb.cxx:116-130): ThrobX starts with the idle as symbol 0 and the space 1.
  let idle = THROB_IDLE;
  let space = x ? 1 : THROB_SPACE;
  const flip = () => {
    if (!x) return;
    [idle, space] = [space, idle];
  };
  const out: number[] = [];
  for (let i = 0; i < THROB_PREAMBLE; i++) {
    out.push(idle);
    flip();
  }
  for (const ch of text) {
    if (ch === "\r") continue;
    if (!x && ch in THROB_SHIFTED) {
      out.push(THROB_SHIFT, THROB_SHIFTED[ch]!);
      continue;
    }
    const bytes = ch.charCodeAt(0) < 128 ? [ch] : Array.from(UTF8.encode(ch), () => " ");
    for (const b of bytes) {
      const c = b >= "a" && b <= "z" ? b.toUpperCase() : b;
      // The table search keeps the last match (throb.cxx:698-706); NUL never matches as
      // a typed character, so the idle and SHIFT entries are never chosen this way.
      let sym = c === "\0" ? -1 : charset.lastIndexOf(c);
      if (sym < 0 || c === " ") {
        sym = space;
        flip();
      }
      out.push(sym);
    }
  }
  // The closing idle, with no flip (throb.cxx:635-639).
  out.push(idle);
  return out;
}

/** A symbol as its two tones, 0-based, lower first (a single tone is the same tone twice). */
export function throbSymbolTones(sym: number, mode: ThrobMode): [number, number] {
  const pair = (TABLE[mode].x ? THROBX_TONE_PAIRS : THROB_TONE_PAIRS)[sym]!;
  return [pair[0] - 1, pair[1] - 1];
}

/** The tone pairs one over sends, 0-based. */
export function throbTonePairs(text: string, mode: ThrobMode): [number, number][] {
  return throbSymbols(text, mode).map((s) => throbSymbolTones(s, mode));
}

/**
 * The throb pulse, sample i of len: mk_semi_pulse and mk_full_pulse (throb.cxx:542-579),
 * with fldigi's integer division for where the edges end, so at 8000 Hz this is fldigi's
 * table sample for sample.
 */
export function throbPulse(i: number, len: number, kind: "semi" | "full"): number {
  if (kind === "full") return 0.5 * (1 - Math.cos((2 * Math.PI * i) / len));
  const a = Math.floor(len / 5);
  const b = Math.floor((len * 4) / 5);
  if (i < a) return 0.5 * (1 - Math.cos((Math.PI * i) / (len / 5)));
  if (i < b) return 1;
  return 0.5 * (1 + Math.cos((Math.PI * (i - b)) / (len / 5)));
}

/**
 * Tone pairs in, text out: decodechar (throb.cxx:357-417). Throb's SHIFT makes the next
 * symbol one of four shifted characters; ThrobX's idle and space both read as a space
 * after a character and as nothing after a space or at the start.
 *
 * One departure: Throb's SHIFT followed by the pair of I prints "-", where fldigi prints
 * "=". fldigi sends "-" exactly that way (throb.cxx:666-669) and has no way to send "=",
 * so "=" was only ever a misprint of a hyphen.
 */
export class ThrobCharDecoder {
  private readonly x: boolean;
  private readonly tones: number;
  private readonly lookup: Int16Array;
  private shift = false;
  private lastChar = "";
  /** Whether the last push was a SHIFT followed by a pair with no shifted character. */
  invalid = false;

  constructor(mode: ThrobMode) {
    const p = TABLE[mode];
    this.x = p.x;
    this.tones = p.freqs.length;
    this.lookup = new Int16Array(this.tones * this.tones).fill(-1);
    const pairs = p.x ? THROBX_TONE_PAIRS : THROB_TONE_PAIRS;
    pairs.forEach(([a, b], i) => {
      this.lookup[(a - 1) * this.tones + (b - 1)] = i;
    });
  }

  reset(): void {
    this.shift = false;
    this.lastChar = "";
    this.invalid = false;
  }

  /** One symbol's tones, 0-based, either order. Returns the text it prints, often "". */
  push(toneA: number, toneB: number): string {
    const t1 = Math.min(toneA, toneB);
    const t2 = Math.max(toneA, toneB);
    this.invalid = false;
    if (!this.x) {
      if (this.shift) {
        this.shift = false;
        if (t1 === 0 && t2 === 8) return "?";
        if (t1 === 1 && t2 === 7) return "@";
        if (t1 === 2 && t2 === 6) return "-";
        if (t1 === 4 && t2 === 4) return "\n";
        this.invalid = true;
        return "";
      }
      if (t1 === 3 && t2 === 5) {
        this.shift = true;
        return "";
      }
      const sym = this.lookup[t1 * this.tones + t2]!;
      if (sym < 0) return "";
      const c = THROB_CHARSET[sym]!;
      return c === "\0" ? "" : c;
    }
    const sym = this.lookup[t1 * this.tones + t2]!;
    if (sym < 0) return "";
    if (sym === 0 || sym === 1) {
      if (this.lastChar !== "" && this.lastChar !== " ") {
        this.lastChar = " ";
        return " ";
      }
      this.lastChar = "";
      return "";
    }
    const c = THROBX_CHARSET[sym]!;
    this.lastChar = c;
    return c;
  }
}

export interface ThrobWaveformOptions {
  sampleRate: number;
  /** The operator's frequency: the middle tone, Hz audio. */
  centreHz: number;
  mode: ThrobMode;
  /** Peak amplitude. Default 1. */
  amplitude?: number;
}

/** Samples at `fs` before symbol k starts. At 12, 24 and 48 kHz a symbol is a whole number of samples. */
function symbolStart(k: number, fs: number, symbolLen: number): number {
  return Math.round((k * symbolLen * fs) / THROB_BASE_RATE);
}

/**
 * The audio for a line of text: the whole over (see throbSymbols), each symbol the throb
 * pulse times the mean of its two tones' sines, the phase starting from zero at each
 * symbol as send (throb.cxx:609-614) does. The pulse starts and ends every symbol at
 * zero, so there is no click between symbols or at either end.
 */
export function throbWaveform(text: string, opts: ThrobWaveformOptions): Float32Array {
  const fs = opts.sampleRate;
  const t = TABLE[opts.mode];
  const amp = opts.amplitude ?? 1;
  const pairs = throbTonePairs(text, opts.mode);
  const out = new Float32Array(symbolStart(pairs.length, fs, t.symbolLen));
  for (let k = 0; k < pairs.length; k++) {
    const [a, b] = pairs[k]!;
    const w1 = (2 * Math.PI * (opts.centreHz + t.freqs[a]!)) / fs;
    const w2 = (2 * Math.PI * (opts.centreHz + t.freqs[b]!)) / fs;
    const start = symbolStart(k, fs, t.symbolLen);
    const len = symbolStart(k + 1, fs, t.symbolLen) - start;
    for (let i = 0; i < len; i++) {
      out[start + i] = (amp * throbPulse(i, len, t.pulse) * (Math.sin(w1 * i) + Math.sin(w2 * i))) / 2;
    }
  }
  return out;
}

export function throbDurationMs(text: string, opts: Pick<ThrobWaveformOptions, "mode">): number {
  return (throbSymbols(text, opts.mode).length * TABLE[opts.mode].symbolLen * 1000) / THROB_BASE_RATE;
}
