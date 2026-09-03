// The right-hand side of the stream frame: band conditions, and a map of the last day.
//
// THE COMPLAINT, and it was fair: "the whole top right is empty". The overlay had grown a
// WORKING block and a decode list, both in a column down the left, and the other 60% of a
// 1280-pixel frame was black. The previous stream this replaces was an OBS composite of
// WSJT-X, GridTracker's map, a solar panel and a QRZ lookup — dense with information. A
// waterfall and eleven lines of text is not a competitive picture.
//
// WHY THIS DRAWS PIXELS RATHER THAN ASKING ffmpeg. `drawtext` renders one colour per filter
// instance. Band chips are only worth having BECAUSE they are coloured — green, amber, red
// is the whole message — and a filter per colour per band is twenty filters rebuilt whenever
// conditions change. Rectangles and dots are cheap to draw and need no font, so everything
// that carries colour is drawn here and only the labels are left to ffmpeg.
//
// PURE, for the same reason lib/stream/frame.ts is: it takes numbers and returns pixels, so
// the parts that go wrong — a map projection, a chip that lands off the edge, a dot for a
// grid square that does not exist — are assertable without ffmpeg, a radio or a network.

import { LAND_RINGS } from "@/lib/geo/land";
// A value import as well as the re-export below: `export ... from` binds nothing locally.
import { charWidth } from "@/lib/stream/layout";

/** A frame buffer to draw into: RGB, row-major, no padding. */
export interface Surface {
  rgb: Buffer;
  width: number;
  height: number;
}

/** A rectangle in frame coordinates. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Clip and write one pixel.
 *
 * EVERY draw goes through here. The alternative is bounds-checking at each call site, which
 * is where an off-by-one becomes a stripe of colour wrapped onto the next row — a fault that
 * looks like a rendering glitch and is actually a buffer overrun.
 */
function px(s: Surface, x: number, y: number, r: number, g: number, b: number): void {
  if (x < 0 || y < 0 || x >= s.width || y >= s.height) return;
  const o = (y * s.width + x) * 3;
  s.rgb[o] = r;
  s.rgb[o + 1] = g;
  s.rgb[o + 2] = b;
}

/** Fill a rectangle, clipped. */
export function fillRect(s: Surface, rect: Rect, rgb: [number, number, number]): void {
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) px(s, x, y, rgb[0], rgb[1], rgb[2]);
  }
}

/** Outline a rectangle, one pixel wide. */
export function strokeRect(s: Surface, rect: Rect, rgb: [number, number, number]): void {
  for (let x = rect.x; x < rect.x + rect.w; x++) {
    px(s, x, rect.y, rgb[0], rgb[1], rgb[2]);
    px(s, x, rect.y + rect.h - 1, rgb[0], rgb[1], rgb[2]);
  }
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    px(s, rect.x, y, rgb[0], rgb[1], rgb[2]);
    px(s, rect.x + rect.w - 1, y, rgb[0], rgb[1], rgb[2]);
  }
}

// ---------------------------------------------------------------------------
// Band conditions
// ---------------------------------------------------------------------------

/** What the Decodes page's band chips show, reduced to what a chip needs. */
export interface BandChip {
  band: string;
  /** Stations heard on the band in the window. */
  count: number;
  /** Entities among them — the number that separates a wide opening from a regional one. */
  entities: number;
  usability: "good" | "fair" | "poor" | "unknown";
}

/**
 * Grade colours, matching the page rather than invented here.
 *
 * An operator watching their own stream should see the same green they see on the Decodes
 * page. "unknown" is deliberately grey and not amber: no data is not a middling forecast,
 * and colouring it as one would be a guess wearing a grade's clothes.
 */
export const GRADE_RGB: Record<BandChip["usability"], [number, number, number]> = {
  good: [74, 210, 122],
  fair: [210, 153, 34],
  poor: [220, 80, 80],
  unknown: [120, 120, 135],
};

/**
 * Lay out the band chips and draw their backgrounds.
 *
 * Returns the rectangle of each chip so the caller can place the LABEL over it — the text
 * is ffmpeg's job and it needs coordinates in the same frame. Returning them rather than
 * recomputing on the text side means one layout, not two that can disagree.
 */
export function drawBandChips(
  s: Surface,
  chips: BandChip[],
  area: Rect,
  opts: { chipW?: number; chipH?: number; gap?: number } = {},
): { chip: BandChip; rect: Rect }[] {
  const chipW = opts.chipW ?? 84;
  const chipH = opts.chipH ?? 46;
  const gap = opts.gap ?? 8;
  const perRow = Math.max(1, Math.floor((area.w + gap) / (chipW + gap)));

  const placed: { chip: BandChip; rect: Rect }[] = [];
  chips.forEach((chip, i) => {
    const col = i % perRow;
    const row = Math.floor(i / perRow);
    const rect: Rect = {
      x: area.x + col * (chipW + gap),
      y: area.y + row * (chipH + gap),
      w: chipW,
      h: chipH,
    };
    // Off the bottom of its area: dropped rather than drawn over whatever is below. A chip
    // half-overlapping the map is worse than a chip missing.
    if (rect.y + rect.h > area.y + area.h) return;
    const grade = GRADE_RGB[chip.usability];
    // A dark card with a coloured edge and a coloured strip, rather than a solid block of
    // colour: white labels have to stay readable on it, and a saturated background at this
    // size makes 11-pixel text mush.
    fillRect(s, rect, [26, 26, 34]);
    strokeRect(s, rect, grade);
    fillRect(s, { x: rect.x, y: rect.y, w: rect.w, h: 3 }, grade);
    placed.push({ chip, rect });
  });
  return placed;
}

// ---------------------------------------------------------------------------
// The map
// ---------------------------------------------------------------------------

/** A point to plot. */
export interface MapPoint {
  lat: number;
  lon: number;
}

/**
 * Equirectangular, the same projection pages/gridmap.tsx uses.
 *
 * SPANS `w - 1`, NOT `w`, and that off-by-one was a real escape rather than a nicety.
 * Multiplying by the full width maps lon 180 to `area.x + area.w` — one column PAST the
 * last valid pixel — and `px()` clips against the surface, not against this box. So every
 * coastline vertex on the antimeridian, and every contact at the date line, drew one pixel
 * outside the map and into whatever sat beside it. Caught by asserting that nothing is
 * drawn outside the area, which is the only way this is visible: on screen it is a single
 * stray pixel that reads as noise.
 *
 * Returns null for anything non-finite or out of range. A NaN would survive the comparisons
 * in `px()` — NaN is neither `< 0` nor `>= width` — and index the buffer at NaN, which
 * silently writes nothing and leaves a point missing with no error anywhere.
 */
function project(lat: number, lon: number, area: Rect): { x: number; y: number } | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  if (area.w <= 0 || area.h <= 0) return null;
  return {
    x: area.x + ((lon + 180) / 360) * (area.w - 1),
    y: area.y + ((90 - lat) / 180) * (area.h - 1),
  };
}

/**
 * Coastlines, contacts and spots, in a box.
 *
 * PLATE CARRÉE because it is one multiplication per coordinate and because grid squares are
 * rectangles on it — the same reasoning pages/gridmap.tsx records. Distances lie toward the
 * poles and nothing here measures distance.
 *
 * The coastlines are drawn as POINTS rather than joined lines. At 420 pixels wide the
 * vendored 110 m rings are dense enough that consecutive vertices land on adjacent pixels,
 * so line-drawing would cost a Bresenham per segment across ~5,000 points and look
 * identical. Measured at this size, not assumed for all sizes: a much larger map would need
 * the lines.
 */
export function drawMap(
  s: Surface,
  area: Rect,
  data: {
    /** Contacts to plot — the last 24 hours. */
    contacts?: MapPoint[];
    /** Stations that heard US, from PSKReporter. */
    heardBy?: MapPoint[];
    /** Where we are. */
    home?: MapPoint | null;
  },
): void {
  // Ocean, so the box reads as a map before any land is drawn and an empty one still looks
  // deliberate.
  fillRect(s, area, [10, 14, 26]);

  for (const ring of LAND_RINGS) {
    for (const [lon, lat] of ring) {
      const p = project(lat, lon, area);
      if (p) px(s, Math.round(p.x), Math.round(p.y), 58, 74, 96);
    }
  }

  // HEARD-BY UNDER CONTACTS, so a contact is never hidden by a spot. There are far more
  // spots than contacts and they are the less important of the two.
  for (const h of data.heardBy ?? []) {
    const p = project(h.lat, h.lon, area);
    if (p) px(s, Math.round(p.x), Math.round(p.y), 90, 130, 200);
  }

  for (const c of data.contacts ?? []) {
    const p = project(c.lat, c.lon, area);
    if (!p) continue;
    // CLAMPED so the two-pixel dot cannot straddle the edge. A point exactly on the right
    // or bottom edge would otherwise put half its dot outside the box.
    const x = Math.min(Math.round(p.x), area.x + area.w - 2);
    const y = Math.min(Math.round(p.y), area.y + area.h - 2);
    // Two pixels across, because one pixel of contact on a map with 5,000 pixels of
    // coastline is not findable — which is the same reasoning the waterfall's
    // nearest-neighbour mapping rests on.
    for (let dy = 0; dy <= 1; dy++) {
      for (let dx = 0; dx <= 1; dx++) px(s, x + dx, y + dy, 255, 170, 40);
    }
  }

  const homeP = data.home ? project(data.home.lat, data.home.lon, area) : null;
  if (homeP) {
    const p = homeP;
    const x = Math.round(p.x);
    const y = Math.round(p.y);
    // A cross, so home is distinguishable from a contact at a glance.
    // Clipped to the AREA. `px` only knows about the surface, so a home marker near the
    // edge would otherwise reach three pixels outside the map.
    for (let d = -3; d <= 3; d++) {
      const cx = x + d;
      const cy = y + d;
      if (cx >= area.x && cx < area.x + area.w) px(s, cx, y, 255, 255, 255);
      if (cy >= area.y && cy < area.y + area.h) px(s, x, cy, 255, 255, 255);
    }
  }

  strokeRect(s, area, [58, 74, 96]);
}

// `drawSideColumn` WAS REMOVED HERE, and it is worth saying why rather than leaving a
// silence. It drew the right column's swatches and returned their labels in one function —
// the right idea — but nothing ever called it: `services/radio/index.ts` uses
// `drawBandStrip` and builds the solar line inline, and no check exercised it either. So it
// sat through the 720p -> 1080p pass untouched, with a swatch offset of `textX - 26` and a
// 14x12 swatch sized against a 17px font, plus a SECOND copy of the solar-line format that
// could silently disagree with the one that ships. Dead code with stale geometry and a
// duplicated format is an invitation; the git history has it if it is ever wanted.

/**
 * DejaVu Sans Mono's advance width, as a fraction of the font size.
 *
 * The chip rectangles and their labels are drawn by two different systems — pixels here,
 * `drawtext` there — and the ONLY thing that can keep them aligned across a row is deriving
 * both from one character width. Measured from the face rather than guessed: DejaVu Sans
 * Mono advances 1233/2048 of an em.
 */
// RE-EXPORTED, NOT REDEFINED. These lived here and were about to be duplicated into
// `lib/stream/layout.ts`, which is the exact shape of the bug this whole module exists to
// avoid: two numbers that must agree, in two files, with nothing checking.
export { MONO_ADVANCE, charWidth } from "@/lib/stream/layout";

/**
 * A horizontal strip of band chips, in rows, with the labels aligned to them.
 *
 * Returns the text lines for `drawtext`. Each chip's label is padded to exactly
 * `charsPerChip` characters, and the chip rectangle is placed at that same multiple of the
 * character width — so a chip and its label cannot drift apart no matter how many there are.
 * The alternative, choosing a chip width and then hoping the text lines up, drifts by a
 * pixel per chip and is visibly wrong by the eighth.
 */
export function drawBandStrip(
  s: Surface,
  chips: BandChip[],
  opts: {
    x: number;
    /** The y the TEXT BLOCK starts at — the same value the drawtext filter is given. */
    textY: number;
    /** Which line of that block the first chip row lands on. */
    firstLine: number;
    fontSize: number;
    lineH: number;
    perRow: number;
    charsPerChip: number;
  },
): string {
  const cw = charWidth(opts.fontSize);
  const pitch = opts.charsPerChip * cw;
  const rows = Math.ceil(chips.length / opts.perRow);
  const lines: string[] = [];

  // TWO TEXT LINES PER CHIP ROW, so a chip is tall enough to be a chip and its label still
  // lands inside it. The first line carries the label, the second is blank and gives the
  // box its height.
  const LINES_PER_ROW = 2;
  const chipH = opts.lineH * LINES_PER_ROW - 4;

  for (let r = 0; r < rows; r++) {
    const row = chips.slice(r * opts.perRow, (r + 1) * opts.perRow);
    let line = "";
    // THE BOX IS POSITIONED FROM THE TEXT LINE, not from its own running total. That was
    // the bug on the live stream: the labels rendered one line ABOVE their boxes, because
    // the text advanced by lineH and the boxes advanced by chipH+6 and nothing made those
    // agree. Now the box is placed at the line its label will occupy, and a padding of 4
    // above puts the glyphs inside it rather than on its edge.
    // CENTRED, not top-aligned. The first attempt put the box 4 pixels above its text
    // line, which left the label sitting against the top edge with half the chip empty
    // beneath it. `drawtext`'s y is the TOP of the glyph box, so centring means offsetting
    // the box by half the leftover height — derived from the font size rather than nudged
    // until it looked right, so a different font size stays centred.
    const padTop = Math.round((chipH - opts.fontSize) / 2);
    const lineIndex = opts.firstLine + r * LINES_PER_ROW;
    const rowY = opts.textY + lineIndex * opts.lineH - padTop;
    row.forEach((chip, i) => {
      const rect: Rect = {
        x: Math.round(opts.x + i * pitch),
        y: rowY,
        // FOUR PIXELS narrower than the pitch, not one CHARACTER. A character-wide gap
        // meant the chip box was 9 characters while the label was 10, so the last character
        // of every label sat in the gap and the row read as one run-on string. The gap only
        // has to be visible, not a whole glyph wide.
        w: Math.round(pitch) - 4,
        h: chipH,
      };
      const grade = GRADE_RGB[chip.usability];
      fillRect(s, rect, [26, 26, 34]);
      strokeRect(s, rect, grade);
      fillRect(s, { x: rect.x, y: rect.y, w: rect.w, h: 3 }, grade);

      // BAND, STATIONS, ENTITIES — padded to exactly the chip's character budget, so the
      // next chip starts where its rectangle does.
      // A LEADING SPACE so the text does not touch the chip's left border, and the whole
      // thing padded to the chip's character budget so the next label starts exactly where
      // the next rectangle does.
      const label = ` ${chip.band} ${chip.count}/${chip.entities}`;
      line += label.padEnd(opts.charsPerChip).slice(0, opts.charsPerChip);
    });
    lines.push(line.trimEnd());
    // The blank that gives the box its second line of height. Emitted after every row
    // including the last, so the caller can put something below without it riding up.
    lines.push("");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The ticker
// ---------------------------------------------------------------------------

/**
 * The invitation, shown along the bottom now and then.
 *
 * A viewer who does not already know they can ask to be worked never will, because nothing
 * on the frame says so. But a permanent banner across a waterfall is a permanent banner
 * across the thing people came to watch — so it appears, sits long enough to be read, and
 * goes away.
 *
 * PURE AND TIME-DRIVEN rather than stateful, so its cycle is assertable: given a clock it
 * returns what should be on screen at that instant, and nothing has to be stepped to test it.
 */
export interface TickerCycle {
  /** How long the message stays up. */
  showMs: number;
  /** How long the gap between showings is. */
  hideMs: number;
}

export const DEFAULT_TICKER: TickerCycle = { showMs: 20_000, hideMs: 100_000 };

/**
 * Which message to show, or null for the quiet part of the cycle.
 *
 * The variation is derived from the clock rather than drawn at random, because a random
 * choice per frame would flicker between messages ten times a second. Each showing picks
 * one message and keeps it for the whole showing.
 */
export function tickerLine(
  messages: string[],
  now: number,
  cycle: TickerCycle = DEFAULT_TICKER,
): string | null {
  if (messages.length === 0) return null;
  const period = cycle.showMs + cycle.hideMs;
  if (period <= 0) return null;
  // JavaScript's `%` keeps the sign of its LEFT operand, so `now % period` goes negative
  // for a negative clock and every comparison after it is wrong. The `+ period` before the
  // second modulo is what fixes it.
  const phase = ((now % period) + period) % period;
  if (phase >= cycle.showMs) return null;
  // AND THE SAME TRAP ONE LINE DOWN, which the phase fix did not cover: a negative cycle
  // number gives a negative index, `messages[-1]` is `undefined`, and the ticker silently
  // never appears. Found by asserting that the phase repeats every period rather than by
  // asserting any particular instant — the first version of that assertion checked one
  // arbitrary negative time, which happened to fall in the hide window and proved nothing.
  const cycles = Math.floor(now / period);
  const index = ((cycles % messages.length) + messages.length) % messages.length;
  return messages[index] ?? null;
}

// `drawTickerBar` WAS REMOVED, and the reason is the sharpest lesson in this file.
//
// The ticker still needs a backing — the waterfall underneath is bright and busy and white
// glyphs on it are unreadable exactly where a signal happens to be. But it must NOT be
// painted into the canvas, because the ticker sits at y 1002 and `WaterfallCanvas.push`
// scrolls every row below y 375 upward one row per spectrum frame. Anything drawn into that
// region is not a rectangle, it is a rectangle with a velocity:
//
//   pushed at 4 rows/s (SPECTRUM_INTERVAL_MS 250), the 57 px bar climbs out of the frame
//   over (1002 - 375) / 4 = 157 s, against a ticker period of 120 s — so one or two opaque
//   ghost bars were essentially ALWAYS crawling up the waterfall, and during a showing the
//   once-a-second redraw at a fixed y left a 133 px smear.
//
// Measured by simulation against these real modules, not reasoned about. The voice profile
// (50 ms rows, 20/s) makes it five times worse.
//
// So the backing is now `drawtext`'s own `box=1`, which ffmpeg paints over the finished
// video every frame. It cannot scroll, cannot ghost, and costs nothing. The lesson
// generalises and is now asserted: the panel code may only paint ABOVE `TOP_MARGIN`.
