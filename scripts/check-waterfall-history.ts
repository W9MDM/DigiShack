// Timestamp gaps, screen density and resize history must not alter what was received.
import assert from "node:assert/strict";
import { WaterfallHistory, waterfallSlots, waterfallWidth, writeWaterfallRow } from "@/lib/radio/waterfall-history";

const row = (at: number, value = 100) => ({ at, bins: new Uint8Array([value]) });
const history = new WaterfallHistory();
for (const at of [1000, 1250, 2000]) history.push(row(at));
assert.deepEqual(waterfallSlots(history.entries, 2000, 5, 250).map((r) => r?.at ?? null), [1000, 1250, null, null, 2000]);
assert.deepEqual(waterfallSlots(history.entries, 2500, 5, 250).map((r) => r?.at ?? null), [null, null, 2000, null, null]);
assert.equal(waterfallSlots(history.entries, 2000, 8, 250)[7]?.at, 2000, "resizing keeps newest at the bottom");
assert.equal(waterfallSlots(history.entries, 2000, 8, 250)[3]?.at, 1000, "resizing preserves temporal spacing");
assert.deepEqual(waterfallSlots([row(1001), row(1249), row(1501), row(1749)], 1750, 4, 250).map((r) => r?.at), [1001, 1249, 1501, 1749], "timer jitter does not create false dropout stripes");
history.push(row(2000));
history.push(row(1750));
assert.equal(history.entries.length, 3, "duplicate and slightly late rows do not advance history");
history.push(row(-500));
assert.equal(history.entries.length, 1, "large backwards clock step starts a new timeline");
history.clear();
for (let at = 0; at < 5000; at++) history.push(row(at));
assert.equal(history.entries.length, 4096, "high-rate input stays bounded");
history.push(row(700_000));
assert.equal(history.entries.length, 1, "expired rows are evicted after a long outage");
assert.equal(waterfallWidth(1000, 1), 1000);
assert.equal(waterfallWidth(1000, 2), 2000);
assert.equal(waterfallWidth(3000, 3), 4096, "large displays have a bounded backing width");
assert.equal(waterfallWidth(0, 1), 1);

const palette = new Uint8Array(768);
for (let v = 0; v < 256; v++) palette.fill(v, v * 3, v * 3 + 3);
const pixels = new Uint8ClampedArray(8);
writeWaterfallRow(new Uint8Array([0, 255, 0, 0]), pixels, 2, 1, palette);
assert.deepEqual([...pixels], [255, 255, 255, 255, 0, 0, 0, 255], "downsampling keeps narrow peaks");
writeWaterfallRow(new Uint8Array([100]), pixels, 2, 1, palette);
assert.deepEqual([...pixels], [100, 100, 100, 255, 100, 100, 100, 255], "upsampling does not create intermediate peaks");
writeWaterfallRow(new Uint8Array([100]), pixels, 2, 2, palette);
assert.equal(pixels[0], 200, "history can be recoloured from raw bins");
writeWaterfallRow(new Uint8Array(0), pixels, 2, 1, palette);
assert.deepEqual([...pixels], [0, 0, 0, 255, 0, 0, 0, 255], "gaps use the bottom of the palette");
console.log("Waterfall history, outage, density, resize and narrow-carrier checks passed.");
