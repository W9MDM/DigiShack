/* eslint-disable no-console */
// IFKP: the speeds and tone placement, the Varicode, the IFK tone arithmetic against
// sequences worked by hand from fldigi's code, the waveform, and the demodulator on
// generated signals - clean, at every rate the radios give, chunked, off frequency, on a
// mismatched clock, in noise - and on noise and digital silence alone, where nothing may
// print.

import { IFK33_TONES, Ifk33VaricodeDecoder, ifk33Audio, ifk33NibbleBetween, ifk33Tones } from "@/lib/digital/fsq";
import {
  IFKP_BANDWIDTH_HZ,
  IFKP_BASE_RATE,
  IFKP_SPEEDS,
  IFKP_TONE_SPACING_HZ,
  IFKP_VARICODE,
  ifkpBaseBin,
  ifkpClampCentre,
  ifkpCodeFor,
  ifkpDurationMs,
  ifkpNibbles,
  ifkpParams,
  ifkpToneHz,
  ifkpWaveform,
  type IfkpSpeed,
} from "@/lib/digital/ifkp";
import { IfkpDemodulator } from "@/lib/digital/ifkpdemod";

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

/** Add white noise for a signal-to-noise ratio measured in a 2.5 kHz bandwidth, with four seconds of noise either side. */
function withNoise(wave: Float32Array, snrDb: number, sampleRate: number, seed = 7): Float32Array {
  let p = 0;
  for (const v of wave) p += v * v;
  const noisePower = (p / wave.length / 10 ** (snrDb / 10)) * (sampleRate / 2 / 2500);
  const g = noiseSource(seed);
  const sigma = Math.sqrt(noisePower);
  const pad = 4 * sampleRate;
  const out = new Float32Array(wave.length + 2 * pad);
  for (let i = 0; i < out.length; i++) out[i] = (wave[i - pad] ?? 0) + sigma * g();
  return out;
}

/** The wave followed by `seconds` of exact zeros, as a FlexRadio's DAX gives between overs. */
function thenSilence(wave: Float32Array, seconds: number, sampleRate: number): Float32Array {
  const out = new Float32Array(wave.length + Math.round(seconds * sampleRate));
  out.set(wave, 0);
  return out;
}

function decodeAll(demod: IfkpDemodulator, wave: Float32Array, chunk = wave.length): string {
  let text = "";
  for (let i = 0; i < wave.length; i += chunk) text += demod.feed(wave.subarray(i, Math.min(wave.length, i + chunk)));
  return text;
}

/** The magnitude of one frequency over a stretch of samples. */
function toneMag(wave: Float32Array, from: number, to: number, hz: number, fs: number): number {
  let re = 0;
  let im = 0;
  for (let i = from; i < to; i++) {
    re += wave[i]! * Math.cos((2 * Math.PI * hz * i) / fs);
    im -= wave[i]! * Math.sin((2 * Math.PI * hz * i) / fs);
  }
  return Math.hypot(re, im);
}

/** IFKP is usually typed in lower case (fldigi's IFKPLOWERCASE): one nibble a letter. */
const LINE = "cq cq cq de kc9qrs kc9qrs EM48sq pse k";
/** Silence after an over long enough for the last character's hold (three symbols) at the slowest speed. */
const TAIL_S = 3;

async function main(): Promise<void> {
  console.log("\nthe speeds and the tones (ifkp.cxx:58, 256-293, 687-709; ifkp.h:37-46)");
  {
    const want: Record<IfkpSpeed, number> = { "0.5": 8192, "1": 4096, "2": 2048 };
    for (const s of IFKP_SPEEDS) {
      const p = ifkpParams(s);
      ok(p.symbolLen === want[s] && Math.abs(p.baud - 16000 / want[s]) < 1e-12, `IFKP ${s}: ${p.symbolLen} samples at 16 kHz, ${p.baud.toFixed(4)} baud`);
    }
    ok(Math.abs(IFKP_TONE_SPACING_HZ - 11.71875) < 1e-12, `tones 3 x 16000 / 4096 = ${IFKP_TONE_SPACING_HZ} Hz apart at every speed`);
    eq(IFKP_BANDWIDTH_HZ, 386, "fldigi's bandwidth: 33 x 3 x 16000 / 4096 in integers, 386");
    // ceil((1500 - 193) * 4096 / 16000) = ceil(334.59) = 335; no rounding to a multiple of 3 here.
    eq(ifkpBaseBin(1500), 335, "on 1500 Hz tone 0 is FFT bin 335");
    ok(Math.abs(ifkpToneHz(0, 1500) - 1308.59375) < 1e-9 && Math.abs(ifkpToneHz(32, 1500) - 1683.59375) < 1e-9, `and the tones run ${ifkpToneHz(0, 1500).toFixed(2)} to ${ifkpToneHz(32, 1500).toFixed(2)} Hz`);
    eq([ifkpClampCentre(100), ifkpClampCentre(4000)], [293, 3707], "the frequency is held half the bandwidth inside 100-3900 Hz");
  }

  console.log("\nthe Varicode (ifkp_varicode.cxx)");
  {
    // Entries copied from fldigi's encoding table, ifkp_varicode[][2].
    eq(ifkpCodeFor(32), [28], "space is the one nibble 28 ({28, 0})");
    eq(ifkpCodeFor(101), [5], "e is 5");
    eq(ifkpCodeFor(10), [28, 30], "LF is 28 30");
    eq(ifkpCodeFor(46), [27], "full stop is 27");
    eq(ifkpCodeFor(69), [5, 29], "E is 5 29");
    eq(ifkpCodeFor(49), [1, 30], "1 is 1 30");
    eq(ifkpCodeFor(63), [28, 29], "? is 28 29");
    eq(ifkpCodeFor(247), [11, 31], "÷ is 11 31");
    eq(ifkpCodeFor(248), [12, 31], "and fldigi's odd one: ø (248) goes as 12 31, which reads as °");
    eq(ifkpCodeFor(0), [0], "the idle is the one nibble 0 (send_idle, ifkp.cxx:717-720)");

    const chars: number[] = [10];
    for (let c = 32; c < 127; c++) chars.push(c);
    chars.push(163, 176, 177, 215, 247);
    const d = new Ifk33VaricodeDecoder(IFKP_VARICODE);
    const got: number[] = [];
    for (const n of [...chars.flatMap((c) => ifkpCodeFor(c)), 0]) {
      const r = d.push(n);
      if (r !== null) got.push(r);
    }
    eq(got, chars, `all ${chars.length} characters stream through the decoder and read back`);
    const d2 = new Ifk33VaricodeDecoder(IFKP_VARICODE);
    eq([d2.push(0), d2.push(0), d2.push(5)], [null, 0, 0], "the idle reads as NUL, which prints nothing");
  }

  console.log("\nIFK, known answers worked by hand from send_symbol (ifkp.cxx:711-715)");
  {
    // The over "et": two idles, e, t, one idle = nibbles 0 0 5 20 0. From tone 0, each tone
    // is the last + nibble + IFKP_OFFSET (1), mod 33: 0+0+1=1, 1+0+1=2, 2+5+1=8, 8+20+1=29, 29+0+1=30.
    const nib = ifkpNibbles("et");
    eq(nib, [0, 0, 5, 20, 0], "the over 'et' is idle, idle, e, t, idle (tx_process, ifkp.cxx:1060-1104)");
    eq(ifk33Tones(nib), [1, 2, 8, 29, 30], "and its tones are 1 2 8 29 30");
    // "Hi k": H = 8 29, i = 9, space = 28, k = 11. 2+8+1=11, 11+29+1=41->8, 8+9+1=18,
    // 18+28+1=47->14, 14+11+1=26, 26+0+1=27.
    eq(ifk33Tones(ifkpNibbles("Hi k")), [1, 2, 11, 8, 18, 14, 26, 27], "'Hi k' is 1 2 11 8 18 14 26 27");
    const all = ifkpNibbles(LINE);
    const tones = ifk33Tones(all);
    let inverse = true;
    for (let i = 1; i < tones.length; i++) if (ifk33NibbleBetween(tones[i - 1]!, tones[i]!) !== all[i]) inverse = false;
    ok(inverse, "the receiver's difference reads every nibble back");
    ok(tones.every((t, i) => i === 0 || t !== tones[i - 1]), "and no tone is ever repeated");
  }

  console.log("\nthe waveform");
  for (const fs of [12_000, 24_000, 48_000]) {
    for (const speed of IFKP_SPEEDS) {
      const wave = ifkpWaveform("cq", { sampleRate: fs, centreHz: 1500, speed });
      const ms = ifkpDurationMs("cq", { speed });
      ok(Math.abs(wave.length - (ms * fs) / 1000) <= 0.5, `IFKP ${speed} at ${fs} Hz: ${wave.length} samples is the ${ms.toFixed(1)} ms the duration says`);
    }
  }
  {
    const fs = 12_000;
    const speed: IfkpSpeed = "2";
    const wave = ifkpWaveform("Hi k", { sampleRate: fs, centreHz: 1500, speed });
    const sym = (ifkpParams(speed).symbolLen * fs) / IFKP_BASE_RATE;
    const heard: number[] = [];
    for (let k = 0; k < 8; k++) {
      let best = 0;
      let bestMag = 0;
      for (let t = 0; t < IFK33_TONES; t++) {
        const m = toneMag(wave, k * sym, (k + 1) * sym, ifkpToneHz(t, 1500), fs);
        if (m > bestMag) {
          bestMag = m;
          best = t;
        }
      }
      heard.push(best);
    }
    eq(heard, [1, 2, 11, 8, 18, 14, 26, 27], "the audio carries those tones, symbol by symbol, on fldigi's frequencies");
    let peak = 0;
    for (const v of wave) peak = Math.max(peak, Math.abs(v));
    ok(peak <= 1.0001 && peak > 0.99, "full scale and no more", `${peak}`);
    ok(Math.abs(wave[0]!) < 0.01 && Math.abs(wave[wave.length - 1]!) < 0.05, "starts and ends at zero: no click");
    const maxStep = (2 * Math.PI * ifkpToneHz(32, 1500)) / fs;
    let jump = 0;
    for (let i = 1; i < wave.length; i++) jump = Math.max(jump, Math.abs(wave[i]! - wave[i - 1]!));
    ok(jump <= maxStep * 1.01, `phase-continuous across tone changes (largest step ${jump.toFixed(3)}, limit ${maxStep.toFixed(3)})`);
  }

  console.log("\nthe demodulator on a clean signal");
  for (const fs of [12_000, 24_000, 48_000]) {
    for (const speed of IFKP_SPEEDS) {
      const wave = thenSilence(ifkpWaveform(LINE, { sampleRate: fs, centreHz: 1500, speed, amplitude: 0.5 }), TAIL_S * 2, fs);
      const text = decodeAll(new IfkpDemodulator({ sampleRate: fs, centreHz: 1500, speed }), wave);
      ok(text === LINE, `IFKP ${speed} at ${fs} Hz reads back exactly`, JSON.stringify(text));
    }
  }
  {
    const fs = 12_000;
    const speed: IfkpSpeed = "1";
    const body = "de KC9QRS: 73, £5 ±1\nnext line? ok";
    const wave = thenSilence(ifkpWaveform(body, { sampleRate: fs, centreHz: 1500, speed }), TAIL_S, fs);
    const demod = new IfkpDemodulator({ sampleRate: fs, centreHz: 1500, speed });
    const text = decodeAll(demod, wave);
    eq(text, body, "a newline, capitals, punctuation and the Latin-1 signs come back whole; the idles print nothing");
    eq(demod.statistics.errors, 0, "nothing unread");
    eq(demod.statistics.chars, text.length, "and the character count says so");
    const mid = new IfkpDemodulator({ sampleRate: fs, centreHz: 1500, speed });
    mid.feed(ifkpWaveform(body, { sampleRate: fs, centreHz: 1500, speed }));
    ok(Math.abs(mid.statistics.level - 1) < 0.1, `the level reads the tone's amplitude (${mid.statistics.level.toFixed(2)})`);
    ok(mid.statistics.quality > 0.9 && mid.statistics.open, `quality near 1 on a clean signal (${mid.statistics.quality.toFixed(2)})`);
    for (const chunk of [1, 97]) {
      const t = decodeAll(new IfkpDemodulator({ sampleRate: fs, centreHz: 1500, speed }), wave, chunk);
      eq(t, text, `fed ${chunk === 1 ? "one sample at a time" : `in chunks of ${chunk}`} the text is the same`);
    }
    const w48 = thenSilence(ifkpWaveform(LINE, { sampleRate: 48_000, centreHz: 1500, speed: "2" }), TAIL_S, 48_000);
    const whole = decodeAll(new IfkpDemodulator({ sampleRate: 48_000, centreHz: 1500, speed: "2" }), w48);
    const ones = decodeAll(new IfkpDemodulator({ sampleRate: 48_000, centreHz: 1500, speed: "2" }), w48, 1);
    ok(ones === whole && whole === LINE, "and at 48 kHz in IFKP 2.0, one sample at a time");
  }
  {
    const fs = 24_000;
    const speed: IfkpSpeed = "2";
    const demod = new IfkpDemodulator({ sampleRate: fs, centreHz: 1000, speed });
    demod.retune(1800);
    const t = decodeAll(demod, thenSilence(ifkpWaveform(LINE, { sampleRate: fs, centreHz: 1800, speed }), TAIL_S, fs));
    eq(t, LINE, "retuned to 1800 Hz, it reads a signal there");
    const half = ifkpWaveform(LINE, { sampleRate: fs, centreHz: 1800, speed });
    demod.feed(half.subarray(0, half.length >> 1));
    demod.reset();
    const t2 = decodeAll(demod, thenSilence(ifkpWaveform("de kc9qrs", { sampleRate: fs, centreHz: 1800, speed }), TAIL_S, fs));
    eq(t2, "de kc9qrs", "and after a reset mid-over, the next over and nothing of the last");
  }

  console.log("\noff frequency and off clock");
  for (const speed of IFKP_SPEEDS) {
    for (const off of [4, -7, 30, -60]) {
      const fs = 12_000;
      const tones = ifk33Tones(ifkpNibbles(LINE));
      const sps = (ifkpParams(speed).symbolLen * fs) / IFKP_BASE_RATE;
      const wave = thenSilence(ifk33Audio(tones, (n) => ifkpToneHz(n, 1500) + off, sps, fs, 0.5), TAIL_S * 2, fs);
      const demod = new IfkpDemodulator({ sampleRate: fs, centreHz: 1500, speed });
      const t = decodeAll(demod, wave);
      ok(
        t === LINE && Math.abs(demod.statistics.afcHz - off) <= IFKP_TONE_SPACING_HZ / 2,
        `IFKP ${speed} ${off > 0 ? "+" : ""}${off} Hz off reads, and the offset is seen (${demod.statistics.afcHz.toFixed(1)} Hz)`,
        JSON.stringify(t),
      );
    }
  }
  {
    const wave = thenSilence(ifkpWaveform(LINE + " " + LINE, { sampleRate: 12_006, centreHz: 1500, speed: "2" }), TAIL_S, 12_000);
    const t = decodeAll(new IfkpDemodulator({ sampleRate: 12_000, centreHz: 1500, speed: "2" }), wave);
    eq(t, `${LINE} ${LINE}`, "IFKP 2.0 from a sound card 500 ppm fast reads back");
  }

  console.log("\nin noise (S/N in 2.5 kHz)");
  {
    // Levels where each speed copies cleanly; most characters still read about 3 dB lower.
    const levels: [IfkpSpeed, number][] = [["0.5", -15], ["1", -11], ["2", -9]];
    for (const [speed, snr] of levels) {
      const fs = 12_000;
      const clean = ifkpWaveform(LINE, { sampleRate: fs, centreHz: 1500, speed, amplitude: 0.5 });
      for (const seed of [7, 8, 9]) {
        const t = decodeAll(new IfkpDemodulator({ sampleRate: fs, centreHz: 1500, speed }), withNoise(clean, snr, fs, seed));
        ok(t === LINE, `IFKP ${speed} at ${snr} dB reads back, nothing before or after it (seed ${seed})`, JSON.stringify(t));
      }
    }
    for (const [speed, snr] of [["0.5", -17], ["1", -14], ["2", -12]] as [IfkpSpeed, number][]) {
      const fs = 24_000;
      const clean = ifkpWaveform(LINE, { sampleRate: fs, centreHz: 1500, speed, amplitude: 0.5 });
      const t = decodeAll(new IfkpDemodulator({ sampleRate: fs, centreHz: 1500, speed }), withNoise(clean, snr, fs));
      let hits = 0;
      const words = LINE.split(" ");
      for (const w of words) if (t.includes(w)) hits++;
      ok(hits >= words.length / 2, `IFKP ${speed} at ${snr} dB: half the words or more still read (${hits} of ${words.length})`, JSON.stringify(t));
    }
  }

  console.log("\nnoise alone, and silence: nothing prints");
  for (const speed of IFKP_SPEEDS) {
    const fs = 12_000;
    const g = noiseSource(199 + Number(speed) * 10);
    const wave = new Float32Array(fs * 60);
    for (let i = 0; i < wave.length; i++) wave[i] = 0.3 * g();
    const demod = new IfkpDemodulator({ sampleRate: fs, centreHz: 1500, speed });
    const text = decodeAll(demod, wave, 4096);
    ok(text.length <= 2, `IFKP ${speed}: sixty seconds of band noise prints next to nothing (${text.length} characters)`, JSON.stringify(text));
    ok(demod.statistics.quality < 0.15 && !demod.statistics.open, `  quality reads as noise (${demod.statistics.quality.toFixed(2)})`);
    if (speed === "1") {
      const junk = decodeAll(new IfkpDemodulator({ sampleRate: fs, centreHz: 1500, speed, squelch: 0 }), wave);
      ok(junk.length > 50, `  with the squelch off the same noise prints junk (${junk.length} characters), which is the squelch's job`);
    }
  }
  for (const speed of IFKP_SPEEDS) {
    const fs = 48_000;
    const wave = thenSilence(ifkpWaveform(LINE, { sampleRate: fs, centreHz: 1500, speed }), 4, fs);
    const demod = new IfkpDemodulator({ sampleRate: fs, centreHz: 1500, speed });
    const t = decodeAll(demod, wave, 4800);
    ok(t === LINE, `IFKP ${speed}: four seconds of digital silence after an over prints nothing`, JSON.stringify(t));
    ok(!demod.statistics.open && demod.statistics.level < 1e-4, `  and the squelch is shut on it (quality ${demod.statistics.quality.toFixed(2)})`);
  }
  {
    const fs = 12_000;
    let extra = 0;
    for (let seed = 1; seed <= 9; seed++) {
      const speed = IFKP_SPEEDS[seed % IFKP_SPEEDS.length]!;
      const clean = ifkpWaveform(LINE, { sampleRate: fs, centreHz: 1500, speed, amplitude: 0.5 });
      const t = decodeAll(new IfkpDemodulator({ sampleRate: fs, centreHz: 1500, speed }), withNoise(clean, 0, fs, seed));
      const i = t.indexOf(LINE);
      extra += i < 0 ? 99 : t.length - LINE.length;
    }
    ok(extra <= 1, `nine strong overs between stretches of noise: ${extra} characters of the noise either side printed`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
