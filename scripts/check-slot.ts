/* eslint-disable no-console */
// Picking somewhere to transmit.
//
// The manual-call form asked for an offset in hertz and defaulted to 1500 — the middle
// of the passband, and therefore the single most contested frequency on a busy band.
// "Put me where nobody else is" is the actual question, and it is arithmetic.

import {
  MAX_SLOT_HZ,
  MIN_SLOT_HZ,
  occupiedFrom,
  pickClearSlot,
} from "@/lib/digital/slot";

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail = ""): void {
  if (cond) {
    pass++;
    console.log(`  ok    ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
function eq(a: unknown, b: unknown, label: string): void {
  ok(a === b, label, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

function main(): void {
  console.log("\nan empty band");
  {
    const s = pickClearSlot([]);
    eq(s.hz, Math.round((MIN_SLOT_HZ + MAX_SLOT_HZ) / 2), "lands in the middle of the passband");
    ok(!s.crowded, "and is not crowded");
  }

  console.log("\none station");
  {
    // Everything below 700 is 500 Hz wide; everything above is 2200. The bigger side wins.
    const s = pickClearSlot([700]);
    ok(s.hz > 700, "goes to the larger side of the occupied frequency");
    eq(s.hz, Math.round((700 + MAX_SLOT_HZ) / 2), "and to the middle of it");
    ok(s.clearanceHz > 1000, "with a lot of room", `${s.clearanceHz} Hz`);
  }

  console.log("\nthe widest gap, not the first one");
  {
    // Gaps: 200-400 (200), 400-500 (100), 500-2000 (1500), 2000-2900 (900).
    const s = pickClearSlot([400, 500, 2000]);
    eq(s.hz, 1250, "the 500-2000 gap is chosen and split down the middle");
    eq(s.clearanceHz, 750, "clearance is half the gap");
    // First-fit would have answered 300 — jammed against the bottom of the passband,
    // where the transmit filter is already rolling off and where every other first-fit
    // picker would also land.
    ok(s.hz !== 300, "first-fit's answer is NOT what comes back");
  }

  console.log("\nthe passband edges are walls");
  {
    // With no walls the "widest gap" on a band with one signal at 2800 would run from
    // 2800 to infinity. It must stop at the top of what the transmitter can place.
    const s = pickClearSlot([250, 2800]);
    ok(s.hz > 250 && s.hz < 2800, "the answer stays inside the passband", `${s.hz} Hz`);
  }

  console.log("\na packed band says so");
  {
    // Every 100 Hz from 250 to 2850: the best gap is 100 Hz, so clearance is 50 —
    // exactly one FT8 signal width, and not enough to be clear of both neighbours.
    const packed: number[] = [];
    for (let f = 250; f <= 2850; f += 100) packed.push(f);
    const s = pickClearSlot(packed);
    eq(s.clearanceHz, 50, "clearance is half of the 100 Hz gaps");
    ok(s.crowded, "and it reports the band as crowded rather than looking confident");
  }

  console.log("\nduplicates and out-of-band signals are ignored");
  {
    const a = pickClearSlot([1000, 1000, 1000]);
    const b = pickClearSlot([1000]);
    eq(a.hz, b.hz, "three stations on one frequency crowd it exactly as much as one");
    const c = pickClearSlot([50, 4000, 1000]);
    eq(c.hz, b.hz, "signals outside the transmittable passband cannot be collided with");
  }

  console.log("\nwider signals need more room");
  {
    const packed = [500, 600, 700];
    ok(!pickClearSlot(packed, { signalHz: 50 }).crowded, "FT8 fits where FT4 does not");
    // The gaps either side are large; force the comparison onto a narrow one.
    const tight = pickClearSlot([1400, 1480], { min: 1400, max: 1480, signalHz: 90 });
    ok(tight.crowded, "an 80 Hz hole is crowded for a 90 Hz signal");
  }

  console.log("\nstale decodes are not treated as occupied");
  {
    const now = 1_000_000;
    const rows = [
      { freqOffset: 1000, timestamp: new Date(now - 10_000).toISOString() },
      { freqOffset: 1500, timestamp: new Date(now - 600_000).toISOString() },
    ];
    // A station heard ten minutes ago has very often finished and gone; keeping them
    // forever fills the passband with ghosts until nothing looks clear.
    eq(occupiedFrom(rows, now).length, 1, "only the recent one counts");
    eq(occupiedFrom(rows, now)[0], 1000, "and it is the right one");
    eq(occupiedFrom(rows, now, 900_000).length, 2, "a wider window keeps both");
  }

  console.log("\nan unreadable timestamp is kept, not dropped");
  {
    // Dropping it would silently empty the band and make everything look clear, which is
    // the failure that transmits on top of somebody.
    const rows = [{ freqOffset: 1200, timestamp: "not a date" }];
    eq(occupiedFrom(rows, 1_000_000).length, 1, "kept rather than silently discarded");
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

main();
