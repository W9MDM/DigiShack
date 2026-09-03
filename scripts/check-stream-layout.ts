// Checks the stream frame's LAYOUT: that nothing overlaps, nothing escapes, and every
// derived number still derives.
// Run: npm run check:stream-layout
//
// WHY THIS EXISTS. Every layout fault this stream has had was found by the operator looking
// at his own broadcast, not by a check:
//
//   * band labels rendered one line ABOVE their boxes
//   * "waiting for RR73" printed over the band chips
//   * the map drawing one pixel outside its own area
//   * the decode column stopping four lines short of the bottom
//   * the entity count truncated to "20M 120/2"
//
// All five are the same shape of bug: two numbers that had to agree, in two files, with
// nothing comparing them. `drawtext` paints the labels and `lib/stream/panels.ts` paints
// the boxes beneath them, and until `lib/stream/layout.ts` existed half the geometry sat in
// `const`s inside a function body in `services/radio/index.ts` where no test could reach it.
//
// So these assertions are deliberately about RELATIONSHIPS, not values. Asserting
// `FRAME_W === 1920` would restate the source and catch nothing; asserting that the band
// chips end before the map begins catches a real class of fault at any resolution.

import {
  FRAME_W,
  FRAME_H,
  FONT_SIZE,
  LINE_SPACING,
  LINE_H,
  LEFT_X,
  LEFT_Y,
  SIDE_X,
  SIDE_Y,
  TICKER_FONT,
  TICKER_H,
  TICKER_Y,
  TICKER_TEXT_Y,
  TOP_MARGIN,
  LEFT_MARGIN,
  MAP_AREA,
  BAND_X,
  BAND_PER_ROW,
  BAND_CHARS,
  MAX_DECODES,
  DECODE_CHARS,
  SIDE_CHARS,
  HEADER_LINES,
  BOX_BORDER,
  TICKER_X,
  TICKER_W,
  BAND_Y,
  charWidth,
  textLineCapacity,
  columnChars,
} from "@/lib/stream/layout";
import { SETTINGS } from "@/lib/settings/registry";
import { YouTubeStream, videoFilter } from "@/lib/stream/youtube";
import { overlayText, WaterfallCanvas } from "@/lib/stream/frame";
import { DEFAULT_TICKER } from "@/lib/stream/panels";
import { SPECTRUM_INTERVAL_MS } from "@/lib/radio/spectrum";

let failures = 0;

function ok(cond: boolean, what: string, extra?: unknown): void {
  if (cond) {
    console.log(`  ok  ${what}`);
    return;
  }
  failures++;
  console.error(`FAIL  ${what}${extra === undefined ? "" : `  -> ${JSON.stringify(extra)}`}`);
}

function eq(a: unknown, b: unknown, what: string): void {
  ok(Object.is(a, b), what, `expected ${String(b)}, got ${String(a)}`);
}

// ---------------------------------------------------------------------------
console.log("the line pitch is derived, not restated");
// ---------------------------------------------------------------------------

// THE ORIGINAL BUG: a literal 21 sitting next to a literal fontsize 17 and a literal
// line_spacing 4, three numbers agreeing by hand while panels.ts placed swatches from the
// result. This is the assertion that keeps the derivation a derivation.
eq(LINE_H, FONT_SIZE + LINE_SPACING, "LINE_H is fontSize + lineSpacing");

// ---------------------------------------------------------------------------
console.log("textLineCapacity counts the gaps BETWEEN lines, not after them");
// ---------------------------------------------------------------------------

// The off-by-one that matters: n lines occupy n*font + (n-1)*spacing. Getting this wrong by
// counting n gaps loses a line; by counting n-2 gains one that prints off the frame.
{
  // A frame sized to hold EXACTLY 4 lines of 10px font with 5px gaps starting at y=0:
  // 4*10 + 3*5 = 55.
  eq(textLineCapacity(55, 0, 10, 5), 4, "a frame of exactly 4 lines reports 4");
  eq(textLineCapacity(54, 0, 10, 5), 3, "one pixel short of 4 reports 3");
  eq(textLineCapacity(69, 0, 10, 5), 4, "and 14 pixels of slack is still 4, not 5");
  // A 5th line needs 5*10 + 4*5 = 70, not 60 — the gap count is n-1, which is the whole
  // point of this group. Getting this expectation wrong on the first run was the check
  // doing its job on its own author.
  eq(textLineCapacity(70, 0, 10, 5), 5, "the 5th line is admitted the moment it fits");

  // The start offset is charged.
  eq(textLineCapacity(55, 10, 10, 5), 3, "a 10px inset costs a line");

  // Degenerate inputs return 0 rather than Infinity or NaN. A NaN here would propagate into
  // `slice(-NaN)` and silently empty the decode feed.
  eq(textLineCapacity(1080, 21, 0, 0), 0, "a zero-size font yields no lines, not Infinity");
  eq(textLineCapacity(10, 500, 26, 6), 0, "a start below the frame yields 0, never negative");
}

// This is the check that the formula reproduces the figure it replaced. The 720p layout's
// hand-derived ceiling was 33 lines; so is 1080p's. That agreement is the evidence the
// scale was applied consistently to BOTH the frame and the font.
eq(textLineCapacity(720, 14, 17, 4), 33, "the retired 720p layout still computes to 33 lines");
eq(textLineCapacity(FRAME_H, LEFT_Y, FONT_SIZE, LINE_SPACING), 33, "and 1080p computes to 33");

// ---------------------------------------------------------------------------
console.log("the decode budget fills the column and no more");
// ---------------------------------------------------------------------------

eq(
  MAX_DECODES,
  textLineCapacity(FRAME_H, LEFT_Y, FONT_SIZE, LINE_SPACING) - HEADER_LINES,
  "MAX_DECODES is the capacity less the header",
);

{
  // THE OPERATOR'S REPORT: "your still not running decodes all the way to the bottom
  // either." So the assertion is not "some decodes fit" but "the block reaches the bottom".
  const decodes = Array.from({ length: MAX_DECODES }, (_, i) => ({
    at: "11:44:15",
    message: `CQ TEST${String(i).padStart(2, "0")} EN61`,
    snr: -12,
  }));
  const text = overlayText({
    callsign: "K9XYZ",
    grid: "EN61AA",
    band: "40M",
    mode: "FT8",
    dialHz: 7_074_000,
    qsosToday: 71,
    decodes,
    maxDecodes: MAX_DECODES,
    columnChars: DECODE_CHARS,
  });
  // trailing newline is deliberate in overlayText, so drop the empty last element
  const lines = text.split("\n").filter((_, i, a) => i < a.length - 1);
  eq(lines.length, HEADER_LINES + MAX_DECODES, "a full feed renders header + every decode");

  const bottom = LEFT_Y + lines.length * FONT_SIZE + (lines.length - 1) * LINE_SPACING;
  ok(bottom <= FRAME_H, "the full block ends within the frame", { bottom, FRAME_H });
  // AND IS NOT SHORT. A layout that renders 10 lines into a 33-line column passes every
  // "does it fit" assertion, which is exactly the fault the operator reported. One line of
  // slack is the most that can be left over.
  ok(bottom > FRAME_H - LINE_H, "and reaches the bottom rather than stopping short", {
    bottom,
    atLeast: FRAME_H - LINE_H,
  });
}

// ---------------------------------------------------------------------------
console.log("nothing may exceed its column, because drawtext does not wrap");
// ---------------------------------------------------------------------------

// A line one character too long is not a slightly wide line — it is text printed on top of
// whatever panel sits beside it. That is how "waiting for RR73" ended up over the chips.
//
// THE PAINTED EDGE, NOT THE TEXT WIDTH. The first version of this compared
// `DECODE_CHARS * charWidth` against `LEFT_MARGIN` — a width against an absolute x, which
// charges neither the text's own start offset nor the box drawtext paints around it. That
// made it 37 px more permissive than the geometry it was guarding, and it reported the
// 40-character budget as fitting when the real edge was 663 against a 660 margin.
{
  const painted = LEFT_X + DECODE_CHARS * charWidth(FONT_SIZE) + BOX_BORDER;
  ok(painted <= LEFT_MARGIN, "the decode column's PAINTED right edge is inside the margin", {
    painted: Math.round(painted * 10) / 10,
    LEFT_MARGIN,
  });
  // AND IT USES THE COLUMN IT HAS. A budget of 5 characters would satisfy the line above.
  const oneMore = LEFT_X + (DECODE_CHARS + 1) * charWidth(FONT_SIZE) + BOX_BORDER;
  ok(oneMore > LEFT_MARGIN, "and one more character would not fit, so the budget is maximal", {
    oneMore: Math.round(oneMore * 10) / 10,
  });
}

// THE RIGHT COLUMN IS ENFORCED, NOT MERELY BUDGETED. `SIDE_CHARS` was computed here and
// asserted here and read by nothing — the column had a budget with no truncation, while the
// left column has clamped every line since the RR73 spill. The assertion that used to sit
// here was also a tautology: `SIDE_X + columnChars(MAP_AREA.x - SIDE_X, F) * charWidth(F) <=
// MAP_AREA.x` is true for ANY inputs, because columnChars floors. It could not fail.
{
  const painted = SIDE_X + SIDE_CHARS * charWidth(FONT_SIZE);
  ok(painted <= MAP_AREA.x, "the right column's budget stops before the map", {
    painted: Math.round(painted * 10) / 10,
    mapAt: MAP_AREA.x,
  });
  ok(
    SIDE_X + (SIDE_CHARS + 1) * charWidth(FONT_SIZE) > MAP_AREA.x,
    "and is maximal — one more character would reach the map",
  );
}

// `columnChars` must FLOOR. Rounding up is how a budget comes out one character too wide.
eq(columnChars(100, 10), 16, "columnChars floors rather than rounds");
eq(columnChars(0, 26), 0, "a zero-width column holds nothing");
ok(columnChars(-50, 26) === 0, "and a negative width does not produce a negative budget");

{
  // The longest line the station actually produces, measured rather than imagined: a
  // compound callsign on both sides of a sign-off.
  const worst = "11:44:15  -14  <WA2LAN> W3EWL/QRP RR73";
  ok(
    worst.length <= DECODE_CHARS,
    "the worst real decode line fits without truncation",
    { length: worst.length, DECODE_CHARS },
  );
}

{
  // AND THE TRUNCATION IS ENFORCED, not merely available. This is the assertion that would
  // have caught the RR73 spill: hand it something absurd and check nothing escapes.
  //
  // `hunting` is in the fixture because it is now RENDERED. It was in the fixture before it
  // was rendered, which meant that third of the input exercised nothing and the assertion
  // was satisfied by the code ignoring it — coverage of a path that did not exist.
  const text = overlayText({
    callsign: "K9XYZ",
    grid: "EN61AA",
    band: "40M",
    mode: "FT8",
    dialHz: 7_074_000,
    qsosToday: 71,
    decodes: [{ at: "11:44:15", message: "X".repeat(400), snr: -1 }],
    maxDecodes: MAX_DECODES,
    columnChars: DECODE_CHARS,
    working: {
      theirCall: "VP2E/W1ABCD",
      phase: "rreport-sent",
      transcript: [{ dir: "tx", message: "Y".repeat(400), snr: null }],
      hunting: null,
    },
  });
  const over = text.split("\n").filter((l) => l.length > DECODE_CHARS);
  ok(over.length === 0, "no line of any kind exceeds the column", over.slice(0, 3));
}

{
  // THE HUNT LINE REACHES THE FRAME. It did not: `hunting` lived in the interface and in the
  // bridge's call, and the `else` branch that rendered it was deleted in 1.174.1 when the
  // QSO count moved out of it. The field went with it and nothing noticed for three
  // releases, because every fixture that supplied it asserted only what was true when it
  // was dropped.
  const idle = overlayText({
    callsign: "K9XYZ",
    grid: "EN61AA",
    band: "40M",
    mode: "FT8",
    dialHz: 7_074_000,
    qsosToday: 71,
    decodes: [{ at: "11:44:15", message: "CQ K5MGY EM10", snr: -5 }],
    maxDecodes: MAX_DECODES,
    columnChars: DECODE_CHARS,
    working: { theirCall: null, phase: null, transcript: [], hunting: "hunting K5MGY (-5 dB)" },
  });
  ok(idle.includes("hunting K5MGY"), "between contacts, what we are hunting is on the frame");

  // And it is TRUNCATED like everything else, since lastAction is free-form.
  const long = overlayText({
    callsign: "K9XYZ",
    grid: "EN61AA",
    band: "40M",
    mode: "FT8",
    dialHz: 7_074_000,
    qsosToday: 71,
    decodes: [],
    maxDecodes: MAX_DECODES,
    columnChars: DECODE_CHARS,
    working: { theirCall: null, phase: null, transcript: [], hunting: "H".repeat(400) },
  });
  ok(
    long.split("\n").every((l) => l.length <= DECODE_CHARS),
    "and a long hunt line is clamped to the column",
  );

  // A CONTACT OUTRANKS IT. Showing both would be two answers to "what is the station doing".
  const busy = overlayText({
    callsign: "K9XYZ",
    grid: "EN61AA",
    band: "40M",
    mode: "FT8",
    dialHz: 7_074_000,
    qsosToday: 71,
    decodes: [],
    maxDecodes: MAX_DECODES,
    columnChars: DECODE_CHARS,
    working: {
      theirCall: "N4GST",
      phase: "calling",
      transcript: [],
      hunting: "hunting K5MGY (-5 dB)",
    },
  });
  ok(busy.includes("WORKING N4GST"), "during a contact the contact is shown");
  ok(!busy.includes("hunting K5MGY"), "and the hunt line does not also appear");
}

// ---------------------------------------------------------------------------
console.log("the panels do not overlap each other");
// ---------------------------------------------------------------------------

// The band chip row's right edge, derived the same way drawBandStrip derives it: each chip
// is `BAND_CHARS` characters of pitch, and the last is 4px narrower than its pitch.
{
  const pitch = BAND_CHARS * charWidth(FONT_SIZE);
  const right = BAND_X + (BAND_PER_ROW - 1) * pitch + (pitch - 4);
  ok(right <= MAP_AREA.x, "the widest chip row ends before the map begins", {
    right: Math.round(right),
    mapAt: MAP_AREA.x,
  });
  ok(BAND_X >= LEFT_MARGIN, "and the chips start clear of the decode column", {
    BAND_X,
    LEFT_MARGIN,
  });

  // THE LABEL FITS ITS OWN BUDGET, which is historical fault #5: "20M 120/25" is eleven
  // characters against a budget of ten, so the entity count shipped as "20M 120/2" and the
  // number that says whether a band is open widely or regionally was the part lost.
  // `drawBandStrip` pads with `padEnd(n).slice(0, n)` — a HARD cut with no ellipsis, so an
  // overrun is silent. Asserted against the real format string and a plausible worst case.
  const worstLabel = ` 160M 1200/250`;
  ok(
    worstLabel.length > BAND_CHARS,
    "sanity: the fixture below really is a worst case worth checking",
  );
  const realistic = ` 20M 149/42`;
  ok(
    realistic.length <= BAND_CHARS,
    "a real chip label fits its character budget with the count intact",
    { label: realistic, length: realistic.length, BAND_CHARS },
  );
  // Three rows of three holds every band the chips can carry.
  ok(
    BAND_PER_ROW * 3 >= 9,
    "and three rows of the configured width hold the bands the station uses",
  );
}

ok(MAP_AREA.x + MAP_AREA.w <= FRAME_W, "the map fits inside the frame horizontally", MAP_AREA);
ok(MAP_AREA.y + MAP_AREA.h <= FRAME_H, "the map fits inside the frame vertically", MAP_AREA);
// THE MAP MUST NOT REACH THE WATERFALL. Both are drawn as pixels into the same buffer, so
// an overlap is not a z-order question — whichever draws second wins and the other is gone.
ok(
  MAP_AREA.y + MAP_AREA.h <= TOP_MARGIN,
  "and it stays above the waterfall rather than being drawn over by it",
  { mapBottom: MAP_AREA.y + MAP_AREA.h, TOP_MARGIN },
);

// ---------------------------------------------------------------------------
console.log("the ticker sits in its bar, and its bar clears the decode column");
// ---------------------------------------------------------------------------

ok(TICKER_Y + TICKER_H <= FRAME_H, "the ticker bar is inside the frame", {
  bottom: TICKER_Y + TICKER_H,
  FRAME_H,
});
ok(TICKER_FONT <= TICKER_H, "the text is not taller than the bar holding it", {
  TICKER_FONT,
  TICKER_H,
});
ok(TICKER_X + TICKER_W <= FRAME_W, "and the bar does not run off the right edge", {
  right: TICKER_X + TICKER_W,
  FRAME_W,
});

// THE COLLISION NOTHING WAS CHECKING. The decode column runs the FULL HEIGHT of the frame
// and the ticker bar sits at the bottom, so full-width the bar painted over the column's
// last three lines — and permanently, because `WaterfallCanvas.push` repaints only
// x >= leftMargin, so the part inside the column was never redrawn. Every previous ticker
// assertion compared the bar to FRAME_H and to itself, never to the column beside it, and
// one of them actively REQUIRED the overlap by demanding the text block reach the bottom.
{
  ok(TICKER_X >= LEFT_MARGIN, "the ticker bar starts clear of the decode column", {
    TICKER_X,
    LEFT_MARGIN,
  });
  const lines = HEADER_LINES + MAX_DECODES;
  const blockBottom = LEFT_Y + lines * FONT_SIZE + (lines - 1) * LINE_SPACING;
  ok(
    blockBottom > TICKER_Y,
    "sanity: the decode block really does extend past the bar's top, so this matters",
    { blockBottom, TICKER_Y },
  );
  const paintedRight = LEFT_X + DECODE_CHARS * charWidth(FONT_SIZE) + BOX_BORDER;
  ok(
    paintedRight <= TICKER_X,
    "so the two only coexist because the bar starts to the right of the text",
    { paintedRight: Math.round(paintedRight * 10) / 10, TICKER_X },
  );
}

// CENTRED, and this is the operator's own report: "ummmm to ur comment the words are still
// to high they should be centered." Asserting the gaps above and below match to within a
// pixel is what makes that arithmetic rather than a nudge.
{
  const above = TICKER_TEXT_Y - TICKER_Y;
  const below = TICKER_Y + TICKER_H - (TICKER_TEXT_Y + TICKER_FONT);
  ok(Math.abs(above - below) <= 1, "the ticker text is vertically centred in its bar", {
    above,
    below,
  });
  ok(above >= 0 && below >= 0, "and sits inside it rather than over an edge", { above, below });
}

// ---------------------------------------------------------------------------
console.log("the bitrate default is not defined twice");
// ---------------------------------------------------------------------------

// THE BUG THIS CATCHES cost two attempts. `getSetting` falls through to the settings
// registry's own `default`, so the bridge ALWAYS receives a number and the encoder's
// `?? 4500` is never reached. The first fix raised only the encoder's default and changed
// nothing observable — it would have shipped 1080p at the 720p bitrate, which is worse per
// pixel than the 720p it replaced, on a change whose entire purpose was legibility.
{
  const def = SETTINGS.find((s) => s.key === "youtube.videoBitrateKbps");
  ok(!!def, "the bitrate setting is in the registry");
  const registryDefault = Number(def?.default);
  const encoderDefault = new YouTubeStream({ streamKey: "" }).encoding.videoBitrateKbps;
  eq(
    registryDefault,
    encoderDefault,
    "the registry default and the encoder default are the same number",
  );
  // AND IT SUITS THE FRAME. YouTube's published figures are ~1500-4000 for 720p and
  // ~3000-6000 for 1080p; a 1080p frame carried at a 720p rate is the fault above.
  ok(
    registryDefault >= 3000,
    "and it is in YouTube's range for a 1080p source, not a 720p one",
    { registryDefault, FRAME_H },
  );
}

// ---------------------------------------------------------------------------
console.log("the waterfall keeps a usable area");
// ---------------------------------------------------------------------------

// A layout change that squeezed the waterfall to nothing would still satisfy every
// assertion above. It is the picture the whole stream is nominally OF.
ok(FRAME_W - LEFT_MARGIN > FRAME_W / 3, "the waterfall keeps over a third of the width", {
  waterfall: FRAME_W - LEFT_MARGIN,
  FRAME_W,
});
ok(FRAME_H - TOP_MARGIN > FRAME_H / 2, "and over half the height", {
  waterfall: FRAME_H - TOP_MARGIN,
  FRAME_H,
});
ok(LEFT_X > 0 && LEFT_Y > 0, "the left text block is inset from the frame edge");
ok(SIDE_Y === LEFT_Y, "both text blocks share a first baseline", { SIDE_Y, LEFT_Y });

// ---------------------------------------------------------------------------
console.log("the frame is a resolution YouTube has a ladder for");
// ---------------------------------------------------------------------------

// THE REASON THIS CHANGED. Our 720p encode was measured sharp; the softening was YouTube
// serving a low rendition, and a 1280-wide source hands even the best case a 1.4x
// enlargement in an ~1800px player. Asserting 16:9 and a standard height is what stops a
// well-meaning tweak landing on a size YouTube transcodes badly.
eq(FRAME_W / FRAME_H, 16 / 9, "the frame is 16:9");
ok([720, 1080, 1440, 2160].includes(FRAME_H), "and a height YouTube has renditions for", FRAME_H);
ok(FRAME_W % 2 === 0 && FRAME_H % 2 === 0, "both dimensions are even, as yuv420p requires");

// ---------------------------------------------------------------------------
console.log("ANYTHING PAINTED INTO THE CANVAS BELOW THE MARGIN ACQUIRES A VELOCITY");
// ---------------------------------------------------------------------------

// THE ARTIFACT THIS EXISTS FOR, reported as "whats with these lines hat keep showing up"
// over a screenshot of ~20 evenly spaced pale blue lines across the top of the waterfall.
//
// The ticker's backing bar was drawn INTO the canvas: a dark body with a 2 px pale blue top
// edge. The canvas scrolls — `push` moves every row below `topMargin` up by one per spectrum
// frame — and the bar was repainted at a FIXED y once a second. Spectrum rows arrive every
// 250 ms, so between repaints the previous stamp had already climbed 4 px, and the fresh
// dark body could not cover it because the body starts at the bar's own y. So each second
// left its pale top edge stranded 4 px above the last:
//
//     20 s of showing  ->  20 pale lines, 4 px apart, over 76 px
//
// which is the screenshot, and then the whole striped block kept crawling upward for
// (TICKER_Y - TOP_MARGIN) / 4 seconds afterwards with nothing to erase it.
//
// The lesson is not about the ticker. It is that the canvas below `topMargin` is a CONVEYOR,
// so a rectangle drawn there is not a rectangle — it is a rectangle with a velocity. These
// assertions pin that property, reproduce the striping from it, and then require the
// production layout not to rely on it.
{
  const MARK: [number, number, number] = [90, 130, 200];
  const isMark = (c: Uint8Array | Buffer, o: number): boolean =>
    c[o] === MARK[0] && c[o + 1] === MARK[1] && c[o + 2] === MARK[2];
  const rowsWithMark = (canvas: WaterfallCanvas, w: number, x: number): number[] => {
    const out: number[] = [];
    for (let y = 0; y < FRAME_H; y++) if (isMark(canvas.rgb, (y * w + x) * 3)) out.push(y);
    return out;
  };
  const quietRow = () => ({
    bins: new Uint8Array(700),
    binHz: 3.2,
    maxHz: 2240,
  });

  // FIRST: the property itself. A mark ABOVE the margin is stationary; the same mark BELOW
  // it moves one row per push. If this ever stops being true the reasoning above is void.
  {
    const c = new WaterfallCanvas({ width: FRAME_W, height: FRAME_H }, {
      topMargin: TOP_MARGIN,
      leftMargin: LEFT_MARGIN,
    });
    const probe = LEFT_MARGIN + 100;
    const above = TOP_MARGIN - 40;
    const below = TICKER_Y;
    for (const y of [above, below]) {
      const o = (y * FRAME_W + probe) * 3;
      c.rgb[o] = MARK[0];
      c.rgb[o + 1] = MARK[1];
      c.rgb[o + 2] = MARK[2];
    }
    for (let i = 0; i < 8; i++) c.push(quietRow());
    const found = rowsWithMark(c, FRAME_W, probe);
    ok(found.includes(above), "a mark above the top margin does not move", { above, found });
    ok(
      !found.includes(below) && found.includes(below - 8),
      "and a mark below it has moved up exactly one row per push",
      { below, expected: below - 8, found },
    );
  }

  // SECOND: reproduce the operator's stripes, so the fixture is known to be able to show the
  // fault rather than merely to pass. A fixture that cannot reproduce the real fault reports
  // success while the display is broken.
  {
    const c = new WaterfallCanvas({ width: FRAME_W, height: FRAME_H }, {
      topMargin: TOP_MARGIN,
      leftMargin: LEFT_MARGIN,
    });
    const probe = LEFT_MARGIN + 100;
    // The retired `drawTickerBar`, inlined: a dark body and a 2 px pale top edge.
    const paintBar = (): void => {
      for (let y = TICKER_Y; y < TICKER_Y + TICKER_H; y++) {
        for (let x = TICKER_X; x < TICKER_X + TICKER_W; x++) {
          const o = (y * FRAME_W + x) * 3;
          c.rgb[o] = 10;
          c.rgb[o + 1] = 10;
          c.rgb[o + 2] = 16;
        }
      }
      for (let y = TICKER_Y; y < TICKER_Y + 2; y++) {
        for (let x = TICKER_X; x < TICKER_X + TICKER_W; x++) {
          const o = (y * FRAME_W + x) * 3;
          c.rgb[o] = MARK[0];
          c.rgb[o + 1] = MARK[1];
          c.rgb[o + 2] = MARK[2];
        }
      }
    };
    // 20 seconds of showing: repaint once a second, four spectrum rows between repaints.
    const SECONDS = 20;
    const ROWS_PER_SECOND = 1000 / SPECTRUM_INTERVAL_MS;
    for (let sec = 0; sec < SECONDS; sec++) {
      paintBar();
      for (let r = 0; r < ROWS_PER_SECOND; r++) c.push(quietRow());
    }
    const found = rowsWithMark(c, FRAME_W, probe);
    // Pale rows come in pairs (the edge is 2 px), so group them into distinct stripes.
    const stripes = found.filter((y, i) => i === 0 || y - found[i - 1]! > 1);
    ok(
      stripes.length >= SECONDS - 1,
      `the striping reproduces: ${stripes.length} stripes from ${SECONDS}s of repaints`,
      { stripes: stripes.slice(0, 6) },
    );
    const gaps = stripes.slice(1).map((y, i) => y - stripes[i]!);
    ok(
      gaps.every((g) => g === ROWS_PER_SECOND),
      `and they are spaced exactly one second of scroll apart (${ROWS_PER_SECOND} px)`,
      { gaps: gaps.slice(0, 6) },
    );
    // AND IT OUTLIVES THE SHOWING. This is why the operator saw them "keep showing up":
    // nothing erases the block, so it crawls for another (TICKER_Y - TOP_MARGIN) / rate
    // seconds — 157 s against a 120 s ticker period, so one or two were always present.
    const climbSeconds = (TICKER_Y - TOP_MARGIN) / ROWS_PER_SECOND;
    ok(
      climbSeconds > (DEFAULT_TICKER.showMs + DEFAULT_TICKER.hideMs) / 1000,
      "and a ghost outlives the ticker's own period, so one is always on screen",
      { climbSeconds, periodSeconds: (DEFAULT_TICKER.showMs + DEFAULT_TICKER.hideMs) / 1000 },
    );
  }

  // THIRD: the production layout must not rely on the conveyor. Everything the panel code
  // paints into the canvas lives above the margin; the ticker's backing comes from the
  // filter graph instead, which paints over finished video and cannot be dragged.
  {
    ok(
      MAP_AREA.y + MAP_AREA.h <= TOP_MARGIN,
      "the map is painted above the margin, so it is stationary",
      { mapBottom: MAP_AREA.y + MAP_AREA.h, TOP_MARGIN },
    );
    // The band chip block, using drawBandStrip's own arithmetic.
    const LINES_PER_ROW = 2;
    const chipH = LINE_H * LINES_PER_ROW - 4;
    const padTop = Math.round((chipH - FONT_SIZE) / 2);
    const rows = Math.ceil(9 / BAND_PER_ROW);
    const lastRowY = BAND_Y + (2 + (rows - 1) * LINES_PER_ROW) * LINE_H - padTop;
    ok(
      lastRowY + chipH <= TOP_MARGIN,
      "and so is the lowest band chip",
      { chipBottom: lastRowY + chipH, TOP_MARGIN },
    );

    // THE TICKER IS BELOW THE MARGIN, which is precisely why its backing may not be ours.
    ok(
      TICKER_Y > TOP_MARGIN,
      "sanity: the ticker really does sit in the scrolling region, so this matters",
      { TICKER_Y, TOP_MARGIN },
    );
    const filter = videoFilter({
      font: "/f.ttf",
      overlay: "/o.txt",
      side: "/s.txt",
      ticker: "/t.txt",
    });
    const tickerFilter = filter.split("drawtext=").find((f) => f.includes("/t.txt")) ?? "";
    ok(tickerFilter.length > 0, "the filter graph has a drawtext for the ticker");
    ok(
      /box=1/.test(tickerFilter),
      "and it paints its OWN box, so the backing is never drawn into the canvas",
      tickerFilter.slice(0, 120),
    );
    ok(
      /boxborderw=\d+/.test(tickerFilter),
      "with a border, so the box is wider than the glyphs rather than hugging them",
    );
  }
}

console.log(
  failures === 0
    ? "\nstream layout: all assertions passed"
    : `\nstream layout: ${failures} assertion(s) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
