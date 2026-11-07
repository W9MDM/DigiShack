// Hellschreiber: Rudolf Hell's 1929 machine, as amateurs run it today, in six modes (below).
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

/**
 * A line as the page paints it: HELL_RX_ROWS bytes a column, bottom row first, two rows an
 * element, 255 ink and 0 paper. The bridge paints what we send with this, so it lines up
 * with what the receiver paints.
 */
export function hellPaintedColumns(text: string): Uint8Array {
  const cols = hellColumns(text);
  const out = new Uint8Array(cols.length * HELL_RX_ROWS);
  cols.forEach((col, c) => {
    for (let r = 0; r < HELL_RX_ROWS; r++) out[c * HELL_RX_ROWS + r] = col[Math.floor(r / 2)] ? 255 : 0;
  });
  return out;
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

// ---------------------------------------------------------------------------
// The Hell modes
// ---------------------------------------------------------------------------
//
// Every mode here paints the same 14-element column from the same font. They differ in
// how fast the columns go and in how an element is keyed. The figures are fldigi's
// (src/feld/feld.cxx), because fldigi is what the North American nets run:
//
//   Feld Hell     17.5 columns a second, carrier on for ink, off for paper
//   FM Hell-105   17.5, frequency shift keying, 55 Hz shift, ink on the LOWER tone
//   FM Hell-245   17.5, the same with a 122.5 Hz shift
//   Hell 80       35, frequency shift keying, 300 Hz shift, ink on the lower tone
//   Slow Hell     2.1875 (Feld Hell at an eighth of the speed), on and off
//   PSK Hell      17.5, a carrier that reverses phase at the start of an ink element
//
// fldigi has no PSK Hell. This one follows the description on hellschreiber.com ("an
// unchanged phase at the beginning of a pixel means white, and a reversed phase means
// black") at Feld Hell's element rate, and has only been checked against itself.

export type HellVariant = "feld" | "fm105" | "fm245" | "hell80" | "slow" | "psk";

export interface HellVariantSpec {
  id: HellVariant;
  /** What the page calls it. */
  label: string;
  /** Columns a second. */
  columnRate: number;
  keying: "am" | "fsk" | "psk";
  /** FSK only: the distance between the two tones, Hz. */
  shiftHz: number;
  /** About how wide it is on the waterfall, Hz: fldigi's figure. */
  bandwidthHz: number;
  /** The longest line it will send at once, ms. */
  maxSendMs: number;
}

export const HELL_VARIANTS: readonly HellVariantSpec[] = [
  { id: "feld", label: "Feld Hell", columnRate: 17.5, keying: "am", shiftHz: 0, bandwidthHz: 245, maxSendMs: 40_000 },
  { id: "fm105", label: "FM Hell-105", columnRate: 17.5, keying: "fsk", shiftHz: 55, bandwidthHz: 55, maxSendMs: 40_000 },
  { id: "fm245", label: "FM Hell-245", columnRate: 17.5, keying: "fsk", shiftHz: 122.5, bandwidthHz: 122.5, maxSendMs: 40_000 },
  { id: "hell80", label: "Hell 80", columnRate: 35, keying: "fsk", shiftHz: 300, bandwidthHz: 300, maxSendMs: 40_000 },
  // A character takes 3.2 s, so 40 s is a dozen: room for a call and a report.
  { id: "slow", label: "Slow Hell", columnRate: 2.1875, keying: "am", shiftHz: 0, bandwidthHz: 31, maxSendMs: 120_000 },
  { id: "psk", label: "PSK Hell", columnRate: 17.5, keying: "psk", shiftHz: 0, bandwidthHz: 245, maxSendMs: 40_000 },
];

export function hellVariant(id: string | null | undefined): HellVariantSpec {
  return HELL_VARIANTS.find((v) => v.id === id) ?? HELL_VARIANTS[0]!;
}

export function isHellVariant(id: unknown): id is HellVariant {
  return typeof id === "string" && HELL_VARIANTS.some((v) => v.id === id);
}

export interface HellWaveformOptions {
  sampleRate: number;
  /** Carrier, Hz audio. Default 1000. FSK modes shift either side of it. */
  centreHz?: number;
  /** Peak amplitude. Default 1. */
  amplitude?: number;
  /** Default Feld Hell. */
  variant?: HellVariant;
}

export function hellDurationMs(text: string, variant: HellVariant = "feld"): number {
  return (hellColumns(text).length / hellVariant(variant).columnRate) * 1000;
}

/**
 * The keying, sample by sample, 0 paper to 1 ink, every edge a raised cosine one element
 * long centred on the element boundary. Square keying at 245 elements a second would
 * splatter clicks across kilohertz; shaped, Feld Hell stays within about 350 Hz.
 *
 * Built element by element rather than by convolving, which is the same shape: Slow Hell's
 * elements are 1,500 samples long, and a convolution that long over a two-minute line was
 * billions of multiplies.
 */
function shapedKeying(elements: boolean[], rate: number, fs: number, n: number, value: (ink: boolean, index: number) => number): Float32Array {
  const out = new Float32Array(n);
  const at = (e: number) => value(e >= 0 && e < elements.length ? elements[e]! : false, e);
  for (let i = 0; i < n; i++) {
    const pos = (i * rate) / fs;
    const e = Math.min(elements.length - 1, Math.floor(pos));
    const p = pos - e;
    const cur = at(e);
    if (p < 0.5) {
      const prev = at(e - 1);
      const t = p + 0.5;
      out[i] = prev + (cur - prev) * (0.5 - 0.5 * Math.cos(Math.PI * t));
    } else {
      const next = at(e + 1);
      const t = p - 0.5;
      out[i] = cur + (next - cur) * (0.5 - 0.5 * Math.cos(Math.PI * t));
    }
  }
  return out;
}

/**
 * The audio for a line, in any of the modes.
 *
 * - On and off: the carrier keyed by the shaped elements.
 * - FSK: a carrier that never stops, its frequency moved by the shaped elements, ink
 *   shift/2 below the centre and paper shift/2 above, the phase continuous throughout.
 * - PSK: the carrier's sign flips at each ink element; shaped, the amplitude passes
 *   through zero at a reversal and stays full where nothing changes.
 *
 * Every line starts and ends on a character of paper, so the FSK and PSK carriers are
 * brought up and down over one element at each end instead of starting with a click.
 */
export function hellWaveform(text: string, opts: HellWaveformOptions): Float32Array {
  const fs = opts.sampleRate;
  const fc = opts.centreHz ?? HELL_CENTRE_HZ;
  const amp = opts.amplitude ?? 1;
  const v = hellVariant(opts.variant);
  const rate = v.columnRate * HELL_COLUMN_ELEMENTS;
  const elements = hellColumns(text).flat();
  const n = Math.round((elements.length / rate) * fs);
  const out = new Float32Array(n);
  const ramp = Math.max(1, Math.round(fs / rate));
  const edge = (i: number) => (i < ramp ? 0.5 - 0.5 * Math.cos((Math.PI * i) / ramp) : i >= n - ramp ? 0.5 - 0.5 * Math.cos((Math.PI * (n - 1 - i)) / ramp) : 1);

  if (v.keying === "am") {
    const key = shapedKeying(elements, rate, fs, n, (ink) => (ink ? 1 : 0));
    const w = (2 * Math.PI * fc) / fs;
    for (let i = 0; i < n; i++) out[i] = amp * key[i]! * Math.sin(w * i);
    return out;
  }
  if (v.keying === "fsk") {
    const key = shapedKeying(elements, rate, fs, n, (ink) => (ink ? 1 : 0));
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const f = fc + (v.shiftHz / 2) * (1 - 2 * key[i]!);
      phase += (2 * Math.PI * f) / fs;
      if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
      out[i] = amp * edge(i) * Math.sin(phase);
    }
    return out;
  }
  // PSK: the sign of each element, flipped by every ink element.
  const sign: number[] = [];
  let s = 1;
  for (const ink of elements) {
    if (ink) s = -s;
    sign.push(s);
  }
  const base = shapedKeying(elements, rate, fs, n, (_ink, e) => (e < 0 ? 1 : e >= sign.length ? sign[sign.length - 1]! : sign[e]!));
  const w = (2 * Math.PI * fc) / fs;
  for (let i = 0; i < n; i++) out[i] = amp * edge(i) * base[i]! * Math.sin(w * i);
  return out;
}

/**
 * The level over which the receiver reports a signal: above what noise alone reaches. Was
 * 16.5, from generated noise; band noise on 80 m reached 17 on the air, so 18.
 */
export const HELL_SIGNAL_DB = 18;

export interface HellDemodOptions {
  sampleRate: number;
  /** Carrier, Hz audio: the centre between the two tones in the FSK modes. */
  centreHz: number;
  /** Default Feld Hell. */
  variant?: HellVariant;
}

export interface HellDemodStats {
  columns: number;
  /**
   * How far a signal stands out, dB. On and off: peak over the noise floor; noise alone
   * reads 13 to 15, text at 0 dB S/N about 18. FSK and PSK: the same scale, from how
   * steadily the carrier's phase moves (see `coherenceDb`).
   */
  levelDb: number;
  /** Whether something keyed is there now. */
  signal: boolean;
}

/**
 * The receiver. Mix the carrier to zero and low-pass with two boxcars, an element and half
 * an element long, then paint HELL_RX_ROWS rows a column on a free-running clock. What a
 * row's ink is depends on the keying:
 *
 * - On and off: the magnitude, an AM detector, scaled between a peak follower that falls
 *   slowly and a floor that rises slowly, so ink shows against paper at any strength.
 * - FSK: the frequency, from the phase turned over half an element (fldigi's FSKH_rx does
 *   the same over one sample). Ink at shift/2 below the centre, paper at shift/2 above.
 * - PSK: the phase against one element earlier. Reversed is ink, unchanged is paper.
 *
 * feed() returns no text - nothing is decoded - and the painted columns are collected
 * with takeColumns().
 */
export class HellDemodulator {
  private readonly fs: number;
  private readonly v: HellVariantSpec;
  private phase = 0;
  private dphi: number;
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
  /** FSK and PSK: the filtered signal, `lag` samples back. */
  private readonly lag: number;
  private readonly histI: Float32Array;
  private readonly histQ: Float32Array;
  private ph = 0;
  /** Samples per painted row, fractional; the accumulator carries the remainder. */
  private readonly perRow: number;
  private rowClock = 0;
  private rowAcc = 0;
  private rowRe = 0;
  private rowIm = 0;
  private rowMag = 0;
  private rowN = 0;
  private column = new Float32Array(HELL_RX_ROWS);
  private row = 0;
  private peak = 1e-6;
  private floor = 1e-6;
  private readonly peakDecay: number;
  /** FSK and PSK: how steadily the phase moves, averaged over about a second of rows. */
  private coherence = 0;
  /** The same, quicker: how dark the page is painted. */
  private contrast = 0;
  private readonly coherenceAlpha: number;
  private pending: number[] = [];
  private columns = 0;

  constructor(opts: HellDemodOptions) {
    this.fs = opts.sampleRate;
    this.v = hellVariant(opts.variant);
    const elementRate = this.v.columnRate * HELL_COLUMN_ELEMENTS;
    this.dphi = (2 * Math.PI * opts.centreHz) / this.fs;
    this.b1 = Math.max(1, Math.round(this.fs / elementRate));
    this.b2 = Math.max(1, Math.round(this.fs / (2 * elementRate)));
    this.ring1i = new Float32Array(this.b1);
    this.ring1q = new Float32Array(this.b1);
    this.ring2i = new Float32Array(this.b2);
    this.ring2q = new Float32Array(this.b2);
    this.lag = this.v.keying === "psk" ? this.b1 : this.b2;
    this.histI = new Float32Array(this.lag);
    this.histQ = new Float32Array(this.lag);
    const rowRate = this.v.columnRate * HELL_RX_ROWS;
    this.perRow = this.fs / rowRate;
    // The peak falls by half in about two seconds of rows, or four columns if that is
    // longer: Slow Hell paints a column every half second.
    const halfLifeRows = Math.max(2 * rowRate, 4 * HELL_RX_ROWS);
    this.peakDecay = Math.exp(Math.log(0.5) / halfLifeRows);
    this.coherenceAlpha = 1 / Math.max(rowRate, 4 * HELL_RX_ROWS);
  }

  get variant(): HellVariant {
    return this.v.id;
  }

  retune(centreHz: number): void {
    this.dphi = (2 * Math.PI * centreHz) / this.fs;
  }

  get statistics(): Readonly<HellDemodStats> {
    const levelDb =
      this.v.keying === "am"
        ? 20 * Math.log10(Math.max(this.peak, 1e-9) / Math.max(this.floor, 1e-9))
        : coherenceDb(this.coherence);
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
    const am = this.v.keying === "am";
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
      if (am) {
        this.rowAcc += Math.sqrt(i2 * i2 + q2 * q2);
      } else {
        // PSK takes the element-long boxcar alone, the matched filter for an element: the
        // second stage spreads a reversal over an element and a half, and back-to-back ink
        // elements bled into each other (89.6% painted right on a clean signal).
        const zi = this.v.keying === "psk" ? i1 : i2;
        const zq = this.v.keying === "psk" ? q1 : q2;
        // conj(then) * now: its angle is how far the phase turned over `lag` samples.
        const ti = this.histI[this.ph]!;
        const tq = this.histQ[this.ph]!;
        this.rowRe += ti * zi + tq * zq;
        this.rowIm += ti * zq - tq * zi;
        this.rowMag += Math.sqrt((ti * ti + tq * tq) * (zi * zi + zq * zq));
        this.histI[this.ph] = zi;
        this.histQ[this.ph] = zq;
        this.ph = (this.ph + 1) % this.lag;
      }
      this.rowN++;
      this.rowClock += 1;
      if (this.rowClock >= this.perRow) {
        this.rowClock -= this.perRow;
        if (am) this.endRowAm(this.rowAcc / this.rowN);
        else this.endRowPhase();
        this.rowAcc = 0;
        this.rowRe = 0;
        this.rowIm = 0;
        this.rowMag = 0;
        this.rowN = 0;
      }
    }
    return "";
  }

  private endRowAm(m: number): void {
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

  private endRowPhase(): void {
    const mag = Math.hypot(this.rowRe, this.rowIm);
    const c = this.rowMag > 0 ? mag / this.rowMag : 0;
    this.coherence += (c - this.coherence) * this.coherenceAlpha;
    // Four times quicker, both ways: quick enough that the first characters of a call are
    // not drawn pale, and symmetric so that noise's upward flickers do not ratchet it up.
    this.contrast += (c - this.contrast) * Math.min(1, this.coherenceAlpha * 4);
    let ink: number;
    if (this.v.keying === "fsk") {
      // Hz: the angle over `lag` samples. Ink at -shift/2, paper at +shift/2.
      const f = (Math.atan2(this.rowIm, this.rowRe) * this.fs) / (2 * Math.PI * this.lag);
      ink = 0.5 - f / this.v.shiftHz;
    } else {
      // Reversed against an element ago is ink.
      ink = mag > 0 ? 0.5 - (0.5 * this.rowRe) / mag : 0;
    }
    // Noise turns the phase at random, and painted at full contrast it is snow - half the
    // page ink. Without a signal (the level, which is slow) the page is drawn towards paper.
    // Not all the way, so a station coming up out of the noise still shows.
    const sure = Math.max(0.25, Math.min(1, (coherenceDb(this.contrast) - 12) / 6));
    this.column[this.row++] = Math.max(0, Math.min(1, ink)) * sure;
    if (this.row < HELL_RX_ROWS) return;
    this.row = 0;
    this.columns++;
    for (let r = 0; r < HELL_RX_ROWS; r++) this.pending.push(Math.round(this.column[r]! * 255));
  }
}

/**
 * The FSK and PSK receivers' signal level, on the on-and-off receiver's scale.
 *
 * A clean carrier turns its phase steadily, so the products the receiver sums all point
 * the same way and their sum is as long as their lengths added (coherence 1). Noise points
 * them anywhere (coherence near 0, though the low-pass keeps neighbouring samples alike, so
 * not all the way). Mapped so that noise alone lands under HELL_SIGNAL_DB and a readable
 * signal over it; the constants are from check:hell's measurements.
 */
export function coherenceDb(c: number): number {
  const x = Math.max(1e-6, Math.min(0.999999, c));
  return 10 * Math.log10(x / (1 - x)) + HELL_COHERENCE_OFFSET_DB;
}

/** See coherenceDb. */
export const HELL_COHERENCE_OFFSET_DB = 5;
