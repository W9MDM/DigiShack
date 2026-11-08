/* eslint-disable no-console */
// RSID, fldigi's mode identifier: the code, the burst, and the receiver finding it at the
// right frequency at every rate the radios deliver, under noise, and not on noise alone.
// Run: npm run check:rsid

import {
  RSID_DURATION_MS,
  RSID_TABLE,
  RSID_TABLE2,
  RsidDetector,
  rsidCodeFor,
  rsidEncode,
  rsidWaveform,
  type RsidHeard,
} from "@/lib/digital/rsid";
import { DecodePipeline } from "@/lib/radio/decode-pipeline";
import { maxTextMs, textRsidCode, textWaveform, type TextTransmitRequest } from "@/lib/radio/text-waveform";

let failed = 0;
let passed = 0;
function ok(cond: boolean, label: string, detail: unknown = ""): void {
  if (cond) {
    passed++;
    console.log(`  ok    ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail !== "" ? ` - ${String(detail)}` : ""}`);
  }
}

function gaussian(seed: number): () => number {
  let s = seed >>> 0;
  const u = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s + 0.5) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}

function listen(rate: number, audio: Float32Array, chunk = 480): RsidHeard[] {
  const heard: RsidHeard[] = [];
  const d = new RsidDetector(rate, (h) => heard.push(h));
  for (let i = 0; i < audio.length; i += chunk) d.feed(audio.subarray(i, Math.min(audio.length, i + chunk)));
  return heard;
}

function withSilence(rate: number, ...parts: Float32Array[]): Float32Array {
  const pad = new Float32Array(Math.round(rate * 0.5));
  const all = [pad, ...parts, pad];
  const out = new Float32Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

console.log("the code");
{
  const words = RSID_TABLE.map((e) => rsidEncode(e.code));
  ok(words.every((w) => w.length === 15 && w.every((t) => t >= 0 && t < 16)), "every mode is fifteen tones of sixteen");
  let minDist = 15;
  for (let a = 0; a < words.length; a++) {
    for (let b = a + 1; b < words.length; b++) {
      let d = 0;
      for (let s = 0; s < 15; s++) if (words[a]![s] !== words[b]![s]) d++;
      minDist = Math.min(minDist, d);
    }
  }
  // A Reed-Solomon (15,3) code: any two words differ in at least 13 symbols, so reading
  // one symbol wrong still leaves the right word nearest by far.
  ok(minDist >= 13, `any two modes differ in at least 13 of the 15 tones (${minDist})`);
  const codes = new Set([...RSID_TABLE, ...RSID_TABLE2].map((e) => e.code));
  ok(codes.size === RSID_TABLE.length + RSID_TABLE2.length, "no code is listed twice");
  ok(rsidCodeFor({ mode: "PSK31", speed: 31 }) === 1, "BPSK31 is code 1");
  ok(rsidCodeFor({ mode: "PSK31", speed: 125 }) === 4, "BPSK125 is code 4");
  ok(rsidCodeFor({ mode: "OLIVIA", code: "olivia", tones: 8, bandwidth: 250 }) === 69, "Olivia 8/250 is 69");
  ok(rsidCodeFor({ mode: "OLIVIA", code: "contestia", tones: 16, bandwidth: 500 }) === 50, "Contestia 16/500 is 50");
  ok(rsidCodeFor({ mode: "HELL", variant: "feld" }) === 104, "Feld Hell is 104");
  ok(rsidCodeFor({ mode: "HELL", variant: "fm105" }) === 107, "FM Hell-105 is 107");
  ok(rsidCodeFor({ mode: "HELL", variant: "psk" }) === null, "our PSK Hell has none: fldigi's code 105 is a different mode");
  ok(rsidCodeFor({ mode: "HELL", variant: "slow" }) === null, "nor Slow Hell");
  ok(rsidCodeFor({ mode: "RTTY", baud: 45.45, shiftHz: 170 }) === 39, "RTTY 45.45/170 is 39");
  ok(rsidCodeFor({ mode: "RTTY", baud: 45.45, shiftHz: 200 }) === null, "an RTTY shift fldigi has no code for has none");
}

console.log("\nthe burst on the air");
{
  const w = rsidWaveform(1, { sampleRate: 24_000, centreHz: 1000 });
  ok(Math.abs((w.length / 24_000) * 1000 - RSID_DURATION_MS) < 2, `25 symbols long, ${RSID_DURATION_MS.toFixed(0)} ms`);
  const sym = Math.floor((1024 / 11025) * 24_000);
  ok(w.subarray(0, sym * 5).every((x) => x === 0) && w.subarray(sym * 20).every((x) => x === 0), "five symbols of silence either side");
  let peak = 0;
  for (const x of w) peak = Math.max(peak, Math.abs(x));
  ok(peak <= 1 && peak > 0.99, "full scale, no more");
}

console.log("\nheard where it was sent");
for (const rate of [12_000, 24_000, 48_000]) {
  for (const [code, centre] of [[1, 1000], [69, 1500], [104, 800], [107, 2200], [50, 600]] as const) {
    const heard = listen(rate, withSilence(rate, rsidWaveform(code, { sampleRate: rate, centreHz: centre })));
    const h = heard[0];
    ok(
      heard.length === 1 && h?.code === code && Math.abs(h.hz - centre) <= 3,
      `${rate / 1000} kHz: ${RSID_TABLE.find((e) => e.code === code)?.name} at ${centre} Hz is heard once, at ${h?.hz ?? "-"} Hz`,
      JSON.stringify(heard),
    );
  }
}
{
  const heard = listen(24_000, withSilence(24_000, rsidWaveform(69, { sampleRate: 24_000, centreHz: 1500 })));
  const m = heard[0]?.mode;
  ok(m?.mode === "OLIVIA" && m.tones === 8 && m.bandwidth === 250 && m.code === "olivia", "and says which of our modes it is: Olivia 8/250");
}

console.log("\nthrough noise, beside another signal, and not on noise alone");
{
  const rate = 24_000;
  const w = withSilence(rate, rsidWaveform(72, { sampleRate: rate, centreHz: 1400, amplitude: 0.3 }));
  const g = gaussian(7);
  // Noise of 0.3 per sample across 12 kHz is about -16 dB in a 10 Hz tone's bin of 5 Hz: a
  // weak but copyable signal, as fldigi's RxID is.
  for (let i = 0; i < w.length; i++) w[i] = w[i]! + 0.3 * g();
  for (let i = 0; i < w.length; i++) w[i] = w[i]! + 0.3 * Math.sin((2 * Math.PI * 700 * i) / rate);
  const heard = listen(rate, w);
  ok(heard.length === 1 && heard[0]!.code === 72 && Math.abs(heard[0]!.hz - 1400) <= 3, "Olivia 8/500 under noise and beside a carrier is still read", JSON.stringify(heard));

  const quiet = new Float32Array(rate * 120);
  const g2 = gaussian(11);
  for (let i = 0; i < quiet.length; i++) quiet[i] = 0.3 * g2();
  const none = listen(rate, quiet, 2400);
  ok(none.length === 0, `two minutes of noise names no mode (${none.map((h) => h.name).join(", ")})`);
}

console.log("\nthe second table, after ESCAPE");
{
  const rate = 24_000;
  const esc = rsidWaveform(6, { sampleRate: rate, centreHz: 1200 });
  const second = rsidWaveform(620, { sampleRate: rate, centreHz: 1200 });
  // fldigi sends the second word ten symbols after the first: our waveforms carry five of
  // silence at each end, so they join with ten between them.
  const heard = listen(rate, withSilence(rate, esc.subarray(0, esc.length), second));
  ok(heard.length === 1 && heard[0]!.name === "MFSK64" && heard[0]!.mode === undefined, "ESCAPE then MFSK64 is heard as MFSK64, a mode we do not have yet", JSON.stringify(heard));
}

console.log("\nsent before a line");
{
  const rate = 24_000;
  const psk: TextTransmitRequest = { mode: "PSK31", text: "CQ de KC9QRS K", centreHz: 1200, shiftHz: 0, sideband: "USB" };
  const plain = textWaveform(psk, rate);
  const withId = textWaveform({ ...psk, rsid: true }, rate);
  const idLen = Math.floor((1024 / 11025) * rate) * 25;
  ok(withId.length === plain.length + idLen, "with RSID on, the line is the RSID then the same line");
  ok(textRsidCode({ ...psk, rsid: true }) === 1 && textRsidCode(psk) === null, "PSK31 sends code 1, and nothing when RSID is off");
  ok(Math.abs(maxTextMs({ ...psk, rsid: true }) - maxTextMs(psk) - RSID_DURATION_MS) < 1e-6, "the cap grows by the RSID's 2.3 s, so it never cuts the line short");
  ok(textRsidCode({ mode: "CW", rsid: true }) === null && textRsidCode({ mode: "JTTY", rsid: true }) === null, "CW and JTTY send none");
  ok(textRsidCode({ mode: "HELL", hellVariant: "psk", rsid: true }) === null, "nor our PSK Hell, which fldigi cannot copy");
  ok(textRsidCode({ mode: "OLIVIA", tones: 8, bandwidth: 250, code: "olivia", rsid: true }) === 69, "Olivia 8/250 sends 69");

  // Through the pipeline a receiving DigiShack runs: the RSID is heard where the line is,
  // and the line still prints after it.
  const pipe = new DecodePipeline({ mode: "FT8", inputSampleRate: rate });
  const heard: RsidHeard[] = [];
  let text = "";
  pipe.on("rsid", (h) => heard.push(h));
  pipe.on("text", (t) => (text += t.text));
  pipe.on("error", () => {});
  pipe.setStream({ mode: "PSK31", centreHz: 1200 });
  for (let i = 0; i < withId.length; i += 256) pipe.push(withId.subarray(i, Math.min(withId.length, i + 256)));
  pipe.push(new Float32Array(rate));
  ok(heard.length === 1 && heard[0]!.name === "BPSK31" && Math.abs(heard[0]!.hz - 1200) <= 3, `a receiving pipeline hears BPSK31 at 1200 Hz (${heard.map((h) => h.name + "@" + h.hz).join(", ")})`);
  ok(text.includes("CQ de KC9QRS K"), `and the line prints after it (${JSON.stringify(text)})`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
