/* eslint-disable no-console */
// The stream decoders against the bridge's habit of re-sending their settings.
//
// The bridge applies the active stream's settings on every slice update, whether or not
// anything changed. Until 1.201.6 the pipeline treated each one as a retune: Olivia and
// Contestia lost their sync every time, so a signal that decodes cleanly decoded NOTHING
// with the settings re-sent every two seconds; PSK31 lost its AFC and read
// "C DE 1W1WQ CD1A" for "CQ CQ DE W1AW W1AW CQ CQ DE W1AW K"; and a squelch or threshold
// change was dropped because the early return compared only the speed. Found by an
// independent review (DIGITAL-MODE-REVIEW-FOR-CLAUDE.md) and fixed by its patch.
// Run: npm run check:stream-settings
import { oliviaParams, oliviaSymbols, oliviaWaveform } from "@/lib/digital/olivia";
import { psk31Waveform } from "@/lib/digital/psk31";
import { DecodePipeline, type StreamOptions } from "@/lib/radio/decode-pipeline";

let failed = 0;
function ok(cond: boolean, what: string, extra?: unknown): void {
  if (cond) console.log(`  ok    ${what}`);
  else {
    failed++;
    console.log(`  FAIL  ${what}`, extra ?? "");
  }
}

const fs = 24_000;
function decode(wave: Float32Array, opts: StreamOptions, resendEvery: number | null): string {
  const p = new DecodePipeline({ mode: "FT8", inputSampleRate: fs });
  let text = "";
  p.on("text", (t) => (text += t.text));
  p.setStream(opts);
  for (let i = 0; i < wave.length; i += 128) {
    if (resendEvery && i % (fs * resendEvery) === 0) p.setStream({ ...opts });
    p.push(wave.subarray(i, i + 128));
  }
  p.stop();
  return text;
}

console.log("re-sending unchanged settings keeps the decoder's state");
for (const code of ["olivia", "contestia"] as const) {
  const size = { tones: 16, bandwidth: 500, code } as const;
  const w = oliviaWaveform(oliviaSymbols("CQ CQ de W1AW pse k", { ...size, preambleBlocks: 3 }), { ...size, sampleRate: fs, centreHz: 1500 });
  const audio = new Float32Array(w.length + Math.ceil(fs * 8 * oliviaParams(size).blockSeconds));
  audio.set(w);
  const opts: StreamOptions = { mode: "OLIVIA", ...size, centreHz: 1500 };
  const once = decode(audio, opts, null);
  ok(once.length > 10, `${code}: the line decodes`, once);
  ok(decode(audio, opts, 2) === once, `${code}: and the same with the settings re-sent every two seconds`);
}
{
  const w = psk31Waveform("CQ CQ DE W1AW W1AW CQ CQ DE W1AW K", { sampleRate: fs, centreHz: 1006, preambleSymbols: 96 });
  const opts: StreamOptions = { mode: "PSK31", centreHz: 1000 };
  const once = decode(w, opts, null);
  ok(once.includes("CQ CQ DE W1AW"), "PSK31 6 Hz off: the AFC pulls it in", once);
  ok(decode(w, opts, 2) === once, "and the same with the settings re-sent every two seconds");
}

console.log("\na changed threshold takes effect");
const cases: [StreamOptions, StreamOptions, number][] = [
  [{ mode: "RTTY", markHz: 2295, spaceHz: 2125, squelch: 0.7 }, { mode: "RTTY", markHz: 2295, spaceHz: 2125, squelch: 1 }, 1],
  [{ mode: "PSK31", centreHz: 1000, squelch: 0.5 }, { mode: "PSK31", centreHz: 1000, squelch: 1 }, 1],
  [{ mode: "CW", pitchHz: 600, thresholdDb: 16 }, { mode: "CW", pitchHz: 600, thresholdDb: 30 }, 10 ** (30 / 20)],
  [{ mode: "OLIVIA", centreHz: 1500, tones: 16, bandwidth: 500, syncThreshold: 4 }, { mode: "OLIVIA", centreHz: 1500, tones: 16, bandwidth: 500, syncThreshold: 8 }, 8],
];
for (const [before, after, want] of cases) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p: any = new DecodePipeline({ mode: "FT8", inputSampleRate: fs });
  p.setStream(before);
  p.setStream(after);
  const d = p.rtty ?? p.psk ?? p.cw ?? p.olivia;
  const got = d.squelch ?? d.threshold;
  ok(Math.abs(got - want) < 1e-6, `${after.mode}: the new value is in force`, `got ${got}, want ${want}`);
  p.stop();
}

console.log("");
if (failed > 0) {
  console.log(`${failed} FAILED`);
  process.exit(1);
}
console.log("all stream-settings assertions passed");
