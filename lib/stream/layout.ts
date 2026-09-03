// The stream frame's layout: one pure module, so it can be ASSERTED.
//
// WHY THIS FILE EXISTS. The geometry used to be split between `lib/stream/youtube.ts`
// (which owns the `drawtext` filter) and a block of `const`s inside a function body in
// `services/radio/index.ts` (which owns the pixels). Those two have to agree exactly —
// drawtext paints the labels, the panel code paints the boxes under them — and nothing
// could check that, because half of it was unreachable from a test. Every mismatch so far
// was found by the operator looking at his own stream: labels one line above their boxes,
// "waiting for RR73" printed over the band chips, the map escaping its area, the decode
// column stopping four lines short of the bottom.
//
// PURE ON PURPOSE. No node imports, so this stays reachable from anywhere — `youtube.ts`
// pulls in `child_process` and could never be imported by a check that also wanted to run
// in a browser-ish context, and `check:client-bundle` exists to catch exactly that leak.
//
// EVERY RECT IS DERIVED, not typed in. That is the property that made the 720p -> 1080p
// change safe: the frame and the font scaled by the same 1.5, so every CHARACTER budget in
// the layout — the decode column's width, a band chip's 13 — came out unchanged, and not
// one truncation rule had to move.

/**
 * FRAME SIZE — 1080p, and this is a legibility decision rather than a vanity one.
 *
 * THE REPORT: "its not legible today", with a screenshot in which every callsign was a
 * grey smear. The encoder was not at fault, and that was MEASURED rather than assumed: the
 * same 430x290 crop of the decode column was taken before the encoder and after it, from a
 * late frame deep inside a GOP, and the two were indistinguishable. True CBR was confirmed
 * at the same time — 2419 kbps against the 2500 asked for.
 *
 * So the softening happened after us. Two candidates were simulated from that identical
 * frame and compared against the operator's screenshot:
 *
 *   A  our 720p scaled straight to the ~1800 px player window   -> soft, still readable
 *   B  our 720p reduced to 480p, then scaled to that window     -> matched the screenshot
 *
 * B means YouTube handed the player a LOW RENDITION and the player enlarged it. We cannot
 * choose the viewer's rendition. What we can choose is how many real pixels each rung of
 * YouTube's ladder is built from — and a 720p source hands a 1280-pixel-wide picture to a
 * window that is routinely 1800 wide, so even the BEST case was a 1.4x enlargement, which
 * is simulation A, which is already soft. There was no rung that could have looked right.
 *
 * HONEST LIMIT, because the fix is partial and saying otherwise would be a lie: this makes
 * the good cases sharp and the 480p case no worse. It does NOT make 360p readable. Thirty
 * rows of monospace text in a video frame cannot survive that reduction at any source
 * resolution — only fewer, larger rows would, and the operator asked for more rows, not
 * bigger ones. That trade is his to make, not one to make quietly on his behalf.
 */
export const FRAME_W = 1920;
export const FRAME_H = 1080;

/**
 * The text metrics every overlay and panel must agree on.
 *
 * ONE SOURCE FOR THE LINE PITCH. `LINE_H` is DERIVED from the two numbers handed to
 * `drawtext` rather than written down beside them, because it was previously a literal 21
 * sitting next to a literal fontsize 17 and a literal line_spacing 4 — three numbers that
 * had to agree by hand, while `lib/stream/panels.ts` positioned colour swatches from the
 * result. Deriving it makes that class of bug impossible rather than merely absent.
 */
export const FONT_SIZE = 26;
export const LINE_SPACING = 6;
export const LINE_H = FONT_SIZE + LINE_SPACING;

/** DejaVu Sans Mono's advance, measured from the face rather than guessed. */
export const MONO_ADVANCE = 1233 / 2048;

/** The width of one character at a given font size, in pixels. */
export function charWidth(fontSize: number): number {
  return fontSize * MONO_ADVANCE;
}

/** Where the left-hand decode column's text block starts. */
export const LEFT_X = 27;
export const LEFT_Y = 21;

/**
 * Where the right-hand text block starts.
 *
 * `lib/stream/panels.ts` draws chips and swatches beside these lines and the two must agree
 * to the pixel — change one and they slide off their labels.
 */
export const SIDE_X = 678;
export const SIDE_Y = 21;

/**
 * THE LAYOUT the operator specified: the decode list runs the full height down the left,
 * the waterfall takes the narrower space beside it, the map is large, and the band chips
 * sit in rows in the space the waterfall gave up at the top.
 *
 *   x 0            660                      1320         1905
 *   +--------------+-------------------------+-------------+
 *   | decode list  | band chips, three rows  |   the map   |  y 0..375
 *   | (full height)+-------------------------+-------------+
 *   |              |                                       |
 *   |              |            waterfall                  |  y 375..1080
 *   +--------------+---------------------------------------+
 */
export const TOP_MARGIN = 375;
export const LEFT_MARGIN = 660;

/** Four times the area of the first attempt, which the operator called too small. */
export const MAP_AREA = { x: 1320, y: 18, w: 585, h: 339 };

/**
 * The ticker bar along the bottom.
 *
 * IT SPANS THE WATERFALL ONLY, not the whole frame, and that is a bug fix rather than a
 * preference. Drawn full-width it overlapped the last three lines of the decode column —
 * the column runs the full height of the frame, so lines 31, 32 and 33 sit at y 981, 1013
 * and 1045 against a bar occupying 1002..1059.
 *
 * WORSE THAN AN OVERLAP, it was PERMANENT. `WaterfallCanvas.push` only repaints x >=
 * leftMargin, so nothing ever redraws the part of the bar that fell inside the decode
 * column: it was painted once and then sat there for the rest of the broadcast, including
 * for the 100 seconds in every 120 when no ticker message is even up.
 *
 * Starting it at `LEFT_MARGIN` costs the ticker a fifth of its width and costs the decode
 * column nothing, which is the right way round — the operator asked for more decode rows,
 * twice.
 */
export const TICKER_FONT = 29;
export const TICKER_H = 57;
export const TICKER_Y = FRAME_H - TICKER_H - 21;
export const TICKER_X = LEFT_MARGIN;
export const TICKER_W = FRAME_W - LEFT_MARGIN;

/**
 * The ticker's text baseline, CENTRED IN ITS BAR and derived rather than nudged.
 *
 * "ummmm to ur comment the words are still to high they should be centered" was the report
 * the first time this was a hand-picked offset. It is arithmetic now.
 */
export const TICKER_TEXT_Y = TICKER_Y + Math.round((TICKER_H - TICKER_FONT) / 2);

/** Band chips share the right-hand text block's origin, so labels land in their boxes. */
export const BAND_X = SIDE_X;
export const BAND_Y = SIDE_Y;

/**
 * THREE ROWS OF THREE, as the operator suggested when the labels would not fit.
 *
 * Four per row forced a 10-character budget and "20M 120/25" is eleven, so the entity
 * count was being truncated to "20M 120/2" on the live stream. Three per row buys 13.
 */
export const BAND_PER_ROW = 3;
export const BAND_CHARS = 13;

/**
 * How many lines of text fit between a starting y and the bottom of the frame.
 *
 * PURE, and it exists because this arithmetic was previously done three times in comments
 * and once in a magic number, in two different resolutions, and the comments went stale the
 * moment the frame grew.
 *
 * `drawtext` stacks n lines occupying `n*fontSize + (n-1)*lineSpacing` pixels — the gaps sit
 * BETWEEN the lines, so there are n-1 of them and not n. The last line needs its full height
 * above the bottom edge, which is the part that is easy to get wrong by one line:
 *
 *     startY + n*fontSize + (n-1)*lineSpacing <= frameH
 *     n <= (frameH - startY + lineSpacing) / (fontSize + lineSpacing)
 *
 * Both layouts this has shipped agree on 33, which is the check that the formula matches the
 * hand-derived figure it replaces: 720p gives (720-14+4)/21 = 33.8 and 1080p gives
 * (1080-21+6)/32 = 33.3. That agreement is not luck — the font scaled with the frame.
 */
export function textLineCapacity(
  frameH: number,
  startY: number,
  fontSize: number,
  lineSpacing: number,
): number {
  const pitch = fontSize + lineSpacing;
  if (pitch <= 0) return 0;
  return Math.max(0, Math.floor((frameH - startY + lineSpacing) / pitch));
}

/**
 * How many characters fit in a column of a given pixel width.
 *
 * FLOOR, NEVER ROUND. `drawtext` does not wrap: a line one character too long is not a
 * slightly wide line, it is text printed on top of whatever panel sits beside it. That is
 * how "waiting for RR73" ended up over the band chips.
 */
export function columnChars(pixelWidth: number, fontSize: number): number {
  return Math.max(0, Math.floor(pixelWidth / charWidth(fontSize)));
}

/** Lines the decode overlay spends on its header before the feed starts. */
export const HEADER_LINES = 3;

/**
 * How many decode lines the left column has room for.
 *
 * DERIVED FROM THE FRAME AND THE FONT rather than tuned by looking at the stream, which is
 * how it previously ended up four lines short of the bottom — the operator's "your still
 * not running decodes all the way to the bottom either".
 */
export const MAX_DECODES =
  textLineCapacity(FRAME_H, LEFT_Y, FONT_SIZE, LINE_SPACING) - HEADER_LINES;

/**
 * How much `box=1:boxborderw=N` in the left overlay's drawtext filter adds on each side.
 *
 * The box is what makes the decode text readable over the waterfall, and it is WIDER THAN
 * THE TEXT — by this much at each end. Anything computing where the column really ends has
 * to charge it.
 */
export const BOX_BORDER = 10;

/**
 * How wide the decode column is, in characters.
 *
 * THREE THINGS ARE CHARGED, and the first version of this charged only one. `drawtext`
 * starts the text at `LEFT_X` and paints a box `BOX_BORDER` wider at each end, so the
 * painted right edge is `LEFT_X + n*charWidth + BOX_BORDER` — which must land inside
 * `LEFT_MARGIN` or the box overhangs the waterfall.
 *
 * At 40 characters that edge was 27 + 626 + 10 = 663 against a 660 margin: three pixels
 * over, on the exact assertion that claimed it fitted. Charging everything gives 39, and
 * the longest line the station actually produces is a compound-callsign exchange like
 * "11:44:15  -14  <WA2LAN> W3EWL/QRP RR73" at 38 — so one character of headroom survives.
 *
 * Down from the 720p layout's 41 for two reasons: the font grew by 26/17 = 1.529 while the
 * frame grew by 1.5, and the box border is now charged where before it was not. Text
 * slightly larger relative to the frame is the right direction to err on a legibility fix.
 */
export const DECODE_CHARS = columnChars(LEFT_MARGIN - LEFT_X - BOX_BORDER, FONT_SIZE);

/** How wide the right-hand column is, in characters: from its origin to the map's edge. */
export const SIDE_CHARS = columnChars(MAP_AREA.x - SIDE_X, FONT_SIZE);
