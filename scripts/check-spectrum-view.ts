/* eslint-disable no-console */
// The Spectrum page's pure logic: wire decoding, dB recovery, the history ring and its time
// map, colour maps, axis ticks, the camera and stored preferences.
//
// The properties that matter most are the ones a plausible-looking display can get wrong
// silently: a narrow carrier or a one-frame burst averaged away, a gap papered over with a
// stale row, history that re-scales differently from the rows arriving now, or an axis
// label that disagrees with where the pixels are. Each has an assertion below.

import { PALETTE } from "@/components/digital/spectrum-canvas";
import { panadapterMessage } from "@/lib/radio/panadapter";
import { spectrumMessage } from "@/lib/radio/spectrum";
import {
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
  colormapRgb,
  colormapRgba,
  COLORMAPS,
  lutLuminance,
  turboRgb,
} from "@/lib/spectrum/colormaps";
import { BridgeClock, RateMeter, SpectrumFeed } from "@/lib/spectrum/feed";
import { SpectrumHistory } from "@/lib/spectrum/history";
import { bytesToDb, displayWindow, LevelTracker, normaliseDb } from "@/lib/spectrum/levels";
import { DEFAULT_PREFS, loadPrefs, PREFS_KEY, sanitizePrefs } from "@/lib/spectrum/prefs";
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

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
