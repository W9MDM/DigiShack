/* eslint-disable no-console */
// The stream branch of the decode pipeline on CW: keyed audio at the FlexRadio's 24 kHz,
// pushed in DAX-packet-sized pieces, comes out as text with a heartbeat once a second
// carrying the decoder's speed estimate, and no window events.
// Run: npm run check:cw-pipeline

import { cwWaveform } from "@/lib/digital/cw";
import { DecodePipeline } from "@/lib/radio/decode-pipeline";

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
  ok(JSON.stringify(a) === JSON.stringify(b), what, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

async function main(): Promise<void> {
  const RATE = 24_000;
  const TEXT = "CQ CQ DE W1AW W1AW K";
  const p = new DecodePipeline({ mode: "FT8", inputSampleRate: RATE });
  const text: string[] = [];
  const beats: { mode: string; seconds: number; chars: number; wpm?: number; keyed?: boolean }[] = [];
  let windows = 0;
  p.on("text", (t) => text.push(t.text));
  p.on("stream", (s) => beats.push(s as (typeof beats)[number]));
  p.on("window", () => windows++);

  console.log("entering the CW stream");
  p.setStream({ mode: "CW", pitchHz: 600, wpm: 20 });
  eq(p.streaming, "CW", "setStream(CW) is reported");
  ok(!p.windowsArmed, "and the window timer is not armed");

  console.log("\naudio in, text out");
  const w = cwWaveform(TEXT, { sampleRate: RATE, wpm: 25 });
  for (let i = 0; i < w.length; i += 256) p.push(w.subarray(i, Math.min(w.length, i + 256)));
  p.push(new Float32Array(RATE));
  eq(text.join("").trim(), TEXT, "the text arrives, in pieces, in order");
  const seconds = Math.floor((w.length + RATE) / RATE);
  ok(beats.length === seconds || beats.length === seconds + 1, `one heartbeat per second of audio (${seconds} s)`, beats.length);
  ok(beats.every((b) => b.mode === "CW"), "each names the mode");
  const last = beats[beats.length - 1];
  eq(last?.chars, TEXT.replace(/ /g, "").length, "the heartbeat carries the character count");
  ok(Math.abs((last?.wpm ?? 0) - 25) < 2, "and the speed it hears", last?.wpm);
  eq(last?.keyed, false, "key up after the text");
  eq(windows, 0, "no window event was emitted during the stream");

  console.log("\nthe pitch follows the radio");
  text.length = 0;
  p.setStream({ mode: "CW", pitchHz: 700, wpm: 20 });
  eq(p.streaming, "CW", "still streaming after a retune");
  const w2 = cwWaveform("PITCH", { sampleRate: RATE, wpm: 20, pitchHz: 700 });
  for (let i = 0; i < w2.length; i += 256) p.push(w2.subarray(i, Math.min(w2.length, i + 256)));
  p.push(new Float32Array(RATE));
  eq(text.join("").trim(), "PITCH", "a signal at the new pitch decodes");

  console.log("\nswitching streams, and leaving");
  p.setStream({ mode: "RTTY", markHz: 2295, spaceHz: 2125 });
  eq(p.streaming, "RTTY", "RTTY replaces CW in place");
  p.setStream(null);
  eq(p.streaming, null, "setStream(null) ends it");
  ok(p.windowsArmed, "and the window schedule is armed again");
  p.stop();

  console.log("");
  if (failed > 0) {
    console.log(`${failed} FAILED`);
    process.exit(1);
  }
  console.log("all CW pipeline assertions passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
