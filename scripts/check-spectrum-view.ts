/* eslint-disable no-console */
// The Spectrum page's pure logic: wire decoding, dB recovery, the history ring and its time
// map, colour maps, axis ticks, the camera and stored preferences.
//
// The properties that matter most are the ones a plausible-looking display can get wrong
// silently: a narrow carrier or a one-frame burst averaged away, a gap papered over with a
// stale row, history that re-scales differently from the rows arriving now, or an axis
// label that disagrees with where the pixels are. Each has an assertion below.

import { PALETTE, recolourWaterfall, waterfallPalette } from "@/components/digital/spectrum-canvas";
import { traceColours } from "@/components/digital/SpectrumTrace";
import { panadapterMessage } from "@/lib/radio/panadapter";
import { spectrumMessage } from "@/lib/radio/spectrum";
import {
  ANALYZER_NARROW_PX,
  ANALYZER_Y_AXIS_PX,
  analyzerLayout,
  cycleStart,
  fillTimeTicks,
  formatAgo,
  formatFrequency,
  formatSpan,
  formatUtcClock,
  frequencyTicks,
  frequencyUnit,
  niceStep,
  timeLabelStep,
} from "@/lib/spectrum/axis";
import {
  cameraEye,
  DEFAULT_CAMERA,
  lookAt,
  mat4,
  MAX_PITCH,
  MIN_DISTANCE,
  multiply,
  orbitBy,
  panBy,
  perspective,
  project,
  zoomBy,
  type OrbitCamera,
} from "@/lib/spectrum/camera";
import {
  BACKGROUND_RGB,
  colormapChrome,
  colormapRgb,
  colormapRgba,
  COLORMAPS,
  CYCLE_LINE_RGBA,
  GAP_RGB_A,
  GAP_RGB_B,
  lutLuminance,
  NIGHT_COLORMAP,
  turboRgb,
} from "@/lib/spectrum/colormaps";
import { BridgeClock, RateMeter, SpectrumFeed } from "@/lib/spectrum/feed";
import { SpectrumHistory } from "@/lib/spectrum/history";
import { bytesToDb, displayWindow, LevelTracker, normaliseDb } from "@/lib/spectrum/levels";
import { DEFAULT_PREFS, effectiveColormap, loadPrefs, PREFS_KEY, sanitizePrefs, VIEWS } from "@/lib/spectrum/prefs";
import {
  columnsMax,
  columnsSigned,
  countRuns,
  countSignals,
  DEFAULT_THRESHOLD_DB,
  DELTA_DEADBAND_DB,
  DELTA_DEPTH,
  DELTA_DROP_MAX,
  DELTA_DROP_MIN,
  DELTA_DROP_TINT,
  DELTA_RISE_MIN_INDEX,
  deltaReferences,
  FLOOR_BUCKETS,
  FLOOR_FRACTION,
  loadThresholdDb,
  MAX_THRESHOLD_DB,
  MIN_THRESHOLD_DB,
  nearTransmit,
  noiseFloorDb,
  recentMean,
  rowDelta,
  saveThresholdDb,
  sanitizeThresholdDb,
  SIGNAL_ROWS,
  THRESHOLD_KEY,
} from "@/lib/spectrum/rowmath";
import { decodeBase64Bins, FrameDecoder } from "@/lib/spectrum/wire";

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
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;
const hex = (lut: Uint8Array, i: number) =>
  [lut[i * 3]!, lut[i * 3 + 1]!, lut[i * 3 + 2]!].map((v) => v.toString(16).padStart(2, "0")).join("");

/** A history row of `n` bins, all at byte `fill` except `peaks` (index -> byte). */
function row(at: number, n: number, fill = 0, peaks: Record<number, number> = {}, lowHz = 0, binHz = 10) {
  const bytes = new Uint8Array(n).fill(fill);
  for (const [i, v] of Object.entries(peaks)) bytes[Number(i)] = v;
  return { bytes, count: n, floorDb: -100, ceilingDb: -60, lowHz, binHz, at };
}

// ---------------------------------------------------------------------------------------
console.log("\nwire: the bridge's own encoders round-trip through the page's decoder");
{
  const bins = new Uint8Array(512);
  for (let i = 0; i < bins.length; i++) bins[i] = (i * 37) % 256;
  const msg = spectrumMessage(
    { bins, binHz: 5.859375, maxHz: 3000, floorDb: -112, ceilingDb: -72, at: 1_700_000_000_250 },
    "FT8",
    15_000,
  );
  const dec = new FrameDecoder();
  const f = dec.decode(JSON.parse(JSON.stringify(msg)) as Record<string, unknown>);
  ok(f !== null && f.kind === "audio", "a spectrum message decodes as the audio feed");
  ok(f !== null && f.count === 512 && f.bytes.subarray(0, 512).every((v, i) => v === bins[i]), "every bin byte survives base64");
  ok(f !== null && f.lowHz === 0 && f.binHz === 5.859375, "audio bins start at 0 Hz at the message's bin width");
  ok(f !== null && f.mode === "FT8" && f.periodMs === 15_000, "mode and T/R period are carried for cycle rules");
  ok(f !== null && f.floorDb === -112 && f.ceilingDb === -72 && f.calibrated, "floor and ceiling are carried");

  const pan = new Uint8Array(4096).fill(7);
  const pm = panadapterMessage(
    { bins: pan, centerHz: 14_100_000, spanHz: 200_000, binHz: 200_000 / 4096, floorDb: -120, ceilingDb: -95, at: 5 },
    "FlexRadio",
  );
  const g = dec.decode(JSON.parse(JSON.stringify(pm)) as Record<string, unknown>);
  ok(g !== null && g.kind === "rf" && g.count === 4096, "a panadapter message decodes as the RF feed, larger than the first scratch");
  ok(g !== null && near(g.lowHz, 14_000_000) && near(g.binHz * g.count, 200_000), "RF bin 0 sits at centre - span/2 and bins tile the span");
  ok(g !== null && g.radio === "FlexRadio", "the radio is named");
  ok(dec.decode({ kind: "status" }) === null, "other kinds are not frames");
  ok(dec.decode({ kind: "spectrum", bins: 42, binHz: 5, at: 1 }) === null, "a malformed frame is refused, not drawn");
  const old = dec.decode({ kind: "spectrum", bins: msg.bins, binHz: 5, at: 9 });
  ok(old !== null && !old.calibrated && old.floorDb === 0 && old.ceilingDb === 40, "a frame without levels falls back to relative dB");
  ok(decodeBase64Bins("AAEC/w==").join(",") === "0,1,2,255", "decodeBase64Bins decodes plain base64");
}

// ---------------------------------------------------------------------------------------
console.log("\nlevels: bytes back to dB, and the display window");
{
  const out = new Float32Array(3);
  bytesToDb([0, 255, 51], 3, -100, -60, out);
  ok(near(out[0]!, -100) && near(out[1]!, -60) && near(out[2]!, -92, 1e-4), "byte 0 is the floor, 255 the ceiling, 51 a fifth of the way");
  ok(normaliseDb(-110, -100, 40) === 0 && normaliseDb(-50, -100, 40) === 1 && near(normaliseDb(-80, -100, 40), 0.5), "normalisation clamps and is linear");
  const w = displayWindow(-100, 40, { floorOffsetDb: 0, rangeDb: null });
  ok(w.loDb === -100 && w.rangeDb === 40, "default window reproduces the bridge's own colouring");
  const w2 = displayWindow(-100, 23, { floorOffsetDb: 5, rangeDb: 1 });
  ok(w2.loDb === -95 && w2.rangeDb === 3, "floor offset adds; range has a 3 dB minimum");

  const t = new LevelTracker(3000, 12);
  t.update(-100, -60, 0);
  ok(t.floorDb === -100 && t.spanDb === 40, "first frame sets the levels");
  t.update(-98, -58, 3000);
  ok(near(t.floorDb!, -100 + 2 * (1 - Math.exp(-1)), 1e-9), "one time constant moves 63% of a small step");
  t.update(-130, -90, 3250);
  ok(t.floorDb === -130, "a step beyond 12 dB snaps (band or gain change)");
}

// ---------------------------------------------------------------------------------------
console.log("\nhistory: rows, gaps, merging, wrap and memory");
{
  const h = new SpectrumHistory({ maxRows: 64, defaultIntervalMs: 250 });
  h.setHistoryMs(10_000);
  for (let k = 0; k < 8; k++) h.push(row(1000 + k * 250, 100));
  ok(h.size === 8 && h.width === 100, "steady frames each get a row");
  ok(h.startAt[1] === 1000 && h.endAt[1] === 1250, "contiguous rows tile time edge to edge");
  ok(near(h.intervalMs, 250), "the frame interval is measured");

  // A 1 s outage: three frames missing.
  h.push(row(1000 + 7 * 250 + 1000, 100));
  const p = h.physical(h.size - 1);
  ok(h.startAt[p] === 1000 + 7 * 250 + 750, "after a gap the row claims one interval, not the whole silence");

  const map = new Float32Array(2 * 12);
  const end = 1000 + 7 * 250 + 1000;
  h.buildRowMap(end, 12 * 250, 12, map);
  const counts = Array.from({ length: 12 }, (_, i) => map[2 * i + 1]!);
  ok(counts[0] === 1, "newest slot holds the post-gap row");
  ok(counts[1] === 0 && counts[2] === 0 && counts[3] === 0, "the outage is three empty slots — drawn as no data, never a repeated row", counts.join(","));
  ok(counts[4] === 1 && counts[11] === 1, "the slots before the outage each hold one row");
  ok(h.physical(h.size - 2) === map[2 * 4], "a slot points at the row covering it");

  // Resize: twice the slots over the same span keeps the same time placement.
  const map2 = new Float32Array(2 * 24);
  h.buildRowMap(end, 12 * 250, 24, map2);
  const c2 = Array.from({ length: 24 }, (_, i) => map2[2 * i + 1]!);
  ok(c2.slice(2, 8).every((c) => c === 0) && c2[0]! > 0 && c2[8]! > 0, "a taller canvas shows the same outage at the same time", c2.join(","));
  // Shorter canvas: several rows per slot, all of them referenced.
  const map3 = new Float32Array(2 * 3);
  h.buildRowMap(end, 12 * 250, 3, map3);
  ok(map3[5] === 4, "a short canvas assigns every row in a slot, for the peak reduction");

  ok(h.push(row(end, 100)) === false && h.push(row(end - 100, 100)) === false, "duplicate and late frames are ignored");
  h.push(row(end - 10_000, 100));
  ok(h.size === 1, "a large backwards clock step starts a new timeline");

  // Wrap: bounded, oldest evicted, data array never grows.
  const g = new SpectrumHistory({ maxRows: 32 });
  g.setHistoryMs(1); // no merging
  const before = g.data.length;
  for (let k = 0; k < 500; k++) g.push(row(10_000 + k * 250, 50));
  ok(g.size === 32 && g.capacity === 32, "the ring holds exactly its capacity");
  ok(g.oldestStartAt() === 10_000 + (500 - 32) * 250 - 250, "the oldest rows are the ones evicted");
  ok(before === 0 && g.data.length === 32 * 50, "storage is allocated once at capacity x width");

  // Budget: a 4096-bin panadapter is capped by bytes, not rows.
  const big = new SpectrumHistory({ budgetBytes: 24 * 1024 * 1024 });
  big.push(row(1, 4096));
  ok(big.capacity === 1536 && big.data.byteLength <= 24 * 1024 * 1024, "the byte budget bounds a 4096-bin history to 1536 rows");
}

{
  // Merging: fast frames are merged by MAXIMUM.
  const h = new SpectrumHistory({ maxRows: 16, defaultIntervalMs: 100 });
  h.setHistoryMs(16_000); // minRowMs = 16000 * 1.15 / 16 = 1150 ms
  h.push(row(1000, 20));
  h.push(row(1100, 20, 0, { 7: 255 })); // a one-frame burst
  h.push(row(1200, 20));
  ok(h.size === 1, "frames faster than the history allows share a row");
  const v = h.data[h.physical(0) * h.width + 7]!;
  ok(near(v, -60, 1e-4), "a one-frame burst survives the merge at full strength (max, not mean)");
  ok(h.endAt[h.physical(0)] === 1200 && h.startAt[h.physical(0)] === 900, "the merged row spans all its frames");
  // An axis change never merges into the old row.
  h.push(row(1300, 20, 0, {}, 5000, 10));
  ok(h.size === 2, "a retune starts a new row");
  const pk = h.peakIn(950, 1250, 0, 200);
  ok(pk !== null && near(pk.db, -60, 1e-4) && near(pk.hz, 75), "peakIn finds the carrier and reports its bin centre");
  const none = h.peakIn(1250, 1300, 0, 200);
  ok(none === null, "the retuned row has nothing at the old frequencies");
  const later = h.peakIn(1250, 1300, 5000, 5200);
  ok(later !== null && near(later.db, -100, 1e-4), "and does at its own frequencies");
}

{
  // Narrow carrier against many bins per sample: peakIn over a wide window.
  const h = new SpectrumHistory();
  h.push(row(1000, 4096, 0, { 2049: 255 }, 0, 1));
  const pk = h.peakIn(900, 1000, 2000, 2100);
  ok(pk !== null && near(pk.db, -60, 1e-4), "a single-bin carrier is the peak of a 100-bin pixel");
  ok(h.refHz === 0, "the precision reference starts at the first row's low edge");
  h.push(row(1250, 4096, 0, {}, 14_000_000, 1));
  ok(h.refHz === 14_000_000 && h.metaEpoch === 3, "a move of more than 1 MHz rebases the reference (float32 precision)");
}

// ---------------------------------------------------------------------------------------
console.log("\nfeed: clock, rate and subscriptions");
{
  const c = new BridgeClock();
  ok(c.now(0) === null, "no clock before a frame");
  c.observe(10_000, 100); // 30 ms delay → offset 9900
  c.observe(10_250, 380); // late by 30 ms: offset 9870
  ok(c.now(1000) === 10_900, "'now' uses the least-delayed frame, so jitter does not shake the picture");

  const r = new RateMeter(5000);
  for (let k = 0; k < 20; k++) r.mark(k * 250);
  ok(near(r.fps(5000), 4, 0.25), "four frames a second reads as 4 fps");
  ok(r.fps(60_000) === 0, "a feed that stopped reads 0 fps");

  const feed = new SpectrumFeed("audio");
  let woke = 0;
  const off = feed.subscribe(() => woke++);
  const dec = new FrameDecoder();
  const frame = dec.decode(
    JSON.parse(
      JSON.stringify(spectrumMessage({ bins: new Uint8Array(512), binHz: 5.86, maxHz: 3000, floorDb: -110, ceilingDb: -70, at: 1000 }, "FT4", 7500)),
    ) as Record<string, unknown>,
  )!;
  ok(feed.ingest(frame, 50) && woke === 1, "a stored frame wakes subscribers");
  ok(!feed.ingest(frame, 60) && woke === 1, "a duplicate does not");
  off();
  ok(feed.info.periodMs === 7500 && near(feed.info.highHz, 512 * 5.86), "feed info describes the latest frame");
}

// ---------------------------------------------------------------------------------------
console.log("\ncolour maps");
{
  const ds = colormapRgb("digishack");
  ok(ds.length === PALETTE.length && ds.every((v, i) => v === PALETTE[i]), "DigiShack map is byte-identical to the existing waterfall PALETTE");
  const v = colormapRgb("viridis");
  ok(hex(v, 0) === "440154" && hex(v, 255) === "fde725" && hex(v, 128) === "21918c", "viridis matches the published anchors", `${hex(v, 0)} ${hex(v, 128)} ${hex(v, 255)}`);
  const inf = colormapRgb("inferno");
  ok(hex(inf, 0) === "000004" && hex(inf, 255) === "fcffa4" && hex(inf, 128) === "bc3754", "inferno matches the published anchors");
  const mg = colormapRgb("magma");
  ok(hex(mg, 0) === "000004" && hex(mg, 255) === "fcfdbf" && hex(mg, 64) === "51127c", "magma matches the published anchors");
  ok(turboRgb(0).join() === "35,23,27" && turboRgb(1).join() === "144,12,0", "turbo is Google's polynomial at both ends");
  const gs = colormapRgb("grayscale");
  ok(hex(gs, 0) === "000000" && hex(gs, 255) === "ffffff" && hex(gs, 128) === "808080", "grayscale is linear");
  for (const id of ["viridis", "inferno", "magma", "grayscale"] as const) {
    const lut = colormapRgb(id);
    let mono = true;
    for (let i = 16; i < 256; i += 16) if (lutLuminance(lut, i) < lutLuminance(lut, i - 16)) mono = false;
    ok(mono, `${id} brightens monotonically, so a stronger signal never reads as weaker`);
  }
  for (const c of COLORMAPS) {
    const rgba = colormapRgba(c.id);
    ok(rgba.length === 1024 && rgba[3] === 255 && rgba[1023] === 255, `${c.label} has an opaque 256-entry texture table`);
  }
}

// ---------------------------------------------------------------------------------------
console.log("\nnight theme");
{
  // The dark theme must be exactly what it was: the night palette is an addition, and the
  // waterfalls an operator already reads by day may not shift by one level.
  const dark = waterfallPalette("dark");
  ok(dark === PALETTE, "the dark theme's waterfall palette IS PALETTE");
  const ds = colormapRgb("digishack");
  ok(dark.every((v, i) => v === ds[i]), "and still byte-identical to the DigiShack map");
  const dc = colormapChrome("digishack");
  ok(
    dc.background === BACKGROUND_RGB && dc.gapA === GAP_RGB_A && dc.gapB === GAP_RGB_B && dc.cycleLine === CYCLE_LINE_RGBA,
    "every dark-theme map keeps its clear colour, gap hatch and cycle rule",
  );
  ok(COLORMAPS.every((c) => c.id === "night" || colormapChrome(c.id) === dc), "only Night red brings different chrome");

  const nr = colormapRgb(NIGHT_COLORMAP);
  ok(waterfallPalette("night") === nr, "the night theme's waterfalls draw in Night red");
  ok(COLORMAPS.some((c) => c.id === NIGHT_COLORMAP && c.label === "Night red"), "Night red is on the /spectrum menu");
  ok(hex(nr, 0) === "000000", "Night red starts at black", hex(nr, 0));
  ok(hex(nr, 255) === "ffa000", "and ends at amber", hex(nr, 255));
  let blue = 0;
  let order = 0;
  let mono = true;
  let noiseDark = true;
  for (let i = 0; i < 256; i++) {
    const [r, g, b] = [nr[i * 3]!, nr[i * 3 + 1]!, nr[i * 3 + 2]!];
    if (b !== 0) blue++;
    if (g > r) order++;
    // EVERY step, not every 16th: a single dip is a stronger signal reading weaker.
    if (i > 0 && lutLuminance(nr, i) < lutLuminance(nr, i - 1)) mono = false;
    if (i < 128 && lutLuminance(nr, i) > 0.05) noiseDark = false;
  }
  ok(blue === 0, "Night red has no blue in any of its 256 entries", `${blue} with blue`);
  ok(order === 0, "and R >= G throughout — red to amber, never green", `${order} entries greener than red`);
  ok(mono, "Night red brightens monotonically, entry by entry");
  ok(noiseDark, "its bottom half stays dark (luminance <= 0.05), so noise is a dark field");
  const nc = colormapChrome("night");
  const chromeBad = [nc.background, nc.gapA, nc.gapB, nc.cycleLine, nc.gridLine].filter((c) => c[2] !== 0 || c[1] > c[0]);
  ok(chromeBad.length === 0, "Night red's hatch, rules and clear colour are red-to-amber with no blue");
  ok(
    nc.gapA.join() !== nc.gapB.join() && nc.gapA.join() !== Array.from(nr.slice(0, 3)).join(),
    "the night hatch is still two tones, and not the floor colour",
  );

  // The trace over the RF waterfall: every colour it strokes or fills, at night.
  const t = traceColours("night");
  const rgbaOf = (s: string) => (/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/.exec(s) ?? []).slice(1).map(Number);
  const traceAll = [...t.fill.map(([, c]) => c), t.grid, t.feather, t.core, t.hold];
  const badTrace = traceAll.filter((c) => {
    const [r, g, b] = rgbaOf(c);
    return r === undefined || g === undefined || b !== 0 || g > r;
  });
  ok(badTrace.length === 0, `all ${traceAll.length} night trace colours are red-to-amber with no blue`, badTrace.join(" "));
  ok(t.core !== t.hold, "the peak hold is still a different colour from the live trace");
  ok(traceColours("dark").core === "rgba(190, 240, 255, 0.92)", "the dark trace is unchanged");

  // A theme change re-inks the RF waterfall's bitmap from its own pixels.
  const idxs = [0, 100, 200, 255];
  const img = { data: new Uint8ClampedArray(idxs.length * 4) };
  idxs.forEach((idx, x) => {
    img.data.set([PALETTE[idx * 3]!, PALETTE[idx * 3 + 1]!, PALETTE[idx * 3 + 2]!, 255], x * 4);
  });
  const fake = { getImageData: () => img, putImageData: () => {} } as unknown as CanvasRenderingContext2D;
  const same = (lut: Uint8Array) =>
    idxs.every((idx, x) => [0, 1, 2].every((c) => img.data[x * 4 + c] === lut[idx * 3 + c]));
  recolourWaterfall(fake, idxs.length, 1, PALETTE, nr);
  ok(same(nr), "recolouring maps each pixel to the same index in the new palette");
  recolourWaterfall(fake, idxs.length, 1, nr, PALETTE);
  ok(same(PALETTE), "and back again, losslessly");

  // /spectrum: Night red by default at night, but never over an explicit pick.
  ok(effectiveColormap(DEFAULT_PREFS, false) === "digishack", "default prefs draw DigiShack in the dark theme");
  ok(effectiveColormap(DEFAULT_PREFS, true) === "night", "and Night red in the night theme");
  ok(effectiveColormap({ colormap: "grayscale", colormapChosen: true }, true) === "grayscale", "a map picked from the menu is kept at night");
  ok(effectiveColormap({ colormap: "night", colormapChosen: true }, false) === "night", "and Night red picked by day is kept by day");
  ok(sanitizePrefs({ colormap: "viridis" }).colormapChosen, "a non-default map stored before the flag existed counts as chosen");
  ok(!sanitizePrefs({ colormap: "digishack" }).colormapChosen, "the default stored before the flag does not");
  ok(!sanitizePrefs({ colormap: "viridis", colormapChosen: false }).colormapChosen, "an explicit flag wins");
}

// ---------------------------------------------------------------------------------------
console.log("\naxes");
{
  ok(niceStep(430) === 500 && niceStep(21) === 25 && niceStep(1) === 1 && niceStep(0.07) === 0.1, "nice steps follow 1-2-2.5-5");
  const a = frequencyTicks(0, 3000, 7);
  ok(a.step === 500 && a.values.join() === "0,500,1000,1500,2000,2500,3000", "audio ruler: 500 Hz steps", a.values.join());
  ok(frequencyUnit(3000, 500) === "Hz" && formatFrequency(1500, "Hz", 500) === "1500", "audio labels in Hz");
  const r = frequencyTicks(14_000_000, 14_200_000, 8);
  ok(r.step === 25_000 && r.values[1] === 14_025_000, "RF ruler: 25 kHz steps on a 200 kHz span");
  ok(frequencyUnit(14_200_000, 25_000) === "MHz" && formatFrequency(14_025_000, "MHz", 25_000) === "14.025", "a 2.5-step gets the extra decimal");
  ok(formatFrequency(14_074_500, "MHz", 500) === "14.0745", "500 Hz steps get four decimals");
  ok(timeLabelStep(120_000, 400, 30, 15_000) === 15_000, "FT8 labels sit on 15 s cycle boundaries");
  ok(timeLabelStep(900_000, 400, 30, 15_000) === 120_000, "a long history labels whole multiples of the cycle");
  ok(timeLabelStep(120_000, 400, 30, 7_500) === 15_000, "FT4 7.5 s cycles double up when 7.5 s would crowd");
  ok(cycleStart(1_700_000_007_000, 15_000) % 15_000 === 0, "cycle starts sit on the UTC grid");
  const ticks = new Float64Array(10);
  const n = fillTimeTicks(ticks, 60_500, 60_000, 15_000, "utc");
  ok(n === 4 && ticks[0] === 60_000 && ticks[3] === 15_000, "UTC ticks are grid multiples inside the span");
  const m = fillTimeTicks(ticks, 60_500, 30_000, 15_000, "ago");
  ok(m === 3 && ticks[0] === 60_500 && ticks[2] === 30_500, "'ago' ticks count back from now");
  ok(formatUtcClock(Date.UTC(2026, 9, 19, 14, 3, 15)) === "14:03:15", "UTC clock format");
  ok(formatAgo(0) === "now" && formatAgo(15_000) === "−15 s" && formatAgo(90_000) === "−1 min 30 s", "'ago' format");
  ok(formatSpan(120_000) === "2 min" && formatSpan(45_000) === "45 s", "span format");
}

// ---------------------------------------------------------------------------------------
console.log("\ncamera");
{
  const view = lookAt(mat4(), 0, 0, 5, 0, 0, 0);
  const proj = perspective(mat4(), Math.PI / 2, 1, 0.1, 100);
  const mvp = multiply(mat4(), proj, view);
  const out = new Float32Array(2);
  ok(project(out, mvp, 0, 0, 0, 200, 100) && near(out[0]!, 100, 1e-3) && near(out[1]!, 50, 1e-3), "the target projects to the centre");
  ok(project(out, mvp, 5, 0, 0, 200, 100) && near(out[0]!, 200, 1e-3), "a point 45 degrees off-axis lands on the edge at 90 degrees FOV");
  ok(!project(out, mvp, 0, 0, 10, 200, 100), "a point behind the camera is not drawn");
  project(out, mvp, 0, 1, 0, 200, 100);
  ok(out[1]! < 50, "up is up on screen");

  const cam: OrbitCamera = { ...DEFAULT_CAMERA };
  const eye = cameraEye(cam, new Float32Array(3));
  ok(eye[2]! > 0 && eye[1]! > 0, "the default camera looks from the front (newest edge) and above");
  orbitBy(cam, 0, 10);
  ok(cam.pitch === MAX_PITCH, "pitch is clamped, so the view cannot flip under the surface");
  zoomBy(cam, 0.0001);
  ok(cam.distance === MIN_DISTANCE, "zoom is clamped");
  const c2: OrbitCamera = { ...DEFAULT_CAMERA };
  panBy(c2, 100, 0, 500);
  ok(c2.tx < 0 && near(c2.ty, DEFAULT_CAMERA.ty), "dragging right moves the target left, so the scene follows the cursor");
}

// ---------------------------------------------------------------------------------------
console.log("\non-air rows: history marks what was received while transmitting");
{
  const h = new SpectrumHistory({ maxRows: 64, defaultIntervalMs: 250 });
  h.setHistoryMs(1_000); // no merging
  h.push(row(1000, 20));
  h.push(row(1250, 20), true);
  h.push(row(1500, 20));
  ok(h.tx[h.physical(0)] === 0 && h.tx[h.physical(1)] === 1 && h.tx[h.physical(2)] === 0, "each row records whether it was taken on the air");

  const m = new SpectrumHistory({ maxRows: 16, defaultIntervalMs: 100 });
  m.setHistoryMs(16_000); // would merge these frames into one row
  m.push(row(1000, 20));
  m.push(row(1100, 20), true);
  m.push(row(1200, 20), true);
  ok(m.size === 2 && m.tx[m.physical(0)] === 0 && m.tx[m.physical(1)] === 1, "a frame on the other side of a TX change never merges into the row before it");

  const feed = new SpectrumFeed("audio");
  const dec = new FrameDecoder();
  const frameAt = (at: number) =>
    dec.decode(
      JSON.parse(
        JSON.stringify(spectrumMessage({ bins: new Uint8Array(64), binHz: 5.86, maxHz: 3000, floorDb: -110, ceilingDb: -70, at }, "FT8", 15_000)),
      ) as Record<string, unknown>,
    )!;
  feed.ingest(frameAt(1000), 0);
  feed.transmitting = true;
  feed.ingest(frameAt(1250), 250);
  const fh = feed.history;
  ok(fh.tx[fh.physical(0)] === 0 && fh.tx[fh.physical(1)] === 1, "the feed marks rows stored while it is told the station is transmitting");
}

console.log("\ndelta: what changed against the last few rows");
{
  const N = 64;
  const STEP = 40 / 255; // dB per wire byte in row()
  const mk = () => {
    const h = new SpectrumHistory({ maxRows: 64, defaultIntervalMs: 250 });
    h.setHistoryMs(1_000);
    return h;
  };
  const out = new Float32Array(N);
  const refs = new Int32Array(DELTA_DEPTH);

  const h = mk();
  // A steady carrier at bin 10 and a noise floor that holds still.
  for (let k = 0; k < 5; k++) h.push(row(1000 + k * 250, N, 30, { 10: 200 }));
  ok(rowDelta(h, 4, out, refs) && out.every((v) => v === 0), "a steady carrier and a steady floor show no change at all");
  ok(deltaReferences(h, 4, DELTA_DEPTH, refs) === 3 && refs[0] === h.physical(3) && refs[2] === h.physical(1), "a row is compared with the three rows before it, newest first");
  ok(!rowDelta(h, 0, out, refs), "the first row has nothing to be compared with, so it is drawn flat");

  // Bin 20 keys up 20 dB, bin 30 flickers 3 dB, and the carrier at bin 10 drops off.
  h.push(row(2250, N, 30, { 20: 30 + 128, 30: 30 + 19 }));
  ok(rowDelta(h, 5, out, refs), "a row after three steady ones is compared");
  ok(near(out[20]!, 128 * STEP - DELTA_DEADBAND_DB, 1e-3), "a signal keying up lights by its rise beyond the dead-band", String(out[20]));
  ok(out[30] === 0, "a 3 dB flicker stays inside the dead-band and dark");
  ok(near(out[10]!, -(170 * STEP - DELTA_DEADBAND_DB), 1e-3), "a carrier dropping off shows as a negative change", String(out[10]));
  ok(out.filter((v) => v !== 0).length === 2, "and nothing else in the row lights");
  ok(rowDelta(h, 5, out, refs, { gateDb: -40 }) && out.every((v) => v === 0), "a contrast floor above both levels gates the change out as noise");
  // The keyed signal holds: its second row compares against a mean that already holds part of it.
  h.push(row(2500, N, 30, { 20: 30 + 128 }));
  ok(rowDelta(h, 6, out, refs) && out[20]! > 0 && out[20]! < 128 * STEP - DELTA_DEADBAND_DB, "a signal that holds fades out of Delta as it becomes the past");

  // A retune: same bins, new frequencies.
  const d = mk();
  d.push(row(1000, N, 30));
  d.push(row(1250, N, 30));
  d.push(row(1500, N, 200, {}, 5_000));
  ok(!rowDelta(d, 2, out, refs), "the first row on a new span is never compared with the old one (no full-width flash)");
  d.push(row(1750, N, 200, {}, 5_000));
  ok(rowDelta(d, 3, out, refs) && deltaReferences(d, 3, DELTA_DEPTH, refs) === 1, "the row after it compares only with rows on its own span");
  // An outage.
  d.push(row(4000, N, 30, {}, 5_000));
  ok(!rowDelta(d, 4, out, refs), "a row after an outage is not compared across the gap");

  // Our own transmission: four rows of near-silence in the middle of a busy band.
  const t = mk();
  let at = 1000;
  for (let k = 0; k < 20; k++, at += 250) t.push(row(at, N, 60)); // rows 0-19
  for (let k = 0; k < 4; k++, at += 250) t.push(row(at, N, 0), true); // rows 20-23 on the air
  for (let k = 0; k < 20; k++, at += 250) t.push(row(at, N, 60)); // rows 24-43
  ok(!rowDelta(t, 19, out, refs) && !rowDelta(t, 9, out, refs), "rows within the guard before the transmission are drawn flat (status can lag the audio)");
  ok(rowDelta(t, 7, out, refs) && out.every((v) => v === 0), "rows well before it are compared as usual");
  ok([20, 21, 22, 23].every((k) => !rowDelta(t, k, out, refs)), "rows taken on the air are drawn flat, not as the whole band dropping out");
  ok([24, 26, 30, 34].every((k) => !rowDelta(t, k, out, refs)), "rows within the guard after it are drawn flat, not as the whole band keying up");
  ok(rowDelta(t, 35, out, refs) && out.every((v) => v === 0), "once clear of the guard, a row compares with rows after the transmission");
  ok(deltaReferences(t, 25, DELTA_DEPTH, refs) === 1, "references never reach back across an on-air row");
  ok(nearTransmit(t, 22) && nearTransmit(t, 34) && nearTransmit(t, 9) && !nearTransmit(t, 35) && !nearTransmit(t, 8), "the guard is 2.5 s either side of the on-air rows");

  // A TX flag that arrives 2 s after the audio went quiet (a 2 s status poll): eight quiet rows
  // stored as received, then the on-air rows.
  const lag = mk();
  at = 1000;
  for (let k = 0; k < 10; k++, at += 250) lag.push(row(at, N, 200)); // rows 0-9 receiving, 31 dB over the silence
  for (let k = 0; k < 8; k++, at += 250) lag.push(row(at, N, 0)); // rows 10-17 quiet, flag not yet up
  for (let k = 0; k < 4; k++, at += 250) lag.push(row(at, N, 0), true); // rows 18-21 flagged
  for (let k = 0; k < 8; k++, at += 250) lag.push(row(at, N, 200)); // rows 22-29
  ok(rowDelta(lag, 10, out, refs, { guardMs: 1_000 }) && out.every((v) => v < 0) && rowDelta(lag, 11, out, refs, { guardMs: 1_000 }) && out.every((v) => v < 0), "a flag 2 s late is past a 1 s guard: the quiet rows read as the whole band dropping");
  ok([10, 11, 12, 13, 14, 15, 16, 17].every((k) => !rowDelta(lag, k, out, refs)), "the default guard covers a flag 2 s late, as seen on the air");
  ok(
    [10, 11, 12, 13, 14, 15, 16, 17].every((k) => !rowDelta(lag, k, out, refs, { guardMs: 3_000 })),
    "a guard longer than the flag's latency draws every quiet row before it flat",
  );

  // Pure noise, as the audio feed carries it: one unaveraged FFT per row (exponential power),
  // a wire floor at the row's 25th percentile + 2 dB, one byte per bin. Fixed seed.
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return (seed + 0.5) / 2147483648;
  };
  const NB = 512;
  const noisy = new SpectrumHistory({ maxRows: 64, defaultIntervalMs: 85 });
  noisy.setHistoryMs(1_000);
  let tracked: number | null = null;
  const noiseRow = (atMs: number, keyed: boolean) => {
    const db = new Float64Array(NB);
    for (let b = 0; b < NB; b++) {
      const p = -Math.log(rnd()) + (keyed && b >= 100 && b < 110 ? 10 ** 1.2 : 0); // +12 dB over the noise
      db[b] = 10 * Math.log10(p) - 100;
    }
    const sorted = Float64Array.from(db).sort();
    const ff = sorted[Math.floor(NB * 0.25)]!;
    tracked = tracked === null ? ff : tracked * 0.9 + ff * 0.1;
    const floorDb = tracked + 2;
    const bytes = new Uint8Array(NB);
    for (let b = 0; b < NB; b++) bytes[b] = Math.max(0, Math.min(255, Math.round(((db[b]! - floorDb) / 40) * 255)));
    noisy.push({ bytes, count: NB, floorDb, ceilingDb: floorDb + 40, lowHz: 0, binHz: 5.86, at: atMs });
    return floorDb;
  };
  const nOut = new Float32Array(NB);
  let litAdaptive = 0;
  let litFixed = 0;
  let total = 0;
  at = 1000;
  for (let k = 0; k < 40; k++, at += 85) {
    const gate = noiseRow(at, false);
    if (k < 4) continue;
    if (rowDelta(noisy, noisy.size - 1, nOut, refs, { gateDb: gate })) litAdaptive += nOut.filter((v) => v !== 0).length;
    if (rowDelta(noisy, noisy.size - 1, nOut, refs, { gateDb: gate, deadbandDb: DELTA_DEADBAND_DB })) litFixed += nOut.filter((v) => v !== 0).length;
    total += NB;
  }
  ok(litAdaptive / total < 0.03, "unaveraged noise stays dark: under 3% of its bins light", `${((100 * litAdaptive) / total).toFixed(1)}%`);
  ok(litFixed / total > 0.1, "(a fixed 4 dB dead-band would light over a tenth of them)", `${((100 * litFixed) / total).toFixed(1)}%`);
  const keyGate = noiseRow(at, true);
  ok(
    rowDelta(noisy, noisy.size - 1, nOut, refs, { gateDb: keyGate }) && nOut.subarray(100, 110).filter((v) => v > 0).length >= 9,
    "a signal keying up 12 dB out of that noise still lights",
    Array.from(nOut.subarray(100, 110), (v) => v.toFixed(1)).join(),
  );

  // Reducing to columns.
  const col = new Float32Array(4);
  columnsSigned(new Float32Array([-9, 2, -3, -7, 0, 0, 0, 0]), 8, 0, 10, 0, 80, 4, col);
  ok(col[0] === 2 && col[1] === -7 && col[2] === 0 && col[3] === 0, "in a column a rise beats a drop, and the deepest drop shows otherwise", Array.from(col).join());
  const cm = new Float32Array(2);
  columnsMax(new Float32Array([1, 9, 2, 3, 3, 3]), 0, 6, 0, 10, 0, 60, 2, cm);
  ok(cm[0] === 9 && cm[1] === 3, "the column reduction keeps a one-bin carrier at full strength");

  // By day a drop must never be mistaken for a rise: every drop colour against every colour a
  // rise can take, on every map.
  for (const { id } of COLORMAPS) {
    const lut = colormapRgb(id);
    const bg = colormapChrome(id).background;
    const tint = DELTA_DROP_TINT[id];
    let closest = Number.POSITIVE_INFINITY;
    for (let s = 0; s <= 10; s++) {
      const m = DELTA_DROP_MIN + ((DELTA_DROP_MAX - DELTA_DROP_MIN) * s) / 10;
      const c = [0, 1, 2].map((i) => bg[i]! + (tint[i]! - bg[i]!) * m);
      for (let i = DELTA_RISE_MIN_INDEX; i < 256; i++) {
        closest = Math.min(closest, Math.hypot(c[0]! - lut[i * 3]!, c[1]! - lut[i * 3 + 1]!, c[2]! - lut[i * 3 + 2]!));
      }
    }
    ok(closest >= 45, `a drop on ${id} is a colour no rise is drawn in`, `closest ${closest.toFixed(0)}`);
  }
}

console.log("\nthreshold: noise floor, signal count and the stored slider");
{
  const buckets = new Int32Array(FLOOR_BUCKETS);
  const v = new Float32Array(100);
  bytesToDb(new Uint8Array(100).fill(10).fill(200, 70), 100, -100, -60, v);
  const at10 = -100 + (10 * 40) / 255;
  ok(near(noiseFloorDb(v, 0, 100, buckets), at10, 1e-4), "the floor of a row 30% signals is the noise level exactly");
  ok(near(noiseFloorDb(v, 0, 100, buckets, 0), at10, 1e-4) && near(noiseFloorDb(v, 0, 100, buckets, 0.9), -100 + (200 * 40) / 255, 1e-4), "other percentiles land on the right level");
  ok(noiseFloorDb(new Float32Array([-90, -90, -90]), 0, 3, buckets) === -90 && Number.isNaN(noiseFloorDb(v, 0, 0, buckets)), "a flat row is its own floor; an empty one has none");
  bytesToDb(new Uint8Array(100).fill(200).fill(10, 0, 40), 100, -100, -60, v);
  ok(
    FLOOR_FRACTION <= 0.25 && near(noiseFloorDb(v, 0, 100, buckets), at10, 1e-4),
    "a busy band 60% signal still has its floor on the noise (a median would sit on the signals)",
  );
  ok(noiseFloorDb(v, 0, 100, buckets, 0.5) > at10, "(the median of that row is a signal level)");
  // Threshold on that busy row: the 60 signal bins sit 29 dB up and all stay above the line.
  ok(countRuns(v, 0, 100, noiseFloorDb(v, 0, 100, buckets) + DEFAULT_THRESHOLD_DB) === 1, "so a busy band's signals stay above the line instead of becoming background");

  const r = new Float32Array(40).fill(-100);
  r[5] = -80; // a speck
  r.fill(-80, 10, 13); // a three-bin signal
  r.fill(-80, 20, 25);
  r[22] = -100; // one signal with a one-bin dip in it
  r.fill(-80, 30, 32);
  r.fill(-80, 34, 36); // two signals two bins apart
  ok(countRuns(r, 0, 40, -90) === 4, "runs: a speck ignored, a one-bin dip bridged, a two-bin gap splits", String(countRuns(r, 0, 40, -90)));
  ok(countRuns(r, 0, 40, -70) === 0 && countRuns(r, 0, 40, -90, 1) === 5, "nothing above a higher line; with no speck rule the speck counts");

  const h = new SpectrumHistory({ maxRows: 64, defaultIntervalMs: 250 });
  h.setHistoryMs(1_000);
  for (let k = 0; k < 4; k++) h.push(row(1000 + k * 250, 64, 0, { 10: 128, 11: 128, 12: 128, 40: 128, 41: 128, 50: k === 3 ? 128 : 0 }));
  const mean = new Float32Array(h.width);
  ok(countSignals(h, 8, mean, buckets) === 2, "two signals 20 dB up count as two; a one-row, one-bin speck does not");
  ok(countSignals(h, 25, mean, buckets) === 0, "a threshold above them counts none");
  h.push(row(2000, 64, 255), true);
  ok(countSignals(h, 8, mean, buckets) === 2, "a row taken on the air is left out of the count");
  ok(recentMean(h, SIGNAL_ROWS, mean) === 64 && near(mean[10]!, -100 + (128 * 40) / 255, 1e-4), "the count averages the newest received rows in dB");
  ok(countSignals(new SpectrumHistory(), 8, mean, buckets) === null, "no rows, no count");

  ok(sanitizeThresholdDb(null) === DEFAULT_THRESHOLD_DB && DEFAULT_THRESHOLD_DB === 12, "the threshold defaults to 12 dB over the 25th percentile");
  ok(sanitizeThresholdDb("15") === 15 && sanitizeThresholdDb(99) === MAX_THRESHOLD_DB && sanitizeThresholdDb(-4) === MIN_THRESHOLD_DB && sanitizeThresholdDb("x") === DEFAULT_THRESHOLD_DB, "stored values are read, clamped to 3..30, junk replaced");
  const blocked = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
  ok(loadThresholdDb(blocked) === DEFAULT_THRESHOLD_DB && loadThresholdDb(null) === DEFAULT_THRESHOLD_DB, "blocked or missing storage gives the default");
  let threw = false;
  try {
    saveThresholdDb(blocked, 12);
  } catch {
    threw = true;
  }
  ok(!threw, "saving to blocked storage does not throw");
  const store = new Map<string, string>();
  const mem = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, s: string) => void store.set(k, s) };
  saveThresholdDb(mem, 50);
  ok(loadThresholdDb(mem) === 30 && THRESHOLD_KEY.startsWith("digishack."), "a saved threshold reads back, clamped, under the app's namespace");

  const ids = VIEWS.map((x) => x.id);
  ok(ids.indexOf("delta") === ids.indexOf("persistence") + 1 && ids.indexOf("threshold") === ids.indexOf("delta") + 1, "Delta and Threshold follow Persistence on the switch");
  ok(sanitizePrefs({ view: "delta" }).view === "delta" && sanitizePrefs({ view: "ridgeline" }).view === "ridgeline", "every view on the switch is remembered, not just the first three");
  ok(
    VIEWS.find((x) => x.id === "spectrogram")?.label === "Waterfall HD" && !VIEWS.some((x) => x.label === "Spectrogram"),
    "the high-resolution waterfall is labelled Waterfall HD, under its old id so saved views and ?view=spectrogram links still work",
  );
}

// ---------------------------------------------------------------------------------------
console.log("\npreferences");
{
  ok(JSON.stringify(sanitizePrefs(null)) === JSON.stringify(DEFAULT_PREFS), "nothing stored gives the defaults");
  const p = sanitizePrefs({
    view: "3d",
    source: "rf",
    colormap: "nope",
    contrast: { audio: { floorOffsetDb: 999, rangeDb: 0 }, rf: "x" },
    historySec: 550,
    heightScale: 99,
    depthSec: "a",
    timeLabels: "ago",
  });
  ok(p.view === "3d" && p.source === "rf" && p.colormap === "digishack", "valid fields kept, an unknown colour map replaced");
  ok(p.contrast.audio.floorOffsetDb === 40 && p.contrast.audio.rangeDb === 3, "contrast values are clamped");
  ok(p.contrast.rf.rangeDb === null && p.historySec === 600 && p.heightScale === 3 && p.depthSec === 60, "history snaps to a choice; bad values fall back");
  ok(loadPrefs({ getItem: () => "{not json" }).view === "spectrogram", "corrupt storage yields the defaults");
  ok(
    loadPrefs({
      getItem: () => {
        throw new Error("blocked");
      },
    }).view === "spectrogram",
    "blocked storage yields the defaults",
  );
  ok(PREFS_KEY.startsWith("digishack."), "stored under the app's namespace");
}

// ---------------------------------------------------------------------------------------
console.log("\nanalyzer layout");
{
  const wide = analyzerLayout(1200);
  ok(
    !wide.narrow && wide.traceShare === 0.55 && wide.tickX === 4 && wide.tickAlign === "left" && wide.titleX === 10,
    "from sm up the analyzer keeps its original split and dB scale",
  );
  ok(analyzerLayout(ANALYZER_NARROW_PX).narrow === false && analyzerLayout(ANALYZER_NARROW_PX - 1).narrow, "the phone layout starts below sm");
  const phone = analyzerLayout(371);
  ok(phone.traceShare > wide.traceShare, "a phone gives the trace more of the box, so the waterfall strip is shorter");
  ok(phone.tickAlign === "right" && phone.tickX < ANALYZER_Y_AXIS_PX, "phone tick labels end inside the gutter, against the plot");
  // 11px text: the rotated title is about one line (11px) across, centred 2px left of titleX.
  // The widest tick label, "-110", is under 4 chars at 0.62em. They must not touch.
  const titleRight = phone.titleX - 2 + 11 / 2;
  const labelLeft = phone.tickX - 4 * 0.62 * 11;
  ok(titleRight < labelLeft, "the rotated dB title clears the widest tick label", `${titleRight} vs ${labelLeft}`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
