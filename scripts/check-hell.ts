/* eslint-disable no-console */
// Feld Hell: the font, the timing, the keyed carrier and its width, and the receiver on
// generated signals - clean, off frequency, in noise, chunked, at both radios' rates - and
// on noise alone, where the page must stay grey rather than paint a signal.
// Run: npm run check:hell

import {
  HELL_CHAR_COLUMNS,
  HELL_COLUMN_ELEMENTS,
  HELL_COLUMN_RATE,
  HELL_RX_ROWS,
  HellDemodulator,
  hellColumns,
  hellDurationMs,
  hellGlyphColumns,
  hellHasGlyph,
  hellWaveform,
} from "@/lib/digital/hell";

let failed = 0;
function ok(cond: boolean, label: string, detail = ""): void {
  if (cond) console.log(`  ok    ${label}`);
  else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` - ${detail}` : ""}`);
  }
}

/** Deterministic Gaussian noise. */
function noiseSource(seed: number): () => number {
  let s = seed >>> 0;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s + 1) / 4294967297;
  };
  return () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());
}

/**
 * How much of the text comes back as sent: the painted rows laid end to end, lined up
 * with the elements sent at the best lag, and each element read as ink or paper.
 */
function receive(text: string, rate: number, opts: { offsetHz?: number; snrDb?: number; chunk?: number; seed?: number } = {}): { accuracy: number; inkGrey: number; paperGrey: number; signal: boolean } {
  const wave = hellWaveform(text, { sampleRate: rate, centreHz: 1000 + (opts.offsetHz ?? 0), amplitude: 0.5 });
  const lead = Math.round(rate * 0.7);
  const audio = new Float32Array(lead + wave.length + lead);
  audio.set(wave, lead);
  if (opts.snrDb !== undefined) {
    // S/N in a 2.5 kHz noise bandwidth, against the carrier's power while keyed.
    const sigPower = 0.5 * 0.5 * 0.5;
    const noisePower = sigPower / 10 ** (opts.snrDb / 10);
    const sigma = Math.sqrt((noisePower * rate) / 2 / 2500);
    const g = noiseSource(opts.seed ?? 7);
    for (let i = 0; i < audio.length; i++) audio[i] = audio[i]! + sigma * g();
  }
  const d = new HellDemodulator({ sampleRate: rate, centreHz: 1000 });
  const step = opts.chunk ?? 512;
  const rows: number[] = [];
  for (let i = 0; i < audio.length; i += step) {
    d.feed(audio.subarray(i, i + step));
    const c = d.takeColumns();
    if (c) rows.push(...c);
  }
  const sent = hellColumns(text).flat();
  // Best lag, in painted rows, over the lead-in and a column of slack.
  const leadRows = Math.round(0.7 * HELL_COLUMN_RATE * HELL_RX_ROWS);
  let best = { lag: 0, score: -Infinity };
  for (let lag = leadRows - 3 * HELL_RX_ROWS; lag < leadRows + 3 * HELL_RX_ROWS; lag++) {
    let s = 0;
    for (let j = 0; j < sent.length; j++) {
      const v = ((rows[lag + 2 * j] ?? 0) + (rows[lag + 2 * j + 1] ?? 0)) / 2;
      s += sent[j] ? v : -v;
    }
    if (s > best.score) best = { lag, score: s };
  }
  let right = 0;
  let ink = 0;
  let inkN = 0;
  let paper = 0;
  let paperN = 0;
  for (let j = 0; j < sent.length; j++) {
    const v = ((rows[best.lag + 2 * j] ?? 0) + (rows[best.lag + 2 * j + 1] ?? 0)) / 2;
    if (v >= 128 === sent[j]) right++;
    if (sent[j]) {
      ink += v;
      inkN++;
    } else {
      paper += v;
      paperN++;
    }
  }
  return { accuracy: right / sent.length, inkGrey: ink / Math.max(1, inkN), paperGrey: paper / Math.max(1, paperN), signal: d.statistics.signal };
}

console.log("the font and the timing");
{
  const all = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,?/-=:;'\"()+*@!#&<>_ ";
  ok([...all].every(hellHasGlyph), "every letter, digit and the usual punctuation has a glyph");
  ok([...all].every((c) => hellGlyphColumns(c).length === HELL_CHAR_COLUMNS && hellGlyphColumns(c).every((col) => col.length === HELL_COLUMN_ELEMENTS)), "each is 7 columns of 14 elements");
  ok(JSON.stringify(hellGlyphColumns("q")) === JSON.stringify(hellGlyphColumns("Q")), "lowercase is sent as capitals");
  ok(JSON.stringify(hellGlyphColumns("~")) === JSON.stringify(hellGlyphColumns("?")), "a character the font lacks goes as a question mark");
  ok(hellGlyphColumns("H").every((col) => !col[0] && !col[HELL_COLUMN_ELEMENTS - 1]), "a column has paper top and bottom, so stacked lines do not touch");
  const h = hellGlyphColumns("H");
  ok(h[0]!.slice(1, 13).every((e) => e) && h[2]!.filter(Boolean).length === 2 && h[5]!.every((e) => !e) && h[6]!.every((e) => !e), "H: two full uprights, the bar between, then two columns of space");
  const l = hellGlyphColumns("L");
  ok(l[1]![1] === true && l[1]![2] === true && l[1]![3] === false, "L's foot is at the bottom: columns go bottom first");
  ok(Math.abs(HELL_COLUMN_RATE - 17.5) < 1e-9, "17.5 columns a second");
  ok(Math.abs(hellDurationMs("CQ") - ((4 * 7) / 17.5) * 1000) < 1e-6, "CQ is 1.6 s: two characters and a space either side, at 2.5 a second");
  ok(Math.abs(hellDurationMs("CQ   CQ") - hellDurationMs("CQ CQ")) < 1e-6, "runs of spaces close up to one");
}

console.log("\nthe keyed carrier");
{
  const rate = 24_000;
  const w = hellWaveform("RYRYRY EEE", { sampleRate: rate, centreHz: 1000 });
  ok(Math.abs(w.length / rate - hellDurationMs("RYRYRY EEE") / 1000) < 0.01, "the audio is as long as the columns");
  ok(Math.max(...w.map(Math.abs)) <= 1.0001, "and never over full scale");
  ok(Math.abs(w[0]!) < 1e-6 && Math.abs(w[w.length - 1]!) < 1e-6, "silent at both ends: a space of paper either side");
  // Width: the power more than 300 Hz from the carrier, through a plain DFT at a few points.
  const power = (f: number) => {
    let re = 0;
    let im = 0;
    for (let i = 0; i < w.length; i++) {
      re += w[i]! * Math.cos((2 * Math.PI * f * i) / rate);
      im += w[i]! * Math.sin((2 * Math.PI * f * i) / rate);
    }
    return re * re + im * im;
  };
  const centre = power(1000);
  const far = Math.max(power(1400), power(600), power(1600), power(400));
  const db = 10 * Math.log10(far / centre);
  ok(db < -30, `shaped keying: 400 Hz and more off the carrier is over 30 dB down (${db.toFixed(0)} dB)`);
}

console.log("\nthe receiver");
for (const rate of [24_000, 48_000, 12_000]) {
  const r = receive("CQ CQ DE K9XYZ K9XYZ PSE K", rate);
  ok(r.accuracy > 0.97, `clean at ${rate / 1000} kHz: ${(r.accuracy * 100).toFixed(1)}% of elements painted right`);
}
{
  const r = receive("THE QUICK BROWN FOX 0123456789", 24_000, { chunk: 37 });
  ok(r.accuracy > 0.97, `in odd-sized pieces: ${(r.accuracy * 100).toFixed(1)}%`);
  ok(r.inkGrey > 180 && r.paperGrey < 60, `ink is dark and paper is light (${r.inkGrey.toFixed(0)} against ${r.paperGrey.toFixed(0)})`);
}
{
  const r = receive("CQ CQ DE K9XYZ", 24_000, { offsetHz: 60 });
  ok(r.accuracy > 0.9, `60 Hz off the carrier still paints: ${(r.accuracy * 100).toFixed(1)}%`);
}
for (const [snr, want] of [
  [0, 0.9],
  [-6, 0.75],
] as const) {
  const r = receive("CQ CQ DE K9XYZ K9XYZ K", 24_000, { snrDb: snr, seed: 11 });
  ok(r.accuracy > want, `at ${snr} dB in 2.5 kHz: ${(r.accuracy * 100).toFixed(1)}% painted right (readable over ${want * 100}%)`);
}
{
  // Noise alone: the page stays grey, and no signal is reported.
  const rate = 24_000;
  const g = noiseSource(3);
  const d = new HellDemodulator({ sampleRate: rate, centreHz: 1000 });
  const audio = new Float32Array(rate * 8);
  for (let i = 0; i < audio.length; i++) audio[i] = 0.05 * g();
  d.feed(audio);
  const cols = d.takeColumns()!;
  const mean = cols.reduce((a, b) => a + b, 0) / cols.length;
  ok(mean < 128, `noise alone paints grey, not ink (mean ${mean.toFixed(0)} of 255)`);
  ok(!d.statistics.signal, `and reads as no signal (${d.statistics.levelDb.toFixed(1)} dB)`);
  ok(cols.length === Math.floor(8 * HELL_COLUMN_RATE) * HELL_RX_ROWS, `17.5 columns a second, ${HELL_RX_ROWS} rows each`);
}
{
  const rate = 24_000;
  const d = new HellDemodulator({ sampleRate: rate, centreHz: 1000 });
  d.feed(hellWaveform("CQ CQ CQ", { sampleRate: rate, centreHz: 1000, amplitude: 0.3 }));
  ok(d.statistics.signal, `a signal reads as one (${d.statistics.levelDb.toFixed(1)} dB)`);
  d.retune(1500);
  const before = d.statistics.columns;
  d.feed(new Float32Array(rate));
  ok(d.statistics.columns > before, "and a retune keeps it painting");
}

console.log("");
if (failed > 0) {
  console.log(`${failed} FAILED`);
  process.exit(1);
}
console.log("all Hell assertions passed");
