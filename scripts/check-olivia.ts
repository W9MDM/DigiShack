/* eslint-disable no-console */
// Olivia: the Hadamard transforms, the FEC block both ways, the waveform, and the
// demodulator on generated signals - clean at both radios' rates and two sizes, off
// frequency, in noise, chunked - and on noise alone, where the threshold has to hold.

import {
  OLIVIA_SYMBOLS_PER_BLOCK,
  binaryCode,
  fht,
  grayCode,
  ifht,
  oliviaDecodeBlock,
  oliviaDurationMs,
  oliviaEncodeBlock,
  oliviaFirstCarrierBin,
  oliviaParams,
  oliviaSymbols,
  oliviaTextToChars,
  oliviaWaveform,
} from "@/lib/digital/olivia";
import { OliviaDemodulator } from "@/lib/digital/oliviademod";

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  ok    ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
function eq<T>(got: T, want: T, label: string): void {
  ok(got === want, label, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

function noiseSource(seed: number): () => number {
  let s = seed >>> 0;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  return () => {
    const u = Math.max(rnd(), 1e-12);
    const v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

function withNoise(wave: Float32Array, snrDb: number, sampleRate: number, seed = 7): Float32Array {
  let p = 0;
  for (const v of wave) p += v * v;
  const signalPower = p / wave.length;
  const noisePower = (signalPower / 10 ** (snrDb / 10)) * (sampleRate / 2 / 2500);
  const g = noiseSource(seed);
  const sigma = Math.sqrt(noisePower);
  const out = new Float32Array(wave.length);
  for (let i = 0; i < wave.length; i++) out[i] = wave[i]! + sigma * g();
  return out;
}

function decodeAll(demod: OliviaDemodulator, wave: Float32Array, chunk = wave.length): string {
  let text = "";
  for (let i = 0; i < wave.length; i += chunk) text += demod.feed(wave.subarray(i, Math.min(wave.length, i + chunk)));
  return text;
}

/** Olivia prints a block from inside its integration window, so the last blocks need silence after them to come out. */
function flush(demod: OliviaDemodulator, sampleRate: number, seconds: number): string {
  return demod.feed(new Float32Array(Math.round(sampleRate * seconds)));
}

async function main(): Promise<void> {
  console.log("\nthe parameters");
  {
    const p = oliviaParams({ tones: 32, bandwidth: 1000 });
    eq(p.bitsPerSymbol, 5, "32 tones is five bits a symbol");
    eq(p.refSymbolLen, 512, "1000/32: a 512-sample symbol at 8 kHz");
    eq(p.baud, 31.25, "31.25 baud");
    eq(p.toneSpacingHz, 31.25, "tones 31.25 Hz apart");
    eq(Math.round(p.blockSeconds * 1000), 2048, "a block is 2.048 s");
    const q = oliviaParams({ tones: 16, bandwidth: 500 });
    eq(q.refSymbolLen, 512, "500/16: the same symbol");
    eq(q.baud, 31.25, "and the same baud");
    const r = oliviaParams({ tones: 8, bandwidth: 500 });
    eq(r.baud, 62.5, "500/8 is twice as fast");
    eq(oliviaFirstCarrierBin(p, 1500), Math.floor((512 / 16) * ((1500 - (1000 * (1 - 0.5 / 32)) / 2) / 500)) + 1, "the first carrier bin follows fldigi's placement");
  }

  console.log("\nGray code and the Hadamard transforms");
  {
    eq(grayCode(5), 7, "Gray(5) = 7");
    for (let i = 0; i < 256; i++) if (binaryCode(grayCode(i)) !== i) failed++;
    ok(true, "binary(Gray(x)) = x for every byte (counted as one)");
    const x = new Float64Array(64);
    for (let i = 0; i < 64; i++) x[i] = Math.sin(i * 1.7) * 3;
    const y = Float64Array.from(x);
    ifht(y, 64);
    fht(y, 64);
    let maxErr = 0;
    for (let i = 0; i < 64; i++) maxErr = Math.max(maxErr, Math.abs(y[i]! - 64 * x[i]!));
    ok(maxErr < 1e-9, "FHT after IFHT is 64 times the input", `${maxErr}`);
  }

  console.log("\nthe FEC block both ways");
  {
    const chars = [67, 81, 32, 100, 101]; // "CQ de"
    const block = oliviaEncodeBlock(chars, 5);
    eq(block.length, OLIVIA_SYMBOLS_PER_BLOCK, "64 symbols");
    ok(block.every((s) => s < 32), "every symbol is a 5-bit tone index");
    // Hard soft bits: +1 for a 0, -1 for a 1.
    const soft = new Float64Array(64 * 5);
    for (let t = 0; t < 64; t++) for (let b = 0; b < 5; b++) soft[t * 5 + b] = block[t]! & (1 << b) ? -1 : 1;
    const r = oliviaDecodeBlock(soft, 5);
    eq(r.chars.join(","), chars.join(","), "decodes back to the characters");
    eq(r.signal, 64, "with the Hadamard peak at 64");
    eq(r.noiseEnergy, 0, "and nothing left in the other bins");
    // A fifth of the symbols wrong, scattered: still decodes.
    const soft2 = Float64Array.from(soft);
    let seed = 12345;
    const wrong = new Set<number>();
    while (wrong.size < 13) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      wrong.add(seed % 64);
    }
    for (const t of wrong) for (let b = 0; b < 5; b++) soft2[t * 5 + b] = -soft2[t * 5 + b]!;
    const r2 = oliviaDecodeBlock(soft2, 5);
    eq(r2.chars.join(","), chars.join(","), "a fifth of the symbols inverted still decodes");
    const four = oliviaEncodeBlock([72, 73], 4);
    const soft4 = new Float64Array(64 * 4);
    for (let t = 0; t < 64; t++) for (let b = 0; b < 4; b++) soft4[t * 4 + b] = four[t]! & (1 << b) ? -1 : 1;
    eq(oliviaDecodeBlock(soft4, 4).chars.join(","), "72,73,0,0", "a 16-tone block carries four characters, padded with idle");
    eq(oliviaTextToChars("a\nb").join(","), "97,13,10,98", "newline goes as CR LF");
  }

  console.log("\nthe waveform");
  {
    const fs = 12_000;
    const mode = { tones: 16, bandwidth: 500 } as const;
    const symbols = oliviaSymbols("CQ", { ...mode });
    eq(symbols.length, 3 * 64, "one idle block before, the text block, one idle after");
    const wave = oliviaWaveform(symbols, { ...mode, sampleRate: fs, centreHz: 1500 });
    const p = oliviaParams(mode);
    eq(wave.length, (symbols.length + 1) * Math.round((p.refSymbolSepar * fs) / 8000), "the length is the symbols plus the last half symbol");
    let peak = 0;
    for (const v of wave) peak = Math.max(peak, Math.abs(v));
    ok(peak <= 1.0001, "never over full scale", `${peak}`);
    ok(Math.abs(oliviaDurationMs("CQ", mode) - (wave.length / fs) * 1000) < 1, "the duration says the same");
    // The energy sits inside the tone set.
    const power = (hz: number) => {
      let re = 0;
      let im = 0;
      for (let i = 0; i < wave.length; i++) {
        re += wave[i]! * Math.cos((2 * Math.PI * hz * i) / fs);
        im -= wave[i]! * Math.sin((2 * Math.PI * hz * i) / fs);
      }
      return (re * re + im * im) / wave.length;
    };
    const first = oliviaFirstCarrierBin(p, 1500) * p.binHz;
    ok(power(first + 3 * p.toneSpacingHz) > power(first - 4 * p.toneSpacingHz) * 20, "a tone bin carries far more than a bin outside the set");
  }

  const LINE = "CQ CQ de W1AW W1AW pse k";
  console.log("\nthe demodulator on a clean signal");
  for (const [fs, mode] of [
    [12_000, { tones: 16, bandwidth: 500 }],
    [24_000, { tones: 16, bandwidth: 500 }],
    [12_000, { tones: 32, bandwidth: 1000 }],
    [12_000, { tones: 8, bandwidth: 250 }],
  ] as const) {
    const wave = oliviaWaveform(oliviaSymbols(LINE, { ...mode, preambleBlocks: 2 }), { ...mode, sampleRate: fs, centreHz: 1500 });
    const demod = new OliviaDemodulator({ ...mode, sampleRate: fs, centreHz: 1500 });
    const text = decodeAll(demod, wave) + flush(demod, fs, 8 * oliviaParams(mode).blockSeconds);
    ok(text.includes(LINE), `${mode.bandwidth}/${mode.tones} at ${fs / 1000} kHz reads back`, JSON.stringify(text));
    ok(demod.statistics.snr >= 4, `with a signal over noise above the threshold (${demod.statistics.snr.toFixed(1)})`);
  }
  {
    const fs = 12_000;
    const mode = { tones: 16, bandwidth: 500 } as const;
    const wave = oliviaWaveform(oliviaSymbols(LINE, { ...mode, preambleBlocks: 2 }), { ...mode, sampleRate: fs, centreHz: 1500 });
    const whole = decodeAll(new OliviaDemodulator({ ...mode, sampleRate: fs, centreHz: 1500 }), wave);
    const d2 = new OliviaDemodulator({ ...mode, sampleRate: fs, centreHz: 1500 });
    const chunked = decodeAll(d2, wave, 97);
    eq(chunked, whole, "fed in odd chunks the text is the same");
  }

  console.log("\noff frequency: the synchroniser's margin");
  for (const off of [20, -45]) {
    const fs = 12_000;
    const mode = { tones: 16, bandwidth: 500 } as const;
    const wave = oliviaWaveform(oliviaSymbols(LINE, { ...mode, preambleBlocks: 2 }), { ...mode, sampleRate: fs, centreHz: 1500 + off });
    const demod = new OliviaDemodulator({ ...mode, sampleRate: fs, centreHz: 1500 });
    const text = decodeAll(demod, wave) + flush(demod, fs, 8 * oliviaParams(mode).blockSeconds);
    ok(text.includes(LINE), `a tone set ${off > 0 ? "+" : ""}${off} Hz off the centre reads back`, JSON.stringify(text));
    ok(Math.abs(demod.statistics.freqOffsetHz - off) <= 16, `and the synchroniser found it (${demod.statistics.freqOffsetHz.toFixed(1)} Hz)`);
  }

  console.log("\nin noise");
  for (const snr of [0, -6]) {
    const fs = 12_000;
    const mode = { tones: 16, bandwidth: 500 } as const;
    const clean = oliviaWaveform(oliviaSymbols(LINE, { ...mode, preambleBlocks: 3 }), { ...mode, sampleRate: fs, centreHz: 1500, amplitude: 0.5 });
    const wave = withNoise(clean, snr, fs);
    const demod = new OliviaDemodulator({ ...mode, sampleRate: fs, centreHz: 1500 });
    const text = decodeAll(demod, wave) + flush(demod, fs, 8 * oliviaParams(mode).blockSeconds);
    ok(text.includes(LINE), `at ${snr} dB in 2.5 kHz the line reads back`, JSON.stringify(text));
  }
  {
    const fs = 12_000;
    const mode = { tones: 16, bandwidth: 500 } as const;
    const clean = oliviaWaveform(oliviaSymbols(LINE, { ...mode, preambleBlocks: 3 }), { ...mode, sampleRate: fs, centreHz: 1500, amplitude: 0.5 });
    const wave = withNoise(clean, -10, fs);
    const demod = new OliviaDemodulator({ ...mode, sampleRate: fs, centreHz: 1500 });
    const text = decodeAll(demod, wave) + flush(demod, fs, 8 * oliviaParams(mode).blockSeconds);
    let hits = 0;
    for (const w of LINE.split(" ")) if (text.includes(w)) hits++;
    ok(hits >= 4, `at -10 dB most of the words still read (${hits} of ${LINE.split(" ").length})`, JSON.stringify(text));
  }

  console.log("\nnoise alone: the threshold holds");
  {
    const fs = 12_000;
    const g = noiseSource(99);
    const wave = new Float32Array(fs * 40);
    for (let i = 0; i < wave.length; i++) wave[i] = 0.3 * g();
    const demod = new OliviaDemodulator({ tones: 16, bandwidth: 500, sampleRate: fs, centreHz: 1500 });
    const text = decodeAll(demod, wave);
    ok(text.length === 0, `forty seconds of band noise prints nothing (${text.length} characters)`, JSON.stringify(text));
    ok(demod.statistics.snr < 4, `signal over noise reads as noise (${demod.statistics.snr.toFixed(2)})`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
