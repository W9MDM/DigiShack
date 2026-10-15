/* eslint-disable no-console */
// The stream branch of the decode pipeline on PSK31: audio at the FlexRadio's 24 kHz, pushed
// in DAX-packet-sized pieces, comes out as text with a heartbeat once a second carrying the
// quality, and no window events; a retune keeps the demodulator, a speed change makes a new
// one, and leaving the stream re-arms the window schedule.
// Run: npm run check:psk31-pipeline

import { psk31Waveform } from "@/lib/digital/psk31";
import { DecodePipeline, STREAM_HEARTBEAT_MS, isStreamMode } from "@/lib/radio/decode-pipeline";

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
  const TEXT = "CQ CQ de W1AW W1AW pse K";
  const p = new DecodePipeline({ mode: "FT8", inputSampleRate: RATE });
  const text: string[] = [];
  const beats: { mode: string; seconds: number; chars: number; errors: number; quality: number; afcHz: number; open: boolean }[] = [];
  let windows = 0;
  p.on("text", (t) => text.push(t.text));
  p.on("stream", (s) => beats.push(s as (typeof beats)[number]));
  p.on("window", () => windows++);
  p.on("error", (e) => console.log("  pipeline error:", e.message));

  console.log("entering the stream");
  ok(isStreamMode("PSK31"), "PSK31 is a stream mode");
  p.setStream({ mode: "PSK31", centreHz: 1000 });
  eq(p.streaming, "PSK31", "setStream(PSK31) is reported");
  ok(!p.windowsArmed, "and the window timer is not armed");
  p.start();
  ok(!p.windowsArmed, "start() arms nothing while streaming");

  console.log("\naudio in, text out");
  const w = psk31Waveform(TEXT, { sampleRate: RATE, centreHz: 1000 });
  for (let i = 0; i < w.length; i += 256) p.push(w.subarray(i, Math.min(w.length, i + 256)));
  p.push(new Float32Array(RATE));
  ok(text.join("").includes(TEXT), "the text arrives, in pieces, in order", text.join(""));
  const seconds = Math.floor((w.length + RATE) / RATE);
  ok(beats.length === seconds || beats.length === seconds + 1, `one heartbeat per second of audio (${seconds} s)`, beats.length);
  ok(beats.every((b) => b.mode === "PSK31"), "each names the mode");
  const mid = beats[Math.floor(beats.length / 2)];
  ok((mid?.quality ?? 0) > 0.8 && mid?.open === true, "a heartbeat during the signal carries a quality near 1 with the squelch open", mid);
  const last = beats[beats.length - 1];
  eq(last?.chars, TEXT.length, "the heartbeat after the text carries the full character count");
  eq(last?.errors, 0, "and no unread codes on a clean signal");
  eq(windows, 0, "no window event was emitted during the stream");
  eq(STREAM_HEARTBEAT_MS, 1_000, "the heartbeat interval is one second");

  console.log("\nretuning while streaming keeps the demodulator");
  const off = psk31Waveform("RETUNED", { sampleRate: RATE, centreHz: 1500 });
  p.setStream({ mode: "PSK31", centreHz: 1500 });
  eq(p.streaming, "PSK31", "still streaming");
  text.length = 0;
  for (let i = 0; i < off.length; i += 256) p.push(off.subarray(i, Math.min(off.length, i + 256)));
  p.push(new Float32Array(RATE));
  ok(text.join("").includes("RETUNED"), "a signal at the new carrier decodes after the retune", text.join(""));

  console.log("\na speed change is a new demodulator");
  const fast = psk31Waveform("FASTER", { sampleRate: RATE, centreHz: 1500, speed: 63 });
  p.setStream({ mode: "PSK31", centreHz: 1500, speed: 63 });
  text.length = 0;
  for (let i = 0; i < fast.length; i += 256) p.push(fast.subarray(i, Math.min(fast.length, i + 256)));
  p.push(new Float32Array(RATE));
  ok(text.join("").includes("FASTER"), "BPSK63 decodes after switching the speed", text.join(""));

  console.log("\nleaving the stream");
  p.setStream(null);
  eq(p.streaming, null, "setStream(null) ends it");
  ok(p.windowsArmed, "and the window schedule is armed again for the window mode");
  p.stop();
  ok(!p.windowsArmed, "stop() clears the schedule");

  console.log("");
  if (failed > 0) {
    console.log(`${failed} FAILED`);
    process.exit(1);
  }
  console.log("all PSK31 pipeline assertions passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
