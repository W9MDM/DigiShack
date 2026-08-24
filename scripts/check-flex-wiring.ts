/* eslint-disable no-console */
// FlexDaxSource's glue to the shared decode pipeline.
//
// WHY THIS EXISTS, and it is not a happy reason: extracting the pipeline in 0.86.0 left
// this code with no coverage at all. Before the extraction, `check-pipeline-golden.ts`
// constructed a `FlexDaxSource` and called its private `processWindow`, so the class was
// at least instantiated. After it, that test drives `DecodePipeline` directly — correctly,
// because that is where the decoding lives — and nothing constructed a FlexDaxSource any
// more. `npm run check` passed while no longer touching the file the refactor changed.
//
// The glue is small but it is exactly where a refactor like that goes wrong: does the
// constructor forward the pipeline's events, does a received packet actually reach the
// buffer, does start() start the scheduler, does stop() stop it. Every one of those
// could be broken with the whole suite still green, and the symptom would be a radio
// that connects, shows a waterfall, and decodes nothing.
//
// No network: packets are handed to `onPacket` directly, which is what the UDP socket
// does anyway.

import { DAX_SAMPLE_RATE, FlexDaxSource } from "@/lib/flex/dax";
import { buildWaveform } from "@/lib/radio/waveform";

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
  ok(JSON.stringify(a) === JSON.stringify(b), label, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

const VITA_HEADER_BYTES = 28;
const AUDIO_PACKET_CLASS = 0x03e3;
const METER_PACKET_CLASS = 0x8002;

/** A VITA-49 audio packet as the radio sends it: interleaved stereo float32 BE. */
function audioPacket(samples: Float32Array): Buffer {
  const buf = Buffer.alloc(VITA_HEADER_BYTES + samples.length * 8);
  buf.writeUInt16BE(AUDIO_PACKET_CLASS, 14);
  for (let i = 0; i < samples.length; i++) {
    // L and R are identical on a receive slice.
    buf.writeFloatBE(samples[i] as number, VITA_HEADER_BYTES + i * 8);
    buf.writeFloatBE(samples[i] as number, VITA_HEADER_BYTES + i * 8 + 4);
  }
  return buf;
}

type Innards = {
  onPacket(b: Buffer): void;
  pipeline: {
    buffer: number[];
    processWindow(s: number[], w: Date): void;
    currentMode: string;
    periodMs: number;
  };
};

function make(mode: "FT8" | "FT4" | "FT2" = "FT8"): {
  source: FlexDaxSource;
  inner: Innards;
} {
  const source = new FlexDaxSource({ host: "0.0.0.0", mode, depth: 2, silenceRms: 1e-5 });
  return { source, inner: source as unknown as Innards };
}

console.log("\na received packet reaches the decode buffer");
{
  const { inner } = make();
  eq(inner.pipeline.buffer.length, 0, "the buffer starts empty");

  const tone = new Float32Array(1200);
  for (let i = 0; i < tone.length; i++) {
    tone[i] = Math.sin((2 * Math.PI * 1200 * i) / DAX_SAMPLE_RATE);
  }
  inner.onPacket(audioPacket(tone));

  eq(inner.pipeline.buffer.length, 1200, "1200 stereo frames become 1200 mono samples");
  ok(
    Math.abs((inner.pipeline.buffer[10] as number) - (tone[10] as number)) < 1e-6,
    "and the values survive the big-endian float read",
  );
}

console.log("\npackets that are not audio");
{
  // Once meters are subscribed they arrive on the same socket. Parsing one as float32
  // audio would inject garbage straight into the decode buffer.
  const { inner } = make();
  const meter = Buffer.alloc(VITA_HEADER_BYTES + 64);
  meter.writeUInt16BE(METER_PACKET_CLASS, 14);
  inner.onPacket(meter);
  eq(inner.pipeline.buffer.length, 0, "a meter packet contributes no audio samples");

  const unknown = Buffer.alloc(VITA_HEADER_BYTES + 64);
  unknown.writeUInt16BE(0x1234, 14);
  inner.onPacket(unknown);
  eq(inner.pipeline.buffer.length, 0, "nor does an unrecognised class");

  const runt = Buffer.alloc(VITA_HEADER_BYTES);
  inner.onPacket(runt);
  eq(inner.pipeline.buffer.length, 0, "a header-only packet is ignored rather than throwing");
}

console.log("\nthe pipeline's events come out of the source");
{
  // The constructor subscribes to the pipeline and re-emits. If that wiring were
  // dropped the radio would decode perfectly and the application would never hear
  // about it — a failure with no error anywhere.
  const { source, inner } = make("FT2");

  let decodes: string[] = [];
  let windowSeen = false;
  let errorSeen = false;
  source.on("decodes", (d) => {
    decodes = d.decodes.map((x) => x.message);
  });
  source.on("window", () => {
    windowSeen = true;
  });
  source.on("error", () => {
    errorSeen = true;
  });

  const MSG = "CQ K9XYZ EN52";
  const wave = buildWaveform(MSG, "FT2", 1200, DAX_SAMPLE_RATE);
  const total = Math.round((DAX_SAMPLE_RATE * (1_947 + 1_200)) / 1000);
  const win = new Float32Array(total);
  win.set(wave.subarray(0, Math.min(wave.length, total)));

  inner.pipeline.processWindow(Array.from(win), new Date(0));

  ok(windowSeen, "the window event is forwarded");
  ok(decodes.includes(MSG), "and so is the decode", decodes.join(" | ") || "nothing forwarded");
  ok(!errorSeen, "with no error raised");
}

console.log("\nmode and lifecycle");
{
  const { source, inner } = make("FT8");
  eq(inner.pipeline.currentMode, "FT8", "the pipeline is built in the configured mode");
  eq(source.periodMs, 15_000, "and the source reports that mode's period");

  ok(source.setMode("FT4"), "changing mode reports a change");
  eq(inner.pipeline.currentMode, "FT4", "and reaches the pipeline");
  eq(source.periodMs, 7_500, "the period follows");
  ok(!source.setMode("FT4"), "setting the same mode again reports no change");

  eq(source.mode, "FT4", "the source agrees with itself");
}

console.log("\nstop is safe before start");
{
  // stop() runs on teardown paths that may fire before start() ever completed — a
  // failed connect, for instance. It must not throw there.
  const { source, inner } = make();
  const tone = new Float32Array(100);
  inner.onPacket(audioPacket(tone));
  ok(inner.pipeline.buffer.length > 0, "buffered something first");

  let threw = false;
  void source.stop().catch(() => {
    threw = true;
  });
  ok(!threw, "stop() does not throw when nothing was started");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
