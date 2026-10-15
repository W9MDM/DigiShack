/* eslint-disable no-console */
// RTTY off the standard settings: a station at 50, 75 or 100 baud, or sending reversed,
// reads back only when the decoder is set to match - and reads as junk when it is not,
// which is what the operator saw on 14.085 before the panel had Rev and a speed picker.
import { rttyTones, rttyWaveform } from "@/lib/digital/rtty";
import { DecodePipeline } from "@/lib/radio/decode-pipeline";

let failed = 0;
function ok(cond: boolean, what: string, extra?: unknown): void {
  if (cond) console.log(`  ok    ${what}`);
  else {
    failed++;
    console.log(`  FAIL  ${what}`, extra ?? "");
  }
}

const RATE = 24_000;
const TEXT = "CQ CQ DE W1AW W1AW K";
function run(opts: { baud?: number; reverse?: boolean }, sig: { baud?: number; sideband?: "USB" | "LSB" }): string {
  const p = new DecodePipeline({ mode: "FT8", inputSampleRate: RATE });
  let text = "";
  p.on("text", (t) => (text += t.text));
  const t = rttyTones(1000, 170, "USB");
  const tones = opts.reverse ? { markHz: t.spaceHz, spaceHz: t.markHz } : t;
  p.setStream({ mode: "RTTY", ...tones, baud: opts.baud });
  const w = rttyWaveform(TEXT, { sampleRate: RATE, centreHz: 1000, baud: sig.baud, sideband: sig.sideband ?? "USB" });
  for (let i = 0; i < w.length; i += 256) p.push(w.subarray(i, Math.min(w.length, i + 256)));
  p.push(new Float32Array(RATE));
  p.stop();
  return text;
}

console.log("speed");
for (const baud of [50, 75, 100]) {
  ok(run({ baud }, { baud }).includes(TEXT), `${baud} baud reads at ${baud}`);
  ok(!run({}, { baud }).includes(TEXT), `and does not at the default 45.45`);
}
console.log("\nreverse");
ok(run({ reverse: true }, { sideband: "LSB" }).includes(TEXT), "a reversed station reads with Rev on");
ok(!run({}, { sideband: "LSB" }).includes(TEXT), "and not with it off");
ok(run({}, {}).includes(TEXT), "a normal station still reads with Rev off");

console.log("");
if (failed > 0) {
  console.log(`${failed} FAILED`);
  process.exit(1);
}
console.log("all RTTY variant assertions passed");
