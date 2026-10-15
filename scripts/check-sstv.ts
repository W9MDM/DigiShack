/* eslint-disable no-console */
// SSTV: the VIS header, and a test card through every mode and back - clean at both radios'
// rates, in noise, and with the sending sound card's clock off by 0.1% - plus noise alone,
// which must start no picture.
// Run: npm run check:sstv
import {
  SSTV_MODES,
  SstvDecoder,
  sstvImageSeconds,
  sstvModeByVis,
  sstvTestCard,
  sstvVisSegments,
  sstvWaveform,
  type SstvImage,
  type SstvMode,
} from "@/lib/digital/sstv";

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

function addNoise(w: Float32Array, snrDb: number, fs: number, seed = 3): Float32Array {
  let p = 0;
  for (const v of w) p += v * v;
  p /= w.length;
  const sigma = Math.sqrt((p / 10 ** (snrDb / 10)) * (fs / 2 / 2500));
  const rnd = random(seed);
  return w.map((v) => v + sigma * Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd()));
}

/** Mean absolute error per channel, 0..255, over the picture, ignoring the outer 4% each side. */
function error(a: SstvImage, b: SstvImage): number {
  let s = 0;
  let n = 0;
  const mx = Math.round(a.width * 0.04);
  for (let y = 0; y < a.height; y++) {
    for (let x = mx; x < a.width - mx; x++) {
      for (let c = 0; c < 3; c++) {
        const i = (y * a.width + x) * 3 + c;
        s += Math.abs(a.rgb[i]! - b.rgb[i]!);
        n++;
      }
    }
  }
  return s / n;
}

/** How many colour bars come out nearer their own colour than any other bar's, averaged over the bar. */
function barsRecognised(a: SstvImage, b: SstvImage): number {
  const mean = (img: SstvImage, bar: number): number[] => {
    const x0 = Math.round((bar + 0.15) * (img.width / 8));
    const x1 = Math.round((bar + 0.85) * (img.width / 8));
    const y0 = Math.round(img.height * 0.05);
    const y1 = Math.round(img.height * 0.55);
    const out = [0, 0, 0];
    let n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        for (let c = 0; c < 3; c++) out[c]! += img.rgb[(y * img.width + x) * 3 + c]!;
        n++;
      }
    }
    return out.map((v) => v / n);
  };
  const truth = Array.from({ length: 8 }, (_, k) => mean(a, k));
  let right = 0;
  for (let k = 0; k < 8; k++) {
    const got = mean(b, k);
    let best = -1;
    let bestD = Infinity;
    for (let t = 0; t < 8; t++) {
      const d = truth[t]!.reduce((acc, v, c) => acc + (v - got[c]!) ** 2, 0);
      if (d < bestD) {
        bestD = d;
        best = t;
      }
    }
    if (best === k) right++;
  }
  return right;
}

function decode(mode: SstvMode, wave: Float32Array, fs: number): { img: SstvImage | null; started: string | null; rowsSeen: number } {
  let img: SstvImage | null = null;
  let started: string | null = null;
  let rowsSeen = 0;
  const d = new SstvDecoder(fs, {
    onStart: (m) => (started = m.name),
    onRows: (_i, a, b) => (rowsSeen += b - a),
    onImage: (i) => (img = i),
  });
  for (let i = 0; i < wave.length; i += 256) d.feed(wave.subarray(i, i + 256));
  return { img, started, rowsSeen };
}

console.log("the VIS header");
{
  const seg = sstvVisSegments(44);
  ok(seg.length === 13, "leader, break, leader, start, seven bits and parity, stop");
  ok(sstvModeByVis(44)?.name === "Martin 1" && sstvModeByVis(60)?.name === "Scottie 1" && sstvModeByVis(8)?.name === "Robot 36", "the codes name the modes");
  ok(Math.abs(sstvImageSeconds(sstvModeByVis(44)!) - 114.3) < 0.2, `Martin 1 is about 114 s (${sstvImageSeconds(sstvModeByVis(44)!).toFixed(1)})`);
  ok(Math.abs(sstvImageSeconds(sstvModeByVis(95)!) - 126.1) < 0.2, `PD 120 is about 126 s (${sstvImageSeconds(sstvModeByVis(95)!).toFixed(1)})`);
}

const fs24 = 24_000;
console.log("\nevery mode, clean, at the FlexRadio's 24 kHz");
for (const mode of SSTV_MODES) {
  const card = sstvTestCard(mode.width, mode.height);
  const r = decode(mode, sstvWaveform(mode, card, { sampleRate: fs24 }), fs24);
  ok(r.started === mode.name, `${mode.name}: the VIS names it`, r.started);
  const e = r.img ? error(card, r.img) : 999;
  ok(r.img !== null && e < 12, `${mode.name}: the picture comes back (mean error ${e.toFixed(1)} of 255)`);
  ok(r.rowsSeen === mode.height, `${mode.name}: every row is reported as it is decoded (${r.rowsSeen})`);
}

console.log("\nthe Icom's 48 kHz, noise, and a sound card 0.1% slow");
{
  const mode = sstvModeByVis(44)!; // Martin 1
  const card = sstvTestCard(mode.width, mode.height);
  const r48 = decode(mode, sstvWaveform(mode, card, { sampleRate: 48_000 }), 48_000);
  ok(r48.img !== null && error(card, r48.img) < 12, `Martin 1 at 48 kHz (${r48.img ? error(card, r48.img).toFixed(1) : "none"})`);
  {
    const w = addNoise(sstvWaveform(mode, card, { sampleRate: fs24 }), 10, fs24);
    const r = decode(mode, w, fs24);
    const e = r.img ? error(card, r.img) : 999;
    ok(r.img !== null && e < 20, `Martin 1 at 10 dB in 2.5 kHz: a clean picture (${e.toFixed(1)})`);
  }
  {
    // 3 dB is snow, as on any decoder: the test is that the VIS is still heard and the
    // picture underneath is the right one - each colour bar the right colour once the snow
    // is averaged over the bar.
    const w = addNoise(sstvWaveform(mode, card, { sampleRate: fs24 }), 3, fs24);
    const r = decode(mode, w, fs24);
    ok(r.started === "Martin 1", "Martin 1 at 3 dB: the VIS is still heard");
    // Noise pulls a discriminator toward the middle of its band, so black reads dark grey
    // and white light grey - washed out, as on every decoder. Recognisable is the test: each
    // bar's average colour is nearer its own true colour than any other bar's.
    const right = r.img ? barsRecognised(card, r.img) : 0;
    ok(right === 8, `and all eight colour bars are recognisably their colour (${right} of 8)`);
  }
  const skew = decode(mode, sstvWaveform(mode, card, { sampleRate: fs24, clockError: 0.001 }), fs24);
  ok(skew.img !== null && error(card, skew.img) < 15, `Martin 1 sent 0.1% slow: the sync tracking holds it (${skew.img ? error(card, skew.img).toFixed(1) : "none"})`);
  const s1 = sstvModeByVis(60)!;
  const s1card = sstvTestCard(s1.width, s1.height);
  const s1skew = decode(s1, sstvWaveform(s1, s1card, { sampleRate: fs24, clockError: -0.001 }), fs24);
  ok(s1skew.img !== null && error(s1card, s1skew.img) < 15, `Scottie 1 sent 0.1% fast (${s1skew.img ? error(s1card, s1skew.img).toFixed(1) : "none"})`);
}

console.log("\nnoise alone starts nothing");
{
  const rnd = random(7);
  const w = new Float32Array(fs24 * 60);
  for (let i = 0; i < w.length; i++) w[i] = 0.3 * Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());
  let started = 0;
  const d = new SstvDecoder(fs24, { onStart: () => started++ });
  for (let i = 0; i < w.length; i += 256) d.feed(w.subarray(i, i + 256));
  ok(started === 0, `a minute of noise starts no picture (${started})`);
}

console.log("");
if (failed > 0) {
  console.log(`${failed} FAILED`);
  process.exit(1);
}
console.log("all SSTV assertions passed");
