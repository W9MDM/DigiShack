/* eslint-disable no-console */
// The stream branch of the decode pipeline on JTTY: audio at the FlexRadio's 24 kHz in
// DAX-packet pieces comes out as one line of text per message and a `jtty` event with the
// station's frequency, a heartbeat each second, and no window events; the same settings
// again keep the receiver. Plus where JTTY is on the bands, and the transmitter: a line
// built at the DAX rate, never keyed with transmit off.
// Run: npm run check:jtty-pipeline

import { JTTY_FRAME_MS, jttyWaveform } from "@/lib/digital/jtty";
import { FlexDaxTransmitter } from "@/lib/flex/tx";
import { callingFrequencyFor, inferDigitalMode } from "@/lib/ham/digital-freqs";
import { NO_SEQUENCER_MODES } from "@/lib/radio/automation-gate";
import { DecodePipeline, isStreamMode } from "@/lib/radio/decode-pipeline";

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
  let text = "";
  const msgs: { hz: number; text: string; complete: boolean }[] = [];
  const beats: { mode: string; frames: number; messages: number }[] = [];
  let windows = 0;
  p.on("text", (t) => (text += t.text));
  p.on("jtty", (m) => msgs.push(m));
  p.on("stream", (s) => beats.push(s as (typeof beats)[number]));
  p.on("window", () => windows++);
  p.on("error", (e) => console.log("  pipeline error:", e.message));

  console.log("entering the stream");
  ok(isStreamMode("JTTY"), "JTTY is a stream mode: no time slots");
  ok(NO_SEQUENCER_MODES.has("JTTY"), "with no sequencer: an automatic mode stops on landing there");
  p.setStream({ mode: "JTTY" });
  ok(p.streaming === "JTTY" && !p.windowsArmed, "streaming, no window timer");

  console.log("\naudio in, messages out");
  push(p, new Float32Array(RATE));
  push(p, jttyWaveform("CQ K1ABC CQ", { sampleRate: RATE, baseHz: 1210, amplitude: 0.2 }));
  push(p, new Float32Array(RATE / 2));
  push(p, jttyWaveform("K9XYZ 599 042", { sampleRate: RATE, baseHz: 1210, amplitude: 0.2 }));
  push(p, new Float32Array(RATE * 2));
  ok(/1210 Hz .* CQ K1ABC CQ\n/.test(text) && /1210 Hz .* K9XYZ 599 042\n/.test(text), "a line per message, with the station's frequency", text);
  ok(msgs.length === 2 && msgs.every((m) => m.complete && Math.abs(m.hz - 1210) <= 2), "and a jtty event for each, ended by its last frame", msgs);
  ok(beats.length >= 7 && beats.every((b) => b.mode === "JTTY"), "a heartbeat a second, naming the mode");
  // 599 042 keeps its leading zero only as text: K9XYZ, 599, then 042 - three frames.
  ok(beats[beats.length - 1]!.frames === 4 && beats[beats.length - 1]!.messages === 2, "counting four frames (one, then three) and two messages", beats[beats.length - 1]);
  ok(windows === 0, "no window event during the stream");
  p.setStream({ mode: "JTTY" });
  push(p, new Float32Array(RATE));
  ok(beats[beats.length - 1]!.frames === 4, "the same settings again keep the receiver");
  p.setStream(null);
  ok(p.streaming === null && p.windowsArmed, "leaving goes back to windows");
  p.stop();

  console.log("\nwhere JTTY is");
  ok(callingFrequencyFor("20M", "JTTY", 2) === 14_090_000, "20 m is 14.090, as WSJT-X lists it");
  ok(inferDigitalMode(14_090_000).mode === "JTTY" && inferDigitalMode(21_090_000).mode === "JTTY", "14.090 and 21.090 dials read as JTTY");
  ok(inferDigitalMode(7_078_000).mode === "JS8", "7.078, shared with JS8, reads as JS8 until the JTTY chip is pressed");

  console.log("\nsending");
  const off = new FlexDaxTransmitter({ host: "0.0.0.0", allowTransmit: false });
  const r1 = await off.transmitText({ mode: "JTTY", text: "CQ K9XYZ CQ", centreHz: 1500, shiftHz: 0, sideband: "USB" });
  ok(!r1.sent && /disabled/i.test(r1.reason ?? ""), "transmit off: refused", r1.reason);
  const on = new FlexDaxTransmitter({ host: "0.0.0.0", allowTransmit: true });
  const wave = on.buildTextWaveform({ mode: "JTTY", text: "CQ K9XYZ CQ", centreHz: 1500, shiftHz: 0, sideband: "USB" });
  ok(Math.abs(wave.length / RATE - JTTY_FRAME_MS / 1000) < 1e-6, "CQ K9XYZ CQ is one 1.888 s frame at the DAX rate");
  const long = on.buildTextWaveform({ mode: "JTTY", text: "X".repeat(80), centreHz: 1500, shiftHz: 0, sideband: "USB" });
  ok(Math.abs(long.length / RATE - (16 * JTTY_FRAME_MS) / 1000) < 1e-6, "80 characters is sixteen frames, 30 s: under the cap");
  ok(!on.isKeyed && !on.isBusy, "and nothing was keyed");

  console.log("");
  if (failed > 0) {
    console.log(`${failed} FAILED`);
    process.exit(1);
  }
  console.log("all JTTY pipeline assertions passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
