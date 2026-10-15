/* eslint-disable no-console */
// The stream branch of the decode pipeline on Olivia: audio at the FlexRadio's 24 kHz, pushed
// in DAX-packet-sized pieces, comes out as text with a heartbeat once a second carrying the
// synchroniser's S/N, and no window events; a retune keeps the demodulator, a size change
// makes a new one, and leaving the stream re-arms the window schedule.
// Run: npm run check:olivia-pipeline

import { oliviaParams, oliviaSymbols, oliviaWaveform } from "@/lib/digital/olivia";
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

/** Silence in DAX-sized pieces: the pipeline beats at most once per push, as it does live. */
function pushSilence(p: DecodePipeline, samples: number): void {
  const quiet = new Float32Array(256);
  for (let i = 0; i < samples; i += 256) p.push(quiet.subarray(0, Math.min(256, samples - i)));
}

async function main(): Promise<void> {
  const RATE = 24_000;
  const TEXT = "CQ CQ de W1AW pse k";
  const size = { tones: 16, bandwidth: 500 } as const;
  const flushS = 8 * oliviaParams(size).blockSeconds;
  const p = new DecodePipeline({ mode: "FT8", inputSampleRate: RATE });
  const text: string[] = [];
  const beats: { mode: string; seconds: number; chars: number; blocks: number; snr: number; open: boolean }[] = [];
  let windows = 0;
  p.on("text", (t) => text.push(t.text));
  p.on("stream", (s) => beats.push(s as (typeof beats)[number]));
  p.on("window", () => windows++);
  p.on("error", (e) => console.log("  pipeline error:", e.message));

  console.log("entering the stream");
  ok(isStreamMode("OLIVIA"), "OLIVIA is a stream mode");
  p.setStream({ mode: "OLIVIA", centreHz: 1500, ...size });
  eq(p.streaming, "OLIVIA", "setStream(OLIVIA) is reported");
  ok(!p.windowsArmed, "and the window timer is not armed");
  p.start();
  ok(!p.windowsArmed, "start() arms nothing while streaming");

  console.log("\naudio in, text out");
  const w = oliviaWaveform(oliviaSymbols(TEXT, { ...size, preambleBlocks: 2 }), { ...size, sampleRate: RATE, centreHz: 1500 });
  for (let i = 0; i < w.length; i += 256) p.push(w.subarray(i, Math.min(w.length, i + 256)));
  pushSilence(p, Math.round(RATE * flushS));
  ok(text.join("").includes(TEXT), "the text arrives, in pieces, in order", text.join(""));
  const seconds = Math.floor((w.length + Math.round(RATE * flushS)) / RATE);
  ok(beats.length === seconds || beats.length === seconds + 1, `one heartbeat per second of audio (${seconds} s)`, beats.length);
  ok(beats.every((b) => b.mode === "OLIVIA"), "each names the mode");
  const synced = beats.find((b) => b.open);
  ok((synced?.snr ?? 0) >= 4, "a heartbeat during the signal carries a S/N over the threshold with the sync open", synced);
  const last = beats[beats.length - 1];
  eq(last?.chars, TEXT.length, "the heartbeat after the text carries the full character count");
  ok((last?.blocks ?? 0) >= Math.ceil(TEXT.length / 4), "and the blocks printed cover the text", last?.blocks);
  eq(windows, 0, "no window event was emitted during the stream");
  eq(STREAM_HEARTBEAT_MS, 1_000, "the heartbeat interval is one second");

  console.log("\nretuning while streaming keeps the demodulator");
  const off = oliviaWaveform(oliviaSymbols("RETUNED", { ...size, preambleBlocks: 2 }), { ...size, sampleRate: RATE, centreHz: 1200 });
  p.setStream({ mode: "OLIVIA", centreHz: 1200, ...size });
  eq(p.streaming, "OLIVIA", "still streaming");
  text.length = 0;
  for (let i = 0; i < off.length; i += 256) p.push(off.subarray(i, Math.min(off.length, i + 256)));
  pushSilence(p, Math.round(RATE * flushS));
  ok(text.join("").includes("RETUNED"), "a signal at the new centre decodes after the retune", text.join(""));

  console.log("\na size change is a new demodulator");
  const big = { tones: 32, bandwidth: 1000 } as const;
  const wide = oliviaWaveform(oliviaSymbols("WIDER", { ...big, preambleBlocks: 2 }), { ...big, sampleRate: RATE, centreHz: 1200 });
  p.setStream({ mode: "OLIVIA", centreHz: 1200, ...big });
  text.length = 0;
  for (let i = 0; i < wide.length; i += 256) p.push(wide.subarray(i, Math.min(wide.length, i + 256)));
  pushSilence(p, Math.round(RATE * flushS));
  ok(text.join("").includes("WIDER"), "1000/32 decodes after switching the size", text.join(""));

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
  console.log("all Olivia pipeline assertions passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
