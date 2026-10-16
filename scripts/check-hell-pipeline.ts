/* eslint-disable no-console */
// The stream branch of the decode pipeline on Feld Hell: audio at the FlexRadio's 24 kHz,
// pushed in DAX-packet-sized pieces, comes out as painted columns in handfuls, with a
// heartbeat once a second carrying the level, no text and no window events; a retune
// keeps the receiver, the same settings again are a no-op, and leaving the stream re-arms
// the window schedule. Plus the transmitter: a line of Hell is built, capped, and never
// keyed with transmit off.
// Run: npm run check:hell-pipeline

import { HELL_COLUMN_RATE, HELL_RX_ROWS, hellWaveform } from "@/lib/digital/hell";
import { FlexDaxTransmitter } from "@/lib/flex/tx";
import { inferDigitalMode } from "@/lib/ham/digital-freqs";
import { DecodePipeline, isStreamMode } from "@/lib/radio/decode-pipeline";
import { NO_SEQUENCER_MODES } from "@/lib/radio/automation-gate";

let failed = 0;
function ok(cond: boolean, what: string, extra?: unknown): void {
  if (cond) console.log(`  ok    ${what}`);
  else {
    failed++;
    console.log(`  FAIL  ${what}`, extra ?? "");
  }
}

function push(p: DecodePipeline, w: Float32Array): void {
  for (let i = 0; i < w.length; i += 256) p.push(w.subarray(i, Math.min(w.length, i + 256)));
}

async function main(): Promise<void> {
  const RATE = 24_000;
  const p = new DecodePipeline({ mode: "FT8", inputSampleRate: RATE });
  const handfuls: { rows: number; data: Uint8Array }[] = [];
  const beats: { mode: string; columns: number; levelDb: number; signal: boolean }[] = [];
  let text = "";
  let windows = 0;
  p.on("hell", (e) => handfuls.push(e));
  p.on("stream", (s) => beats.push(s as (typeof beats)[number]));
  p.on("text", (t) => (text += t.text));
  p.on("window", () => windows++);
  p.on("error", (e) => console.log("  pipeline error:", e.message));

  console.log("entering the stream");
  ok(isStreamMode("HELL"), "HELL is a stream mode");
  ok(NO_SEQUENCER_MODES.has("HELL"), "with no sequencer: an automatic mode stops on landing there");
  p.setStream({ mode: "HELL", centreHz: 1000 });
  ok(p.streaming === "HELL", "setStream(HELL) is reported");
  ok(!p.windowsArmed, "and the window timer is not armed");

  console.log("\naudio in, columns out");
  const w = hellWaveform("CQ CQ DE K9XYZ K9XYZ K", { sampleRate: RATE, centreHz: 1000, amplitude: 0.4 });
  push(p, new Float32Array(RATE));
  push(p, w);
  push(p, new Float32Array(RATE));
  const total = handfuls.reduce((n, h) => n + h.data.length / h.rows, 0);
  const seconds = (w.length + 2 * RATE) / RATE;
  ok(handfuls.every((h) => h.rows === HELL_RX_ROWS && h.data.length % HELL_RX_ROWS === 0), `in whole columns of ${HELL_RX_ROWS} rows`);
  ok(Math.abs(total - seconds * HELL_COLUMN_RATE) <= 4, `17.5 columns a second (${total} in ${seconds.toFixed(1)} s)`);
  ok(handfuls.every((h) => h.data.length / h.rows >= 4), "in handfuls of four or more, not one per packet");
  const ink = handfuls.flatMap((h) => [...h.data]).filter((v) => v > 200).length;
  ok(ink > 500, `the text paints ink (${ink} dark rows)`);
  ok(text === "", "and prints no text: nothing is decoded");
  ok(beats.length >= Math.floor(seconds) - 1 && beats.every((b) => b.mode === "HELL"), "one heartbeat a second, naming the mode", beats.length);
  ok(beats.some((b) => b.signal), "a heartbeat during the signal says there is one", beats.map((b) => b.levelDb.toFixed(0)).join(" "));
  ok(windows === 0, "no window event during the stream");

  console.log("\nretuning");
  const before = beats[beats.length - 1]!.columns;
  p.setStream({ mode: "HELL", centreHz: 1000 });
  push(p, new Float32Array(RATE));
  ok(beats[beats.length - 1]!.columns > before, "the same settings again keep the receiver: its count carries on");
  p.setStream({ mode: "HELL", centreHz: 1500 });
  const again = beats[beats.length - 1]!.columns;
  push(p, new Float32Array(RATE));
  ok(beats[beats.length - 1]!.columns > again, "a retune keeps it too");
  handfuls.length = 0;
  push(p, hellWaveform("RETUNED", { sampleRate: RATE, centreHz: 1500, amplitude: 0.4 }));
  push(p, new Float32Array(RATE / 2));
  ok(handfuls.flatMap((h) => [...h.data]).filter((v) => v > 200).length > 100, "and paints a signal at the new carrier");

  console.log("\nleaving");
  p.setStream(null);
  ok(p.streaming === null && p.windowsArmed, "back to windows");
  p.stop();

  console.log("\nwhere Hell is");
  ok(inferDigitalMode(14_062_000).mode === "HELL", "a 14.062 dial is Hell: the club's 14.063 at 1000 Hz");
  ok(inferDigitalMode(14_070_000).mode !== "HELL" && inferDigitalMode(7_080_000).mode === "RTTY", "and its neighbours keep their own modes");

  console.log("\nsending");
  const off = new FlexDaxTransmitter({ host: "0.0.0.0", allowTransmit: false });
  const r1 = await off.transmitText({ mode: "HELL", text: "CQ DE K9XYZ", centreHz: 1000, shiftHz: 0, sideband: "USB" });
  ok(!r1.sent && /disabled/i.test(r1.reason ?? ""), "transmit off: refused", r1.reason);
  const on = new FlexDaxTransmitter({ host: "0.0.0.0", allowTransmit: true });
  const r2 = await on.transmitText({ mode: "HELL", text: "X".repeat(120), centreHz: 1000, shiftHz: 0, sideband: "USB" });
  ok(!r2.sent && /over the 40 s cap/.test(r2.reason ?? ""), "120 characters is 48 s: refused before anything keys", r2.reason);
  const wave = on.buildTextWaveform({ mode: "HELL", text: "CQ", centreHz: 1200, shiftHz: 0, sideband: "USB" });
  ok(Math.abs(wave.length / RATE - 1.6) < 0.01, "a line is built at the DAX rate: CQ is 1.6 s");
  ok(!on.isKeyed && !on.isBusy, "and nothing was keyed or left busy");

  console.log("");
  if (failed > 0) {
    console.log(`${failed} FAILED`);
    process.exit(1);
  }
  console.log("all Hell pipeline assertions passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
