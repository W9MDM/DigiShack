// RTTY - the ITA2 (Baudot) code, the asynchronous character frame, and the FSK waveform.
//
// WHAT RTTY IS. Five-bit characters sent asynchronously, one at a time, with no error
// correction and no framing beyond the character itself: a START bit (space), five data
// bits least-significant first, and a STOP of one and a half bits (mark). At the amateur
// standard of 45.45 baud each bit is 22 ms, so a character is 165 ms and a line of text
// takes a few seconds; the line idles on mark between characters. The two tones are
// 170 Hz apart. Everything about it is from the 1930s, which is the point: there is
// nothing to negotiate and every RTTY program on earth decodes every other.
//
// THE CODE. ITA2 has 32 values and two shift states, LETTERS and FIGURES, selected by the
// shift characters LTRS (31) and FIGS (27). A value means one thing in each shift, so "1"
// is FIGS then the code that means Q in letters. Digits and punctuation live in figures;
// the figures table has national variants, and amateur software settled on the US TTY
// set (`$ ! & # ; "`), which is what this uses by default, with plain ITA2 as an option.
//
// UNSHIFT ON SPACE. A convention, not part of the code: a space returns the receiver to
// letters. Nearly every amateur program has it on by default, because a missed LTRS after
// a serial number otherwise turns the next word into figures. The encoder here always
// assumes the receiver unshifts on space - it re-sends FIGS after a space whenever the
// next character needs it, which costs one character and is correct whether the far end
// unshifts or not. The decoder unshifts by default and can be told not to.
//
// THE FRAME IS ALL THE SYNC THERE IS. There is no preamble to find and no sync vector:
// the receiver waits on the idle mark for the mark-to-space edge of a start bit, samples
// the five data bits at their centres from that edge, and checks that the stop bit is
// mark. A bad stop bit is a framing error and the receiver goes back to waiting. That is
// the whole of lib/digital/rttydemod.ts, and it is why RTTY survives a sloppy clock: the
// clock only has to hold for one character.
//
// MARK, SPACE AND SIDEBANDS. By convention mark is the HIGHER radio frequency. With the
// classic audio tones of 2125 Hz (mark) and 2295 Hz (space) that is true on lower
// sideband, which is why RTTY was always "LSB". On upper sideband - which is what a data
// mode on a FlexRadio is, DIGU - the same convention puts mark at the higher AUDIO
// frequency, so the tone pair is centre + 85 (mark) and centre - 85 (space). `rttyTones`
// does that arithmetic once so nothing else has to think about it, and a "reversed"
// signal is exactly a sideband mismatch.
//
// These tables are the ITA2 standard and the US TTY figures variant as MMTTY and fldigi
// ship them; the frame and timing numbers are the amateur standard (45.45 baud, 170 Hz,
// 1.5 stop bits). There is no reference binary for a code this old; the checks assert the
// tables against their published values and the frame against the RY test pattern that
// every RTTY operator knows by ear.

/** Bits per second. 1000 / 22: a 22 ms bit, which is the number people quote as 45.45. */
export const RTTY_BAUD = 1000 / 22;
/** Milliseconds per bit at the standard speed. */
export const RTTY_BIT_MS = 22;
/** Standard amateur shift between the two tones, Hz. */
export const RTTY_SHIFT_HZ = 170;
/** The classic audio tone pair, centred where RTTY audio has always sat. */
export const RTTY_CENTRE_HZ = 2210;
export const RTTY_DATA_BITS = 5;
export const RTTY_STOP_BITS = 1.5;
/** Start + five data + one and a half stop. */
export const RTTY_BITS_PER_CHAR = 1 + RTTY_DATA_BITS + RTTY_STOP_BITS;

export const ITA2_NULL = 0;
export const ITA2_LF = 2;
export const ITA2_SPACE = 4;
export const ITA2_CR = 8;
export const ITA2_FIGS = 27;
export const ITA2_LTRS = 31;

/**
 * The LETTERS case, indexed by code value with bit 1 (sent first) as the least
 * significant bit. Shift and control codes are the empty string; `rttyCodeName` names
 * them for display.
 */
export const ITA2_LETTERS: readonly string[] = [
  "", // 0 NUL
  "E",
  "\n", // 2 LF
  "A",
  " ",
  "S",
  "I",
  "U",
  "\r", // 8 CR
  "D",
  "R",
  "J",
  "N",
  "F",
  "C",
  "K",
  "T",
  "Z",
  "L",
  "W",
  "H",
  "Y",
  "P",
  "Q",
  "O",
  "B",
  "G",
  "", // 27 FIGS
  "M",
  "X",
  "V",
  "", // 31 LTRS
];

/** The FIGURES case as US amateur software uses it (MMTTY, fldigi): `$ ! & # ; "`. */
export const ITA2_FIGURES_US: readonly string[] = [
  "", // 0 NUL
  "3",
  "\n",
  "-",
  " ",
  "\x07", // 5 BELL
  "8",
  "7",
  "\r",
  "$",
  "4",
  "'",
  ",",
  "!",
  ":",
  "(",
  "5",
  '"',
  ")",
  "2",
  "#",
  "6",
  "0",
  "1",
  "9",
  "?",
  "&",
  "", // 27 FIGS
  ".",
  "/",
  ";",
  "", // 31 LTRS
];

/** The FIGURES case of ITA2 itself: `' WRU BELL + =` where the US set has `BELL $ ' " ;`. */
export const ITA2_FIGURES_ITA2: readonly string[] = [
  "",
  "3",
  "\n",
  "-",
  " ",
  "'",
  "8",
  "7",
  "\r",
  "\x05", // 9 WRU (ENQ)
  "4",
  "\x07", // 11 BELL
  ",",
  "!", // 13 national; fldigi and MMTTY both put ! here
  ":",
  "(",
  "5",
  "+",
  ")",
  "2",
  "#", // 20 national
  "6",
  "0",
  "1",
  "9",
  "?",
  "&", // 26 national
  "",
  ".",
  "/",
  "=",
  "",
];

export type RttyFigures = "us" | "ita2";

export function rttyFiguresTable(variant: RttyFigures): readonly string[] {
  return variant === "ita2" ? ITA2_FIGURES_ITA2 : ITA2_FIGURES_US;
}

/** A readable name for a code, for logs and tests: "LTRS", "FIGS", "CR", "NUL", or the char. */
export function rttyCodeName(code: number, shift: "letters" | "figures" = "letters", variant: RttyFigures = "us"): string {
  if (code === ITA2_LTRS) return "LTRS";
  if (code === ITA2_FIGS) return "FIGS";
  if (code === ITA2_NULL) return "NUL";
  if (code === ITA2_CR) return "CR";
  if (code === ITA2_LF) return "LF";
  if (code === ITA2_SPACE) return "SP";
  const t = shift === "letters" ? ITA2_LETTERS : rttyFiguresTable(variant);
  return t[code] ?? "?";
}

export interface RttyCodeOptions {
  /** Which figures set. Default "us", the amateur convention. */
  figures?: RttyFigures;
  /**
   * Unshift on space. Decoder: a space returns to letters (default true). Encoder: the
   * receiver is assumed to do so, so FIGS is re-sent after a space when needed (always,
   * because that is correct for both kinds of receiver).
   */
  usos?: boolean;
}

type Shift = "letters" | "figures";

/**
 * Text to ITA2 codes, with the shift codes the receiver will need. Lower case is sent
 * as upper (ITA2 has no case); a newline becomes CR LF; characters in neither table are
 * dropped. The first printable character is preceded by its shift unless `initial` says
 * the receiver is already there.
 */
export function rttyEncodeText(text: string, opts: RttyCodeOptions = {}, initial: Shift | null = null): number[] {
  const figures = rttyFiguresTable(opts.figures ?? "us");
  const out: number[] = [];
  let shift: Shift | null = initial;
  for (const raw of text.toUpperCase()) {
    if (raw === "\n") {
      out.push(ITA2_CR, ITA2_LF);
      continue;
    }
    if (raw === "\r") continue;
    if (raw === " ") {
      out.push(ITA2_SPACE);
      // The receiver may unshift here; the next figure must re-shift. Letters is the
      // safe assumption either way.
      if (shift === "figures") shift = "letters";
      continue;
    }
    const inLetters = ITA2_LETTERS.indexOf(raw);
    const inFigures = figures.indexOf(raw);
    // Prefer the current shift when a character exists in both (only the controls do).
    let code: number;
    let need: Shift;
    if (inLetters > 0 && (shift !== "figures" || inFigures <= 0)) {
      code = inLetters;
      need = "letters";
    } else if (inFigures > 0) {
      code = inFigures;
      need = "figures";
    } else {
      continue;
    }
    if (shift !== need) {
      out.push(need === "letters" ? ITA2_LTRS : ITA2_FIGS);
      shift = need;
    }
    out.push(code);
  }
  return out;
}

/**
 * A streaming ITA2 decoder: feed it codes as they arrive, get text back, with the shift
 * state carried between calls because a shift character outlives the call that saw it.
 */
export class Ita2Decoder {
  private shift: Shift = "letters";
  private readonly figures: readonly string[];
  private readonly usos: boolean;

  constructor(opts: RttyCodeOptions = {}) {
    this.figures = rttyFiguresTable(opts.figures ?? "us");
    this.usos = opts.usos ?? true;
  }

  get currentShift(): Shift {
    return this.shift;
  }

  reset(): void {
    this.shift = "letters";
  }

  /** The text one code produces: "", one character, or (for CR) nothing, LF being the newline. */
  push(code: number): string {
    if (code === ITA2_LTRS) {
      this.shift = "letters";
      return "";
    }
    if (code === ITA2_FIGS) {
      this.shift = "figures";
      return "";
    }
    if (code === ITA2_NULL || code === ITA2_CR) return "";
    if (code === ITA2_LF) return "\n";
    if (code === ITA2_SPACE) {
      if (this.usos) this.shift = "letters";
      return " ";
    }
    const t = this.shift === "letters" ? ITA2_LETTERS : this.figures;
    return t[code & 31] ?? "";
  }

  pushAll(codes: Iterable<number>): string {
    let s = "";
    for (const c of codes) s += this.push(c);
    return s;
  }
}

/** Codes to text in one go. */
export function rttyDecodeCodes(codes: Iterable<number>, opts: RttyCodeOptions = {}): string {
  return new Ita2Decoder(opts).pushAll(codes);
}

/**
 * One character as the line sees it: a run of levels and durations in bits. 1 is mark,
 * 0 is space. Start bit, five data bits least-significant first, then the stop.
 */
export function rttyCharacterFrame(code: number): { level: 0 | 1; bits: number }[] {
  const f: { level: 0 | 1; bits: number }[] = [{ level: 0, bits: 1 }];
  for (let b = 0; b < RTTY_DATA_BITS; b++) f.push({ level: ((code >> b) & 1) as 0 | 1, bits: 1 });
  f.push({ level: 1, bits: RTTY_STOP_BITS });
  return f;
}

/** The data bits of a code in the order they go on the line, for tests and displays. */
export function rttyDataBits(code: number): (0 | 1)[] {
  const bits: (0 | 1)[] = [];
  for (let b = 0; b < RTTY_DATA_BITS; b++) bits.push(((code >> b) & 1) as 0 | 1);
  return bits;
}

export type Sideband = "USB" | "LSB";

/**
 * The audio frequencies of mark and space for a centre, a shift and a sideband. Mark is
 * the higher RADIO frequency by convention, so on USB it is the higher audio tone and on
 * LSB the lower.
 */
export function rttyTones(centreHz: number, shiftHz: number = RTTY_SHIFT_HZ, sideband: Sideband = "USB"): { markHz: number; spaceHz: number } {
  const half = shiftHz / 2;
  return sideband === "USB"
    ? { markHz: centreHz + half, spaceHz: centreHz - half }
    : { markHz: centreHz - half, spaceHz: centreHz + half };
}

export interface RttyWaveformOptions extends RttyCodeOptions {
  sampleRate: number;
  /** Centre of the tone pair, Hz audio. Default 2210, the classic pair's centre. */
  centreHz?: number;
  shiftHz?: number;
  sideband?: Sideband;
  baud?: number;
  /** Mark tone before the first character, so the far end's filters settle. Default 300. */
  preambleMs?: number;
  /** Mark after the last character. Default one character time. */
  tailMs?: number;
  /** Peak amplitude. Default 1. */
  amplitude?: number;
  /** LTRS characters sent before the text. Default 2, as every RTTY program does. */
  leadingLtrs?: number;
}

/**
 * The audio of a text: mark preamble, LTRS LTRS, the characters, LTRS, a mark tail.
 * Phase-continuous FSK, so the signal has no clicks and stays inside its 170 Hz.
 *
 * Bit boundaries are placed on an exact fractional sample grid (22 ms is 264.0264 samples
 * at 12 kHz), so a long transmission neither gains nor loses time against a receiver's
 * clock: each bit is rounded individually but the error never accumulates.
 */
export function rttyWaveform(text: string, opts: RttyWaveformOptions): Float32Array {
  const fs = opts.sampleRate;
  const { markHz, spaceHz } = rttyTones(opts.centreHz ?? RTTY_CENTRE_HZ, opts.shiftHz ?? RTTY_SHIFT_HZ, opts.sideband ?? "USB");
  const baud = opts.baud ?? RTTY_BAUD;
  const samplesPerBit = fs / baud;
  const amp = opts.amplitude ?? 1;
  const leading = opts.leadingLtrs ?? 2;

  const codes: number[] = [];
  for (let i = 0; i < leading; i++) codes.push(ITA2_LTRS);
  codes.push(...rttyEncodeText(text, opts, "letters"));
  codes.push(ITA2_LTRS);

  // The level schedule in BITS, then rendered on the sample grid.
  const runs: { level: 0 | 1; bits: number }[] = [];
  const preBits = ((opts.preambleMs ?? 300) / 1000) * baud;
  if (preBits > 0) runs.push({ level: 1, bits: preBits });
  for (const c of codes) runs.push(...rttyCharacterFrame(c));
  const tailBits = ((opts.tailMs ?? RTTY_BITS_PER_CHAR * RTTY_BIT_MS) / 1000) * baud;
  if (tailBits > 0) runs.push({ level: 1, bits: tailBits });

  let totalBits = 0;
  for (const r of runs) totalBits += r.bits;
  const total = Math.round(totalBits * samplesPerBit);
  const out = new Float32Array(total);

  let phase = 0;
  let n = 0;
  let bitPos = 0;
  for (const r of runs) {
    bitPos += r.bits;
    const end = Math.min(total, Math.round(bitPos * samplesPerBit));
    const f = r.level === 1 ? markHz : spaceHz;
    const dphi = (2 * Math.PI * f) / fs;
    for (; n < end; n++) {
      out[n] = amp * Math.sin(phase);
      phase += dphi;
      if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
    }
  }
  return out;
}

/** How long a text takes on the air at the standard speed, ms, including the preamble and tail this module adds. */
export function rttyDurationMs(text: string, opts: Partial<RttyWaveformOptions> = {}): number {
  const baud = opts.baud ?? RTTY_BAUD;
  const leading = opts.leadingLtrs ?? 2;
  const chars = leading + rttyEncodeText(text, opts, "letters").length + 1;
  const bits = chars * RTTY_BITS_PER_CHAR;
  return (opts.preambleMs ?? 300) + (bits / baud) * 1000 + (opts.tailMs ?? RTTY_BITS_PER_CHAR * RTTY_BIT_MS);
}
