/* eslint-disable no-console */
// The Icom source runs the stream modes. Until 1.280 only the FlexRadio source switched the
// pipeline over for RTTY, CW, PSK31, Olivia, SSTV, Hell and JTTY: on an IC-7300 choosing
// Hell set the label and ran nothing, and the page waited for a carrier that never came.
// Run: npm run check:icom-streams

import { hellDurationMs, hellWaveform } from "@/lib/digital/hell";
import { maxTextMs, textWaveform } from "@/lib/radio/text-waveform";
import { IcomSource } from "@/lib/icom/rig";
import type { DecodePipeline } from "@/lib/radio/decode-pipeline";

let failed = 0;
function ok(cond: boolean, label: string, detail = ""): void {
  if (cond) console.log(`  ok    ${label}`);
  else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` - ${detail}` : ""}`);
  }
}

// Never connected: the decode half needs no radio. Audio goes in where the audio stream
// would put it.
const src = new IcomSource({ host: "192.0.2.1", username: "x", password: "x", mode: "FT8" });
const pipeline = (src as unknown as { pipeline: DecodePipeline }).pipeline;

console.log("switching modes");
ok(src.mode === "FT8" && pipeline.streaming === null, "starts on FT8, in windows");
ok(src.setMode("HELL") && src.mode === "HELL" && pipeline.streaming === "HELL", "Hell streams");
ok(src.periodMs === 1000, `and beats once a second while it does (${src.periodMs} ms)`);
for (const m of ["RTTY", "CW", "PSK31", "OLIVIA", "SSTV", "JTTY"] as const) {
  src.setMode(m);
  ok(pipeline.streaming === m, `${m} streams`);
}
src.setMode("FT4");
ok(pipeline.streaming === null && src.mode === "FT4" && src.periodMs === 7500, "and back to FT4 in windows");

console.log("\nHell on the Icom paints");
{
  src.setMode("HELL");
  src.setHellOptions({ mode: "HELL", centreHz: 1200, variant: "fm105" });
  let columns = 0;
  let beats = 0;
  src.on("hell", (e) => (columns += e.data.length / e.rows));
  src.on("stream", () => beats++);
  const wave = hellWaveform("CQ CQ DE N9MMR", { sampleRate: 48_000, centreHz: 1200, amplitude: 0.4, variant: "fm105" });
  for (let i = 0; i < wave.length; i += 960) pipeline.push(wave.subarray(i, i + 960));
  ok(columns > 40, `the source emits painted columns (${columns})`);
  ok(beats >= 2, `and the stream heartbeat (${beats})`);
}

console.log("\nits own transmission is not read back");
{
  src.setMode("PSK31");
  let keyed = true;
  src.muteStreamWhile(() => keyed);
  let fed = 0;
  const realPush = pipeline.push.bind(pipeline);
  pipeline.push = (s) => {
    fed += s.length;
    realPush(s);
  };
  // The audio stream's handler is what applies the mute; call it the way the stream does.
  const take = (src as unknown as { takeAudio?: (s: Float32Array, at: number) => void }).takeAudio;
  const feed = take ? (x: Float32Array) => take.call(src, x, Date.now()) : undefined;
  ok(typeof feed === "function", "the audio path can be driven without a radio");
  feed?.(new Float32Array(960));
  ok(fed === 0, "keyed: nothing reaches the stream decoder");
  keyed = false;
  feed?.(new Float32Array(960));
  ok(fed === 960, "unkeyed: it does");
}

console.log("\na line of text for the Icom's transmitter");
{
  const req = { mode: "HELL" as const, text: "CQ DE N9MMR", centreHz: 1000, shiftHz: 0, sideband: "USB" as const, hellVariant: "fm105" as const };
  const w = textWaveform(req, 48_000);
  ok(Math.abs(w.length / 48_000 - hellDurationMs(req.text, "fm105") / 1000) < 0.01, "built at the Icom's 48 kHz, as long as the columns");
  ok(maxTextMs(req) === 40_000 && maxTextMs({ mode: "HELL", hellVariant: "slow" }) === 120_000, "Slow Hell gets two minutes, the rest forty seconds");
  let refused = "";
  try {
    textWaveform({ ...req, hellVariant: "slow", text: "X".repeat(60) }, 48_000);
  } catch (err) {
    refused = err instanceof Error ? err.message : "";
  }
  ok(refused.includes("Slow Hell") && refused.includes("cap"), "an over-long Slow Hell line is refused before the radio", refused);
}

console.log("");
if (failed > 0) {
  console.log(`${failed} FAILED`);
  process.exit(1);
}
console.log("all Icom stream assertions passed");
