// SSTV: the modes, the VIS header, an encoder, and a decoder from audio to pictures.
//
// Slow-scan television sends a picture as a frequency: 1500 Hz is black, 2300 Hz white,
// one pixel after another, a line at a time, with 1200 Hz sync pulses between lines. A
// transmission opens with the VIS header - a 1900 Hz leader, a 1200 Hz break, a second
// leader, then a code of seven bits and a parity bit at 30 ms a bit (1100 Hz a one, 1300 Hz
// a zero) between 1200 Hz start and stop bits - which names the mode, and so the line
// timing, the colour order and the picture size. The modes here are the ones heard on
// 14.230 and 7.171: Martin 1 and 2, Scottie 1, 2 and DX (red, green, blue lines), and
// Robot 36 and PD 90, 120 and 180 (luminance and colour difference, YCbCr).
//
// Timings are the published ones (the Dayton Paper, JL Barber N7CXI, 2000, as every
// decoder from MMSSTV to QSSTV uses them). The decoder demodulates frequency by mixing
// the audio down around 1900 Hz and differencing the phase, finds the VIS, and then reads
// each line where its sync pulse actually is - searched for near where the timing says it
// should be - so a sound card a little fast or slow at either end leans the picture by a
// line's worth of search rather than wrecking it. scripts/check-sstv.ts encodes test
// pictures in every mode and reads them back, clean, in noise and with a clock error.

export type SstvColour = "gbr" | "rgb" | "bw" | "ycc-robot" | "ycc-robot72" | "ycc-pd";

export interface SstvMode {
  name: string;
  vis: number;
  width: number;
  height: number;
  colour: SstvColour;
  /** Sync pulse at 1200 Hz, ms. */
  syncMs: number;
  /** Porch at 1500 Hz after the sync, ms. */
  porchMs: number;
  /** One colour component's scan, ms (Robot 36: the luminance scan). */
  scanMs: number;
  /** Separator between scans, ms (Martin/Scottie). */
  sepMs: number;
  /** One sync period, ms: a line, or for PD a pair of lines. */
  lineMs: number;
  /**
   * 2 for the half-height modes (Martin 3 and 4, Scottie 3 and 4, Robot 8 and 12 B/W):
   * each transmitted line fills two rows of the picture, so it keeps its shape.
   */
  lineHeight?: 2;
}

export const SSTV_MODES: readonly SstvMode[] = [
  { name: "Martin 1", vis: 44, width: 320, height: 256, colour: "gbr", syncMs: 4.862, porchMs: 0.572, scanMs: 146.432, sepMs: 0.572, lineMs: 446.446 },
  { name: "Martin 2", vis: 40, width: 320, height: 256, colour: "gbr", syncMs: 4.862, porchMs: 0.572, scanMs: 73.216, sepMs: 0.572, lineMs: 226.798 },
  { name: "Scottie 1", vis: 60, width: 320, height: 256, colour: "gbr", syncMs: 9, porchMs: 1.5, scanMs: 138.24, sepMs: 1.5, lineMs: 428.22 },
  { name: "Scottie 2", vis: 56, width: 320, height: 256, colour: "gbr", syncMs: 9, porchMs: 1.5, scanMs: 88.064, sepMs: 1.5, lineMs: 277.692 },
  { name: "Scottie DX", vis: 76, width: 320, height: 256, colour: "gbr", syncMs: 9, porchMs: 1.5, scanMs: 345.6, sepMs: 1.5, lineMs: 1050.3 },
  { name: "Robot 36", vis: 8, width: 320, height: 240, colour: "ycc-robot", syncMs: 9, porchMs: 3, scanMs: 88, sepMs: 4.5, lineMs: 150 },
  { name: "PD 90", vis: 99, width: 320, height: 256, colour: "ycc-pd", syncMs: 20, porchMs: 2.08, scanMs: 170.24, sepMs: 0, lineMs: 703.04 },
  { name: "PD 120", vis: 95, width: 640, height: 496, colour: "ycc-pd", syncMs: 20, porchMs: 2.08, scanMs: 121.6, sepMs: 0, lineMs: 508.48 },
  { name: "PD 180", vis: 96, width: 640, height: 496, colour: "ycc-pd", syncMs: 20, porchMs: 2.08, scanMs: 183.04, sepMs: 0, lineMs: 754.24 },
  { name: "PD 50", vis: 93, width: 320, height: 256, colour: "ycc-pd", syncMs: 20, porchMs: 2.08, scanMs: 91.52, sepMs: 0, lineMs: 388.16 },
  { name: "PD 160", vis: 98, width: 512, height: 400, colour: "ycc-pd", syncMs: 20, porchMs: 2.08, scanMs: 195.584, sepMs: 0, lineMs: 804.416 },
  { name: "PD 240", vis: 97, width: 640, height: 496, colour: "ycc-pd", syncMs: 20, porchMs: 2.08, scanMs: 244.48, sepMs: 0, lineMs: 1000 },
  { name: "PD 290", vis: 94, width: 800, height: 616, colour: "ycc-pd", syncMs: 20, porchMs: 2.08, scanMs: 228.8, sepMs: 0, lineMs: 937.28 },
  // Half-height: Martin 1 and 2's and Scottie 1 and 2's lines, 128 of them.
  { name: "Martin 3", vis: 36, width: 320, height: 256, colour: "gbr", syncMs: 4.862, porchMs: 0.572, scanMs: 146.432, sepMs: 0.572, lineMs: 446.446, lineHeight: 2 },
  { name: "Martin 4", vis: 32, width: 320, height: 256, colour: "gbr", syncMs: 4.862, porchMs: 0.572, scanMs: 73.216, sepMs: 0.572, lineMs: 226.798, lineHeight: 2 },
  { name: "Scottie 3", vis: 52, width: 320, height: 256, colour: "gbr", syncMs: 9, porchMs: 1.5, scanMs: 138.24, sepMs: 1.5, lineMs: 428.22, lineHeight: 2 },
  { name: "Scottie 4", vis: 48, width: 320, height: 256, colour: "gbr", syncMs: 9, porchMs: 1.5, scanMs: 88.064, sepMs: 1.5, lineMs: 277.692, lineHeight: 2 },
  // Robot 24 as slowrx reads it: Robot 36's lines under its own VIS code.
  { name: "Robot 24", vis: 4, width: 320, height: 240, colour: "ycc-robot", syncMs: 9, porchMs: 3, scanMs: 88, sepMs: 4.5, lineMs: 150 },
  // Robot 72: luminance 138 ms, then R-Y and B-Y at half width, 69 ms each, every line.
  { name: "Robot 72", vis: 12, width: 320, height: 240, colour: "ycc-robot72", syncMs: 9, porchMs: 3, scanMs: 138, sepMs: 4.5, lineMs: 300 },
  // Black and white Robot: a sync and a luminance scan.
  { name: "Robot 8 B/W", vis: 2, width: 320, height: 240, colour: "bw", syncMs: 7, porchMs: 0, scanMs: 59.9, sepMs: 0, lineMs: 66.9, lineHeight: 2 },
  { name: "Robot 12 B/W", vis: 6, width: 320, height: 240, colour: "bw", syncMs: 7, porchMs: 0, scanMs: 93.12, sepMs: 0, lineMs: 100.12, lineHeight: 2 },
  { name: "Robot 24 B/W", vis: 10, width: 320, height: 240, colour: "bw", syncMs: 7, porchMs: 0, scanMs: 93.12, sepMs: 0, lineMs: 100.12 },
  // Wraase SC-2: red, green, blue with no separators.
  { name: "Wraase SC2-180", vis: 55, width: 320, height: 256, colour: "rgb", syncMs: 5.5225, porchMs: 0.5, scanMs: 235, sepMs: 0, lineMs: 711.0225 },
  { name: "Wraase SC2-120", vis: 63, width: 320, height: 256, colour: "rgb", syncMs: 5.5225, porchMs: 0.5, scanMs: 156.5025, sepMs: 0, lineMs: 475.530018 },
  // Pasokon: red, green, blue, each followed by a gap the length of the porch.
  { name: "Pasokon P3", vis: 113, width: 640, height: 496, colour: "rgb", syncMs: 5.208, porchMs: 1.042, scanMs: 133.333, sepMs: 1.042, lineMs: 409.375 },
  { name: "Pasokon P5", vis: 114, width: 640, height: 496, colour: "rgb", syncMs: 7.813, porchMs: 1.563, scanMs: 200, sepMs: 1.563, lineMs: 614.065 },
  { name: "Pasokon P7", vis: 115, width: 640, height: 496, colour: "rgb", syncMs: 10.417, porchMs: 2.083, scanMs: 266.666, sepMs: 2.083, lineMs: 818.747 },
];

/**
 * VIS codes heard on the air for modes not decoded here, so a header that cannot be drawn
 * at least says what it was. From the Dayton Paper and MMSSTV's list.
 */
export const SSTV_OTHER_VIS: Readonly<Record<number, string>> = {
  0: "Robot 12", 59: "Wraase SC2-60", 51: "Wraase SC2-30",
  35: "MMSSTV extended (MP/MR/ML modes)",
};

export function sstvVisName(code: number): string {
  return sstvModeByVis(code)?.name ?? SSTV_OTHER_VIS[code] ?? `unknown (VIS ${code})`;
}

export function sstvModeByVis(vis: number): SstvMode | null {
  return SSTV_MODES.find((m) => m.vis === vis) ?? null;
}

export function sstvModeByName(name: string): SstvMode | null {
  const n = name.toLowerCase().replace(/\s+/g, "");
  return SSTV_MODES.find((m) => m.name.toLowerCase().replace(/\s+/g, "") === n) ?? null;
}

/** Sync periods in a picture: lines, or pairs of lines for PD. */
export function sstvSyncPeriods(mode: SstvMode): number {
  return mode.colour === "ycc-pd" || mode.lineHeight === 2 ? mode.height / 2 : mode.height;
}

/** Seconds a whole transmission takes after the VIS header. */
export function sstvImageSeconds(mode: SstvMode): number {
  const extra = mode.name.startsWith("Scottie") ? mode.syncMs : 0;
  return (sstvSyncPeriods(mode) * mode.lineMs + extra) / 1000;
}

export const SSTV_BLACK_HZ = 1500;
export const SSTV_WHITE_HZ = 2300;
export const SSTV_SYNC_HZ = 1200;

const clamp8 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
const levelToHz = (v: number) => SSTV_BLACK_HZ + (v / 255) * (SSTV_WHITE_HZ - SSTV_BLACK_HZ);
const hzToLevel = (hz: number) => clamp8(((hz - SSTV_BLACK_HZ) / (SSTV_WHITE_HZ - SSTV_BLACK_HZ)) * 255);

/** RGB to YCbCr, full range, as the decoders that receive it convert back. */
function toYcc(r: number, g: number, b: number): [number, number, number] {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  return [y, cb, cr];
}

function fromYcc(y: number, cb: number, cr: number): [number, number, number] {
  return [clamp8(y + 1.402 * (cr - 128)), clamp8(y - 0.344136 * (cb - 128) - 0.714136 * (cr - 128)), clamp8(y + 1.772 * (cb - 128))];
}

/** A picture: RGB bytes, row by row. */
export interface SstvImage {
  width: number;
  height: number;
  rgb: Uint8ClampedArray;
}

// ---------------------------------------------------------------------------
// Encoding

/** Tone segments, Hz and ms, for a phase-continuous FSK synthesiser. */
type Segment = [hz: number, ms: number];

export function sstvVisSegments(vis: number): Segment[] {
  const seg: Segment[] = [[1900, 300], [1200, 10], [1900, 300], [1200, 30]];
  let ones = 0;
  for (let b = 0; b < 7; b++) {
    const bit = (vis >> b) & 1;
    ones += bit;
    seg.push([bit ? 1100 : 1300, 30]);
  }
  seg.push([ones % 2 ? 1100 : 1300, 30]); // even parity
  seg.push([1200, 30]);
  return seg;
}

function scanSegments(levels: ArrayLike<number>, ms: number): Segment[] {
  const per = ms / levels.length;
  const out: Segment[] = [];
  for (let i = 0; i < levels.length; i++) out.push([levelToHz(levels[i]!), per]);
  return out;
}

/** The segments for a picture in a mode, header included. */
export function sstvSegments(mode: SstvMode, img: SstvImage): Segment[] {
  if (img.width !== mode.width || img.height !== mode.height) {
    throw new Error(`${mode.name} is ${mode.width}x${mode.height}; the picture is ${img.width}x${img.height}`);
  }
  const W = mode.width;
  const px = (x: number, y: number, c: number) => img.rgb[(y * W + x) * 3 + c]!;
  const chan = (y: number, c: number) => Array.from({ length: W }, (_, x) => px(x, y, c));
  const ycc = (y: number) => Array.from({ length: W }, (_, x) => toYcc(px(x, y, 0), px(x, y, 1), px(x, y, 2)));
  const seg: Segment[] = [...sstvVisSegments(mode.vis)];
  const lh = mode.lineHeight ?? 1;
  const luma = (y: number) => Array.from({ length: W }, (_, x) => 0.299 * px(x, y, 0) + 0.587 * px(x, y, 1) + 0.114 * px(x, y, 2));
  if (mode.colour === "bw") {
    for (let y = 0; y < mode.height; y += lh) {
      seg.push([SSTV_SYNC_HZ, mode.syncMs]);
      if (mode.porchMs > 0) seg.push([1500, mode.porchMs]);
      seg.push(...scanSegments(luma(y), mode.scanMs));
    }
  } else if (mode.colour === "rgb") {
    for (let y = 0; y < mode.height; y += lh) {
      seg.push([SSTV_SYNC_HZ, mode.syncMs], [1500, mode.porchMs]);
      for (const c of [0, 1, 2]) {
        seg.push(...scanSegments(chan(y, c), mode.scanMs));
        if (mode.sepMs > 0) seg.push([1500, mode.sepMs]);
      }
    }
  } else if (mode.colour === "ycc-robot72") {
    for (let y = 0; y < mode.height; y++) {
      const row = ycc(y);
      const half = (k: 1 | 2) => Array.from({ length: W / 2 }, (_, i) => (row[2 * i]![k] + row[2 * i + 1]![k]) / 2);
      seg.push([SSTV_SYNC_HZ, mode.syncMs], [1500, mode.porchMs]);
      seg.push(...scanSegments(row.map((v) => v[0]), mode.scanMs));
      seg.push([1500, mode.sepMs], [1900, 1.5], ...scanSegments(half(2), mode.scanMs / 2));
      seg.push([2300, mode.sepMs], [1900, 1.5], ...scanSegments(half(1), mode.scanMs / 2));
    }
  } else if (mode.colour === "gbr") {
    const scottie = mode.name.startsWith("Scottie");
    if (scottie) seg.push([SSTV_SYNC_HZ, mode.syncMs]);
    for (let y = 0; y < mode.height; y += lh) {
      if (scottie) {
        seg.push([1500, mode.sepMs], ...scanSegments(chan(y, 1), mode.scanMs));
        seg.push([1500, mode.sepMs], ...scanSegments(chan(y, 2), mode.scanMs));
        seg.push([SSTV_SYNC_HZ, mode.syncMs], [1500, mode.porchMs], ...scanSegments(chan(y, 0), mode.scanMs));
      } else {
        seg.push([SSTV_SYNC_HZ, mode.syncMs], [1500, mode.porchMs]);
        seg.push(...scanSegments(chan(y, 1), mode.scanMs), [1500, mode.sepMs]);
        seg.push(...scanSegments(chan(y, 2), mode.scanMs), [1500, mode.sepMs]);
        seg.push(...scanSegments(chan(y, 0), mode.scanMs), [1500, mode.sepMs]);
      }
    }
  } else if (mode.colour === "ycc-robot") {
    for (let y = 0; y < mode.height; y++) {
      const row = ycc(y);
      const next = ycc(Math.min(mode.height - 1, y + 1));
      const prev = ycc(Math.max(0, y - 1));
      const even = y % 2 === 0;
      // Chroma at half resolution, averaged over the pair of lines that share it.
      const chroma = Array.from({ length: W / 2 }, (_, i) => {
        const a = row[i * 2]!;
        const b = (even ? next : prev)[i * 2]!;
        return even ? (a[2] + b[2]) / 2 : (a[1] + b[1]) / 2;
      });
      seg.push([SSTV_SYNC_HZ, mode.syncMs], [1500, mode.porchMs]);
      seg.push(...scanSegments(row.map((v) => v[0]), mode.scanMs));
      seg.push([even ? 1500 : 2300, mode.sepMs], [1900, 1.5]);
      seg.push(...scanSegments(chroma, 44));
    }
  } else {
    for (let y = 0; y < mode.height; y += 2) {
      const a = ycc(y);
      const b = ycc(y + 1);
      const cr = a.map((v, x) => (v[2] + b[x]![2]) / 2);
      const cb = a.map((v, x) => (v[1] + b[x]![1]) / 2);
      seg.push([SSTV_SYNC_HZ, mode.syncMs], [1500, mode.porchMs]);
      seg.push(...scanSegments(a.map((v) => v[0]), mode.scanMs));
      seg.push(...scanSegments(cr, mode.scanMs));
      seg.push(...scanSegments(cb, mode.scanMs));
      seg.push(...scanSegments(b.map((v) => v[0]), mode.scanMs));
    }
  }
  return seg;
}

/** Audio for a picture: phase-continuous, `clockError` stretches it (0.001 = 0.1% slow). */
export function sstvWaveform(mode: SstvMode, img: SstvImage, opts: { sampleRate: number; amplitude?: number; clockError?: number; leadMs?: number }): Float32Array {
  const fs = opts.sampleRate;
  const segs = sstvSegments(mode, img);
  const stretch = 1 + (opts.clockError ?? 0);
  const lead = Math.round(((opts.leadMs ?? 200) / 1000) * fs);
  let totalMs = 0;
  for (const [, ms] of segs) totalMs += ms;
  const out = new Float32Array(lead + Math.ceil((totalMs * stretch * fs) / 1000) + lead);
  const amp = opts.amplitude ?? 0.8;
  let phase = 0;
  let t = 0; // ms, exact, so per-pixel durations never accumulate rounding
  let n = lead;
  for (const [hz, ms] of segs) {
    t += ms * stretch;
    const end = lead + Math.round((t * fs) / 1000);
    const dphi = (2 * Math.PI * hz) / fs;
    for (; n < end && n < out.length; n++) {
      out[n] = amp * Math.sin(phase);
      phase += dphi;
      if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Decoding

/**
 * Instantaneous frequency, sample by sample: mix down by 1900 Hz, low-pass the baseband,
 * and difference its phase.
 *
 * The mixer leaves the wanted difference (within 700 Hz of zero) and a sum near twice
 * 1900 Hz - 3100 to 4200 Hz for the range a picture uses. One boxcar a quarter of a
 * millisecond long let about a quarter of that through, which averaged away over a slow
 * mode's pixel and ruined every sample of a sync pulse or a fast mode's pixel. Three
 * boxcars in a row, each with its null at 4 kHz, take it down to about 2% while passing
 * the picture's 700 Hz at about 90%. Their delay (a third of a millisecond at most) is the
 * same for sync and pixels alike, so it moves nothing relative to anything else.
 */
class Boxcar {
  private readonly bufI: Float64Array;
  private readonly bufQ: Float64Array;
  private head = 0;
  private sumI = 0;
  private sumQ = 0;
  constructor(private readonly len: number) {
    this.bufI = new Float64Array(len);
    this.bufQ = new Float64Array(len);
  }
  step(i: number, q: number): [number, number] {
    this.sumI += i - this.bufI[this.head]!;
    this.sumQ += q - this.bufQ[this.head]!;
    this.bufI[this.head] = i;
    this.bufQ[this.head] = q;
    this.head = (this.head + 1) % this.len;
    return [this.sumI / this.len, this.sumQ / this.len];
  }
}

export class SstvFm {
  private ph = 0;
  private readonly dphi: number;
  private stages: Boxcar[];
  private lastI = 1;
  private lastQ = 0;
  private readonly k: number;

  constructor(private readonly fs: number) {
    this.dphi = (2 * Math.PI * 1900) / fs;
    const len = Math.max(2, Math.round(fs / 4000));
    this.stages = [new Boxcar(len), new Boxcar(len), new Boxcar(len)];
    this.k = fs / (2 * Math.PI);
  }

  /**
   * Narrow the low-pass to suit a mode once the VIS has named it. The default passes the
   * fastest pixels there are (PD 120's, 0.19 ms); a slow mode's pixels are two or three
   * times longer, and a filter that long lets in proportionally less noise. Floored where
   * its null still sits at 2.4 kHz, below the mixer's sum products.
   */
  setPixelMs(pixelMs: number): void {
    const len = Math.max(Math.round(this.fs / 4000), Math.min(Math.round(this.fs / 2400), Math.round((pixelMs / 1000) * this.fs * 0.9)));
    this.stages = [new Boxcar(len), new Boxcar(len), new Boxcar(len)];
  }

  /** One sample in, the frequency (Hz) out. */
  step(x: number): number {
    let i = x * Math.cos(this.ph);
    let q = -x * Math.sin(this.ph);
    this.ph += this.dphi;
    if (this.ph > 2 * Math.PI) this.ph -= 2 * Math.PI;
    for (const st of this.stages) [i, q] = st.step(i, q);
    const re = i * this.lastI + q * this.lastQ;
    const im = q * this.lastI - i * this.lastQ;
    this.lastI = i;
    this.lastQ = q;
    return 1900 + Math.atan2(im, re) * this.k;
  }
}

export interface SstvDecodeEvents {
  /** Any header heard, decoded or not: its code and name, once per header. */
  onVis?: (code: number, name: string, decoded: boolean) => void;
  /** A VIS header naming a known mode: a picture is starting. */
  onStart?: (mode: SstvMode) => void;
  /** Rows finished, from `fromRow` up to but not including `toRow`. */
  onRows?: (img: SstvImage, fromRow: number, toRow: number) => void;
  /** The picture is complete. */
  onImage?: (img: SstvImage, mode: SstvMode) => void;
}

/**
 * A streaming SSTV decoder: feed audio, get pictures. Hunts for a VIS header; on one that
 * names a known mode, gathers the transmission's audio and reads each line as it becomes
 * available, sync by sync.
 */
export class SstvDecoder {
  private readonly fm: SstvFm;
  /** Frequency history while hunting, for the VIS. */
  private readonly hist: Float32Array;
  private histN = 0;
  private sinceCheck = 0;
  private mode: SstvMode | null = null;
  /** Frequency of the picture's audio, from the end of the VIS stop bit. */
  private freq: Float32Array | null = null;
  private freqN = 0;
  private img: SstvImage | null = null;
  private period = 0;
  private rowsDone = 0;
  /** Where the current sync period was found, samples into `freq`, and the drift so far. */
  private nextSync = 0;
  private drift = 0;
  private readonly samplesPerMs: number;
  private stats = { pictures: 0, visHeard: 0 };
  /** Samples left before the hunt may count another header: one header is one count. */
  private visQuiet = 0;

  constructor(private readonly fs: number, private readonly events: SstvDecodeEvents = {}) {
    this.fm = new SstvFm(fs);
    this.samplesPerMs = fs / 1000;
    this.hist = new Float32Array(Math.round(fs * 1.2));
  }

  get statistics(): Readonly<{ pictures: number; visHeard: number; receiving: string | null; rows: number }> {
    return { ...this.stats, receiving: this.mode?.name ?? null, rows: this.rowsDone };
  }

  /** Abandon a picture in progress and hunt again. */
  reset(): void {
    this.mode = null;
    this.freq = null;
    this.img = null;
    this.histN = 0;
  }

  feed(samples: ArrayLike<number>): void {
    for (let n = 0; n < samples.length; n++) {
      const f = this.fm.step(samples[n]!);
      if (this.mode) {
        this.freq![this.freqN++] = f;
        if (this.freqN >= this.freq!.length) {
          this.readRows(true);
          continue;
        }
      } else {
        // Hunting: keep a rolling second and a bit; check for a VIS every 10 ms.
        if (this.histN < this.hist.length) this.hist[this.histN++] = f;
        else {
          this.hist.copyWithin(0, 1);
          this.hist[this.hist.length - 1] = f;
        }
        if (this.visQuiet > 0) this.visQuiet--;
        if (++this.sinceCheck >= this.samplesPerMs * 10) {
          this.sinceCheck = 0;
          if (this.visQuiet === 0) this.huntVis();
        }
      }
    }
    if (this.mode) this.readRows(false);
  }

  /** Mean frequency over [a, b) ms back from the end of the history. */
  private histMean(fromMsBack: number, toMsBack: number): number {
    const end = this.histN;
    const a = Math.max(0, Math.round(end - fromMsBack * this.samplesPerMs));
    const b = Math.max(a + 1, Math.round(end - toMsBack * this.samplesPerMs));
    let s = 0;
    for (let i = a; i < b; i++) s += this.hist[i]!;
    return s / (b - a);
  }

  /**
   * Is the last stretch of history a VIS? Read backwards from now: stop bit (30 ms at
   * 1200), eight data bits, start bit, second leader. Checked every 10 ms, so the header's
   * end is found to within 10 ms and then pinned to the stop bit's falling edge below.
   */
  private huntVis(): void {
    if (this.histN < this.samplesPerMs * 640) return;
    // Decisions rather than tight windows: in noise a discriminator's readings pull toward
    // the 1900 Hz it mixes around, so a 1200 Hz stop bit at 3 dB reads nearer 1300.
    const near = (hz: number, want: number, tol: number) => Math.abs(hz - want) <= tol;
    // Allow the check to land anywhere in the first 10 ms after the stop bit.
    for (let off = 0; off <= 10; off += 2) {
      const stop = this.histMean(30 + off, off + 2);
      if (stop > 1450) continue;
      const start = this.histMean(300 + off - 2, 270 + off + 2);
      const leader = this.histMean(500 + off, 320 + off);
      if (start > 1450 || !near(leader, 1900, 120)) continue;
      let code = 0;
      let ones = 0;
      let bad = false;
      for (let b = 0; b < 8; b++) {
        const from = 270 + off - b * 30;
        const hz = this.histMean(from - 4, from - 26);
        if (hz < 1200) {
          if (b < 7) code |= 1 << b;
          ones++;
        } else if (hz > 1500) {
          bad = true;
          break;
        }
      }
      if (bad || ones % 2 !== 0) continue;
      const mode = sstvModeByVis(code);
      // One header, one count: the same one matches at the next check or two otherwise,
      // which is how one Robot 72 header read as three.
      this.stats.visHeard++;
      this.visQuiet = Math.round(this.samplesPerMs * 600);
      this.events.onVis?.(code, sstvVisName(code), mode !== null);
      if (!mode) return;
      this.begin(mode, off);
      return;
    }
  }

  private begin(mode: SstvMode, msPastStop: number): void {
    this.mode = mode;
    const samples = Math.ceil((sstvImageSeconds(mode) + 1.5) * this.fs);
    this.freq = new Float32Array(samples);
    // The audio after the stop bit is already in the history: carry it over.
    const carry = Math.round(msPastStop * this.samplesPerMs);
    for (let i = 0; i < carry; i++) this.freq[i] = this.hist[this.histN - carry + i]!;
    this.freqN = carry;
    this.img = { width: mode.width, height: mode.height, rgb: new Uint8ClampedArray(mode.width * mode.height * 3) };
    this.period = mode.lineMs * this.samplesPerMs;
    this.fm.setPixelMs(mode.colour === "ycc-robot" ? mode.scanMs / mode.width : mode.scanMs / mode.width);
    this.rowsDone = 0;
    this.drift = 0;
    // The first sync: Scottie sends one before line 0, and its lines then sync at the end;
    // the others open each line with one.
    this.nextSync = 0;
    this.histN = 0;
    this.events.onStart?.(mode);
  }

  /** Find a sync pulse's leading edge within [from, to) samples of `freq`. */
  private findSync(from: number, to: number, syncMs: number): number | null {
    const len = Math.round(syncMs * this.samplesPerMs);
    const f = this.freq!;
    let best = -1;
    let bestScore = 0;
    // Whole samples: the timing arithmetic hands fractional positions, and an array read at
    // a fraction is undefined - which made every sync after the first unfindable.
    const lo = Math.max(0, Math.floor(from));
    const hi = Math.min(this.freqN - len, Math.ceil(to));
    if (hi <= lo) return null;
    // Running count of samples below 1350 Hz over a sync length: the sync is the run that
    // holds most of them.
    let run = 0;
    for (let i = lo; i < lo + len; i++) if (f[i]! < 1350) run++;
    for (let i = lo; i < hi; i++) {
      if (run > bestScore) {
        bestScore = run;
        best = i;
      }
      if (f[i]! < 1350) run--;
      if (f[i + len]! < 1350) run++;
    }
    return bestScore >= len * 0.6 ? best : null;
  }

  /** Mean level over [a, b) samples, as 0..255. */
  private level(a: number, b: number): number {
    const i0 = Math.max(0, Math.floor(a));
    const i1 = Math.min(this.freqN, Math.max(i0 + 1, Math.floor(b)));
    let s = 0;
    for (let i = i0; i < i1; i++) s += this.freq![i]!;
    return hzToLevel(s / (i1 - i0));
  }

  private scan(start: number, ms: number, n: number): number[] {
    const per = (ms * this.samplesPerMs * (1 + this.drift)) / n;
    const out = new Array<number>(n);
    for (let x = 0; x < n; x++) out[x] = this.level(start + x * per + per * 0.15, start + (x + 1) * per - per * 0.15);
    return out;
  }

  private readRows(finish: boolean): void {
    const mode = this.mode!;
    const periods = sstvSyncPeriods(mode);
    const sp = this.samplesPerMs;
    const scottie = mode.name.startsWith("Scottie");
    while (this.rowsDone < periods) {
      const expected = this.nextSync;
      const need = expected + this.period * (1 + this.drift) + (scottie ? mode.syncMs * sp : 0) + 40 * sp;
      if (this.freqN < need && !finish) return;
      // Where this period's sync actually is, near where the timing says.
      const search = Math.max(12 * sp, this.period * 0.02);
      let syncAt: number;
      if (scottie) {
        // Scottie's line ends with green, blue, then the sync before red; the first period
        // has a leading sync of its own, found the same way.
        const first = this.rowsDone === 0 ? this.findSync(0, 40 * sp, mode.syncMs) : null;
        const lineStart = first !== null ? first + mode.syncMs * sp : expected;
        const midSync = this.findSync(
          lineStart + (2 * mode.sepMs + 2 * mode.scanMs) * sp - search,
          lineStart + (2 * mode.sepMs + 2 * mode.scanMs) * sp + search,
          mode.syncMs,
        );
        const ideal = lineStart + (2 * mode.sepMs + 2 * mode.scanMs) * sp;
        const found = midSync ?? ideal;
        // The line's own start, from where its sync was found.
        syncAt = found - (2 * mode.sepMs + 2 * mode.scanMs) * sp;
        if (this.rowsDone === 0 && first === null) syncAt = Math.max(0, syncAt);
      } else {
        syncAt = this.findSync(expected - search, expected + search, mode.syncMs) ?? expected;
      }
      // Drift: how far the found sync sits from where the nominal period put it, smoothed.
      if (this.rowsDone > 0) {
        const err = (syncAt - expected) / this.period;
        this.drift = Math.max(-0.02, Math.min(0.02, this.drift + 0.2 * err));
      }
      this.decodePeriod(syncAt);
      this.nextSync = syncAt + this.period * (1 + this.drift);
      this.rowsDone++;
    }
    const img = this.img!;
    this.stats.pictures++;
    this.events.onImage?.(img, mode);
    this.reset();
  }

  private decodePeriod(at: number): void {
    const mode = this.mode!;
    const img = this.img!;
    const W = mode.width;
    const sp = this.samplesPerMs * (1 + this.drift);
    const put = (y: number, x: number, r: number, g: number, b: number) => {
      const i = (y * W + x) * 3;
      img.rgb[i] = r;
      img.rgb[i + 1] = g;
      img.rgb[i + 2] = b;
    };
    const p = this.rowsDone;
    const lh = mode.lineHeight ?? 1;
    /** Put a decoded line into its rows: one, or two for the half-height modes. */
    const putLine = (line: number, rgbAt: (x: number) => [number, number, number]) => {
      for (let x = 0; x < W; x++) {
        const [r, g, b] = rgbAt(x);
        for (let k = 0; k < lh; k++) put(line * lh + k, x, r, g, b);
      }
      this.events.onRows?.(img, line * lh, line * lh + lh);
    };
    if (mode.colour === "bw") {
      const y = this.scan(at + (mode.syncMs + mode.porchMs) * sp, mode.scanMs, W);
      putLine(p, (x) => [y[x]!, y[x]!, y[x]!]);
      return;
    }
    if (mode.colour === "rgb") {
      let t = at + (mode.syncMs + mode.porchMs) * sp;
      const r = this.scan(t, mode.scanMs, W);
      t += (mode.scanMs + mode.sepMs) * sp;
      const g = this.scan(t, mode.scanMs, W);
      t += (mode.scanMs + mode.sepMs) * sp;
      const b = this.scan(t, mode.scanMs, W);
      putLine(p, (x) => [r[x]!, g[x]!, b[x]!]);
      return;
    }
    if (mode.colour === "ycc-robot72") {
      let t = at + (mode.syncMs + mode.porchMs) * sp;
      const y = this.scan(t, mode.scanMs, W);
      t += (mode.scanMs + mode.sepMs + 1.5) * sp;
      const cr = this.scan(t, mode.scanMs / 2, W / 2);
      t += (mode.scanMs / 2 + mode.sepMs + 1.5) * sp;
      const cb = this.scan(t, mode.scanMs / 2, W / 2);
      putLine(p, (x) => fromYcc(y[x]!, cb[x >> 1]!, cr[x >> 1]!));
      return;
    }
    if (mode.colour === "gbr") {
      const scottie = mode.name.startsWith("Scottie");
      let t = at;
      let g: number[], b: number[], r: number[];
      if (scottie) {
        t += mode.sepMs * sp;
        g = this.scan(t, mode.scanMs, W);
        t += (mode.scanMs + mode.sepMs) * sp;
        b = this.scan(t, mode.scanMs, W);
        t += (mode.scanMs + mode.syncMs + mode.porchMs) * sp;
        r = this.scan(t, mode.scanMs, W);
      } else {
        t += (mode.syncMs + mode.porchMs) * sp;
        g = this.scan(t, mode.scanMs, W);
        t += (mode.scanMs + mode.sepMs) * sp;
        b = this.scan(t, mode.scanMs, W);
        t += (mode.scanMs + mode.sepMs) * sp;
        r = this.scan(t, mode.scanMs, W);
      }
      putLine(p, (x) => [r[x]!, g[x]!, b[x]!]);
    } else if (mode.colour === "ycc-robot") {
      let t = at + (mode.syncMs + mode.porchMs) * sp;
      const y = this.scan(t, mode.scanMs, W);
      t += (mode.scanMs + mode.sepMs + 1.5) * sp;
      const c = this.scan(t, 44, W / 2);
      // Even lines carry R-Y, odd lines B-Y; each pair of lines shares both.
      this.robotY.set(p, y);
      (p % 2 === 0 ? this.robotCr : this.robotCb).set(p - (p % 2), c);
      if (p % 2 === 1) {
        const cr = this.robotCr.get(p - 1) ?? new Array(W / 2).fill(128);
        const cb = this.robotCb.get(p - 1) ?? new Array(W / 2).fill(128);
        for (const row of [p - 1, p]) {
          const yy = this.robotY.get(row)!;
          for (let x = 0; x < W; x++) {
            const [r, g, b] = fromYcc(yy[x]!, cb[x >> 1]!, cr[x >> 1]!);
            put(row, x, r, g, b);
          }
        }
        this.robotY.delete(p - 1);
        this.robotY.delete(p);
        this.robotCr.delete(p - 1);
        this.robotCb.delete(p - 1);
        this.events.onRows?.(img, p - 1, p + 1);
      }
    } else {
      let t = at + (mode.syncMs + mode.porchMs) * sp;
      const y0 = this.scan(t, mode.scanMs, W);
      t += mode.scanMs * sp;
      const cr = this.scan(t, mode.scanMs, W);
      t += mode.scanMs * sp;
      const cb = this.scan(t, mode.scanMs, W);
      t += mode.scanMs * sp;
      const y1 = this.scan(t, mode.scanMs, W);
      for (let x = 0; x < W; x++) {
        const [r0, g0, b0] = fromYcc(y0[x]!, cb[x]!, cr[x]!);
        put(2 * p, x, r0, g0, b0);
        const [r1, g1, b1] = fromYcc(y1[x]!, cb[x]!, cr[x]!);
        put(2 * p + 1, x, r1, g1, b1);
      }
      this.events.onRows?.(img, 2 * p, 2 * p + 2);
    }
  }

  private readonly robotY = new Map<number, number[]>();
  private readonly robotCr = new Map<number, number[]>();
  private readonly robotCb = new Map<number, number[]>();
}

/** A test card: colour bars over a grey ramp and a white frame, any size. */
export function sstvTestCard(width: number, height: number): SstvImage {
  const rgb = new Uint8ClampedArray(width * height * 3);
  const bars: [number, number, number][] = [
    [255, 255, 255], [255, 255, 0], [0, 255, 255], [0, 255, 0], [255, 0, 255], [255, 0, 0], [0, 0, 255], [0, 0, 0],
  ];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let c: [number, number, number];
      if (y < height * 0.6) c = bars[Math.min(7, Math.floor((x / width) * 8))]!;
      else {
        const v = Math.round((x / (width - 1)) * 255);
        c = [v, v, v];
      }
      const i = (y * width + x) * 3;
      rgb[i] = c[0];
      rgb[i + 1] = c[1];
      rgb[i + 2] = c[2];
    }
  }
  return { width, height, rgb };
}
