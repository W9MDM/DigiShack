/* eslint-disable no-console */
// Checks the waterfall we draw for the YouTube stream.
// Run: npm run check:stream-frame
//
// WHY THIS IS WORTH ASSERTING AT ALL. The stream's picture is drawn here rather than
// screenshotted from the browser, so nothing else in the project agrees or disagrees with
// it — if the scroll runs the wrong way or a carrier lands in the wrong column, the only
// thing that notices is a viewer, and by then it is on YouTube.
//
// It is also the cheap half of the feature. ffmpeg, RTMP and a stream key cannot be
// exercised from a check script; bins-to-pixels can, exactly, and that is where the
// mistakes actually live: palette edges, scroll direction, and the bin mapping that a
// narrow FT8 carrier survives or does not.

import { paletteFor, WaterfallCanvas, overlayText } from "../lib/stream/frame";
import {
  DECODE_CHARS,
  MAX_DECODES,
  HEADER_LINES,
} from "../lib/stream/layout";
import type { WorkingNow } from "../lib/stream/frame";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}`, extra ?? "");
  }
}

/** Read one pixel out of the frame buffer. */
function px(c: WaterfallCanvas, w: number, x: number, y: number): [number, number, number] {
  const o = (y * w + x) * 3;
  return [c.rgb[o]!, c.rgb[o + 1]!, c.rgb[o + 2]!];
}

function main(): void {
  console.log("1. the palette");
  {
    const cold = paletteFor(0);
    const hot = paletteFor(255);
    check("silence is nearly black", cold[0] < 20 && cold[1] < 20 && cold[2] < 40, cold);
    check("a full-scale signal is red", hot[0] > 200 && hot[1] < 100, hot);
    // OUT OF RANGE MUST NOT WRAP. A bin arriving as 300 or -5 through some future scaling
    // change should clamp to an end of the palette, not index past the stops and return
    // undefined — which would write NaN into the buffer and hand ffmpeg garbage.
    check("above full scale clamps", JSON.stringify(paletteFor(999)) === JSON.stringify(hot));
    check("below zero clamps", JSON.stringify(paletteFor(-40)) === JSON.stringify(cold));
    for (const v of [0, 1, 64, 127, 200, 254, 255]) {
      const c = paletteFor(v);
      check(
        `value ${v} is three integers in 0-255`,
        c.length === 3 && c.every((n) => Number.isInteger(n) && n >= 0 && n <= 255),
        c,
      );
    }
    // Monotonic brightness: a stronger signal must never look weaker than a weaker one.
    let worst: string | null = null;
    for (let v = 1; v <= 255; v++) {
      const a = paletteFor(v - 1);
      const b = paletteFor(v);
      const sa = a[0] + a[1] + a[2];
      const sb = b[0] + b[1] + b[2];
      if (sb < sa - 60) worst = `${v - 1} -> ${v}: ${sa} -> ${sb}`;
    }
    check("brightness rises with signal strength", worst === null, worst);
  }

  console.log("");
  console.log("2. THE SCROLL RUNS THE RIGHT WAY");
  {
    // Every waterfall in this hobby puts NEW at the bottom and scrolls the old upward. Get
    // this backwards and the picture is still pretty and still wrong, and an operator
    // watching their own stream would be the one to notice.
    const w = 8;
    const h = 4;
    const c = new WaterfallCanvas({ width: w, height: h });
    const loud = new Uint8Array(w).fill(255);
    const quiet = new Uint8Array(w).fill(0);

    c.push({ bins: loud, binHz: 100, maxHz: 800 });
    const bottom = px(c, w, 0, h - 1);
    check("a new row lands on the BOTTOM line", bottom[0] > 200, bottom);

    c.push({ bins: quiet, binHz: 100, maxHz: 800 });
    check("the new quiet row is now at the bottom", px(c, w, 0, h - 1)[0] < 40, px(c, w, 0, h - 1));
    check("and the loud row moved UP one", px(c, w, 0, h - 2)[0] > 200, px(c, w, 0, h - 2));

    c.push({ bins: quiet, binHz: 100, maxHz: 800 });
    check("two rows later it is two lines up", px(c, w, 0, h - 3)[0] > 200, px(c, w, 0, h - 3));

    // And it must leave eventually rather than smearing at the top for ever.
    for (let i = 0; i < h + 2; i++) c.push({ bins: quiet, binHz: 100, maxHz: 800 });
    let anyLoud = false;
    for (let y = 0; y < h; y++) if (px(c, w, 0, y)[0] > 200) anyLoud = true;
    check("it scrolls off the top and is gone", !anyLoud);

    // A BRAND-NEW CANVAS IS NOT PURE BLACK. It starts at the palette's own floor, so a
    // waterfall that has not filled yet looks like a quiet band rather than a broken
    // picture — which is what a viewer sees for the first minute of every stream.
    const fresh = new WaterfallCanvas({ width: 4, height: 4 });
    const corner = px(fresh, 4, 0, 3);
    check(
      "a fresh canvas starts at the palette floor, not pure black",
      JSON.stringify(corner) === JSON.stringify(paletteFor(0)),
      corner,
    );
  }

  console.log("");
  console.log("3. A NARROW CARRIER MUST SURVIVE THE MAPPING");
  {
    // The fault this guards against is the one the panadapter already taught: an FT8 signal
    // is a handful of bins wide, and mapping bins to a 1280-pixel frame by AVERAGING
    // neighbours makes a real signal vanish into its silent surroundings. Nearest-neighbour
    // keeps it. Asserted with one loud bin in an otherwise dead spectrum.
    const w = 640;
    const c = new WaterfallCanvas({ width: w, height: 2 });
    const bins = new Uint8Array(100);
    bins[50] = 255;
    c.push({ bins, binHz: 25, maxHz: 2500 });

    let lit = 0;
    let firstLit = -1;
    for (let x = 0; x < w; x++) {
      if (px(c, w, x, 1)[0] > 200) {
        lit++;
        if (firstLit < 0) firstLit = x;
      }
    }
    check("the single loud bin is drawn, not averaged away", lit > 0, { lit });
    // 100 bins across 640 pixels: one bin is 6.4 pixels wide.
    check("it occupies roughly one bin's width", lit >= 5 && lit <= 8, { lit });
    check("and it lands halfway across, where it belongs", Math.abs(firstLit - 320) <= 8, {
      firstLit,
    });
  }

  console.log("");
  console.log("4. bounds — nothing may write outside the frame");
  {
    const w = 64;
    const h = 8;
    const c = new WaterfallCanvas({ width: w, height: h });
    check("the buffer is exactly width x height x 3", c.rgb.length === w * h * 3, c.rgb.length);

    // FEWER BINS THAN PIXELS, more bins than pixels, and none at all — all three arrive in
    // practice: the bin count follows the receiver's span, which the operator changes.
    for (const n of [1, 7, 63, 64, 65, 400, 4096]) {
      const before = c.rgb.length;
      c.push({ bins: new Uint8Array(n).fill(180), binHz: 10, maxHz: 3000 });
      check(`${n} bins does not resize or overflow the buffer`, c.rgb.length === before);
    }
    c.push({ bins: new Uint8Array(0), binHz: 10, maxHz: 3000 });
    check("an empty row is drawn dark rather than throwing", px(c, w, 0, h - 1)[0] < 20);

    // A degenerate frame must not throw either — a zero-height waterfall area is what a
    // top margin as tall as the frame produces, and it should simply draw nothing.
    const flat = new WaterfallCanvas({ width: 4, height: 4 }, { topMargin: 4 });
    flat.push({ bins: new Uint8Array(4).fill(255), binHz: 10, maxHz: 100 });
    check("a frame with no room left for the waterfall is survived", true);
  }

  console.log("");
  console.log("5. the top margin is left alone for the text");
  {
    // ffmpeg draws the decode list over the top of the frame. If the waterfall scrolled
    // through that area the text would sit on a moving background and be unreadable.
    const w = 8;
    const h = 10;
    const margin = 4;
    const c = new WaterfallCanvas({ width: w, height: h }, { topMargin: margin });
    for (let i = 0; i < h * 2; i++) {
      c.push({ bins: new Uint8Array(w).fill(255), binHz: 10, maxHz: 100 });
    }
    let intruded = false;
    // Stopping one row short of the margin: the LAST row is the separator rule, which is
    // deliberately visible and is asserted on its own below.
    for (let y = 0; y < margin - 1; y++) {
      for (let x = 0; x < w; x++) if (px(c, w, x, y)[0] > 20) intruded = true;
    }
    check("the header strip stays dark however long it runs", !intruded);
    check("and the waterfall fills everything below it", px(c, w, 0, margin)[0] > 200);
    // The rule between the two. Without it the frame reads as one large black area with
    // text floating in it for the whole first minute, while the waterfall is still filling.
    const rule = px(c, w, 0, margin - 1);
    check("there is a separator rule between the text and the waterfall", rule[2] > rule[0], rule);
  }

  console.log("");
  console.log("5b. THE LEFT COLUMN is left alone too");
  {
    // The decode list runs the full height of the frame down the left, so the waterfall
    // takes the narrower space beside it. A scroll that block-copied whole rows would drag
    // the decode column upward with it — which is invisible in a still and obvious the
    // moment it moves.
    const w = 20;
    const h = 10;
    const left = 8;
    const c = new WaterfallCanvas({ width: w, height: h }, { leftMargin: left });
    for (let i = 0; i < h * 3; i++) {
      c.push({ bins: new Uint8Array(w).fill(255), binHz: 10, maxHz: 100 });
    }
    let intruded = false;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < left; x++) if (px(c, w, x, y)[0] > 20) intruded = true;
    }
    check("the left column stays black however long it scrolls", !intruded);
    check("and the waterfall fills everything right of it", px(c, w, left, h - 1)[0] > 200);
    check(
      "the column boundary is exact — one pixel left of the margin is still black",
      px(c, w, left - 1, h - 1)[0] === 0,
      px(c, w, left - 1, h - 1),
    );

    // The bins must span the NARROWER area, not the full width, or the spectrum is
    // squeezed and every signal lands at the wrong frequency.
    const c2 = new WaterfallCanvas({ width: 100, height: 3 }, { leftMargin: 50 });
    const bins = new Uint8Array(10);
    bins[9] = 255;
    c2.push({ bins, binHz: 10, maxHz: 100 });
    let lastLit = -1;
    for (let x = 0; x < 100; x++) if (px(c2, 100, x, 2)[0] > 200) lastLit = x;
    check("the highest bin lands at the RIGHT edge of the narrowed area", lastLit >= 97, lastLit);
    const bins2 = new Uint8Array(10);
    bins2[0] = 255;
    const c3 = new WaterfallCanvas({ width: 100, height: 3 }, { leftMargin: 50 });
    c3.push({ bins: bins2, binHz: 10, maxHz: 100 });
    let firstLit = -1;
    for (let x = 0; x < 100; x++) if (px(c3, 100, x, 2)[0] > 200 && firstLit < 0) firstLit = x;
    check("and the lowest at its LEFT edge, not the frame's", firstLit === 50, firstLit);
  }

  console.log("");
  console.log("6. the overlay text");
  {
    const text = overlayText({
      callsign: "K9XYZ",
      grid: "EN71",
      band: "20m",
      mode: "FT8",
      dialHz: 14_074_000,
      qsosToday: 12,
      decodes: [
        { at: "14:30:15", message: "CQ K9XYZ EN71", snr: -7 },
        { at: "14:30:00", message: "K9XYZ K1ABC -12", snr: 3 },
      ],
    });
    check("the callsign is on it", text.includes("K9XYZ"));
    check("the dial is in MHz, not hertz", text.includes("14.074 MHz"), text.split("\n")[0]);
    check("the QSO count is on it", text.includes("QSOs today 12"));
    check("a negative report keeps its sign", text.includes("-7"));
    check("a positive report gains one", /\+\s*3/.test(text), text);
    // NEWEST FIRST, the same order the page uses — a viewer looking for the latest decode
    // should not have to hunt down the list for it.
    check(
      "the newest decode is above the older one",
      text.indexOf("CQ K9XYZ EN71") < text.indexOf("K9XYZ K1ABC"),
    );
    // The list is capped so it cannot grow past the frame and push itself off-screen.
    const many = overlayText({
      callsign: "K9XYZ",
      grid: "EN71",
      band: "20m",
      mode: "FT8",
      dialHz: 14_074_000,
      qsosToday: 0,
      decodes: Array.from({ length: 80 }, (_, i) => ({
        at: "14:30:00",
        message: `CQ TEST${i} AA00`,
        snr: -10,
      })),
    });
    // THE COLUMN HAS A CAPACITY and the text must never exceed it. It runs the full height
    // of the frame now — 26 decode lines beside a waterfall that gave up the left side — so
    // the number changed, but the property did not: text that overflows draws over the
    // bottom of the frame, and there is nothing below it to notice.
    check("eighty decodes do not produce eighty lines", many.split("\n").length <= 34, {
      lines: many.split("\n").length,
    });

    // MISSING DATA IS THE NORMAL STARTUP STATE — the bridge has no band or mode until the
    // radio answers, and the stream may well be started first.
    const empty = overlayText({
      callsign: "K9XYZ",
      grid: "EN71",
      band: null,
      mode: null,
      dialHz: null,
      qsosToday: 0,
      decodes: [],
    });
    check(
      "no band, no mode and no dial still renders",
      empty.includes("K9XYZ") && empty.includes("--"),
    );
    check("and it does not print null", !/null|undefined|NaN/.test(empty), empty);
  }

  console.log("");
  console.log("7. WHO WE ARE WORKING, and the exchange");
  {
    // Asked for after seeing the operator's previous stream — an OBS composite carrying
    // WSJT-X, GridTracker and a QRZ lookup of the station being worked. A bare waterfall
    // tells a viewer a contact is happening somewhere in it; this tells them who.
    const base = {
      callsign: "K9XYZ",
      grid: "EN61AA",
      band: "20m",
      mode: "FT8",
      dialHz: 14_074_000,
      qsosToday: 146,
      decodes: Array.from({ length: 20 }, (_, i) => ({
        at: "14:30:00",
        message: `CQ TEST${i} AA00`,
        snr: -10,
      })),
    };
    const working: WorkingNow = {
      theirCall: "K5MGY",
      phase: "rreport-sent",
      transcript: [
        { dir: "tx", message: "K5MGY K9XYZ EN61" },
        { dir: "rx", message: "K9XYZ K5MGY -09", snr: -5 },
        { dir: "tx", message: "K5MGY K9XYZ R-05" },
      ],
      hunting: null,
    };
    const t = overlayText({ ...base, working });
    check("the station being worked is named", t.includes("WORKING K5MGY"), t.split("\n")[2]);
    check(
      "the phase is in words a viewer follows, not the state machine's",
      t.includes("waiting for RR73") && !t.includes("rreport-sent"),
      t.split("\n")[2],
    );
    check("our transmissions are marked", t.includes("▲ K5MGY K9XYZ R-05"));
    check("theirs are marked differently", t.includes("▼ K9XYZ K5MGY -09"));
    check("their report carries their signal", t.includes("▼ K9XYZ K5MGY -09  -5"), t);
    // OLDEST FIRST, unlike the decode list. An exchange read backwards is nonsense.
    check(
      "the exchange reads in the order it happened",
      t.indexOf("K5MGY K9XYZ EN61") < t.indexOf("K5MGY K9XYZ R-05"),
    );

    // THE LAYOUT BUDGET. The top margin is a fixed 280 px and the waterfall begins below
    // it, so a working block that simply ADDED lines would push the decode list down over
    // the spectrum — which is the fault 1.170.7 already fixed once, from the other side.
    const idle = overlayText(base);
    check(
      "an idle frame shows every decode the column has room for",
      idle.split("\n").filter((l) => l.includes("CQ TEST")).length === 20,
      idle.split("\n").filter((l) => l.includes("CQ TEST")).length,
    );
    // THE INVARIANT, restated for a taller column. A busy frame may now be LONGER than an
    // idle one — the column holds 26 and this fixture only supplies 20 — so the old
    // comparison no longer expresses the property. What must hold is that the frame never
    // runs off the bottom, and that the working block is paid for by the decode list rather
    // than by the frame.
    check("a busy frame stays inside the column", t.split("\n").length <= 34, {
      busy: t.split("\n").length,
    });
    check(
      "and the working block costs the decode list, not the frame",
      t.split("\n").filter((l) => l.includes("CQ TEST")).length <=
        idle.split("\n").filter((l) => l.includes("CQ TEST")).length,
      {
        busy: t.split("\n").filter((l) => l.includes("CQ TEST")).length,
        idle: idle.split("\n").filter((l) => l.includes("CQ TEST")).length,
      },
    );
    const long = overlayText({
      ...base,
      working: {
        ...working,
        transcript: Array.from({ length: 12 }, (_, i) => ({
          dir: (i % 2 === 0 ? "tx" : "rx") as "tx" | "rx",
          message: `MSG${i}`,
          snr: -3,
        })),
      },
    });
    check("a long exchange is trimmed to the last four", long.split("MSG").length - 1 === 4, long);
    check(
      "and at least six decodes always survive",
      long.split("\n").filter((l) => l.includes("CQ TEST")).length >= 6,
      long.split("\n").filter((l) => l.includes("CQ TEST")).length,
    );
    // A SHORTER COLUMN must still be obeyed. The caller owns the budget — a future layout
    // with a different height must not have to know how this function counts.
    const small = overlayText({ ...base, maxDecodes: 5 });
    check(
      "a caller-set budget is obeyed",
      small.split("\n").filter((l) => l.includes("CQ TEST")).length === 5,
      small.split("\n").filter((l) => l.includes("CQ TEST")).length,
    );
  }

  console.log("");
  console.log("8. the gaps between contacts");
  {
    const base = {
      callsign: "K9XYZ",
      grid: "EN61AA",
      band: "20m",
      mode: "FT8",
      dialHz: 14_074_000,
      qsosToday: 146,
      decodes: [{ at: "14:30:00", message: "CQ K1ABC FN42", snr: -7 }],
    };
    // THE DAY'S COUNT IS ALWAYS THERE, and this is what keeps it there. It lived in the
    // no-contact branch at first, so it appeared BETWEEN contacts and vanished DURING them
    // — backwards, since a viewer arriving mid-contact is the one most likely to wonder how
    // the day is going.
    const idleFrame = overlayText({
      ...base,
      working: { theirCall: null, phase: null, transcript: [], hunting: "hunting K5MGY (-5 dB)" },
    });
    check("the day's count shows between contacts", idleFrame.includes("QSOs today 146"));
    check("and does not claim to be working anyone", !idleFrame.includes("WORKING"), idleFrame);

    const busyFrame = overlayText({
      ...base,
      working: {
        theirCall: "K5MGY",
        phase: "calling",
        transcript: [{ dir: "tx", message: "K5MGY K9XYZ EN61" }],
        hunting: null,
      },
    });
    check("and DURING a contact too", busyFrame.includes("QSOs today 146"));
    check(
      "on the line under the header, not in it",
      busyFrame.split("\n")[1]?.startsWith("QSOs today") === true,
      busyFrame.split("\n")[1],
    );
    // Which is WHY it moved out of the header: carrying both ran the header into the solar
    // readout in the next column.
    check(
      "keeping the header short enough for the column",
      (busyFrame.split("\n")[0] ?? "").length <= 41,
      (busyFrame.split("\n")[0] ?? "").length,
    );

    // NOTHING MAY EXCEED THE COLUMN. "WORKING K7YHX — sent R+report, waiting for RR73" was
    // 48 characters in a 41-character column and printed straight over the band chips.
    // `drawtext` does not wrap and has no width to wrap at.
    const wide = overlayText({
      ...base,
      working: {
        theirCall: "VK9/W1ABCDEF/QRP",
        phase: "report-sent",
        transcript: [{ dir: "rx", message: "K9XYZ VK9/W1ABCDEF/QRP -05", snr: -5 }],
        hunting: null,
      },
      decodes: [{ at: "14:30:00", message: "X".repeat(90), snr: -7 }],
    });
    const longest = Math.max(...wide.split("\n").map((l) => l.length));
    check(`no line exceeds the column (longest ${longest})`, longest <= DECODE_CHARS, longest);
    check("and an over-long line is marked as cut", wide.includes("…"));

    const done = overlayText({
      ...base,
      working: { theirCall: null, phase: null, transcript: [], hunting: null },
    });
    check("nothing running shows no working block", !done.includes("WORKING"));
    check("and leaves no stray blank block", !/\n\n\n/.test(done), JSON.stringify(done.slice(0, 60)));
    check("omitting `working` entirely still renders", overlayText(base).includes("K9XYZ"));
  }

  console.log("");
  if (failures > 0) {
    console.log(`${failures} failed`);
    process.exit(1);
  }
  console.log("all passed");
}

main();
