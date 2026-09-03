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

import { DECODE_CHARS, MAX_DECODES } from "@/lib/stream/layout";

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
 * reallocated: at 1920x1080 that is 6.2 MB a frame, and ten frames a second of garbage is
 * a bad neighbour for a decoder sharing the machine.
 */
export class WaterfallCanvas {
  readonly rgb: Buffer;
  private readonly rowBytes: number;
  /** Where the waterfall starts, leaving room for the text ffmpeg draws over the top. */
  private readonly topMargin: number;

  /** Where the waterfall starts horizontally, leaving the left column for the decode list. */
  private readonly leftMargin: number;

  constructor(
    private readonly size: FrameSize,
    opts: { topMargin?: number; leftMargin?: number } = {},
  ) {
    this.rowBytes = size.width * 3;
    this.rgb = Buffer.alloc(this.rowBytes * size.height);
    this.topMargin = Math.max(0, Math.min(size.height - 1, opts.topMargin ?? 0));
    // A LEFT MARGIN as well as a top one, so the decode list can run the full height of the
    // frame down the side and the waterfall takes the narrower space beside it. A feed of
    // callsigns is worth more vertical room than a spectrum is worth horizontal.
    this.leftMargin = Math.max(0, Math.min(size.width - 1, opts.leftMargin ?? 0));

    // THE WATERFALL AREA STARTS AT THE PALETTE'S OWN FLOOR, not at pure black.
    //
    // A waterfall fills from the bottom over its first minute, which is what every
    // waterfall does — but against pure black the unfilled part reads as a broken picture
    // rather than an empty one, and a viewer arriving in the first minute of a stream
    // should not have to guess which. The floor colour is what silence looks like, so an
    // empty waterfall looks like a quiet band.
    const [r, g, b] = paletteFor(0);
    for (let y = this.topMargin; y < size.height; y++) {
      let o = y * this.rowBytes + this.leftMargin * 3;
      for (let x = this.leftMargin; x < size.width; x++) {
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
    // waterfall a row to draw a rule on would be the wrong thing to spend.
    let o = (this.topMargin - 1) * this.rowBytes + this.leftMargin * 3;
    for (let x = this.leftMargin; x < this.size.width; x++) {
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

    // SCROLL ROW BY ROW, not in one copyWithin, because the waterfall no longer spans the
    // full width — a single block copy would drag the decode column up with it.
    const left = this.leftMargin;
    const bandBytes = (width - left) * 3;
    for (let y = top; y < height - 1; y++) {
      this.rgb.copyWithin(
        y * this.rowBytes + left * 3,
        (y + 1) * this.rowBytes + left * 3,
        (y + 1) * this.rowBytes + left * 3 + bandBytes,
      );
    }
    this.drawSeparator();

    const n = row.bins.length;
    const y = height - 1;
    let o = y * this.rowBytes + left * 3;
    if (n === 0) {
      this.rgb.fill(0, o, o + bandBytes);
      return;
    }
    const span = width - left;
    for (let x = left; x < width; x++) {
      const bin = Math.min(n - 1, Math.floor(((x - left) * n) / span));
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
// `textLineCapacity` lives in `lib/stream/layout.ts` with the rest of the geometry, so the
// frame's line arithmetic and the frame's dimensions cannot drift apart.

/** What the station is doing right now, if anything. */
export interface WorkingNow {
  /** Who we are working or calling. Null when idle. */
  theirCall: string | null;
  /**
   * The sequencer's phase, verbatim: "calling", "report-sent", "rreport-sent",
   * "rr73-sent", "complete", "abandoned".
   */
  phase: string | null;
  /** The exchange so far, oldest first, both directions. */
  transcript: { dir: "tx" | "rx"; message: string; snr?: number | null }[];
  /** What the hunt is doing when no contact is running — "hunting K5MGY (-5 dB)". */
  hunting: string | null;
}

/**
 * The phase, in words a viewer can follow.
 *
 * The state machine's own names are precise and mean nothing to somebody watching: an
 * operator knows what "rreport-sent" is, an audience does not. One-way and for display
 * only — nothing reads these back.
 */
function phaseLabel(phase: string | null): string {
  switch (phase) {
    // SHORT ENOUGH FOR THE COLUMN. These were sentences — "sent R+report, waiting for
    // RR73" — and the WORKING line then ran 48 characters into a column that holds 41,
    // printing over the band chips beside it. `drawtext` does not wrap.
    case "calling":
      return "calling";
    case "report-sent":
      return "waiting for their report";
    case "rreport-sent":
      return "waiting for RR73";
    case "rr73-sent":
      return "contact made";
    case "complete":
      return "complete";
    case "abandoned":
      return "abandoned";
    default:
      return phase ?? "";
  }
}

export function overlayText(state: {
  callsign: string;
  grid: string;
  band: string | null;
  mode: string | null;
  dialHz: number | null;
  qsosToday: number;
  decodes: { at: string; message: string; snr: number }[];
  /** Optional, so existing callers and their assertions keep working unchanged. */
  working?: WorkingNow | null;
  /** How many decode lines the column has room for. Defaults to the full-height column. */
  maxDecodes?: number;
  /**
   * How many characters wide the column is.
   *
   * 440 pixels of column less an 18-pixel inset is 422, and DejaVu Sans Mono advances
   * 1233/2048 of the font size — at 17 that is 41 characters. Nothing may exceed it:
   * `drawtext` does not wrap, so a longer line prints over the panel beside it.
   */
  columnChars?: number;
}): string {
  const dial = state.dialHz ? (state.dialHz / 1e6).toFixed(3) + " MHz" : "--";
  // THE HEADER LOST ITS QSO COUNT, because the left column is only 440 pixels wide now and
  // this line ran straight into the solar readout in the next column — "QSOs today 14" and
  // "SFI 102.7" overprinting each other on the live stream. `drawtext` has no width to
  // wrap at; the only fix is a line that fits.
  const head = `${state.callsign}  ${state.grid}   ${state.band ?? "--"} ${state.mode ?? "--"}  ${dial}`;

  // WHO WE ARE WORKING, AND THE EXCHANGE — the thing an audience actually wants.
  //
  // Asked for after seeing the previous stream: an OBS composite of WSJT-X, GridTracker and
  // a QRZ lookup of the station being worked. A bare waterfall says a contact is happening
  // somewhere in it. This says who, and how far along.
  //
  // Both directions, prefixed with arrows rather than coloured, because ffmpeg's `drawtext`
  // renders one colour for the whole block — the arrows do the work a second colour would.
  const w = state.working;
  const working: string[] = [];
  if (w?.theirCall) {
    const phase = phaseLabel(w.phase);
    working.push(`WORKING ${w.theirCall}${phase ? "  — " + phase : ""}`);
    // OLDEST FIRST here, unlike the decode list. A decode list is a feed and the newest
    // line is the interesting one; an exchange is a sequence and reading it backwards makes
    // nonsense of it. The last FOUR: a full FT8 contact is six messages, and the opening
    // call stops being interesting once a report has come back.
    for (const t of w.transcript.slice(-4)) {
      const arrow = t.dir === "tx" ? "▲" : "▼";
      const snr =
        t.dir === "rx" && typeof t.snr === "number"
          ? "  " + (t.snr >= 0 ? "+" : "") + String(t.snr)
          : "";
      working.push(`  ${arrow} ${t.message}${snr}`);
    }
  } else if (w?.hunting) {
    // THE GAPS BETWEEN CONTACTS, and this branch was MISSING — a silent regression rather
    // than a decision. `hunting` has been part of `WorkingNow` since the block was built,
    // the bridge has always passed it ("hunting K5MGY (-5 dB)" / "nobody callable this
    // window"), and nothing ever rendered it: the `else` that used to hold it was deleted
    // in 1.174.1 when the QSO count was moved out of it, and the field went with it.
    //
    // It matters because it is most of the broadcast. A contact occupies a few cycles and
    // the station spends the rest of the time deciding who to call, which is exactly when a
    // viewer is looking for something to read — and it answers the operator's own request
    // to show "what callsign we are hunting".
    working.push(w.hunting);
  }

  // THE DAY'S COUNT IS ALWAYS SHOWN, and that was a real bug rather than a preference.
  //
  // It began life inside the `else` above — the branch that runs only when NO contact is in
  // progress — so it appeared between contacts and vanished during them. Which is precisely
  // backwards: a viewer arriving mid-contact is the one most likely to wonder how the day
  // is going, and the count disappeared exactly then.
  //
  // It sits under the header rather than in it because the header ran into the solar
  // readout in the next column when it carried both.
  const qsoLine = `QSOs today ${state.qsosToday}`;

  // Newest first, because that is where the eye goes and it is what the page does.
  //
  // The decode list SHRINKS while a contact is running, so the block above never pushes the
  // waterfall down — the working block and the decode feed share one budget. Six decodes is
  // the floor: below that the list stops being a feed and starts being decoration.
  //
  // HOW THE BUDGET IS ARRIVED AT: `textLineCapacity` below, minus the three lines this
  // function always emits before the feed (the header, the QSO count and the blank). The
  // caller passes the result because the caller is what owns the frame geometry. The
  // fallback is the figure that capacity yields for BOTH the 720p and the 1080p layout —
  // they agree because the font scaled with the frame — but it is a fallback, not the
  // source of truth, and a future layout should pass its own.
  const maxDecodes = state.maxDecodes ?? MAX_DECODES;
  const room = working.length > 0 ? Math.max(6, maxDecodes - working.length - 1) : maxDecodes;
  const lines = state.decodes.slice(0, room).map((d) => {
    const snr = (d.snr >= 0 ? "+" : "") + String(d.snr).padStart(2, " ");
    return `${d.at}  ${snr}  ${d.message}`;
  });

  const body = working.length > 0 ? [...working, "", ...lines] : lines;

  // NOTHING MAY EXCEED THE COLUMN. Shorter phase labels fixed the line that spilled; this
  // stops the next one. `drawtext` renders whatever it is given at whatever width that
  // takes and will not wrap, so a long callsign or a future label would run over the panel
  // beside it with nothing to catch it — which is exactly how "waiting for RR73" ended up
  // printed on top of the band chips.
  const width = state.columnChars ?? DECODE_CHARS;
  const fit = (l: string): string => (l.length <= width ? l : l.slice(0, width - 1) + "…");
  return [head, qsoLine, "", ...body].map(fit).join("\n") + "\n";
}
