/* eslint-disable no-console */
// PSK31: the Varicode table, the bit stream, the waveform, and the demodulator on
// generated signals - clean, off frequency, in noise, chunked, at both radios' rates, at
// 62.5 baud - and on noise alone, where the squelch has to hold.

import { PSK31_VARICODE } from "@/lib/digital/psk31-varicode";
import {
  PSK31_BAUD,
  Psk31VaricodeDecoder,
  psk31CharFor,
  psk31CodeFor,
  psk31DurationMs,
  psk31EncodeText,
  psk31Symbols,
  psk31Waveform,
  pskBaud,
} from "@/lib/digital/psk31";
import { Psk31Demodulator } from "@/lib/digital/psk31demod";

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

/** Deterministic Gaussian noise. */
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

/** Add white noise for a signal-to-noise ratio measured in a 2.5 kHz bandwidth, the usual SSB reference. */
function withNoise(wave: Float32Array, snrDb: number, sampleRate: number, seed = 7): Float32Array {
  let p = 0;
  for (const v of wave) p += v * v;
  const signalPower = p / wave.length;
  // Noise power in the full band so that the share inside 2.5 kHz gives the SNR asked for.
  const noisePower = (signalPower / 10 ** (snrDb / 10)) * (sampleRate / 2 / 2500);
  const g = noiseSource(seed);
  const sigma = Math.sqrt(noisePower);
  const out = new Float32Array(wave.length);
  for (let i = 0; i < wave.length; i++) out[i] = wave[i]! + sigma * g();
  return out;
}

function decodeAll(demod: Psk31Demodulator, wave: Float32Array, chunk = wave.length): string {
  let text = "";
  for (let i = 0; i < wave.length; i += chunk) text += demod.feed(wave.subarray(i, Math.min(wave.length, i + chunk)));
  return text;
}

async function main(): Promise<void> {
  console.log("\nthe Varicode table");
  eq(PSK31_VARICODE.length, 256, "256 codes, one per character");
  ok(PSK31_VARICODE.every((c) => !c.includes("00") && c.startsWith("1") && c.endsWith("1")), "every code starts and ends with 1 and never holds 00");
  eq(new Set(PSK31_VARICODE).size, 256, "and no two characters share one");
  eq(psk31CodeFor(" "), "1", "space is the one-bit code");
  eq(psk31CodeFor("e"), "11", "e is two bits");
  eq(psk31CodeFor("t"), "101", "t");
  eq(psk31CodeFor("o"), "111", "o");
  eq(psk31CodeFor("a"), "1011", "a");
  eq(psk31CodeFor("E"), "1110111", "E, the capital, is longer");
  eq(psk31CodeFor("0"), "10110111", "the digit 0");
  eq(psk31CharFor("11"), "e", "and the code reads back to the character");
  eq(psk31CharFor("1001"), null, "a string with 00 in it is no code");
  eq(psk31CodeFor("Ā"), null, "a character outside the table has no code");

  console.log("\nthe bit stream");
  {
    const bits = psk31EncodeText("et");
    eq(bits.join(""), "1100" + "10100", "characters are their codes each followed by 00");
    const d = new Psk31VaricodeDecoder();
    let s = "";
    for (const b of psk31EncodeText("CQ de K9XYZ")) s += d.pushBit(b);
    eq(s, "CQ de K9XYZ", "and the decoder reads the stream back");
    eq(d.errors, 0, "with nothing dropped");
    const d2 = new Psk31VaricodeDecoder();
    let s2 = "";
    for (const b of psk31EncodeText("a\nb")) s2 += d2.pushBit(b);
    eq(s2, "a\nb", "a newline goes as CR LF and comes back as one newline");
    // A long run of 1s is not a code: dropped, counted, and the stream recovers.
    const d3 = new Psk31VaricodeDecoder();
    let s3 = "";
    for (let i = 0; i < 40; i++) s3 += d3.pushBit(1);
    s3 += d3.pushBit(0) + d3.pushBit(0);
    for (const b of psk31EncodeText("ok")) s3 += d3.pushBit(b);
    ok(s3.endsWith("ok"), "after a run of 1s longer than any code the next characters still read", JSON.stringify(s3));
    eq(d3.errors, 0, "and the run is a steady carrier, not an error");
  }

  console.log("\nthe waveform");
  {
    const fs = 12_000;
    const wave = psk31Waveform("CQ", { sampleRate: fs, centreHz: 1000 });
    const symbols = psk31Symbols("CQ").length;
    eq(wave.length, Math.round((symbols * fs) / PSK31_BAUD), "one symbol is 32 ms: the length is the symbol count over the baud rate");
    let peak = 0;
    for (const v of wave) peak = Math.max(peak, Math.abs(v));
    ok(peak <= 1.0001 && peak > 0.95, "full scale and no more", `${peak}`);
    ok(Math.abs(wave[0]!) < 0.05 && Math.abs(wave[wave.length - 1]!) < 0.05, "starts and ends near zero: no click");
    eq(Math.round(psk31DurationMs("CQ", {})), Math.round((symbols / PSK31_BAUD) * 1000), "and the duration says the same");
    eq(pskBaud(63), 62.5, "BPSK63 is 62.5 baud");
    eq(pskBaud(125), 125, "BPSK125 is 125 baud");
    // Idle is a reversal every symbol: the spectrum is two lines a baud apart, nothing at the carrier.
    const idle = psk31Waveform("", { sampleRate: fs, centreHz: 1000, preambleSymbols: 64, tailSymbols: 0 });
    const tone = (hz: number) => {
      let re = 0;
      let im = 0;
      for (let i = 0; i < idle.length; i++) {
        re += idle[i]! * Math.cos((2 * Math.PI * hz * i) / fs);
        im -= idle[i]! * Math.sin((2 * Math.PI * hz * i) / fs);
      }
      return Math.hypot(re, im) / idle.length;
    };
    const side = tone(1000 + PSK31_BAUD / 2);
    const centre = tone(1000);
    ok(side > centre * 5, "idle puts its energy half a baud either side of the carrier, not on it", `side ${side.toFixed(4)} centre ${centre.toFixed(4)}`);
  }

  const LINE = "CQ CQ CQ de K9XYZ K9XYZ pse K";
  console.log("\nthe demodulator on a clean signal");
  {
    const fs = 12_000;
    const wave = psk31Waveform(LINE, { sampleRate: fs, centreHz: 1000 });
    const demod = new Psk31Demodulator({ sampleRate: fs, centreHz: 1000 });
    const text = decodeAll(demod, wave);
    ok(text.includes(LINE), "the line reads back, every character", JSON.stringify(text));
    ok(demod.statistics.quality > 0.9, "quality near 1", `${demod.statistics.quality.toFixed(3)}`);
    ok(Math.abs(demod.statistics.afcHz) < 0.5, "the AFC stays put on an on-frequency signal", `${demod.statistics.afcHz.toFixed(2)} Hz`);
    ok(demod.statistics.errors <= 1, "nothing dropped but, at most, the first symbols before the timing locks", `${demod.statistics.errors}`);
    const chunked = decodeAll(new Psk31Demodulator({ sampleRate: fs, centreHz: 1000 }), wave, 97);
    eq(chunked, text, "fed in odd chunks the text is the same");
    const one = decodeAll(new Psk31Demodulator({ sampleRate: fs, centreHz: 1000 }), wave, 1);
    eq(one, text, "and one sample at a time");
  }
  {
    const fs = 24_000;
    const wave = psk31Waveform(LINE, { sampleRate: fs, centreHz: 1500 });
    const text = decodeAll(new Psk31Demodulator({ sampleRate: fs, centreHz: 1500 }), wave);
    ok(text.includes(LINE), "at the FlexRadio's 24 kHz, carrier 1500", JSON.stringify(text));
  }
  {
    const fs = 12_000;
    const wave = psk31Waveform(LINE, { sampleRate: fs, centreHz: 1000, speed: 63 });
    const text = decodeAll(new Psk31Demodulator({ sampleRate: fs, centreHz: 1000, speed: 63 }), wave);
    ok(text.includes(LINE), "BPSK63 reads back too", JSON.stringify(text));
  }

  console.log("\noff frequency: the AFC");
  for (const off of [3, -5]) {
    const fs = 12_000;
    const wave = psk31Waveform(LINE, { sampleRate: fs, centreHz: 1000 + off, preambleSymbols: 64 });
    const demod = new Psk31Demodulator({ sampleRate: fs, centreHz: 1000 });
    const text = decodeAll(demod, wave);
    ok(text.includes(LINE), `a carrier ${off > 0 ? "+" : ""}${off} Hz off the centre reads back`, JSON.stringify(text));
    ok(Math.abs(demod.statistics.afcHz - off) < 1, `and the AFC found it (${demod.statistics.afcHz.toFixed(2)} Hz)`);
  }
  {
    const fs = 12_000;
    const wave = psk31Waveform(LINE, { sampleRate: fs, centreHz: 1000 + 3, preambleSymbols: 64 });
    const demod = new Psk31Demodulator({ sampleRate: fs, centreHz: 1000, afc: false });
    const text = decodeAll(demod, wave);
    ok(text.includes(LINE), "and 3 Hz off without the AFC still reads: the differential detector tolerates it", JSON.stringify(text));
    eq(demod.statistics.afcHz, 0, "with the oscillator left alone");
  }

  console.log("\nin noise");
  for (const snr of [10, 0, -5]) {
    const fs = 12_000;
    const clean = psk31Waveform(LINE, { sampleRate: fs, centreHz: 1000, preambleSymbols: 64, amplitude: 0.5 });
    const wave = withNoise(clean, snr, fs);
    const demod = new Psk31Demodulator({ sampleRate: fs, centreHz: 1000 });
    const text = decodeAll(demod, wave);
    ok(text.includes(LINE), `at ${snr} dB in 2.5 kHz the line reads back`, JSON.stringify(text));
    ok(demod.statistics.quality > 0.5, `quality still over the squelch (${demod.statistics.quality.toFixed(2)})`);
  }
  {
    const fs = 12_000;
    const clean = psk31Waveform(LINE, { sampleRate: fs, centreHz: 1000, preambleSymbols: 64, amplitude: 0.5 });
    const wave = withNoise(clean, -10, fs);
    const text = decodeAll(new Psk31Demodulator({ sampleRate: fs, centreHz: 1000 }), wave);
    // At -10 dB a few characters may go; the mode's own limit is about there.
    let hits = 0;
    for (const w of LINE.split(" ")) if (text.includes(w)) hits++;
    ok(hits >= 4, `at -10 dB most of the words still read (${hits} of ${LINE.split(" ").length})`, JSON.stringify(text));
  }

  console.log("\nnoise alone: the squelch holds");
  {
    const fs = 12_000;
    const g = noiseSource(99);
    const wave = new Float32Array(fs * 20);
    for (let i = 0; i < wave.length; i++) wave[i] = 0.3 * g();
    const demod = new Psk31Demodulator({ sampleRate: fs, centreHz: 1000 });
    const text = decodeAll(demod, wave);
    ok(text.length <= 3, `twenty seconds of band noise prints next to nothing (${text.length} characters)`, JSON.stringify(text));
    ok(demod.statistics.quality < 0.4, `quality reads as noise (${demod.statistics.quality.toFixed(2)})`);
    eq(demod.statistics.errors, 0, "and nothing is counted as unread while the squelch is closed");
    ok(Math.abs(demod.statistics.afcHz) < 0.01, `and the AFC has not moved on noise (${demod.statistics.afcHz.toFixed(2)} Hz)`);
    const open = new Psk31Demodulator({ sampleRate: fs, centreHz: 1000, squelch: 0 });
    const junk = decodeAll(open, wave);
    ok(junk.length > 50, `with the squelch off the same noise prints junk (${junk.length} characters), which is the squelch's job`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
