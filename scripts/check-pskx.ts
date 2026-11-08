/* eslint-disable no-console */
// The faster BPSK speeds (250 and 500 baud) and QPSK31/63/125, as fldigi sends them: the
// K=5 code against answers worked by hand from fldigi's encoder, the preamble and
// postamble per speed, and the demodulator on generated signals - at the three rates the
// pipeline feeds it (12 kHz, the FlexRadio's 24 and the Icom's 48), in odd chunks, off
// frequency, in noise where QPSK's code has to earn its keep, and on a minute of noise
// alone, where the squelch has to hold.
// Run: npx tsx scripts/check-pskx.ts

import { psk31Symbols, psk31Waveform, pskBaud, isPskSpeed, type AnyPskSpeed } from "@/lib/digital/psk31";
import { Psk31Demodulator } from "@/lib/digital/psk31demod";
import { QPSK_POLY1, QPSK_POLY2, QPSK_K, QPSK_TRACEBACK, QpskViterbi, qpskEncodeBits, qpskPhaseChange } from "@/lib/digital/qpsk";

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

/** White noise for a signal-to-noise ratio in a 2.5 kHz bandwidth, the usual SSB reference. */
function withNoise(wave: Float32Array, snrDb: number, sampleRate: number, seed = 7): Float32Array {
  let p = 0;
  for (const v of wave) p += v * v;
  const noisePower = (p / wave.length / 10 ** (snrDb / 10)) * (sampleRate / 2 / 2500);
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
type Mode = { speed: AnyPskSpeed; qpsk: boolean; name: string };
const BPSK_FAST: Mode[] = [
  { speed: 250, qpsk: false, name: "BPSK250" },
  { speed: 500, qpsk: false, name: "BPSK500" },
];
const QPSK: Mode[] = [
  { speed: 31, qpsk: true, name: "QPSK31" },
  { speed: 63, qpsk: true, name: "QPSK63" },
  { speed: 125, qpsk: true, name: "QPSK125" },
];

async function main(): Promise<void> {
  console.log("\nthe K=5 code, against fldigi's encoder worked by hand");
  {
    eq([QPSK_K, QPSK_POLY1, QPSK_POLY2], [5, 0x17, 0x19], "K = 5, POLY1 = 0x17, POLY2 = 0x19 (psk/psk.cxx:66-68)");
    // encoder::encode: reg = (reg << 1) | bit, five bits; out = parity(0x17 & reg) | parity(0x19 & reg) << 1.
    // 0x17 = 10111 taps register bits 0,1,2,4; 0x19 = 11001 taps bits 0,3,4.
    //   bit 1: reg 00001 -> p1 1, p2 1 -> 3      bit 0: reg 00010 -> p1 1, p2 0 -> 1
    //   bit 1: reg 00101 -> p1 0, p2 1 -> 2      bit 1: reg 01011 -> p1 0, p2 0 -> 0
    //   bit 0: reg 10110 -> p1 1, p2 1 -> 3      bit 0: reg 01100 -> p1 1, p2 1 -> 3
    //   bit 0: reg 11000 -> p1 1, p2 0 -> 1      bit 0: reg 10000 -> p1 1, p2 1 -> 3
    //   bit 0: reg 00000 -> 0
    eq(qpskEncodeBits([1, 0, 1, 1, 0, 0, 0, 0, 0]), [3, 1, 2, 0, 3, 3, 1, 3, 0], "1011 then five 0s encodes to 3 1 2 0 3 3 1 3 0");
    eq(qpskEncodeBits([1, 1, 1, 1, 1, 1, 1]).slice(4), [2, 2, 2], "a run of 1s settles to dibit 2: parity(10111) 0, parity(11001) 1");
    eq(qpskEncodeBits([0, 0, 0, 0]), [0, 0, 0, 0], "and 0s from rest stay at dibit 0, a reversal: the postamble");
    // tx_carriers: not reversed, d -> (4 - d) & 3 -> sym_vec_pos[4 (4 - d)], 180 + 90 (4 - d)
    // degrees, written as I cos + Q sin, so the audio turns by its negative, 180 + 90 d.
    const deg = (r: number) => Math.round((((r * 180) / Math.PI) % 360 + 360) % 360);
    eq([0, 1, 2, 3].map((d) => deg(qpskPhaseChange(d))), [180, 270, 0, 90], "dibits 0 1 2 3 turn the audio 180 270 0 90 degrees");
    eq([0, 1, 2, 3].map((d) => deg(qpskPhaseChange(d, true))), [180, 90, 0, 270], "and reversed, 180 90 0 270");
    // The decoder on clean metrics: the bits come back, QPSK_TRACEBACK symbols late.
    const bits = [1, 0, 1, 1, 0, 1, 1, 1, 0, 0, 1, 0, 1, 0, 0, 1, 1, 1, 1, 0, 0, ...new Array<number>(QPSK_TRACEBACK).fill(0)];
    const v = new QpskViterbi();
    const back: number[] = [];
    for (const d of qpskEncodeBits(bits)) {
      const met = [0, 0, 0, 0];
      met[d] = 1;
      const b = v.step(met);
      if (b >= 0) back.push(b);
    }
    eq(back.join(""), bits.slice(0, bits.length - QPSK_TRACEBACK).join(""), `the Viterbi decoder reads them back ${QPSK_TRACEBACK} symbols late`);
    // One symbol in four flipped to its opposite: the code corrects it.
    const v2 = new QpskViterbi();
    const back2: number[] = [];
    qpskEncodeBits(bits).forEach((d, i) => {
      const met = [0, 0, 0, 0];
      met[i % 9 === 4 ? (d + 2) % 4 : d] = 1;
      const b = v2.step(met);
      if (b >= 0) back2.push(b);
    });
    eq(back2.join(""), bits.slice(0, bits.length - QPSK_TRACEBACK).join(""), "and with every ninth symbol wrong, still reads them back");
  }

  console.log("\nthe speeds, the preamble and the postamble");
  {
    eq([250, 500].map((s) => pskBaud(s as AnyPskSpeed)), [250, 500], "BPSK250 and BPSK500 are 250 and 500 baud (symbollen 32 and 16 at 8 kHz)");
    ok(isPskSpeed(500) && isPskSpeed(31) && !isPskSpeed(1000) && !isPskSpeed("31"), "isPskSpeed knows the five");
    // dcdbits (psk/psk.cxx:384-447): the preamble and postamble, 256 at PSK250, 512 at PSK500.
    for (const [speed, n] of [[250, 256], [500, 512]] as const) {
      const sy = psk31Symbols("", { speed });
      const zeros = sy.findIndex((b) => b === 1);
      ok(zeros === n && sy.length === 2 * n && sy.slice(n).every((b) => b === 1), `BPSK${speed}: ${n} reversals before and ${n} symbols of steady carrier after`);
    }
    for (const [speed, n] of [[31, 32], [63, 64], [125, 128]] as const) {
      const sy = psk31Symbols("e", { speed, qpsk: true });
      // "e" is 11 then 00: four bits through the encoder, then n zero bits to flush it.
      ok(sy.length === n + 4 + n, `QPSK${speed}: ${n} preamble symbols, the text, ${n} postamble symbols (${sy.length})`);
      ok(sy.slice(0, n).every((d) => d === 0), "  the preamble is reversals, dibit 0, sent straight (tx_process)");
      ok(sy.slice(-(n - 4)).every((d) => d === 0), "  and the postamble, once the 0s fill the register, is reversals too (tx_flush)");
      eq(sy.slice(n, n + 4), qpskEncodeBits([1, 1, 0, 0]), "  the text is the encoder's output from rest");
    }
    // The QPSK waveform turns the carrier as the dibits say: measure the turn at symbol centres.
    const fs = 12_000;
    const sy = psk31Symbols("KC9QRS", { qpsk: true, preambleSymbols: 4, tailSymbols: 4 });
    const w = psk31Waveform("KC9QRS", { sampleRate: fs, centreHz: 1000, qpsk: true, preambleSymbols: 4, tailSymbols: 4 });
    const T = fs / 31.25;
    const at = (k: number) => {
      // Phase at centre k against the carrier, over a few samples either side.
      let re = 0;
      let im = 0;
      const c = Math.round((k + 0.5) * T);
      for (let i = c - 20; i <= c + 20; i++) {
        re += w[i]! * Math.cos((2 * Math.PI * 1000 * i) / fs);
        im += w[i]! * Math.sin((2 * Math.PI * 1000 * i) / fs);
      }
      return Math.atan2(-im, re);
    };
    let right = 0;
    for (let k = 1; k < sy.length; k++) {
      const turn = (((at(k) - at(k - 1)) * 180) / Math.PI + 720) % 360;
      const want = (180 + 90 * sy[k]!) % 360;
      if (Math.abs(((turn - want + 540) % 360) - 180) < 5) right++;
    }
    eq(right, sy.length - 1, "the waveform's phase turns 180 + 90 d degrees at every symbol");
  }

  console.log("\nround trip at 12, 24 and 48 kHz, whole and in chunks of 97 and 1");
  for (const m of [...BPSK_FAST, ...QPSK]) {
    for (const fs of RATES) {
      const wave = psk31Waveform(LINE, { sampleRate: fs, centreHz: 1500, speed: m.speed, qpsk: m.qpsk });
      const mk = () => new Psk31Demodulator({ sampleRate: fs, centreHz: 1500, speed: m.speed, qpsk: m.qpsk });
      const demod = mk();
      const whole = decodeAll(demod, wave);
      ok(whole === LINE, `${m.name} at ${fs / 1000} kHz reads back exactly`, JSON.stringify(whole));
      if (fs === 12_000) {
        ok(demod.statistics.quality > 0.8, `  quality ${demod.statistics.quality.toFixed(2)}`);
        ok(demod.statistics.errors === 0, `  no unread codes (${demod.statistics.errors})`);
      }
      eq(decodeAll(mk(), wave, 97), whole, "  the same in chunks of 97");
      eq(decodeAll(mk(), wave, 1), whole, "  and one sample at a time");
    }
  }
  {
    // BPSK500 at 12 kHz is 24 samples a symbol, which does not divide by sixteen.
    const wave = psk31Waveform(LINE, { sampleRate: 12_000, centreHz: 1000, speed: 500, qpsk: true });
    const t = decodeAll(new Psk31Demodulator({ sampleRate: 12_000, centreHz: 1000, speed: 500, qpsk: true }), wave);
    ok(t === LINE, "QPSK500 at 12 kHz too, though nothing plumbs it yet", JSON.stringify(t));
  }

  console.log("\nreverse");
  {
    const fs = 12_000;
    const wave = psk31Waveform(LINE, { sampleRate: fs, centreHz: 1000, qpsk: true, reverse: true });
    const right = decodeAll(new Psk31Demodulator({ sampleRate: fs, centreHz: 1000, qpsk: true, reverse: true }), wave);
    ok(right === LINE, "QPSK sent reversed reads back with the receiver reversed", JSON.stringify(right));
    const wrong = decodeAll(new Psk31Demodulator({ sampleRate: fs, centreHz: 1000, qpsk: true }), wave);
    ok(!wrong.includes("KC9QRS"), `and not without (${JSON.stringify(wrong)})`);
  }

  console.log("\noff frequency: the fine AFC, and the coarse one pulling in from a click");
  for (const [m, off] of [
    [BPSK_FAST[0]!, 6],
    [BPSK_FAST[1]!, -9],
    [BPSK_FAST[0]!, 90],
    [BPSK_FAST[1]!, -180],
    [QPSK[0]!, 3],
    [QPSK[1]!, -6],
    [QPSK[2]!, 12],
    [QPSK[2]!, 40],
  ] as const) {
    const fs = 12_000;
    const w = psk31Waveform(LINE + " " + LINE, { sampleRate: fs, centreHz: 1500 + off, speed: m.speed, qpsk: m.qpsk });
    const demod = new Psk31Demodulator({ sampleRate: fs, centreHz: 1500, speed: m.speed, qpsk: m.qpsk });
    const t = decodeAll(demod, w);
    ok(t.includes(LINE), `${m.name} ${off > 0 ? "+" : ""}${off} Hz off reads`, JSON.stringify(t));
    ok(Math.abs(demod.statistics.afcHz - off) < Math.max(1, pskBaud(m.speed) / 100), `  and the AFC found it (${demod.statistics.afcHz.toFixed(2)} Hz)`);
  }

  console.log("\nin noise: QPSK's code against BPSK at the same level");
  {
    const TEXT = "CQ CQ CQ de KC9QRS KC9QRS grid EM48sq pse K\nthe quick brown fox jumps over the lazy dog 0123456789\n";
    const fs = 12_000;
    for (const [speed, snr] of [[31, -9], [125, -3]] as const) {
      const errs = { b: 0, q: 0 };
      for (const qpsk of [false, true]) {
        const clean = psk31Waveform(TEXT, { sampleRate: fs, centreHz: 1000, speed, qpsk, amplitude: 0.5 });
        for (const seed of [1, 2, 3, 4, 5]) {
          const t = decodeAll(new Psk31Demodulator({ sampleRate: fs, centreHz: 1000, speed, qpsk }), withNoise(clean, snr, fs, seed));
          errs[qpsk ? "q" : "b"] += editDistance(t, TEXT);
        }
      }
      const n = 5 * TEXT.length;
      ok(errs.b > 0, `${speed} baud at ${snr} dB in 2.5 kHz: BPSK makes errors (${errs.b} in ${n} characters)`);
      ok(errs.q === 0, `  where QPSK copies every character (${errs.q} in ${n}), default squelch`);
    }
  }

  console.log("\na minute of noise alone: the squelch holds");
  for (const [m, fs] of [
    [BPSK_FAST[0]!, 12_000],
    [BPSK_FAST[1]!, 12_000],
    [BPSK_FAST[1]!, 48_000],
    [QPSK[0]!, 12_000],
    [QPSK[2]!, 12_000],
    [QPSK[2]!, 24_000],
  ] as const) {
    const g = noiseSource(99);
    const wave = new Float32Array(fs * 60);
    for (let i = 0; i < wave.length; i++) wave[i] = 0.3 * g();
    const demod = new Psk31Demodulator({ sampleRate: fs, centreHz: 1500, speed: m.speed, qpsk: m.qpsk });
    const text = decodeAll(demod, wave, 4096);
    ok(text.length <= 5, `${m.name} at ${fs / 1000} kHz: sixty seconds of noise prints ${text.length} characters`, JSON.stringify(text));
    ok(Math.abs(demod.statistics.afcHz) < 0.01, `  and the AFC has not moved (${demod.statistics.afcHz.toFixed(2)} Hz)`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
