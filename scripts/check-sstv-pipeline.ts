/* eslint-disable no-console */
// SSTV through the real pipeline: a Martin 2 test card at the FlexRadio's 24 kHz, pushed in
// DAX-sized pieces, comes out as a start, every row, and a finished picture, with a
// heartbeat a second and no window events; and the picture saves as a PNG any viewer reads.
// Run: npm run check:sstv-pipeline
import { inflateSync } from "node:zlib";

import { encodePng } from "@/lib/digital/png";
import { sstvModeByName, sstvTestCard, sstvWaveform } from "@/lib/digital/sstv";
import { DecodePipeline, isStreamMode, type SstvEvent } from "@/lib/radio/decode-pipeline";

let failed = 0;
function ok(cond: boolean, what: string, extra?: unknown): void {
  if (cond) console.log(`  ok    ${what}`);
  else {
    failed++;
    console.log(`  FAIL  ${what}`, extra ?? "");
  }
}

const RATE = 24_000;
const mode = sstvModeByName("Martin 2")!;
const card = sstvTestCard(mode.width, mode.height);

console.log("the stream");
ok(isStreamMode("SSTV"), "SSTV is a stream mode");
const p = new DecodePipeline({ mode: "FT8", inputSampleRate: RATE });
const events: SstvEvent[] = [];
let beats = 0;
let lastBeat: { receiving: string | null; pictures: number } | null = null;
let windows = 0;
p.on("sstv", (e) => events.push(e));
p.on("stream", (s) => {
  beats++;
  if (s.mode === "SSTV") lastBeat = s;
});
p.on("window", () => windows++);
p.setStream({ mode: "SSTV" });
p.start();
ok(p.streaming === "SSTV" && !p.windowsArmed, "setStream(SSTV) streams, with no window timer");

const w = sstvWaveform(mode, card, { sampleRate: RATE });
for (let i = 0; i < w.length; i += 256) p.push(w.subarray(i, Math.min(w.length, i + 256)));
p.push(new Float32Array(RATE));
const start = events.find((e) => e.kind === "start");
ok(start?.kind === "start" && start.mode === "Martin 2" && start.width === 320 && start.height === 256, "a start event names the mode and the size", start);
const rows = events.filter((e) => e.kind === "rows").reduce((n, e) => n + (e.kind === "rows" ? e.to - e.from : 0), 0);
ok(rows === 256, `rows arrive as they are decoded (${rows} of 256)`);
const image = events.find((e) => e.kind === "image");
ok(image?.kind === "image", "and the finished picture");
if (image?.kind === "image") {
  let err = 0;
  for (let i = 0; i < card.rgb.length; i++) err += Math.abs(card.rgb[i]! - image.rgb[i]!);
  err /= card.rgb.length;
  ok(err < 6, `which is the test card (mean error ${err.toFixed(1)} of 255)`);

  console.log("\nthe PNG");
  const png = encodePng(image.width, image.height, image.rgb);
  ok(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "the signature");
  ok(png.readUInt32BE(16) === 320 && png.readUInt32BE(20) === 256 && png[24] === 8 && png[25] === 2, "an IHDR of 320 x 256, 8-bit RGB");
  const idatAt = png.indexOf("IDAT");
  const idatLen = png.readUInt32BE(idatAt - 4);
  const raw = inflateSync(png.subarray(idatAt + 4, idatAt + 4 + idatLen));
  let same = raw.length === (320 * 3 + 1) * 256;
  for (let y = 0; same && y < 256; y++) {
    if (raw[y * 961] !== 0) same = false;
    for (let i = 0; same && i < 960; i++) if (raw[y * 961 + 1 + i] !== image.rgb[y * 960 + i]) same = false;
  }
  ok(same, "whose pixels inflate back to the picture exactly");
}
const beat = lastBeat as { receiving: string | null; pictures: number } | null;
ok(beats > 0 && beat !== null && beat.pictures === 1 && beat.receiving === null, "a heartbeat a second, counting the picture, idle again after it", lastBeat);
ok(windows === 0, "and no window events");
p.stop();

console.log("");
if (failed > 0) {
  console.log(`${failed} FAILED`);
  process.exit(1);
}
console.log("all SSTV pipeline assertions passed");
process.exit(0);
