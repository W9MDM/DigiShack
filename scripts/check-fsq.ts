/* eslint-disable no-console */
// FSQ: the speeds and tone placement, the Varicode, the IFK tone arithmetic against
// sequences worked by hand from fldigi's code, the waveform, and the demodulator on
// generated signals - clean, at every rate the radios give, chunked, off frequency, on a
// mismatched clock, in noise - and on noise and digital silence alone, where nothing may
// print.

import {
  FSQ_BANDWIDTH_HZ,
  FSQ_BASE_RATE,
  FSQ_SPEEDS,
  FSQ_TONE_SPACING_HZ,
  FSQ_VARICODE,
  IFK33_TONES,
  Ifk33VaricodeDecoder,
  fsqBaseBin,
  fsqCodeFor,
  fsqCrc8,
  fsqDurationMs,
  fsqNibbles,
  fsqOverText,
  fsqParams,
  fsqToneHz,
  fsqWaveform,
  ifk33Audio,
  ifk33NibbleBetween,
  ifk33Tones,
  type FsqSpeed,
} from "@/lib/digital/fsq";
import { FsqDemodulator } from "@/lib/digital/fsqdemod";

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

function decodeAll(demod: FsqDemodulator, wave: Float32Array, chunk = wave.length): string {
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

const CALL = "KC9QRS";
const LINE = "CQ CQ CQ de KC9QRS KC9QRS EM48sq pse K";
/**
 * What an over of LINE from KC9QRS prints. The over is " " " \n" "KC9QRS:" LINE "\n" " ":
 * the first symbol has no tone before it to step from, so the first space is never read;
 * the second prints when the LF's nibble completes it; the final space never completes.
 */
const HEARD = ` \n${CALL}:${LINE}\n`;
/** Silence after an over long enough for the last character's hold (three symbols) at the slowest speed. */
const TAIL_S = 5;

async function main(): Promise<void> {
  console.log("\nthe speeds and the tones (fsq.h:41-43, fsq.cxx:185, 260, 297-338)");
  {
    const want: Record<FsqSpeed, number> = { "1.5": 8192, "2": 6144, "3": 4096, "4.5": 3072, "6": 2048 };
    for (const s of FSQ_SPEEDS) {
      const p = fsqParams(s);
      ok(p.symbolLen === want[s] && Math.abs(p.baud - 12000 / want[s]) < 1e-12, `FSQ ${s}: ${p.symbolLen} samples at 12 kHz, ${p.baud.toFixed(3)} baud`);
    }
    ok(Math.abs(FSQ_TONE_SPACING_HZ - 8.7890625) < 1e-12, `tones 3 x 12000 / 4096 = ${FSQ_TONE_SPACING_HZ} Hz apart at every speed`);
    eq(FSQ_BANDWIDTH_HZ, 290, "fldigi's bandwidth: 33 x 3 x 12000 / 4096 in integers, 290");
    // set_freq: ceil((1500 - 145) * 4096 / 12000) = ceil(462.51) = 463, less 463 % 3 = 1: bin 462.
    eq(fsqBaseBin(1500), 462, "on 1500 Hz tone 0 is FFT bin 462");
    ok(Math.abs(fsqToneHz(0, 1500) - 1353.515625) < 1e-9 && Math.abs(fsqToneHz(32, 1500) - 1634.765625) < 1e-9, `and the tones run ${fsqToneHz(0, 1500).toFixed(2)} to ${fsqToneHz(32, 1500).toFixed(2)} Hz`);
    // ceil((1000 - 145) * 4096 / 12000) = ceil(291.84) = 292, less 1: 291.
    eq(fsqBaseBin(1000), 291, "on 1000 Hz bin 291: always a multiple of three, a fixed grid");
    ok(fsqBaseBin(1503) === fsqBaseBin(1500), "so a few hertz either way lands on the same tones, as in fldigi");
  }

  console.log("\nthe Varicode (fsq_varicode.cxx)");
  {
    // Entries copied from fldigi's encoding table, fsq_varicode[][2].
    eq(fsqCodeFor(32), [0], "space is the one nibble 0");
    eq(fsqCodeFor(101), [5], "e is 5");
    eq(fsqCodeFor(10), [28], "LF is the one nibble 28 ({28, 0})");
    eq(fsqCodeFor(46), [27], "full stop is 27");
    eq(fsqCodeFor(69), [5, 29], "E is 5 29");
    eq(fsqCodeFor(49), [1, 30], "1 is 1 30");
    eq(fsqCodeFor(64), [0, 29], "@ is 0 29");
    eq(fsqCodeFor(63), [28, 29], "? is 28 29");
    eq(fsqCodeFor(8), [27, 31], "BS is 27 31");
    eq(fsqCodeFor(127), [28, 31], "DEL is 28 31");
    eq(fsqCodeFor(163), [14, 31], "£ is 14 31");
    eq(fsqCodeFor(0), [28, 30], "the idle is 28 30 (send_idle, fsq.cxx:1374-1378)");
    eq(fsqCodeFor(13), [], "CR has no code of its own, and is not sent");

    const chars: number[] = [10];
    for (let c = 32; c < 127; c++) chars.push(c);
    chars.push(163, 176, 177, 215, 247);
    let shape = true;
    for (const c of chars) {
      const n = fsqCodeFor(c);
      if (!(n.length === 1 && n[0]! < 29) && !(n.length === 2 && n[0]! < 29 && n[1]! >= 29 && n[1]! <= 31)) shape = false;
    }
    ok(shape, "every character is one nibble under 29, or one under 29 and one of 29-31");
    const d = new Ifk33VaricodeDecoder(FSQ_VARICODE);
    const got: number[] = [];
    for (const n of [...chars.flatMap((c) => fsqCodeFor(c)), 0]) {
      const r = d.push(n);
      if (r !== null) got.push(r);
    }
    eq(got, chars, `all ${chars.length} characters stream through the decoder and read back`);
    const d2 = new Ifk33VaricodeDecoder(FSQ_VARICODE);
    eq([d2.push(5), d2.push(29), d2.push(30), d2.push(3)], [null, 69, null, null], "a second-nibble with no first before it completes nothing");
    eq(fsqCrc8("123456789"), "f4", "fldigi's CRC8 (poly 7, init 0) gives the standard check value f4");
  }

  console.log("\nIFK, known answers worked by hand from send_symbol (fsq.cxx:1367-1372)");
  {
    // The over "et": " " " \n" "et" "\n" " " = nibbles 0 0 28 5 20 28 0. From tone 0,
    // each tone is the last + nibble + 1, mod 33:
    //   0+0+1=1, 1+0+1=2, 2+28+1=31, 31+5+1=37->4, 4+20+1=25, 25+28+1=54->21, 21+0+1=22.
    const nib = fsqNibbles("et");
    eq(nib, [0, 0, 28, 5, 20, 28, 0], "the over 'et' is space, space, LF, e, t, LF, space");
    eq(ifk33Tones(nib), [1, 2, 31, 4, 25, 21, 22], "and its tones are 1 2 31 4 25 21 22");
    eq(fsqOverText("hi", { mycall: CALL }), `  \n${CALL}:hi\n `, "fldigi's header: space, FSQBOL, mycall and a colon; FSQEOL to end");
    eq(fsqOverText("hi", { mycall: CALL, directed: true }), `  \n${CALL}:${fsqCrc8(CALL)}hi  \b  `, "directed: the CRC8 of the call after the colon, FSQEOT to end");
    // "A?" in the middle: A = 1 29, ? = 28 29. From tone 2: 2+1+1=4, 4+29+1=34->1, 1+28+1=30, 30+29+1=60->27.
    eq(ifk33Tones([1, 29, 28, 29], 2), [4, 1, 30, 27], "two-nibble characters wrap round the 33 tones: A? from tone 2 is 4 1 30 27");
    const tones = ifk33Tones(fsqNibbles(LINE, { mycall: CALL }));
    let inverse = true;
    let zero = false;
    const all = fsqNibbles(LINE, { mycall: CALL });
    for (let i = 1; i < tones.length; i++) {
      if (ifk33NibbleBetween(tones[i - 1]!, tones[i]!) !== all[i]) inverse = false;
      if (tones[i] === tones[i - 1]) zero = true;
    }
    ok(inverse, "the receiver's difference reads every nibble back");
    ok(!zero && tones.every((t) => t >= 0 && t < IFK33_TONES), "and no tone is ever repeated");
  }

  console.log("\nthe waveform");
  for (const fs of [12_000, 24_000, 48_000]) {
    for (const speed of FSQ_SPEEDS) {
      const wave = fsqWaveform("CQ", { sampleRate: fs, centreHz: 1500, speed, mycall: CALL });
      const ms = fsqDurationMs("CQ", { speed, mycall: CALL });
      ok(Math.abs(wave.length - (ms * fs) / 1000) <= 0.5, `FSQ ${speed} at ${fs} Hz: ${wave.length} samples is the ${ms.toFixed(1)} ms the duration says`);
    }
  }
  {
    const fs = 12_000;
    const speed: FsqSpeed = "6";
    const wave = fsqWaveform("et", { sampleRate: fs, centreHz: 1500, speed });
    const sym = fsqParams(speed).symbolLen;
    const heard: number[] = [];
    for (let k = 0; k < 7; k++) {
      let best = 0;
      let bestMag = 0;
      for (let t = 0; t < IFK33_TONES; t++) {
        const m = toneMag(wave, k * sym, (k + 1) * sym, fsqToneHz(t, 1500), fs);
        if (m > bestMag) {
          bestMag = m;
          best = t;
        }
      }
      heard.push(best);
    }
    eq(heard, [1, 2, 31, 4, 25, 21, 22], "the audio carries those tones, symbol by symbol, on fldigi's frequencies");
    let peak = 0;
    for (const v of wave) peak = Math.max(peak, Math.abs(v));
    ok(peak <= 1.0001 && peak > 0.99, "full scale and no more", `${peak}`);
    ok(Math.abs(wave[0]!) < 0.01 && Math.abs(wave[wave.length - 1]!) < 0.05, "starts and ends at zero: no click");
    const maxStep = (2 * Math.PI * fsqToneHz(32, 1500)) / fs;
    let jump = 0;
    for (let i = 1; i < wave.length; i++) jump = Math.max(jump, Math.abs(wave[i]! - wave[i - 1]!));
    ok(jump <= maxStep * 1.01, `phase-continuous across tone changes (largest step ${jump.toFixed(3)}, limit ${maxStep.toFixed(3)})`);
  }

  console.log("\nthe demodulator on a clean signal");
  for (const fs of [12_000, 24_000, 48_000]) {
    for (const speed of FSQ_SPEEDS) {
      const wave = thenSilence(fsqWaveform(LINE, { sampleRate: fs, centreHz: 1500, speed, mycall: CALL, amplitude: 0.5 }), TAIL_S, fs);
      const text = decodeAll(new FsqDemodulator({ sampleRate: fs, centreHz: 1500, speed }), wave);
      ok(text === HEARD, `FSQ ${speed} at ${fs} Hz reads back exactly`, JSON.stringify(text));
    }
  }
  {
    const fs = 12_000;
    const speed: FsqSpeed = "4.5";
    const body = "KC9QRS: 73 £5 ±1 de KC9QRS\nnext line?";
    const wave = thenSilence(fsqWaveform(body, { sampleRate: fs, centreHz: 1500, speed }), TAIL_S, fs);
    const demod = new FsqDemodulator({ sampleRate: fs, centreHz: 1500, speed });
    const text = decodeAll(demod, wave);
    eq(text, ` \n${body}\n`, "a newline, punctuation and the Latin-1 signs come back whole");
    eq(demod.statistics.errors, 0, "nothing unread");
    eq(demod.statistics.chars, text.length, "and the character count says so");
    const mid = new FsqDemodulator({ sampleRate: fs, centreHz: 1500, speed });
    mid.feed(fsqWaveform(body, { sampleRate: fs, centreHz: 1500, speed }));
    ok(Math.abs(mid.statistics.level - 1) < 0.1, `the level reads the tone's amplitude (${mid.statistics.level.toFixed(2)})`);
    ok(mid.statistics.quality > 0.9 && mid.statistics.open, `quality near 1 on a clean signal (${mid.statistics.quality.toFixed(2)})`);
    for (const chunk of [1, 97]) {
      const t = decodeAll(new FsqDemodulator({ sampleRate: fs, centreHz: 1500, speed }), wave, chunk);
      eq(t, text, `fed ${chunk === 1 ? "one sample at a time" : `in chunks of ${chunk}`} the text is the same`);
    }
    const w48 = thenSilence(fsqWaveform(LINE, { sampleRate: 48_000, centreHz: 1500, speed: "6", mycall: CALL }), TAIL_S, 48_000);
    const whole = decodeAll(new FsqDemodulator({ sampleRate: 48_000, centreHz: 1500, speed: "6" }), w48);
    const ones = decodeAll(new FsqDemodulator({ sampleRate: 48_000, centreHz: 1500, speed: "6" }), w48, 1);
    ok(ones === whole && whole === HEARD, "and at 48 kHz in FSQ 6, one sample at a time");
  }
  {
    const fs = 24_000;
    const speed: FsqSpeed = "3";
    const directed = thenSilence(fsqWaveform(LINE, { sampleRate: fs, centreHz: 1500, speed, mycall: CALL, directed: true }), TAIL_S, fs);
    const t = decodeAll(new FsqDemodulator({ sampleRate: fs, centreHz: 1500, speed }), directed);
    eq(t, ` \n${CALL}:${fsqCrc8(CALL)}${LINE}  \n `, "a directed over prints its CRC as sent, and FSQEOT's BS ends the line");
  }
  {
    const fs = 24_000;
    const speed: FsqSpeed = "6";
    const demod = new FsqDemodulator({ sampleRate: fs, centreHz: 1000, speed });
    demod.retune(1800);
    const t = decodeAll(demod, thenSilence(fsqWaveform(LINE, { sampleRate: fs, centreHz: 1800, speed, mycall: CALL }), TAIL_S, fs));
    eq(t, HEARD, "retuned to 1800 Hz, it reads a signal there");
    // Half an over, then a reset (an RSID burst), then a whole one.
    const half = fsqWaveform(LINE, { sampleRate: fs, centreHz: 1800, speed, mycall: CALL });
    demod.feed(half.subarray(0, half.length >> 1));
    demod.reset();
    const t2 = decodeAll(demod, thenSilence(fsqWaveform("de KC9QRS", { sampleRate: fs, centreHz: 1800, speed }), TAIL_S, fs));
    eq(t2, " \nde KC9QRS\n", "and after a reset mid-over, the next over and nothing of the last");
  }

  console.log("\noff frequency and off clock");
  for (const speed of FSQ_SPEEDS) {
    for (const off of [4, -7, 30, -50]) {
      const fs = 12_000;
      // fldigi's tones on 1500 Hz, every one moved by `off`: a transmitter or receiver off
      // frequency (changing the centre alone would mostly land on the same grid of tones).
      const tones = ifk33Tones(fsqNibbles(LINE, { mycall: CALL }));
      const sps = (fsqParams(speed).symbolLen * fs) / FSQ_BASE_RATE;
      const wave = thenSilence(ifk33Audio(tones, (n) => fsqToneHz(n, 1500) + off, sps, fs, 0.5), TAIL_S, fs);
      const demod = new FsqDemodulator({ sampleRate: fs, centreHz: 1500, speed });
      const t = decodeAll(demod, wave);
      ok(
        t === HEARD && Math.abs(demod.statistics.afcHz - off) <= FSQ_TONE_SPACING_HZ / 2,
        `FSQ ${speed} ${off > 0 ? "+" : ""}${off} Hz off reads, and the offset is seen (${demod.statistics.afcHz.toFixed(1)} Hz)`,
        JSON.stringify(t),
      );
    }
  }
  {
    // Generated at 12 006 Hz and read at 12 000: a sound card 500 ppm off.
    const wave = thenSilence(fsqWaveform(LINE + " " + LINE, { sampleRate: 12_006, centreHz: 1500, speed: "6", mycall: CALL }), TAIL_S, 12_000);
    const t = decodeAll(new FsqDemodulator({ sampleRate: 12_000, centreHz: 1500, speed: "6" }), wave);
    eq(t, ` \n${CALL}:${LINE} ${LINE}\n`, "FSQ 6 from a sound card 500 ppm fast reads back");
  }

  console.log("\nin noise (S/N in 2.5 kHz)");
  {
    const body = `${CALL}:${LINE}`;
    // Levels where each speed copies cleanly; most characters still read about 3 dB lower.
    const levels: [FsqSpeed, number][] = [["1.5", -16], ["2", -15], ["3", -13], ["4.5", -12], ["6", -10]];
    for (const [speed, snr] of levels) {
      const fs = 12_000;
      const clean = fsqWaveform(LINE, { sampleRate: fs, centreHz: 1500, speed, mycall: CALL, amplitude: 0.5 });
      for (const seed of [7, 8, 9]) {
        const t = decodeAll(new FsqDemodulator({ sampleRate: fs, centreHz: 1500, speed }), withNoise(clean, snr, fs, seed));
        // The preamble (space, LF) may lose or gain a character to the noise before it.
        const at = t.indexOf(`\n${body}`);
        ok(at >= 0 && at <= 2 && t.slice(at) === `\n${body}\n`, `FSQ ${speed} at ${snr} dB reads back, nothing after it (seed ${seed})`, JSON.stringify(t));
      }
    }
    for (const [speed, snr] of [["1.5", -18], ["3", -15], ["6", -12]] as [FsqSpeed, number][]) {
      const fs = 24_000;
      const clean = fsqWaveform(LINE, { sampleRate: fs, centreHz: 1500, speed, mycall: CALL, amplitude: 0.5 });
      const t = decodeAll(new FsqDemodulator({ sampleRate: fs, centreHz: 1500, speed }), withNoise(clean, snr, fs));
      let hits = 0;
      const words = LINE.split(" ");
      for (const w of words) if (t.includes(w)) hits++;
      ok(hits >= words.length / 2, `FSQ ${speed} at ${snr} dB: half the words or more still read (${hits} of ${words.length})`, JSON.stringify(t));
    }
  }

  console.log("\nnoise alone, and silence: nothing prints");
  for (const speed of FSQ_SPEEDS) {
    const fs = 12_000;
    const g = noiseSource(99 + Number(speed) * 10);
    const wave = new Float32Array(fs * 60);
    for (let i = 0; i < wave.length; i++) wave[i] = 0.3 * g();
    const demod = new FsqDemodulator({ sampleRate: fs, centreHz: 1500, speed });
    const text = decodeAll(demod, wave, 4096);
    ok(text.length <= 2, `FSQ ${speed}: sixty seconds of band noise prints next to nothing (${text.length} characters)`, JSON.stringify(text));
    ok(demod.statistics.quality < 0.15 && !demod.statistics.open, `  quality reads as noise (${demod.statistics.quality.toFixed(2)})`);
    if (speed === "4.5") {
      const junk = decodeAll(new FsqDemodulator({ sampleRate: fs, centreHz: 1500, speed, squelch: 0 }), wave);
      ok(junk.length > 50, `  with the squelch off the same noise prints junk (${junk.length} characters), which is the squelch's job`);
    }
  }
  for (const speed of FSQ_SPEEDS) {
    const fs = 48_000;
    // A strong over, then four seconds of exact zeros: nothing after the over's own text.
    const wave = thenSilence(fsqWaveform(LINE, { sampleRate: fs, centreHz: 1500, speed, mycall: CALL }), 4, fs);
    const demod = new FsqDemodulator({ sampleRate: fs, centreHz: 1500, speed });
    const t = decodeAll(demod, wave, 4800);
    ok(t === HEARD, `FSQ ${speed}: four seconds of digital silence after an over prints nothing`, JSON.stringify(t));
    ok(!demod.statistics.open && demod.statistics.level < 1e-4, `  and the squelch is shut on it (quality ${demod.statistics.quality.toFixed(2)}, level ${demod.statistics.level.toExponential(1)})`);
  }
  {
    // A strong over, then band noise: the noise after it must not print. Ten overs.
    const fs = 12_000;
    let extra = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const speed = FSQ_SPEEDS[seed % FSQ_SPEEDS.length]!;
      const clean = fsqWaveform(LINE, { sampleRate: fs, centreHz: 1500, speed, mycall: CALL, amplitude: 0.5 });
      const t = decodeAll(new FsqDemodulator({ sampleRate: fs, centreHz: 1500, speed }), withNoise(clean, 0, fs, seed));
      const i = t.indexOf(`${LINE}\n`);
      extra += i < 0 ? 99 : t.length - i - LINE.length - 1;
    }
    ok(extra <= 1, `ten strong overs followed by noise: ${extra} characters of the noise after them printed`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
