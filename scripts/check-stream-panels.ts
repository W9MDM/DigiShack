/* eslint-disable no-console */
// Checks the right-hand panels of the stream frame: band chips and the map.
// Run: npm run check:stream-panels
//
// THE COMPLAINT: "the whole top right is empty". The overlay was a column of text down the
// left of a 1280-pixel frame with 60% of it black, against a previous stream that was an OBS
// composite of WSJT-X, GridTracker's map and a solar panel.
//
// WHAT CAN GO WRONG HERE, and why a viewer would be the only one to notice:
//
//   * A chip or a dot landing outside its box, which on a raw RGB buffer is not a clipped
//     rectangle but a stripe of colour wrapped onto the next row.
//   * A projection sign error, which puts North America in the southern ocean and looks
//     entirely deliberate.
//   * A contact hidden under the spots, or under the coastline.
//
// None of that is visible from a check that only asks "did it throw". So these assertions
// read pixels back.

import {
  drawBandChips,
  drawBandStrip,

  tickerLine,
  drawMap,
  fillRect,
  strokeRect,
  GRADE_RGB,
  type BandChip,
  type Surface,
} from "../lib/stream/panels";

let failed = 0;
function ok(cond: boolean, what: string, extra?: unknown): void {
  if (cond) {
    console.log(`  ok    ${what}`);
  } else {
    failed++;
    console.log(`  FAIL  ${what}`, extra ?? "");
  }
}
function eq(a: unknown, b: unknown, what: string): void {
  ok(Object.is(a, b), what, `expected ${String(b)}, got ${String(a)}`);
}

function surface(width: number, height: number): Surface {
  return { rgb: Buffer.alloc(width * height * 3), width, height };
}
function at(s: Surface, x: number, y: number): [number, number, number] {
  const o = (y * s.width + x) * 3;
  return [s.rgb[o]!, s.rgb[o + 1]!, s.rgb[o + 2]!];
}
/** Is anything drawn outside this rectangle? */
function anythingOutside(s: Surface, r: { x: number; y: number; w: number; h: number }): boolean {
  for (let y = 0; y < s.height; y++) {
    for (let x = 0; x < s.width; x++) {
      const inside = x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
      if (inside) continue;
      const [a, b, c] = at(s, x, y);
      if (a !== 0 || b !== 0 || c !== 0) return true;
    }
  }
  return false;
}

console.log("nothing escapes its box");
{
  // EVERY draw goes through a clipping write. This is the assertion that keeps it that way:
  // on a raw RGB buffer an off-by-one is not a clipped rectangle, it is a stripe of colour
  // wrapped onto the next row, and it looks like a rendering glitch rather than a bug.
  const s = surface(60, 40);
  fillRect(s, { x: -10, y: -10, w: 200, h: 200 }, [255, 0, 0]);
  ok(true, "a rectangle far larger than the surface does not throw or overrun");
  eq(s.rgb.length, 60 * 40 * 3, "and the buffer is not resized");

  const s2 = surface(60, 40);
  strokeRect(s2, { x: 55, y: 35, w: 30, h: 30 }, [0, 255, 0]);
  ok(true, "a rectangle hanging off the corner is survived");

  const s3 = surface(60, 40);
  fillRect(s3, { x: 10, y: 10, w: 20, h: 10 }, [1, 2, 3]);
  ok(!anythingOutside(s3, { x: 10, y: 10, w: 20, h: 10 }), "and a normal fill stays inside");
}

console.log("");
console.log("band chips");
{
  const chips: BandChip[] = [
    { band: "40M", count: 85, entities: 34, usability: "good" },
    { band: "20M", count: 101, entities: 24, usability: "poor" },
    { band: "15M", count: 89, entities: 16, usability: "poor" },
    { band: "30M", count: 49, entities: 16, usability: "fair" },
  ];
  const s = surface(400, 200);
  const area = { x: 10, y: 10, w: 380, h: 120 };
  const placed = drawBandChips(s, chips, area);
  eq(placed.length, 4, "all four are placed");
  ok(!anythingOutside(s, area), "and nothing is drawn outside the area given");

  // The GRADE is the whole point of a chip. Its colour has to reach the pixels.
  const first = placed[0]!;
  const strip = at(s, first.rect.x + 10, first.rect.y + 1);
  eq(JSON.stringify(strip), JSON.stringify(GRADE_RGB.good), "a good band gets the good colour");
  const poor = at(s, placed[1]!.rect.x + 10, placed[1]!.rect.y + 1);
  eq(JSON.stringify(poor), JSON.stringify(GRADE_RGB.poor), "and a poor one the poor colour");
  ok(
    JSON.stringify(GRADE_RGB.unknown) !== JSON.stringify(GRADE_RGB.fair),
    "unknown is not coloured as fair — no data is not a middling forecast",
  );

  // The card behind the label stays dark, or white 11-pixel text on it turns to mush.
  const body = at(s, first.rect.x + 10, first.rect.y + 20);
  ok(body[0] < 60 && body[1] < 60 && body[2] < 70, "the card body stays dark for the label", body);

  // The rectangles must not overlap, or a label sits on two chips.
  let overlap = false;
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i]!.rect;
      const b = placed[j]!.rect;
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) overlap = true;
    }
  }
  ok(!overlap, "no two chips overlap");

  // TOO MANY TO FIT: dropped, not drawn over whatever is below. A chip half on the map is
  // worse than a chip missing.
  const many: BandChip[] = Array.from({ length: 40 }, (_, i) => ({
    band: `B${i}`,
    count: i,
    entities: i,
    usability: "good" as const,
  }));
  const s2 = surface(400, 200);
  const tight = { x: 10, y: 10, w: 380, h: 60 };
  const placed2 = drawBandChips(s2, many, tight);
  ok(placed2.length < many.length, `only what fits is placed (${placed2.length} of 40)`);
  ok(!anythingOutside(s2, tight), "and still nothing outside the area");
  ok(placed2.length > 0, "but it does not give up entirely");
}

console.log("");
console.log("chip labels sit centred in their boxes");
{
  // THE RELATIONSHIP BETWEEN TWO SYSTEMS, which is where this feature has gone wrong twice.
  // The rectangles are pixels drawn here; the labels are ffmpeg's. First the labels landed a
  // whole line ABOVE their boxes, then they sat against the top edge with half the chip
  // empty below. Both were invisible to every assertion that only looked at pixels, so the
  // arithmetic itself is pinned here.
  const s = surface(700, 200);
  const chips: BandChip[] = [
    { band: "80M", count: 19, entities: 9, usability: "good" },
    { band: "20M", count: 120, entities: 25, usability: "poor" },
  ];
  const fontSize = 17;
  const lineH = 21;
  const textY = 14;
  const firstLine = 2;
  drawBandStrip(s, chips, {
    x: 20,
    textY,
    firstLine,
    fontSize,
    lineH,
    perRow: 3,
    charsPerChip: 13,
  });

  // Find the box: scan down column 25 for the grade-coloured border.
  let top = -1;
  let bottom = -1;
  for (let y = 0; y < s.height; y++) {
    const [r, g, b] = at(s, 25, y);
    const lit = r > 20 || g > 20 || b > 20;
    if (lit && top < 0) top = y;
    if (lit) bottom = y;
  }
  ok(top > 0 && bottom > top, "a chip box was drawn", { top, bottom });

  const textTop = textY + firstLine * lineH;
  const above = textTop - top;
  const below = bottom - (textTop + fontSize);
  ok(
    Math.abs(above - below) <= 2,
    `the label is centred: ${above} px above, ${below} px below`,
    { above, below, top, bottom, textTop },
  );
  ok(above > 4, "and is not jammed against the top edge", above);
}

console.log("");
console.log("the label fits inside its own chip");
{
  // "20M 120/2" appeared on the live stream: eleven characters of label truncated into a
  // ten-character budget. The label must never be cut, because the number it loses is the
  // one that says whether the band is open widely or regionally.
  const s = surface(700, 200);
  const text = drawBandStrip(
    s,
    [{ band: "20M", count: 120, entities: 25, usability: "poor" }],
    { x: 20, textY: 14, firstLine: 2, fontSize: 17, lineH: 21, perRow: 3, charsPerChip: 13 },
  );
  ok(text.includes("20M 120/25"), "the entity count survives in full", text.split("\n")[2]);
  const narrow = drawBandStrip(
    surface(700, 200),
    [{ band: "20M", count: 120, entities: 25, usability: "poor" }],
    { x: 20, textY: 14, firstLine: 2, fontSize: 17, lineH: 21, perRow: 3, charsPerChip: 8 },
  );
  ok(
    !narrow.includes("20M 120/25"),
    "and a budget too small to hold it truncates rather than overflowing its neighbour",
    narrow.split("\n")[2],
  );
}

console.log("");
console.log("the map puts places where they are");
{
  const s = surface(400, 300);
  const area = { x: 20, y: 20, w: 360, h: 180 };
  drawMap(s, area, {
    contacts: [{ lat: 41.5, lon: -87 }],
    heardBy: [{ lat: 51.5, lon: 0 }],
    home: { lat: 41.5, lon: -87 },
  });
  ok(!anythingOutside(s, area), "the whole map stays in its box");

  // THE PROJECTION, pinned at the corners and the centre — a sign error here puts North
  // America in the southern ocean and looks entirely deliberate.
  const centre = at(s, area.x + Math.round(area.w / 2), area.y + Math.round(area.h / 2));
  ok(centre.some((v) => v > 0), "0N 0E is inside the map, not off it");

  // North is UP: a northern point must sit above a southern one.
  const s2 = surface(400, 300);
  drawMap(s2, area, { contacts: [{ lat: 60, lon: 0 }] });
  const s3 = surface(400, 300);
  drawMap(s3, area, { contacts: [{ lat: -60, lon: 0 }] });
  const findOrange = (surf: Surface): number => {
    for (let y = 0; y < surf.height; y++) {
      for (let x = 0; x < surf.width; x++) {
        const [r, g, b] = at(surf, x, y);
        if (r > 240 && g > 150 && g < 200 && b < 80) return y;
      }
    }
    return -1;
  };
  const north = findOrange(s2);
  const south = findOrange(s3);
  ok(north > 0 && south > 0, "both hemispheres plot", { north, south });
  ok(north < south, "and north is above south", { north, south });

  // East is RIGHT.
  const s4 = surface(400, 300);
  drawMap(s4, area, { contacts: [{ lat: 0, lon: 100 }] });
  const s5 = surface(400, 300);
  drawMap(s5, area, { contacts: [{ lat: 0, lon: -100 }] });
  const findOrangeX = (surf: Surface): number => {
    for (let x = 0; x < surf.width; x++) {
      for (let y = 0; y < surf.height; y++) {
        const [r, g, b] = at(surf, x, y);
        if (r > 240 && g > 150 && g < 200 && b < 80) return x;
      }
    }
    return -1;
  };
  ok(findOrangeX(s5) < findOrangeX(s4), "east is to the right of west", {
    west: findOrangeX(s5),
    east: findOrangeX(s4),
  });
}

console.log("");
console.log("a contact is never hidden");
{
  // Spots outnumber contacts by a lot, and a contact vanishing under one is the map quietly
  // lying about the thing it exists to show.
  const s = surface(300, 240);
  const area = { x: 0, y: 0, w: 300, h: 150 };
  const same = { lat: 41.5, lon: -87 };
  drawMap(s, area, {
    contacts: [same],
    heardBy: Array.from({ length: 50 }, () => same),
  });
  let orange = 0;
  for (let y = 0; y < s.height; y++) {
    for (let x = 0; x < s.width; x++) {
      const [r, g, b] = at(s, x, y);
      if (r > 240 && g > 150 && g < 200 && b < 80) orange++;
    }
  }
  ok(orange >= 4, `the contact survives fifty spots on the same square (${orange} px)`);
}

console.log("");
console.log("degenerate input is survived, not drawn wrongly");
{
  const s = surface(200, 150);
  const area = { x: 5, y: 5, w: 190, h: 100 };
  drawMap(s, area, {});
  ok(!anythingOutside(s, area), "no data at all still draws a map box and nothing else");
  const ocean = at(s, area.x + 2, area.y + 2);
  ok(ocean.some((v) => v > 0), "and an empty map looks deliberate, not broken", ocean);

  // Coordinates the log can genuinely contain.
  const s2 = surface(200, 150);
  drawMap(s2, area, {
    contacts: [
      { lat: 90, lon: 180 },
      { lat: -90, lon: -180 },
      { lat: 0, lon: 0 },
    ],
  });
  ok(!anythingOutside(s2, area), "the corners of the world stay inside the box");

  const s3 = surface(200, 150);
  drawMap(s3, area, { contacts: [{ lat: NaN, lon: NaN }] });
  ok(!anythingOutside(s3, area), "and a NaN coordinate draws nothing rather than everywhere");

  const zero = surface(10, 10);
  drawMap(zero, { x: 0, y: 0, w: 0, h: 0 }, { contacts: [{ lat: 0, lon: 0 }] });
  ok(true, "a zero-sized area does not throw");
}

console.log("");
console.log("the ticker appears, and goes away again");
{
  // A permanent banner sits across the thing people came to watch. A banner that never
  // appears tells nobody anything. So the cycle itself is the feature, and it is asserted
  // rather than eyeballed over two minutes of stream.
  const msgs = ["first", "second", "third"];
  const cycle = { showMs: 20_000, hideMs: 100_000 };

  ok(tickerLine(msgs, 0, cycle) !== null, "it is up at the start of a cycle");
  ok(tickerLine(msgs, 19_999, cycle) !== null, "still up just before the show ends");
  ok(tickerLine(msgs, 20_000, cycle) === null, "and down the moment it does");
  ok(tickerLine(msgs, 119_999, cycle) === null, "still down at the end of the gap");
  ok(tickerLine(msgs, 120_000, cycle) !== null, "and back for the next cycle");

  // ONE MESSAGE PER SHOWING. Choosing at random per frame would flicker between them ten
  // times a second, which is the obvious implementation and unwatchable.
  const during = [0, 5_000, 10_000, 19_000].map((t) => tickerLine(msgs, t, cycle));
  ok(new Set(during).size === 1, "the message does not change mid-showing", during);
  // But it does vary between showings, or there was no point having three.
  const across = [0, 120_000, 240_000].map((t) => tickerLine(msgs, t, cycle));
  ok(new Set(across).size === 3, "and it rotates between showings", across);

  ok(tickerLine([], 0, cycle) === null, "no messages shows nothing rather than throwing");
  ok(tickerLine(msgs, 0, { showMs: 0, hideMs: 0 }) === null, "a zero cycle shows nothing");
  // A NEGATIVE CLOCK. JavaScript's `%` keeps the sign of its left operand, so a naive
  // `now % period` goes negative and every comparison after it is wrong. The fix is the
  // `+ period` before the second modulo — and the property to assert is that the phase
  // WRAPS, not that any particular instant is showing.
  //
  // (-50_000 legitimately lands in the hide window; asserting it was visible was the
  // assertion being wrong rather than the code, and it said so.)
  // The SHOW/HIDE phase repeats every period. The message deliberately does not — it
  // rotates per cycle, which is the whole reason there is more than one — so comparing the
  // strings was the assertion being wrong a second time. Compare visibility.
  for (const t of [0, 5_000, 19_000, 20_000, 60_000, 119_000]) {
    eq(
      tickerLine(msgs, t - 120_000, cycle) === null,
      tickerLine(msgs, t, cycle) === null,
      `visibility at ${t} matches one full cycle earlier`,
    );
  }
  ok(
    tickerLine(msgs, -120_000, cycle) !== null,
    "and a negative cycle number still yields a message, not undefined",
    tickerLine(msgs, -120_000, cycle),
  );
  ok(tickerLine(msgs, -1, cycle) !== undefined, "and one millisecond before zero is defined");

  // THE BAR BEHIND IT IS NO LONGER DRAWN HERE, and the assertions that used to sit at this
  // point were the ones that missed the fault. They drew the bar into a 200x120 scratch
  // surface and checked it stayed in its strip — which it did. What they could not see is
  // that the real surface SCROLLS: the ticker sits 627 px below the waterfall boundary, and
  // `WaterfallCanvas.push` drags everything below that boundary upward one row per spectrum
  // frame, so the bar climbed out of the picture over 157 s against a 120 s ticker period.
  //
  // A fixture that cannot reproduce the real fault reports success while the display is
  // broken, which is this repo's own stated standard. The backing is `drawtext`'s `box=1`
  // now, and the invariant that replaces these assertions is in
  // `scripts/check-stream-layout.ts`: nothing the panel code paints may sit below
  // `TOP_MARGIN`, and the ticker's backing must come from the filter graph.
}

console.log("");
if (failed > 0) {
  console.log(`${failed} FAILED`);
  process.exit(1);
}
console.log("all stream-panel assertions passed");
