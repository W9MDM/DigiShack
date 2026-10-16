// Feld Hell: Rudolf Hell's 1929 Hellschreiber, as amateurs run it today.
//
// Text is not encoded at all. Each character is a little bitmap, sent one column at a
// time, bottom to top, by switching a single carrier on and off: on is ink, off is paper.
// The receiver does not decode anything either - it paints what it hears, a column at a
// time, and the operator's eye reads it. That is the mode's whole appeal: noise is
// specks on the page, a fade is a pale patch, and text stays readable through both long
// after a decoder would print garbage.
//
// The numbers (Feld Hell, as the Feld Hell Club and fldigi run it):
//   - a column is 14 elements tall; an element is 1/245 s (4.08 ms);
//   - a column is 14 elements, so 17.5 columns a second;
//   - a character is 7 columns (glyph and space), so 2.5 characters a second.
// "122.5 baud" is the same thing quoted per pair of elements, the font's own pixel.
//
// The receiver's clock runs free. If the two ends' clocks differ, lines slant; if the
// receiver starts mid-column, a character is split between the bottom of one column and
// the top of the next. Hell receivers have always drawn each column twice, one copy above
// the other, so that a whole character is always somewhere in the pair - the eye picks
// it out. The page here does the same.

/** Elements in a column. */
export const HELL_COLUMN_ELEMENTS = 14;
/** Elements a second. */
export const HELL_ELEMENT_RATE = 245;
/** Columns a second: 17.5. */
export const HELL_COLUMN_RATE = HELL_ELEMENT_RATE / HELL_COLUMN_ELEMENTS;
/** Columns a character: five of glyph, two of space. */
export const HELL_CHAR_COLUMNS = 7;
/** Where the carrier sits, Hz audio, unless told otherwise. */
export const HELL_CENTRE_HZ = 1000;
/** Rows the receiver paints per column: two per element, so a column lands where it lands. */
export const HELL_RX_ROWS = HELL_COLUMN_ELEMENTS * 2;

/**
 * The font: 5 by 7, uppercase, the shapes every 5x7 character display has used. Hell is
 * traditionally all capitals, and lowercase is sent as capitals. Zero is slashed, as hams
 * write it. Rows top to bottom.
 */
const GLYPHS: Record<string, string> = {
  A: ".###. #...# #...# ##### #...# #...# #...#",
  B: "####. #...# #...# ####. #...# #...# ####.",
  C: ".###. #...# #.... #.... #.... #...# .###.",
  D: "####. #...# #...# #...# #...# #...# ####.",
  E: "##### #.... #.... ####. #.... #.... #####",
  F: "##### #.... #.... ####. #.... #.... #....",
  G: ".###. #...# #.... #.### #...# #...# .####",
  H: "#...# #...# #...# ##### #...# #...# #...#",
  I: ".###. ..#.. ..#.. ..#.. ..#.. ..#.. .###.",
  J: "..### ...#. ...#. ...#. ...#. #..#. .##..",
  K: "#...# #..#. #.#.. ##... #.#.. #..#. #...#",
  L: "#.... #.... #.... #.... #.... #.... #####",
  M: "#...# ##.## #.#.# #.#.# #...# #...# #...#",
  N: "#...# #...# ##..# #.#.# #..## #...# #...#",
  O: ".###. #...# #...# #...# #...# #...# .###.",
  P: "####. #...# #...# ####. #.... #.... #....",
  Q: ".###. #...# #...# #...# #.#.# #..#. .##.#",
  R: "####. #...# #...# ####. #.#.. #..#. #...#",
  S: ".#### #.... #.... .###. ....# ....# ####.",
  T: "##### ..#.. ..#.. ..#.. ..#.. ..#.. ..#..",
  U: "#...# #...# #...# #...# #...# #...# .###.",
  V: "#...# #...# #...# #...# #...# .#.#. ..#..",
  W: "#...# #...# #...# #.#.# #.#.# #.#.# .#.#.",
  X: "#...# #...# .#.#. ..#.. .#.#. #...# #...#",
  Y: "#...# #...# .#.#. ..#.. ..#.. ..#.. ..#..",
  Z: "##### ....# ...#. ..#.. .#... #.... #####",
  "0": ".###. #...# #..## #.#.# ##..# #...# .###.",
  "1": "..#.. .##.. ..#.. ..#.. ..#.. ..#.. .###.",
  "2": ".###. #...# ....# ...#. ..#.. .#... #####",
  "3": "##### ...#. ..#.. ...#. ....# #...# .###.",
  "4": "...#. ..##. .#.#. #..#. ##### ...#. ...#.",
  "5": "##### #.... ####. ....# ....# #...# .###.",
  "6": "..##. .#... #.... ####. #...# #...# .###.",
  "7": "##### ....# ...#. ..#.. .#... .#... .#...",
  "8": ".###. #...# #...# .###. #...# #...# .###.",
  "9": ".###. #...# #...# .#### ....# ...#. .##..",
  ".": "..... ..... ..... ..... ..... .##.. .##..",
  ",": "..... ..... ..... ..... .##.. ..#.. .#...",
  "?": ".###. #...# ....# ...#. ..#.. ..... ..#..",
  "/": "..... ....# ...#. ..#.. .#... #.... .....",
  "-": "..... ..... ..... ##### ..... ..... .....",
  "=": "..... ..... ##### ..... ##### ..... .....",
  ":": "..... .##.. .##.. ..... .##.. .##.. .....",
  ";": "..... .##.. .##.. ..... .##.. ..#.. .#...",
  "'": "..#.. ..#.. .#... ..... ..... ..... .....",
  '"': ".#.#. .#.#. .#.#. ..... ..... ..... .....",
  "(": "...#. ..#.. .#... .#... .#... ..#.. ...#.",
  ")": ".#... ..#.. ...#. ...#. ...#. ..#.. .#...",
  "+": "..... ..#.. ..#.. ##### ..#.. ..#.. .....",
  "*": "..... ..#.. #.#.# .###. #.#.# ..#.. .....",
  "@": ".###. #...# ....# .##.# #.#.# #.#.# .###.",
  "!": "..#.. ..#.. ..#.. ..#.. ..#.. ..... ..#..",
  "#": ".#.#. .#.#. ##### .#.#. ##### .#.#. .#.#.",
  "&": ".##.. #..#. #.#.. .#... #.#.# #..#. .##.#",
  "<": "...#. ..#.. .#... #.... .#... ..#.. ...#.",
  ">": ".#... ..#.. ...#. ....# ...#. ..#.. .#...",
  _: "..... ..... ..... ..... ..... ..... #####",
  " ": "..... ..... ..... ..... ..... ..... .....",
};

/**
 * How many elements each font row takes, bottom row first. Seven rows into twelve
 * elements, with one element of paper above and below so stacked lines do not touch:
 * the outer rows and the middle pair get two, the two in between one each.
 */
const ROW_ELEMENTS = [2, 2, 1, 2, 1, 2, 2];

/** A character's columns: HELL_CHAR_COLUMNS of them, each HELL_COLUMN_ELEMENTS on/off, bottom first. */
const columnCache = new Map<string, boolean[][]>();

export function hellGlyphColumns(ch: string): boolean[][] {
  const key = ch.toUpperCase();
  const cached = columnCache.get(key);
  if (cached) return cached;
  const rows = (GLYPHS[key] ?? GLYPHS["?"]!).split(" ");
  const cols: boolean[][] = [];
  for (let c = 0; c < HELL_CHAR_COLUMNS; c++) {
    const col: boolean[] = [false];
    for (let r = 0; r < 7; r++) {
      const ink = c < 5 && rows[6 - r]![c] === "#";
      for (let k = 0; k < ROW_ELEMENTS[r]!; k++) col.push(ink);
    }
    col.push(false);
    cols.push(col);
  }
  columnCache.set(key, cols);
  return cols;
}

/** Whether the font has this character; others are sent as a question mark. */
export function hellHasGlyph(ch: string): boolean {
  return ch.toUpperCase() in GLYPHS;
}

/** The whole line as columns, with a character's space of paper either side. */
export function hellColumns(text: string): boolean[][] {
  const out: boolean[][] = [];
  for (const ch of ` ${text.replace(/\s+/g, " ")} `) out.push(...hellGlyphColumns(ch));
  return out;
}

export interface HellWaveformOptions {
  sampleRate: number;
  /** Carrier, Hz audio. Default 1000. */
  centreHz?: number;
  /** Peak amplitude. Default 1. */
  amplitude?: number;
}

export function hellDurationMs(text: string): number {
  return (hellColumns(text).length / HELL_COLUMN_RATE) * 1000;
}

/**
 * The audio: the carrier keyed by the elements, each edge a raised cosine one element
 * long. Square keying at 245 elements a second would splatter clicks across kilohertz;
 * shaped, the signal stays within about 350 Hz, which is what a Feld Hell signal is.
 */
export function hellWaveform(text: string, opts: HellWaveformOptions): Float32Array {
  const fs = opts.sampleRate;
  const fc = opts.centreHz ?? HELL_CENTRE_HZ;
  const amp = opts.amplitude ?? 1;
  const cols = hellColumns(text);
  const elements = cols.length * HELL_COLUMN_ELEMENTS;
  const n = Math.round((elements / HELL_ELEMENT_RATE) * fs);
  // The keying, sample by sample.
  const key = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const e = Math.min(elements - 1, Math.floor((i * HELL_ELEMENT_RATE) / fs));
    key[i] = cols[Math.floor(e / HELL_COLUMN_ELEMENTS)]![e % HELL_COLUMN_ELEMENTS] ? 1 : 0;
  }
  // Smoothed by a raised cosine an element long: each edge becomes a half-cosine ramp.
  const len = Math.max(1, Math.round(fs / HELL_ELEMENT_RATE));
  const win = new Float32Array(len);
  let sum = 0;
  for (let k = 0; k < len; k++) {
    win[k] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (k + 0.5)) / len);
    sum += win[k]!;
  }
  const half = Math.floor(len / 2);
  const out = new Float32Array(n);
  const w = (2 * Math.PI * fc) / fs;
  for (let i = 0; i < n; i++) {
    let env = 0;
    for (let k = 0; k < len; k++) {
      const j = i + k - half;
      if (j >= 0 && j < n) env += key[j]! * win[k]!;
    }
    out[i] = amp * (env / sum) * Math.sin(w * i);
  }
  return out;
}

/**
 * The level over which the receiver reports a signal: above what noise alone reaches. Was
 * 16.5, from generated noise; band noise on 80 m reached 17 on the air, so 18.
 */
export const HELL_SIGNAL_DB = 18;

export interface HellDemodOptions {
  sampleRate: number;
  /** Carrier, Hz audio. */
  centreHz: number;
}

export interface HellDemodStats {
  columns: number;
  /** Peak over the noise floor, dB: noise alone reads 13 to 15, text at 0 dB S/N about 18. */
  levelDb: number;
  /** Whether something keyed is there now. */
  signal: boolean;
}

/**
 * The receiver. Mix the carrier to zero, low-pass, take the magnitude - an AM detector -
 * then sample it HELL_RX_ROWS times a column on a free-running clock. Levels are set by
 * the signal: a peak follower that falls slowly and a floor that rises slowly, so the
 * page shows ink against paper whatever the signal strength.
 *
 * feed() returns no text - nothing is decoded - and the painted columns are collected
 * with takeColumns().
 */
export class HellDemodulator {
  private readonly fs: number;
  private phase = 0;
  private dphi: number;
  // Two boxcars on I and Q: an element long, then half an element. About 250 Hz wide;
  // a station a hundred hertz off still paints, only paler.
  private readonly b1: number;
  private readonly b2: number;
  private readonly ring1i: Float32Array;
  private readonly ring1q: Float32Array;
  private readonly ring2i: Float32Array;
  private readonly ring2q: Float32Array;
  private p1 = 0;
  private p2 = 0;
  private s1i = 0;
  private s1q = 0;
  private s2i = 0;
  private s2q = 0;
  /** Samples per painted row, fractional; the accumulator carries the remainder. */
  private readonly perRow: number;
  private rowClock = 0;
  private rowAcc = 0;
  private rowN = 0;
  private column = new Float32Array(HELL_RX_ROWS);
  private row = 0;
  private peak = 1e-6;
  private floor = 1e-6;
  private readonly peakDecay: number;
  private pending: number[] = [];
  private columns = 0;

  constructor(opts: HellDemodOptions) {
    this.fs = opts.sampleRate;
    this.dphi = (2 * Math.PI * opts.centreHz) / this.fs;
    this.b1 = Math.max(1, Math.round(this.fs / HELL_ELEMENT_RATE));
    this.b2 = Math.max(1, Math.round(this.fs / (2 * HELL_ELEMENT_RATE)));
    this.ring1i = new Float32Array(this.b1);
    this.ring1q = new Float32Array(this.b1);
    this.ring2i = new Float32Array(this.b2);
    this.ring2q = new Float32Array(this.b2);
    this.perRow = this.fs / (HELL_COLUMN_RATE * HELL_RX_ROWS);
    // The peak falls by half in about two seconds of rows.
    this.peakDecay = Math.exp(Math.log(0.5) / (2 * HELL_COLUMN_RATE * HELL_RX_ROWS));
  }

  retune(centreHz: number): void {
    this.dphi = (2 * Math.PI * centreHz) / this.fs;
  }

  get statistics(): Readonly<HellDemodStats> {
    const levelDb = 20 * Math.log10(Math.max(this.peak, 1e-9) / Math.max(this.floor, 1e-9));
    return { columns: this.columns, levelDb, signal: levelDb >= HELL_SIGNAL_DB };
  }

  /** The columns painted since the last call, HELL_RX_ROWS bytes each, bottom row first; null if fewer than `min`. */
  takeColumns(min = 1): Uint8Array | null {
    if (this.pending.length < min * HELL_RX_ROWS) return null;
    const out = Uint8Array.from(this.pending);
    this.pending = [];
    return out;
  }

  feed(samples: ArrayLike<number>): string {
    for (let n = 0; n < samples.length; n++) {
      const x = samples[n]!;
      const i0 = x * Math.cos(this.phase);
      const q0 = -x * Math.sin(this.phase);
      this.phase += this.dphi;
      if (this.phase > 2 * Math.PI) this.phase -= 2 * Math.PI;
      this.s1i += i0 - this.ring1i[this.p1]!;
      this.s1q += q0 - this.ring1q[this.p1]!;
      this.ring1i[this.p1] = i0;
      this.ring1q[this.p1] = q0;
      this.p1 = (this.p1 + 1) % this.b1;
      const i1 = this.s1i / this.b1;
      const q1 = this.s1q / this.b1;
      this.s2i += i1 - this.ring2i[this.p2]!;
      this.s2q += q1 - this.ring2q[this.p2]!;
      this.ring2i[this.p2] = i1;
      this.ring2q[this.p2] = q1;
      this.p2 = (this.p2 + 1) % this.b2;
      const i2 = this.s2i / this.b2;
      const q2 = this.s2q / this.b2;
      this.rowAcc += Math.sqrt(i2 * i2 + q2 * q2);
      this.rowN++;
      this.rowClock += 1;
      if (this.rowClock >= this.perRow) {
        this.rowClock -= this.perRow;
        this.endRow(this.rowAcc / this.rowN);
        this.rowAcc = 0;
        this.rowN = 0;
      }
    }
    return "";
  }

  private endRow(m: number): void {
    // Peak: up at once, down slowly. Floor: down fast, up slowly - it settles low in the
    // spread of the paper between elements, which is most of a page of text. Not at the
    // minimum: noise dips deep now and then, and a floor on the dips made noise alone read
    // as a 25 dB signal.
    this.peak = m > this.peak ? m : this.peak * this.peakDecay;
    this.floor += (m - this.floor) * (m < this.floor ? 0.05 : 0.002);
    if (this.floor > this.peak) this.floor = this.peak;
    this.column[this.row++] = m;
    if (this.row < HELL_RX_ROWS) return;
    this.row = 0;
    this.columns++;
    // Ink scaled between the floor and the peak. Without a signal the two are close and
    // the page would show the noise at full contrast; a margin over the floor keeps it grey.
    const span = Math.max(this.peak - this.floor, this.floor * 2, 1e-9);
    for (let r = 0; r < HELL_RX_ROWS; r++) {
      const v = (this.column[r]! - this.floor) / span;
      this.pending.push(Math.max(0, Math.min(255, Math.round(v * 255))));
    }
  }
}
