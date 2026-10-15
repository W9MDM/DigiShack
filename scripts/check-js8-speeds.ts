/* eslint-disable no-console */
// JS8's speeds through the real pipeline, decoder thread and transmitter waveform: for
// Normal, Fast, Turbo and Slow, a heartbeat built the way the transmitter builds it, at
// the FlexRadio's 24 kHz, placed in its window where that speed starts, is read back by
// the pipeline set to that speed - and the timing tables say that speed's period, start
// delay and transmission length.
// Run: npm run check:js8-speeds
import { JS8_SUBMODES, type Js8Submode } from "@/lib/digital/js8";
import { js8BuildFrames } from "@/lib/digital/js8-message";
import { DAX_SAMPLE_RATE } from "@/lib/flex/dax";
import { DecodePipeline, type Decode } from "@/lib/radio/decode-pipeline";
import { PERIOD_MS, setJs8Submode, TRANSMISSION_MS, TX_START_OFFSET_MS } from "@/lib/radio/timing";
import { buildJs8Waveform } from "@/lib/radio/waveform";

let failed = 0;
function ok(cond: boolean, what: string, extra?: unknown): void {
  if (cond) console.log(`  ok    ${what}`);
  else {
    failed++;
    console.log(`  FAIL  ${what}`, extra ?? "");
  }
}

async function main(): Promise<void> {
  const frame = js8BuildFrames("W1AW", "FN31", "@HB HEARTBEAT")[0]!;
  for (const [sub, name] of [["A", "Normal"], ["B", "Fast"], ["C", "Turbo"], ["E", "Slow"]] as [Js8Submode, string][]) {
    console.log(`\n${name}`);
    setJs8Submode(sub);
    const p = JS8_SUBMODES[sub];
    ok(PERIOD_MS.JS8 === p.periodS * 1000, `the period is ${p.periodS} s`, PERIOD_MS.JS8);
    ok(TX_START_OFFSET_MS.JS8 === Math.round(p.startS * 1000), `the start delay is ${p.startS} s`, TX_START_OFFSET_MS.JS8);
    const wave = buildJs8Waveform(frame, 1500, DAX_SAMPLE_RATE);
    ok(Math.abs(wave.length / DAX_SAMPLE_RATE - TRANSMISSION_MS.JS8 / 1000) < 0.05, `and the transmitter's waveform is ${TRANSMISSION_MS.JS8 / 1000} s long`, wave.length / DAX_SAMPLE_RATE);
    // The window as the pipeline cuts it: the period, the signal at its start delay.
    const buf = new Float32Array(Math.round((DAX_SAMPLE_RATE * PERIOD_MS.JS8) / 1000));
    const lead = Math.round((DAX_SAMPLE_RATE * TX_START_OFFSET_MS.JS8) / 1000);
    buf.set(wave.subarray(0, Math.min(wave.length, buf.length - lead)), lead);
    const pipe = new DecodePipeline({ mode: "JS8", inputSampleRate: DAX_SAMPLE_RATE, depth: 2, silenceRms: 1e-5 });
    let decodes: Decode[] = [];
    pipe.on("decodes", (d) => (decodes = d.decodes));
    pipe.on("error", (e) => console.log("  pipeline error:", e.message));
    await pipe.processWindow(Array.from(buf), new Date(0));
    pipe.stop();
    const hit = decodes.find((d) => d.message === "W1AW: @HB HEARTBEAT FN31");
    ok(hit !== undefined, `the pipeline set to ${name} reads the heartbeat`, decodes.map((d) => d.message).join(" | ") || "nothing");
    if (hit) ok(Math.abs(hit.freqOffset - 1500) <= 3, `at 1500 Hz (${hit.freqOffset})`);
  }
  setJs8Submode("A");

  console.log("\na speed reads only its own signals");
  {
    setJs8Submode("B");
    const fast = buildJs8Waveform(frame, 1500, DAX_SAMPLE_RATE);
    setJs8Submode("A");
    const buf = new Float32Array(DAX_SAMPLE_RATE * 15);
    buf.set(fast, Math.round(DAX_SAMPLE_RATE * 0.5));
    const pipe = new DecodePipeline({ mode: "JS8", inputSampleRate: DAX_SAMPLE_RATE, depth: 2, silenceRms: 1e-5 });
    let decodes: Decode[] = [];
    pipe.on("decodes", (d) => (decodes = d.decodes));
    await pipe.processWindow(Array.from(buf), new Date(0));
    pipe.stop();
    ok(decodes.length === 0, "a Fast heartbeat is not read by the decoder on Normal", decodes.map((d) => d.message).join(" | "));
  }

  console.log("");
  if (failed > 0) {
    console.log(`${failed} FAILED`);
    process.exit(1);
  }
  console.log("all JS8 speed assertions passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
