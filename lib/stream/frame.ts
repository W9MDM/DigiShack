// The waterfall, drawn as raw RGB for a video encoder.
//
// WHY WE DRAW IT RATHER THAN SCREENSHOT THE UI. The obvious way to stream "our UI" is a
// headless browser screencasting the real page, and that was the first plan. It costs 135
// apt packages in a container that has no X server, several hundred megabytes, and roughly
// a core — on the same box that decodes FT8. Measured before deciding, not assumed.
//
// So the waterfall is drawn here from the same spectrum rows the browser gets, and ffmpeg
// draws the text over it with `drawtext`. That is not a compromise as much as it sounds: a
// stream is watched, not operated, and a layout built for watching beats a recording of a
// layout built for clicking.
//
// PURE, AND THAT IS THE POINT. It takes bins and returns pixels, so the thing most likely
// to be wrong — the colour mapping, the scroll, the bounds — can be asserted without
// ffmpeg, a radio, or a network.

/** One row of spectrum, as the bridge already produces it for the browser. */
export interface SpectrumInput {
  /** 0-255 per bin, low frequency first. */
  bins: Uint8Array;
  binHz: number;
  maxHz: number;
}

export interface FrameSize {
  width: number;
  height: number;
}

/**
 * The waterfall palette, black through blue and green to red.
 *
 * The SAME shape as the browser's, so the stream and the page do not disagree about what a
 * strong signal looks like — an operator watching their own stream should recognise it.
 * Written as stops rather than a formula because the interesting part is where the colours
 * change, and a formula hides that.
 */
const STOPS: { at: number; rgb: [number, number, number] }[] = [
  { at: 0.0, rgb: [0, 0, 12] },
  { at: 0.25, rgb: [0, 20, 120] },
  { at: 0.45, rgb: [0, 130, 190] },
  { at: 0.62, rgb: [0, 200, 120] },
  { at: 0.78, rgb: [220, 220, 0] },
  { at: 0.9, rgb: [255, 120, 0] },
  { at: 1.0, rgb: [255, 40, 40] },
];

/** Map 0-255 to the palette. Exported so the mapping can be asserted at its edges. */
export function paletteFor(value: number): [number, number, number] {
  const t = Math.max(0, Math.min(1, value / 255));
  for (let i = 1; i < STOPS.length; i++) {
    const a = STOPS[i - 1]!;
    const b = STOPS[i]!;
    if (t > b.at && i < STOPS.length - 1) continue;
    const span = b.at - a.at || 1;
    const k = Math.max(0, Math.min(1, (t - a.at) / span));
    return [
      Math.round(a.rgb[0] + (b.rgb[0] - a.rgb[0]) * k),
      Math.round(a.rgb[1] + (b.rgb[1] - a.rgb[1]) * k),
      Math.round(a.rgb[2] + (b.rgb[2] - a.rgb[2]) * k),
    ];
  }
  return STOPS[STOPS.length - 1]!.rgb;
}

/**
 * A scrolling waterfall in a fixed RGB buffer.
 *
 * Rows are added at the BOTTOM and the picture scrolls up, which is the direction every
 * waterfall in this hobby runs. The buffer is reused between frames rather than
 * reallocated: at 1280x720 that is 2.7 MB a frame, and ten frames a second of garbage is
 * a bad neighbour for a decoder sharing the machine.
 */
export class WaterfallCanvas {
  readonly rgb: Buffer;
  private readonly rowBytes: number;
  /** Where the waterfall starts, leaving room for the text ffmpeg draws over the top. */
  private readonly topMargin: number;

  constructor(
    private readonly size: FrameSize,
    opts: { topMargin?: number } = {},
  ) {
    this.rowBytes = size.width * 3;
    this.rgb = Buffer.alloc(this.rowBytes * size.height);
    this.topMargin = Math.max(0, Math.min(size.height - 1, opts.topMargin ?? 0));

    // THE WATERFALL AREA STARTS AT THE PALETTE'S OWN FLOOR, not at pure black.
    //
    // A waterfall fills from the bottom over its first minute, which is what every
    // waterfall does — but against pure black the unfilled part reads as a broken picture
    // rather than an empty one, and a viewer arriving in the first minute of a stream
    // should not have to guess which. The floor colour is what silence looks like, so an
    // empty waterfall looks like a quiet band.
    const [r, g, b] = paletteFor(0);
    for (let y = this.topMargin; y < size.height; y++) {
      let o = y * this.rowBytes;
      for (let x = 0; x < size.width; x++) {
        this.rgb[o++] = r;
        this.rgb[o++] = g;
        this.rgb[o++] = b;
      }
    }
    this.drawSeparator();
  }

  /**
   * A hairline between the text and the waterfall.
   *
   * Redrawn after every scroll, because the scroll moves it. Without it the boundary is
   * invisible while the waterfall is still filling, and the frame looks like one large
   * black area with some text floating in it.
   */
  private drawSeparator(): void {
    if (this.topMargin <= 0) return;
    // ON THE LAST ROW OF THE TEXT AREA, not the first row of the waterfall. Costing the
    // waterfall a row to draw a rule on would be the wrong thing to spend: the text area
    // has 280 rows of which it uses 266, and the waterfall has every row doing work.
    let o = (this.topMargin - 1) * this.rowBytes;
    for (let x = 0; x < this.size.width; x++) {
      this.rgb[o++] = 40;
      this.rgb[o++] = 60;
      this.rgb[o++] = 90;
    }
  }

  /**
   * Scroll up one row and draw a new spectrum row along the bottom.
   *
   * Bins are stretched or squeezed to the frame width by nearest-neighbour rather than
   * averaged: a narrow carrier is one bin, and averaging it with its silent neighbours is
   * how a real signal disappears from a display. The same reasoning the panadapter uses.
   */
  push(row: SpectrumInput): void {
    const { width, height } = this.size;
    const top = this.topMargin;
    const usable = height - top;
    if (usable <= 0) return;

    // Scroll: every row moves up one, within the waterfall area only.
    this.rgb.copyWithin(top * this.rowBytes, (top + 1) * this.rowBytes, height * this.rowBytes);
    this.drawSeparator();

    const n = row.bins.length;
    const y = height - 1;
    let o = y * this.rowBytes;
    if (n === 0) {
      this.rgb.fill(0, o, o + this.rowBytes);
      return;
    }
    for (let x = 0; x < width; x++) {
      const bin = Math.min(n - 1, Math.floor((x * n) / width));
      const [r, g, b] = paletteFor(row.bins[bin]!);
      this.rgb[o++] = r;
      this.rgb[o++] = g;
      this.rgb[o++] = b;
    }
  }

  /** Paint the whole frame one colour. Used for the header strip and at startup. */
  fill(r: number, g: number, b: number): void {
    for (let i = 0; i < this.rgb.length; i += 3) {
      this.rgb[i] = r;
      this.rgb[i + 1] = g;
      this.rgb[i + 2] = b;
    }
  }
}

/**
 * The text ffmpeg draws over the frame, as a file it re-reads.
 *
 * `drawtext` can take `textfile=` with `reload=1`, which re-reads the file every frame — so
 * the overlay changes without restarting ffmpeg or rebuilding a filter graph. Written whole
 * and renamed into place by the caller, because a half-written file read mid-frame shows
 * the viewer a torn line.
 */
export function overlayText(state: {
  callsign: string;
  grid: string;
  band: string | null;
  mode: string | null;
  dialHz: number | null;
  qsosToday: number;
  decodes: { at: string; message: string; snr: number }[];
}): string {
  const dial = state.dialHz ? (state.dialHz / 1e6).toFixed(3) + " MHz" : "--";
  const head = `${state.callsign}  ${state.grid}   ${state.band ?? "--"} ${state.mode ?? "--"}  ${dial}   QSOs today ${state.qsosToday}`;
  // Newest first, because that is where the eye goes and it is what the page does.
  // TEN, which is what fits above the waterfall at this font size. Twelve overflowed the
  // margin and drew the last two lines on top of the spectrum.
  const lines = state.decodes.slice(0, 10).map((d) => {
    const snr = (d.snr >= 0 ? "+" : "") + String(d.snr).padStart(2, " ");
    return `${d.at}  ${snr}  ${d.message}`;
  });
  return [head, "", ...lines].join("\n") + "\n";
}
