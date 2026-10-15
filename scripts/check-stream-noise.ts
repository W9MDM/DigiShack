/* eslint-disable no-console */
// The stream decoders on noise, and on weak signals, measured together: a change that
// quietens one must not cost the other. The noise kinds are an independent review's
// (white, band-limited HF, narrow, a fading carrier), 40 s each at 12, 24 and 48 kHz.
// RTTY printed 24 characters across them before 1.201.7's acquisition rule and prints
// none now; its word copy on weak signals is the same or better at every level.
// Run: npm run check:stream-noise
import { CwDemodulator } from "@/lib/digital/cwdemod";
import { rttyWaveform } from "@/lib/digital/rtty";
import { RttyDemodulator } from "@/lib/digital/rttydemod";

let failed = 0;
function ok(cond: boolean, what: string, extra?: unknown): void {
  if (cond) console.log(`  ok    ${what}`);
  else {
    failed++;
    console.log(`  FAIL  ${what}`, extra ?? "");
  }
}

function random(seed: number): () => number {
  let s = seed;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s + 0.5) / 4294967296;
  };
}

function noise(fs: number, seconds: number, kind: string, seed: number): Float32Array {
  const rnd = random(seed);
  const out = new Float32Array(fs * seconds);
  let lo = 0, hi = 0, ni = 0, nq = 0;
  const a = 1 - Math.exp((-2 * Math.PI * 3000) / fs);
  const b = 1 - Math.exp((-2 * Math.PI * 300) / fs);
  const narrow = 1 - Math.exp((-2 * Math.PI * 12) / fs);
  for (let i = 0; i < out.length; i++) {
    const n = Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());
    lo += a * (n - lo);
    hi += b * (lo - hi);
    ni += narrow * (n - ni);
    nq += narrow * ((rnd() - 0.5) * 3.46 - nq);
    const ph = (2 * Math.PI * 1000 * i) / fs;
    out[i] =
      kind === "white" ? 0.05 * n
      : kind === "hf-noise" ? 0.05 * (lo - hi)
      : kind === "narrow-noise" ? 0.3 * (ni * Math.cos(ph) - nq * Math.sin(ph))
      : 0.01 * (lo - hi) + 0.05 * Math.sin(ph) * (0.5 + 0.5 * Math.sin((2 * Math.PI * 0.7 * i) / fs));
  }
  return out;
}

console.log("noise alone");
let rtty = 0;
let cw = 0;
for (const fs of [12_000, 24_000, 48_000]) {
  for (const kind of ["white", "hf-noise", "narrow-noise", "fading-carrier"]) {
    const a = noise(fs, 40, kind, 99);
    const r = new RttyDemodulator({ sampleRate: fs, markHz: 2295, spaceHz: 2125 });
    const c = new CwDemodulator({ sampleRate: fs, pitchHz: 600 });
    for (let i = 0; i < a.length; i += 128) {
      rtty += r.feed(a.subarray(i, i + 128)).trim().length;
      cw += c.feed(a.subarray(i, i + 128)).trim().length;
    }
  }
}
ok(rtty <= 2, `RTTY prints next to nothing on eight minutes of noise (${rtty} characters; 24 before acquisition)`);
ok(cw <= 10, `CW stays where it was (${cw} characters; the review measured 14 with spacing)`);

console.log("\nweak RTTY still copies");
const LINE = "CQ CQ CQ DE W1AW W1AW W1AW PSE K ";
const fs = 24_000;
const clean = rttyWaveform(LINE.repeat(4), { sampleRate: fs, centreHz: 2210, preambleMs: 1500 });
let p = 0;
for (const v of clean) p += v * v;
p /= clean.length;
for (const [snr, want] of [[0, 108], [-3, 105], [-6, 60]] as const) {
  let right = 0;
  for (const seed of [1, 2, 3]) {
    const sigma = Math.sqrt((p / 10 ** (snr / 10)) * (fs / 2 / 2500));
    const rnd = random(seed * 977 + snr);
    const w = clean.map((v) => v + sigma * Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd()));
    const r = new RttyDemodulator({ sampleRate: fs, markHz: 2295, spaceHz: 2125 });
    let t = "";
    for (let i = 0; i < w.length; i += 128) t += r.feed(w.subarray(i, i + 128));
    const got = t.trim().split(/\s+/);
    for (const wd of LINE.repeat(4).trim().split(/\s+/)) {
      const k = got.indexOf(wd);
      if (k >= 0) {
        right++;
        got.splice(k, 1);
      }
    }
  }
  ok(right >= want, `at ${snr} dB in 2.5 kHz, ${right} of 108 words (at least ${want})`);
}

console.log("");
if (failed > 0) {
  console.log(`${failed} FAILED`);
  process.exit(1);
}
console.log("all stream-noise assertions passed");
