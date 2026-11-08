/* eslint-disable no-console */
// PSK-R (fldigi's PSK125R, 250R, 500R, and PSK63R continued from them): the K=7 code and
// the interleaver against answers worked by hand from fldigi's encoder, the preamble and
// postamble, and the demodulator on generated signals - at the three rates the pipeline
// feeds it (12 kHz, the FlexRadio's 24 and the Icom's 48), in odd chunks, off frequency, in
// noise where the code has to earn its keep against plain BPSK at the same baud, on a minute
// of noise alone, and into dead silence after a line.
// Run: npx tsx scripts/check-pskr.ts

import { psk31Symbols, psk31Waveform, type AnyPskSpeed } from "@/lib/digital/psk31";
import { Psk31Demodulator } from "@/lib/digital/psk31demod";
import {
  PSKR_K,
  PSKR_POLY1,
  PSKR_POLY2,
  PSKR_RSID,
  PskrEncoder,
  isPskrSpeed,
  pskrDcdBits,
  pskrDelaySymbols,
  pskrDepth,
  pskrSymbols,
  type PskrSpeed,
} from "@/lib/digital/pskr";
import { mfskEncodeText, mfskVaricodeFor } from "@/lib/digital/mfsk-varicode";

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
  ok(JSON.stringify(got) === JSON.stringify(want), label, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
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

/** The signal, then `afterSec` of nothing (or of the noise alone), with white noise for an S/N in 2.5 kHz measured over the signal. */
function withNoise(wave: Float32Array, snrDb: number, sampleRate: number, seed: number, afterSec = 0): Float32Array {
  let p = 0;
  for (const v of wave) p += v * v;
  const noisePower = (p / wave.length / 10 ** (snrDb / 10)) * (sampleRate / 2 / 2500);
  const g = noiseSource(seed);
  const sigma = Math.sqrt(noisePower);
  const out = new Float32Array(wave.length + Math.round(afterSec * sampleRate));
  for (let i = 0; i < out.length; i++) out[i] = (wave[i] ?? 0) + sigma * g();
  return out;
}

/** The line and then a stretch of silence: the receiver needs audio after the carrier to push the last bits out. */
function padded(wave: Float32Array, sampleRate: number, sec: number): Float32Array {
  const out = new Float32Array(wave.length + Math.round(sec * sampleRate));
  out.set(wave);
  return out;
}

function decodeAll(demod: Psk31Demodulator, wave: Float32Array, chunk = wave.length): string {
  let text = "";
  for (let i = 0; i < wave.length; i += chunk) text += demod.feed(wave.subarray(i, Math.min(wave.length, i + chunk)));
  return text;
}

/** Characters inserted, dropped or changed to turn one string into the other. */
function editDistance(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = d[0]!;
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = d[j]!;
      d[j] = Math.min(up + 1, d[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return d[b.length]!;
}

const LINE = "CQ CQ de KC9QRS KC9QRS EM48sq pse K";
const RATES = [12_000, 24_000, 48_000];
const SPEEDS: PskrSpeed[] = [63, 125, 250, 500];
const name = (s: PskrSpeed) => `PSK${s}R`;
const demodFor = (fs: number, speed: AnyPskSpeed, extra: { squelch?: number; afc?: boolean } = {}) =>
  new Psk31Demodulator({ sampleRate: fs, centreHz: 1500, speed, pskr: true, ...extra });

async function main(): Promise<void> {
  console.log("\nthe code and the interleaver, against fldigi's encoder worked by hand");
  {
    eq([PSKR_K, PSKR_POLY1, PSKR_POLY2], [7, 0x6d, 0x4f], "K = 7, POLY1 = 0x6d, POLY2 = 0x4f (psk/psk.cxx:72-74)");
    eq(SPEEDS.map(pskrDepth), [20, 40, 80, 160], "interleaver depth 20 (by psk.cxx:1033-1036), 40, 80, 160 (psk.cxx:664, :671, :678)");
    eq(SPEEDS.map(pskrDcdBits), [64, 128, 256, 512], "dcdbits 64, 128, 256, 512 (psk.cxx:450-455, :660-685)");
    eq([PSKR_RSID.PSK125R, PSKR_RSID.PSK250R, PSKR_RSID.PSK500R, PSKR_RSID.PSK63F], [183, 186, 187, 22], "RSID 183, 186, 187, and 22 for PSK63F (rsid/rsid_defs.cxx:46-48, :67)");
    ok(isPskrSpeed(125) && !isPskrSpeed(31) && !isPskrSpeed(1000), "isPskrSpeed knows the four");
    let threw = false;
    try {
      psk31Symbols("x", { speed: 31, pskr: true });
    } catch {
      threw = true;
    }
    ok(threw, "PSK-R at 31 baud is refused, not guessed at");

    // The transmission's first data bits: the preamble's 1 0 1 0, then NUL's Varicode
    // 1110... (mfsk/mfskvaricode.cxx:36). encoder::encode (filters/viterbi.cxx): the register
    // shifts left with the new bit in bit 0; p1 = parity(0x6d & reg), p2 = parity(0x4f & reg).
    // 0x6d = 1101101 taps bits 0,2,3,5,6; 0x4f = 1001111 taps bits 0,1,2,3,6.
    //   1: reg 0000001  p1 1  p2 1        0: reg 0000010  p1 0  p2 1
    //   1: reg 0000101  p1 0  p2 0        0: reg 0001010  p1 1  p2 0
    //   1: reg 0010101  p1 0  p2 0        1: reg 0101011  p1 1  p2 1
    //   1: reg 1010111  p1 1  p2 0        0: reg 0101110  p1 1  p2 1
    // tx_bit sends the interleaved bit 0 (p1's row) first, then bit 1 (p2's): with no
    // interleaver (PSK63F) that is p1 p2 for each data bit.
    eq(mfskVaricodeFor(0), "11101011100", "NUL's MFSK Varicode, sent after the preamble (tx_process)");
    const head = pskrSymbols("e", { speed: 63, depth: 0, preambleSymbols: 8, tailSymbols: 0 });
    eq(head.slice(0, 16), [1, 1, 0, 1, 0, 0, 1, 0, 0, 0, 1, 1, 1, 0, 1, 1], "no interleaver: 1 0 1 0 1 1 1 0 key 11 01 00 10 00 11 10 11");
    // The interleaver (mfsk/interleave.cxx, INTERLEAVE_FWD, flushed to 0 by clearbits):
    // bits() puts p2 in row 0 and p1 in row 1, and the forward direction delays row 1 one
    // place a stage. So p1 is `depth` data bits late and starts as the flushed 0s, and p2
    // goes straight through.
    const p1 = [1, 0, 0, 1, 0, 1, 1, 1];
    const p2 = [1, 1, 0, 0, 0, 1, 0, 1];
    const d = pskrDepth(125);
    const il = pskrSymbols("e", { speed: 125, preambleSymbols: 8, tailSymbols: 120 });
    eq(il.slice(0, 16), [0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1], "PSK125R: p1 held back, the first symbols 0 p2 0 p2 ...");
    eq([0, 1, 2, 3, 4, 5, 6, 7].map((k) => il[2 * k + 1]), p2, "  every second symbol is p2 as it is made");
    eq([0, 1, 2, 3, 4, 5, 6, 7].map((k) => il[2 * (k + d)]), p1, `  and p1 comes ${d} data bits later`);
    ok(il.slice(0, 2 * d).filter((_, i) => i % 2 === 0).every((b) => b === 0), "  after the flushed 0s");
    // The encoder on its own matches the hand-worked table.
    const enc = new PskrEncoder(0);
    eq([1, 0, 1, 0, 1, 1, 1, 0].map((b) => enc.bit(b)).flat(), head.slice(0, 16), "PskrEncoder agrees bit by bit");
  }

  console.log("\nthe preamble and the postamble");
  for (const speed of SPEEDS) {
    const dcd = pskrDcdBits(speed);
    const textBits = 11 + mfskEncodeText("e").length;
    const sy = psk31Symbols("e", { speed, pskr: true });
    ok(sy.length === 2 * (dcd + textBits + dcd), `${name(speed)}: ${dcd} preamble bits, NUL, the text, ${dcd} postamble bits, two symbols each (${sy.length})`);
    // Once the interleaver has emptied, 1 0 pairs key the 1100 cycle and 1s steady carrier.
    const depth = pskrDepth(speed);
    const pre = sy.slice(2 * (depth + 8), 2 * dcd);
    ok(pre.every((b, i) => b === [1, 1, 0, 0][i % 4]), "  the preamble settles to 1100 1100 (fldigi's PSK-R DCD-on pattern, psk.cxx:1624-1633)");
    const tailSteady = sy.slice(sy.length - 2 * (dcd - depth - 7));
    ok(tailSteady.every((b) => b === 1), `  the postamble ends in ${tailSteady.length} symbols of steady carrier`);
  }

  console.log("\nround trip at 12, 24 and 48 kHz, whole and in chunks of 97 and 1");
  for (const speed of SPEEDS) {
    for (const fs of RATES) {
      // A second of silence after: the decoder hands out the last bits a second or two after
      // they were sent, and needs audio, any audio, to clock them out.
      const wave = padded(psk31Waveform(LINE, { sampleRate: fs, centreHz: 1500, speed, pskr: true }), fs, 2);
      const demod = demodFor(fs, speed);
      const whole = decodeAll(demod, wave);
      ok(whole === LINE, `${name(speed)} at ${fs / 1000} kHz reads back exactly`, JSON.stringify(whole));
      if (fs === 12_000) {
        ok(demod.statistics.errors === 0, `  no unread codes (${demod.statistics.errors})`);
        ok(demod.statistics.chars === LINE.length, `  ${demod.statistics.chars} characters counted`);
      }
      if (fs !== 48_000 || speed === 500) {
        eq(decodeAll(demodFor(fs, speed), wave, 97), whole, "  the same in chunks of 97");
        eq(decodeAll(demodFor(fs, speed), wave, 1), whole, "  and one sample at a time");
      }
    }
  }
  {
    const fs = 12_000;
    const wave = padded(psk31Waveform(LINE, { sampleRate: fs, centreHz: 1500, speed: 125, pskr: true }), fs, 2);
    const demod = demodFor(fs, 125);
    let q = 0;
    for (let i = 0; i < wave.length - fs * 2; i += 1200) {
      demod.feed(wave.subarray(i, i + 1200));
      q = Math.max(q, demod.statistics.quality);
    }
    ok(q > 0.9, `a clean signal's quality reads ${q.toFixed(2)}`);
    // PSK63F: the same code with no interleaver (psk.cxx:450-455, :2340).
    const f = padded(psk31Waveform(LINE, { sampleRate: fs, centreHz: 1500, speed: 63, pskr: true, pskrDepth: 0 }), fs, 2);
    const t = decodeAll(new Psk31Demodulator({ sampleRate: fs, centreHz: 1500, speed: 63, pskr: true, pskrDepth: 0 }), f);
    ok(t === LINE, "PSK63F (pskrDepth 0) reads back too", JSON.stringify(t));
    const wrong = decodeAll(demodFor(fs, 63), f);
    ok(!wrong.includes("KC9QRS"), `and not on a PSK63R receiver (${JSON.stringify(wrong)})`);
    // A line longer than the interleaver, with every printable character and a UTF-8 one.
    let all = "";
    for (let c = 32; c < 127; c++) all += String.fromCharCode(c);
    all += " café\nnext line";
    const long = padded(psk31Waveform(all, { sampleRate: fs, centreHz: 1500, speed: 250, pskr: true }), fs, 2);
    const lt = decodeAll(demodFor(fs, 250), long, 4096);
    ok(lt === all, "PSK250R: every printable character, UTF-8 and a newline", JSON.stringify(lt));
  }

  console.log("\nreset (after an RSID burst) forgets everything");
  {
    const fs = 12_000;
    const demod = demodFor(fs, 125);
    // Half of one line, then tones that are no PSK at all, then reset, then a different line.
    const first = psk31Waveform("KC9QRS de W9XYZ the first line", { sampleRate: fs, centreHz: 1500, speed: 125, pskr: true });
    demod.feed(first.subarray(0, Math.floor(first.length / 2)));
    const burst = new Float32Array(fs);
    for (let i = 0; i < burst.length; i++) burst[i] = Math.sin((2 * Math.PI * (1400 + 200 * Math.floor(i / 700) % 3) * i) / fs);
    demod.feed(burst);
    demod.reset();
    const second = padded(psk31Waveform(LINE, { sampleRate: fs, centreHz: 1500, speed: 125, pskr: true }), fs, 2);
    const t = demod.feed(second);
    ok(t === LINE, "the next line reads exactly, nothing of the first", JSON.stringify(t));
    const fresh = demodFor(fs, 125);
    eq(t, fresh.feed(second), "  the same as a new receiver gives");
  }

  console.log("\noff frequency");
  for (const [speed, off] of [
    [63, 2],
    [125, -4],
    [250, 7],
    [500, -12],
    [250, 30],
    [500, -80],
  ] as const) {
    const fs = 12_000;
    const w = padded(psk31Waveform(LINE + " " + LINE, { sampleRate: fs, centreHz: 1500 + off, speed, pskr: true }), fs, 2);
    const demod = demodFor(fs, speed);
    const t = decodeAll(demod, w);
    ok(t.includes(LINE), `${name(speed)} ${off > 0 ? "+" : ""}${off} Hz off reads`, JSON.stringify(t));
    ok(Math.abs(demod.statistics.afcHz - off) < Math.max(1, speed / 50), `  and the AFC found it (${demod.statistics.afcHz.toFixed(2)} Hz)`);
  }

  console.log("\nin noise: PSK-R against plain BPSK at the same baud and level");
  {
    // The comparison is the code's: both with the AFC off, so it measures the decoders and
    // not how either AFC behaves in noise. PSK-R must then also copy with its AFC on.
    const TEXT = "CQ CQ CQ de KC9QRS KC9QRS grid EM48sq pse K\nthe quick brown fox jumps over the lazy dog 0123456789\n";
    const fs = 12_000;
    const SEEDS = [1, 2, 3, 4, 5];
    for (const [speed, snr] of [
      [63, -10],
      [125, -7],
      [250, -5],
      [500, -2],
    ] as const) {
      const errs = { b: 0, r: 0, afc: 0 };
      for (const [key, pskr, afc] of [["b", false, false], ["r", true, false], ["afc", true, true]] as const) {
        const clean = psk31Waveform(TEXT, { sampleRate: fs, centreHz: 1000, speed, pskr, amplitude: 0.5 });
        for (const seed of SEEDS) {
          const demod = new Psk31Demodulator({ sampleRate: fs, centreHz: 1000, speed, pskr, afc });
          const t = decodeAll(demod, withNoise(clean, snr, fs, seed, 2), 4096);
          errs[key] += editDistance(t, TEXT);
        }
      }
      const n = SEEDS.length * TEXT.length;
      ok(errs.b > 50, `${speed} baud at ${snr} dB in 2.5 kHz: BPSK${speed} makes errors (${errs.b} in ${n} characters)`);
      ok(errs.r <= n / 100, `  where ${name(speed as PskrSpeed)} copies, under 1% (${errs.r} in ${n}), default squelch`);
      ok(errs.afc <= n / 100, `  and with its AFC on (${errs.afc} in ${n})`);
    }
  }

  console.log("\na minute of noise alone: the squelch holds");
  for (const [speed, fs] of [
    [63, 12_000],
    [125, 12_000],
    [250, 12_000],
    [500, 12_000],
    [500, 48_000],
  ] as const) {
    const g = noiseSource(99);
    const wave = new Float32Array(fs * 60);
    for (let i = 0; i < wave.length; i++) wave[i] = 0.3 * g();
    const demod = demodFor(fs, speed);
    const text = decodeAll(demod, wave, 4096);
    ok(text.length <= 3, `${name(speed)} at ${fs / 1000} kHz: sixty seconds of noise prints ${text.length} characters`, JSON.stringify(text));
    ok(Math.abs(demod.statistics.afcHz) < 0.5, `  and the AFC has not wandered (${demod.statistics.afcHz.toFixed(2)} Hz)`);
  }
  {
    const fs = 12_000;
    const g = noiseSource(98);
    const wave = new Float32Array(fs * 20);
    for (let i = 0; i < wave.length; i++) wave[i] = 0.3 * g();
    const t = decodeAll(demodFor(fs, 125, { squelch: 0 }), wave, 4096);
    ok(t.length > 20, `with the squelch off the same noise prints junk (${t.length} characters), which is the squelch's job`);
  }

  console.log("\nafter a line: dead silence, and noise");
  for (const speed of SPEEDS) {
    const fs = 12_000;
    const wave = psk31Waveform(LINE, { sampleRate: fs, centreHz: 1500, speed, pskr: true });
    const demod = demodFor(fs, speed);
    const during = demod.feed(wave);
    // The last characters are still in the de-interleaver and the decoder when the carrier
    // stops; silence clocks them out and must add nothing after.
    const silence = demod.feed(new Float32Array(fs * 4));
    ok(during + silence === LINE, `${name(speed)}: four seconds of digital silence finish the line and add nothing`, JSON.stringify([during, silence]));
    ok(demod.statistics.quality < 0.5 && !demod.statistics.open, `  and the squelch has closed (quality ${demod.statistics.quality.toFixed(2)})`);
    const noisy = withNoise(wave, 6, fs, 11, 4);
    const nt = decodeAll(demodFor(fs, speed), noisy, 4096);
    ok(nt === LINE, `  four seconds of noise after a line add nothing either`, JSON.stringify(nt));
  }
  ok(pskrDelaySymbols(40) === 248, "the decoder's delay at PSK125R: 2 x (40 + 84) symbols, about two seconds");

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
