/* eslint-disable no-console */
// The stream branch of the decode pipeline: RTTY audio at the FlexRadio's 24 kHz, pushed
// in DAX-packet-sized pieces, comes out as text with a heartbeat once a second and no
// window events; the window schedule stops for a stream and resumes after it.
// Run: npm run check:rtty-pipeline

import { RTTY_CENTRE_HZ, RTTY_SHIFT_HZ, rttyTones, rttyWaveform } from "@/lib/digital/rtty";
import { DecodePipeline, STREAM_HEARTBEAT_MS } from "@/lib/radio/decode-pipeline";

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
  const beats: { mode: string; seconds: number; chars: number; framingErrors: number; mark: number; space: number }[] = [];
  let windows = 0;
  p.on("text", (t) => text.push(t.text));
  p.on("stream", (s) => beats.push(s));
  p.on("window", () => windows++);
  p.on("error", (e) => console.log("  pipeline error:", e.message));

  console.log("entering a stream");
  eq(p.streaming, null, "a new pipeline is not streaming");
  const usb = rttyTones(RTTY_CENTRE_HZ, RTTY_SHIFT_HZ, "USB");
  p.setStream("RTTY", { ...usb, figures: "us", usos: true });
  eq(p.streaming, "RTTY", "setStream(RTTY) is reported");
  ok(!p.windowsArmed, "and the window timer is not armed");
  p.start();
  ok(!p.windowsArmed, "start() arms nothing while streaming - a stream has no windows");

  console.log("\naudio in, text out");
  const w = rttyWaveform(TEXT, { sampleRate: RATE });
  // DAX delivers 24 kHz audio in packets of a few hundred samples; feed it that way.
  for (let i = 0; i < w.length; i += 256) p.push(w.subarray(i, Math.min(w.length, i + 256)));
  eq(text.join(""), TEXT, "the text arrives, in pieces, in order");
  const seconds = Math.floor(w.length / RATE);
  ok(beats.length === seconds || beats.length === seconds + 1, `one heartbeat per second of audio (${seconds} s)`, beats.length);
  ok(beats.every((b) => b.mode === "RTTY"), "each names the mode");
  const duringSignal = beats[beats.length - 1];
  ok((duringSignal?.mark ?? 0) > 0 && (duringSignal?.space ?? 0) >= 0, "a heartbeat during the signal carries the tone levels", duringSignal);
  // The heartbeat lands on whole seconds of audio, so the one inside the last character
  // precedes it; a second of silence after the text brings one that follows it.
  p.push(new Float32Array(RATE));
  const last = beats[beats.length - 1];
  eq(last?.chars, TEXT.length, "the heartbeat after the text carries the full character count");
  eq(last?.framingErrors, 0, "and no framing errors on a clean signal");
  eq(windows, 0, "no window event was emitted during the stream");
  eq(STREAM_HEARTBEAT_MS, 1_000, "the heartbeat interval is one second");

  console.log("\nretuning while streaming keeps the demodulator");
  const off = rttyWaveform("RETUNED", { sampleRate: RATE, centreHz: RTTY_CENTRE_HZ + 300 });
  p.setStream("RTTY", { ...rttyTones(RTTY_CENTRE_HZ + 300, RTTY_SHIFT_HZ, "USB"), figures: "us", usos: true });
  eq(p.streaming, "RTTY", "still streaming");
  text.length = 0;
  for (let i = 0; i < off.length; i += 256) p.push(off.subarray(i, Math.min(off.length, i + 256)));
  eq(text.join(""), "RETUNED", "a signal at the new centre decodes after the retune");

  console.log("\nleaving the stream");
  p.setStream(null);
  eq(p.streaming, null, "setStream(null) ends it");
  ok(p.windowsArmed, "and the window schedule is armed again for the window mode");
  p.setStream(null);
  ok(p.windowsArmed, "a second setStream(null) is harmless");
  p.stop();
  ok(!p.windowsArmed, "stop() clears the schedule");

  console.log("");
  if (failed > 0) {
    console.log(`${failed} FAILED`);
    process.exit(1);
  }
  console.log("all RTTY pipeline assertions passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
