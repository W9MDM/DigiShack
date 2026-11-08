/* eslint-disable no-console */
// Thor: the submode table, the Varicode, the IFK+ tones against sequences worked by hand
// from fldigi's code (both convolutional codes), the waveform, and the demodulator on
// generated signals - clean, at every rate the radios give, chunked, off frequency, on a
// mismatched clock, in noise, with symbols deliberately wrecked - and on noise and digital
// silence alone, where nothing may print.

import { Interleaver, parity, ViterbiDecoder } from "@/lib/digital/fec";
import { MFSK_VARICODE } from "@/lib/digital/mfsk-varicode";
import {
  THOR_K15_POLY1,
  THOR_K15_POLY2,
  THOR_MODES,
  THOR_TONES,
  ThorVaricodeDecoder,
  thorCharForCode,
  thorDurationMs,
  thorParams,
  thorSymbols,
  thorToneHz,
  thorTonesWaveform,
  thorVaricodeFor,
  thorWaveform,
  type ThorMode,
} from "@/lib/digital/thor";
import { ThorDemodulator } from "@/lib/digital/thordemod";
import { dominoexWaveform } from "@/lib/digital/dominoex";
import { DominoexDemodulator } from "@/lib/digital/dominoexdemod";

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

/**
 * The time for an over's last bits to come out of the receiver after the signal stops:
 * the interleaver's 3 x depth symbols and the decoder's traceback, two bits a symbol, with
 * room. The receiver keeps listening between overs, so the tests do too.
 */
function drainSeconds(mode: ThorMode): number {
  const p = thorParams(mode);
  return (3 * p.depth + p.traceback / 2 + 20) / p.baud;
}

/**
 * White noise for a signal-to-noise ratio measured in a 2.5 kHz bandwidth, the usual SSB
 * reference, over the signal's own average power. A second of noise before the signal and
 * the drain time after it, so the decoder starts on an empty channel and the end comes out.
 */
function withNoise(wave: Float32Array, snrDb: number, fs: number, mode: ThorMode, seed = 7): Float32Array {
  let p = 0;
  for (const v of wave) p += v * v;
  const noisePower = (p / wave.length / 10 ** (snrDb / 10)) * (fs / 2 / 2500);
  const g = noiseSource(seed);
  const sigma = Math.sqrt(noisePower);
  const pad = fs;
  const out = new Float32Array(wave.length + pad + Math.round(drainSeconds(mode) * fs));
  for (let i = 0; i < out.length; i++) out[i] = (wave[i - pad] ?? 0) + sigma * g();
  return out;
}

/** The over followed by digital silence for the drain time: a FlexRadio's DAX between overs. */
function withSilence(wave: Float32Array, fs: number, mode: ThorMode, seconds = drainSeconds(mode)): Float32Array {
  const out = new Float32Array(wave.length + Math.round(seconds * fs));
  out.set(wave);
  return out;
}

function decodeAll(demod: ThorDemodulator, wave: Float32Array, chunk = wave.length): string {
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

const LINE = "CQ CQ CQ de KC9QRS KC9QRS EM48sq pse K";

async function main(): Promise<void> {
  console.log("\nthe submodes, as fldigi's constructor sets them (thor.cxx:217-410)");
  {
    // mode: [baud, spacing Hz, depth, flush idles, K]
    const want: Record<ThorMode, [number, number, number, number, number]> = {
      "4": [8000 / 2048, 2 * (8000 / 2048), 10, 4, 7],
      "5": [11025 / 2048, 2 * (11025 / 2048), 10, 4, 7],
      "8": [8000 / 1024, 2 * (8000 / 1024), 10, 4, 7],
      "11": [11025 / 1024, 11025 / 1024, 10, 8, 7],
      "16": [8000 / 512, 8000 / 512, 10, 8, 7],
      "22": [11025 / 512, 11025 / 512, 10, 16, 7],
      "25x4": [25, 100, 50, 40, 15],
      "50x1": [50, 50, 50, 40, 15],
      "50x2": [50, 100, 50, 40, 15],
      "100": [100, 100, 50, 40, 15],
    };
    for (const m of THOR_MODES) {
      const p = thorParams(m);
      const [baud, spacing, depth, flush, k] = want[m];
      ok(
        Math.abs(p.baud - baud) < 1e-9 && Math.abs(p.toneSpacingHz - spacing) < 1e-9 && p.depth === depth && p.flushLength === flush && p.k === k,
        `Thor ${m}: ${p.baud.toFixed(3)} baud, tones ${p.toneSpacingHz.toFixed(2)} Hz apart, ${p.bandwidthHz.toFixed(0)} Hz wide, interleaver ${p.depth} deep, ${p.flushLength} flush idles, K=${p.k}`,
      );
    }
    const k7 = thorParams("16");
    eq([k7.poly1, k7.poly2, k7.traceback], [0x6d, 0x4f, 45], "the slow submodes' code is NASA K=7, 0x6d 0x4f (thor.h:43-45), traceback 45");
    const k15 = thorParams("100");
    eq([k15.poly1, k15.poly2, k15.traceback], [0o44735, 0o63057, 180], "the fast ones' is K=15, 044735 063057 (thor.h:49-51), traceback 15 x 12");
    const t0 = thorToneHz(0, 1500, "11");
    const t17 = thorToneHz(17, 1500, "11");
    ok(Math.abs(t0 - (1500 - 8.5 * (11025 / 1024))) < 1e-9, `tone 0 of Thor 11 on 1500 is 8.5 spacings down (${t0.toFixed(2)} Hz), as sendtone puts it (thor.cxx:1209)`);
    ok(Math.abs((t0 + t17) / 2 - 1500) < 1e-9, "and the tone set is centred on the frequency, not started from it");
  }

  console.log("\nthe Varicode (thorvaricode.cxx)");
  {
    let same = true;
    for (let b = 0; b < 256; b++) if (thorVaricodeFor(b) !== MFSK_VARICODE[b]) same = false;
    ok(same, "the primary alphabet is MFSK's (thorvarienc calls varienc)");
    let primary = 0;
    for (let b = 0; b < 256; b++) if (thorCharForCode(parseInt(thorVaricodeFor(b), 2)) === b) primary++;
    eq(primary, 256, "every primary character reads back to itself");
    let secondary = 0;
    let above = true;
    let shape = true;
    for (let c = 32; c <= 122; c++) {
      const code = thorVaricodeFor(c, true);
      if (thorCharForCode(parseInt(code, 2)) === c + 256) secondary++;
      if (parseInt(code, 2) < 0xb80) above = false;
      if (!/^1.*00$/.test(code) || code.slice(0, -1).includes("001")) shape = false;
    }
    eq(secondary, 91, "every secondary character, space to z, reads back to itself, flagged secondary");
    ok(above, "and every secondary code reads 0xB80 or more, where thorvaridec looks for them");
    let mfskBelow = true;
    for (const code of MFSK_VARICODE) if (parseInt(code, 2) >= 0xb80) mfskBelow = false;
    ok(mfskBelow, "while every MFSK code reads below it, so the two cannot collide");
    ok(shape, "secondary codes start with 1, end with 00 and hold no 001 before the end, like MFSK's");
    eq(thorVaricodeFor(0x7b, true), MFSK_VARICODE[0], "a secondary character past z goes as a NUL");
    eq(thorVaricodeFor(32, true), "101110000000", "secondary space is 101110000000 (0xB80)");
    eq(thorVaricodeFor(122, true), "111110110000", "secondary z is 111110110000 (0xFB0)");
    for (const sec of [false, true]) {
      const d = new ThorVaricodeDecoder();
      const got: number[] = [];
      const want: number[] = [];
      // Idle 0s first, as the preamble leaves the decoder: then the first 1 starts a code.
      for (let i = 0; i < 40; i++) d.push(0);
      for (let c = 32; c < (sec ? 123 : 127); c++) {
        want.push(sec ? c + 256 : c);
        for (const bit of thorVaricodeFor(c, sec)) {
          const r = d.push(bit === "1" ? 1 : 0);
          if (r !== null) got.push(r);
        }
      }
      const r = d.push(1);
      if (r !== null) got.push(r);
      eq(got, want, `every printable character streams through the bit decoder (${sec ? "secondary" : "primary"} alphabet)`);
    }
    const d = new ThorVaricodeDecoder();
    let none = true;
    for (let i = 0; i < 64; i++) if (d.push(0) !== null) none = false;
    ok(none, "a run of 0s is no character");
  }

  console.log("\nIFK+ and the code, known answers worked by hand from fldigi (thor.cxx:1233-1324)");
  {
    // The preamble is 16 raw symbols of value 0 from tone 0: steps of 2, round the 18 tones.
    const preamble = [2, 4, 6, 8, 10, 12, 14, 16, 0, 2, 4, 6, 8, 10, 12, 14];
    // Then the idle, a NUL, 11101011100, through the encoder, two code bits a data bit
    // (first polynomial first), four to a symbol, through an interleaver Clearbits filled
    // with 0s. Bit 0 of each symbol goes straight through; bits 1-3 come out depth, 2 x
    // depth and 3 x depth symbols later, so the first symbols carry bit 0 alone.
    //   K=7, 0x6d 0x4f (1101101, 1001111), register newest bit lowest:
    //     data 1 -> reg 1:      parity(1101101&1)=1, parity(1001111&1)=1      -> 1 1
    //     data 1 -> reg 11:     parity(01)=1,        parity(11)=0             -> 1 0   symbol 1110 -> bit 0 only: 1000 = 8
    //     data 1 -> reg 111:    parity(101)=0,       parity(111)=1            -> 0 1
    //     data 0 -> reg 1110:   parity(1100)=0,      parity(1110)=1           -> 0 1   symbol 0101 -> 0000 = 0
    //     data 1 -> reg 11101:  parity(01101)=1,     parity(01101)=1          -> 1 1
    //     data 0 -> reg 111010: parity(101000)=0,    parity(001010)=0         -> 0 0   symbol 1100 -> 1000 = 8
    //   tones: 14 + 2 + 8 = 24 -> 6; 6 + 2 + 0 = 8; 8 + 2 + 8 = 18 -> 0.
    //   K=15, 044735 063057 (low six bits 011101, 101111): the first two pairs are the same;
    //     data 1 -> reg 11101:  parity(11101)=0,     parity(01101)=1          -> 0 1
    //     data 0 -> reg 111010: parity(011000)=0,    parity(101010)=1         -> 0 1   symbol 0101 -> 0 -> tone 8 + 2 = 10.
    eq(thorSymbols("et", { mode: "16" }).tones.slice(0, 19), [...preamble, 6, 8, 0], "Thor 16 (K=7): the preamble ladder, then 6 8 0");
    eq(thorSymbols("et", { mode: "50x1" }).tones.slice(0, 19), [...preamble, 6, 8, 10], "Thor 50x1 (K=15): the same ladder, then 6 8 10");
    eq(
      [parity(0x6d & 0b111010), parity(0x4f & 0b111010), parity(THOR_K15_POLY1 & 0b111010), parity(THOR_K15_POLY2 & 0b111010)],
      [0, 0, 0, 1],
      "the parities those rows rest on",
    );

    // The whole stream, from the other end: undo IFK+, de-interleave, decode with the hard
    // bits, read the Varicode - the text and the framing come back.
    for (const mode of ["11", "25x4"] as ThorMode[]) {
      const p = thorParams(mode);
      const { tones } = thorSymbols(LINE, { mode });
      const inlv = new Interleaver(4, p.depth, "rev");
      const dec = new ViterbiDecoder(p.k, p.poly1, p.poly2);
      dec.setTraceback(p.traceback);
      dec.setChunkSize(1);
      const vd = new ThorVaricodeDecoder();
      let minStep = THOR_TONES;
      const bytes: number[] = [];
      const pair: number[] = [];
      const feed = (bits: number[]) => {
        inlv.symbols(bits);
        for (const b of bits) {
          pair.push(b);
          if (pair.length < 2) continue;
          const c = dec.decode(pair[0]!, pair[1]!);
          pair.length = 0;
          if (c < 0) continue;
          const ch = vd.push(c);
          if (ch !== null && ch >= 0) bytes.push(ch);
        }
      };
      for (let i = 16; i < tones.length; i++) {
        const step = (tones[i]! - tones[i - 1]! + THOR_TONES) % THOR_TONES;
        minStep = Math.min(minStep, step);
        const v = step - 2;
        feed([v & 8 ? 255 : 0, v & 4 ? 255 : 0, v & 2 ? 255 : 0, v & 1 ? 255 : 0]);
      }
      // The receiver keeps listening after the over: erasures push the last bits out.
      for (let i = 0; i < 3 * p.depth + p.traceback; i++) feed([128, 128, 128, 128]);
      const text = String.fromCharCode(...bytes.filter((b) => b >= 32));
      ok(text.includes(LINE), `Thor ${mode}: undoing IFK+, the interleaver and the code by hand gives the line back`, JSON.stringify(text));
      ok(bytes.includes(2) && bytes.includes(4), "  framed by STX and EOT");
      ok(minStep >= 2, `  and no step is less than two tones (smallest ${minStep})`);
    }
  }

  console.log("\nthe waveform");
  for (const fs of [12_000, 24_000, 48_000]) {
    for (const mode of ["11", "8", "100"] as ThorMode[]) {
      const wave = thorWaveform("CQ", { sampleRate: fs, centreHz: 1500, mode });
      const ms = thorDurationMs("CQ", { mode });
      ok(Math.abs(wave.length - (ms * fs) / 1000) <= 0.5, `Thor ${mode} at ${fs} Hz: ${wave.length} samples is the ${ms.toFixed(1)} ms the duration says`);
    }
  }
  {
    const fs = 12_000;
    const mode: ThorMode = "16";
    const wave = thorWaveform("et", { sampleRate: fs, centreHz: 1500, mode });
    const p = thorParams(mode);
    const sym = (fs * p.symbolLen) / p.baseRate;
    const want = thorSymbols("et", { mode }).tones.slice(0, 24);
    const heard: number[] = [];
    for (let k = 0; k < want.length; k++) {
      let best = 0;
      let bestMag = 0;
      for (let t = 0; t < THOR_TONES; t++) {
        const m = toneMag(wave, Math.round(k * sym), Math.round((k + 1) * sym), thorToneHz(t, 1500, mode), fs);
        if (m > bestMag) {
          bestMag = m;
          best = t;
        }
      }
      heard.push(best);
    }
    eq(heard, want, "the audio carries those tones, symbol by symbol");
    let peak = 0;
    for (const v of wave) peak = Math.max(peak, Math.abs(v));
    ok(peak <= 1.0001 && peak > 0.99, "full scale and no more", `${peak}`);
    ok(Math.abs(wave[0]!) < 1e-6 && Math.abs(wave[wave.length - 1]!) < 0.01, "starts and ends at zero: the soft start and the faded tail");
    // THOR_RISETIME: every symbol rises and falls over 4 ms, so the level dips to nothing
    // at each boundary - fldigi's waveform, kept so the spectrum matches.
    const b = Math.round(20 * sym);
    let dip = 0;
    for (let i = b - 2; i <= b + 2; i++) dip = Math.max(dip, Math.abs(wave[i]!));
    ok(dip < 0.05, `each symbol has fldigi's 4 ms raised-cosine edges (level ${dip.toFixed(3)} at a boundary)`);
    const { tones, tailSymbols } = thorSymbols("et", { mode });
    eq(tailSymbols, 2, "and the over ends with two symbols of the lowest tone, fading (softTHOR: 800 / 512 + 1 in integers)");
    eq(thorTonesWaveform(tones, tailSymbols, { sampleRate: fs, centreHz: 1500, mode }).length, wave.length, "thorTonesWaveform is the same audio from the tones");
  }

  console.log("\nthe demodulator on a clean signal");
  for (const fs of [12_000, 24_000, 48_000]) {
    for (const mode of ["8", "11", "16", "22"] as ThorMode[]) {
      const wave = withSilence(thorWaveform(LINE, { sampleRate: fs, centreHz: 1500, mode, amplitude: 0.5 }), fs, mode);
      const text = decodeAll(new ThorDemodulator({ sampleRate: fs, centreHz: 1500, mode }), wave);
      ok(text === LINE, `Thor ${mode} at ${fs} Hz reads back exactly`, JSON.stringify(text));
    }
  }
  for (const mode of ["4", "5", "25x4", "50x1", "50x2", "100"] as ThorMode[]) {
    for (const fs of [12_000, 48_000]) {
      const wave = withSilence(thorWaveform(LINE, { sampleRate: fs, centreHz: 1500, mode, amplitude: 0.5 }), fs, mode);
      const text = decodeAll(new ThorDemodulator({ sampleRate: fs, centreHz: 1500, mode }), wave);
      ok(text === LINE, `Thor ${mode} at ${fs} Hz too`, JSON.stringify(text));
    }
  }
  {
    const fs = 12_000;
    const mode: ThorMode = "11";
    const sent = LINE + "\n73 Café";
    const wave = withSilence(thorWaveform(sent, { sampleRate: fs, centreHz: 1500, mode }), fs, mode);
    const demod = new ThorDemodulator({ sampleRate: fs, centreHz: 1500, mode });
    const text = decodeAll(demod, wave);
    eq(text, sent, "a newline and UTF-8 come back whole; the STX and EOT framing prints nothing");
    eq(demod.statistics.errors, 0, "nothing unread");
    eq(demod.statistics.chars, text.length, "and the character count says so");
    const mid = new ThorDemodulator({ sampleRate: fs, centreHz: 1500, mode });
    decodeAll(mid, wave.subarray(0, Math.round(wave.length * 0.6)));
    ok(mid.statistics.quality > 0.9, `quality near 1 mid-over (${mid.statistics.quality.toFixed(2)})`);
    ok(Math.abs(mid.statistics.level - 1) < 0.1, `the level reads the tone's amplitude (${mid.statistics.level.toFixed(2)})`);
    for (const chunk of [1, 97]) {
      const t = decodeAll(new ThorDemodulator({ sampleRate: fs, centreHz: 1500, mode }), wave, chunk);
      eq(t, text, `fed ${chunk === 1 ? "one sample at a time" : `in chunks of ${chunk}`} the text is the same`);
    }
    const w48 = withSilence(thorWaveform(LINE, { sampleRate: 48_000, centreHz: 1500, mode: "100" }), 48_000, "100");
    const whole = decodeAll(new ThorDemodulator({ sampleRate: 48_000, centreHz: 1500, mode: "100" }), w48);
    const ones = decodeAll(new ThorDemodulator({ sampleRate: 48_000, centreHz: 1500, mode: "100" }), w48, 1);
    eq(ones, whole, "and at 48 kHz in Thor 100, one sample at a time");
    eq(whole, LINE, "  which is the line");
  }
  {
    const fs = 24_000;
    const mode: ThorMode = "16";
    const demod = new ThorDemodulator({ sampleRate: fs, centreHz: 1000, mode });
    demod.retune(1800);
    const t = decodeAll(demod, withSilence(thorWaveform(LINE, { sampleRate: fs, centreHz: 1800, mode }), fs, mode));
    eq(t, LINE, "retuned to 1800 Hz, it reads a signal there");
    // Half an over, then a reset (as after an RSID burst), then a whole one: nothing of the
    // first may leak into the second.
    const first = thorWaveform("QRZ? de KC9QRS", { sampleRate: fs, centreHz: 1800, mode });
    decodeAll(demod, first.subarray(0, Math.round(first.length / 2)));
    demod.reset();
    const t2 = decodeAll(demod, withSilence(thorWaveform("de KC9QRS", { sampleRate: fs, centreHz: 1800, mode }), fs, mode));
    eq(t2, "de KC9QRS", "and after a reset mid-over, the next over and nothing of the last");
    eq([demod.statistics.quality > 0, demod.statistics.afcHz === demod.statistics.afcHz], [true, true], "  with its statistics live again");
  }
  {
    // Two overs back to back with silence between, as a QSO goes.
    const fs = 12_000;
    const mode: ThorMode = "22";
    const a = withSilence(thorWaveform("KC9QRS de W1AW K", { sampleRate: fs, centreHz: 1500, mode }), fs, mode, 3);
    const b = withSilence(thorWaveform("W1AW de KC9QRS R 599 EM48sq K", { sampleRate: fs, centreHz: 1500, mode }), fs, mode);
    const both = new Float32Array(a.length + b.length);
    both.set(a);
    both.set(b, a.length);
    eq(decodeAll(new ThorDemodulator({ sampleRate: fs, centreHz: 1500, mode }), both), "KC9QRS de W1AW KW1AW de KC9QRS R 599 EM48sq K", "two overs in a row, each whole, nothing between");
  }
  {
    // Tuned in after the start: no preamble, no STX. A clean signal unmutes on a run of
    // clean text and prints from there.
    const fs = 12_000;
    const mode: ThorMode = "16";
    const long = "the quick brown fox jumps over the lazy dog 0123456789 de KC9QRS EM48sq";
    const wave = withSilence(thorWaveform(long, { sampleRate: fs, centreHz: 1500, mode }), fs, mode);
    const t = decodeAll(new ThorDemodulator({ sampleRate: fs, centreHz: 1500, mode }), wave.subarray(Math.round(fs * 4)));
    ok(t.length > 20 && long.endsWith(t), `picked up mid-over, it prints the rest once it has a run of clean text (${JSON.stringify(t)})`);
  }

  console.log("\noff frequency and off clock");
  for (const mode of ["8", "11", "16", "50x1"] as ThorMode[]) {
    for (const off of [4, -7, 30]) {
      const fs = 12_000;
      const wave = withSilence(thorWaveform(LINE, { sampleRate: fs, centreHz: 1500 + off, mode, amplitude: 0.5 }), fs, mode);
      const demod = new ThorDemodulator({ sampleRate: fs, centreHz: 1500, mode });
      const t = decodeAll(demod, wave);
      const sp = thorParams(mode).toneSpacingHz;
      ok(
        t === LINE && Math.abs(demod.statistics.afcHz - off) <= sp / 2,
        `Thor ${mode} ${off > 0 ? "+" : ""}${off} Hz off reads, and the offset is seen (${demod.statistics.afcHz.toFixed(1)} Hz)`,
        JSON.stringify(t),
      );
    }
  }
  for (const mode of ["11", "22", "100"] as ThorMode[]) {
    // Generated at 12 006 Hz and read at 12 000: a sound card 500 ppm off, which the
    // symbol timing has to follow.
    const wave = withSilence(thorWaveform(LINE + " " + LINE, { sampleRate: 12_006, centreHz: 1500, mode }), 12_000, mode);
    const t = decodeAll(new ThorDemodulator({ sampleRate: 12_000, centreHz: 1500, mode }), wave);
    eq(t, LINE + " " + LINE, `Thor ${mode} from a sound card 500 ppm fast reads back`);
  }

  console.log("\nin noise (S/N in 2.5 kHz)");
  {
    // A dB inside where each submode copied three seeds in three (see docs/thor.md).
    const levels: [ThorMode, number][] = [
      ["4", -17], ["5", -15], ["8", -14], ["11", -12], ["16", -11], ["22", -8],
      ["25x4", -9], ["50x1", -5], ["50x2", -6], ["100", -2],
    ];
    for (const [mode, snr] of levels) {
      const fs = 12_000;
      const clean = thorWaveform(LINE, { sampleRate: fs, centreHz: 1500, mode, amplitude: 0.5 });
      for (const seed of [7, 8]) {
        const demod = new ThorDemodulator({ sampleRate: fs, centreHz: 1500, mode });
        const t = decodeAll(demod, withNoise(clean, snr, fs, mode, seed));
        ok(t === LINE, `Thor ${mode} at ${snr} dB reads back, nothing before or after it (seed ${seed})`, JSON.stringify(t));
      }
    }
    // A strong signal: the junk the far end's half-sent interleaver leaves at the end of
    // an over is as confident as text, and must not print.
    for (const mode of ["4", "8", "22", "50x2", "100"] as ThorMode[]) {
      const fs = 12_000;
      const clean = thorWaveform(LINE, { sampleRate: fs, centreHz: 1500, mode, amplitude: 0.5 });
      const t = decodeAll(new ThorDemodulator({ sampleRate: fs, centreHz: 1500, mode }), withNoise(clean, 30, fs, mode, 7));
      eq(t, LINE, `Thor ${mode} at +30 dB: the line and not a character of the over's tail`);
    }
  }

  console.log("\nthe error correction at work");
  {
    // Every fifteenth symbol after the preamble moved to a wrong tone, on a clean signal:
    // the IFK+ steps either side of each are both wrong, about one step in eight, each
    // with full confidence - in DominoEX a wrong character every few - and the code puts
    // it back. (Every ninth, a step in five, is past what it can mend.)
    for (const mode of ["11", "16", "50x1"] as ThorMode[]) {
      const fs = 12_000;
      const { tones, tailSymbols } = thorSymbols(LINE, { mode });
      const wrecked = [...tones];
      const g = noiseSource(3);
      let changed = 0;
      for (let i = 20; i < wrecked.length; i += 15) {
        wrecked[i] = (wrecked[i]! + 3 + Math.floor(((g() + 4) / 8) * 12)) % THOR_TONES;
        changed++;
      }
      let badSteps = 0;
      for (let i = 1; i < tones.length; i++) {
        const a = (tones[i]! - tones[i - 1]! + THOR_TONES) % THOR_TONES;
        const b = (wrecked[i]! - wrecked[i - 1]! + THOR_TONES) % THOR_TONES;
        if (a !== b) badSteps++;
      }
      const wave = withSilence(thorTonesWaveform(wrecked, tailSymbols, { sampleRate: fs, centreHz: 1500, mode, amplitude: 0.5 }), fs, mode);
      const t = decodeAll(new ThorDemodulator({ sampleRate: fs, centreHz: 1500, mode }), wave);
      eq(t, LINE, `Thor ${mode}: ${changed} symbols wrecked, ${badSteps} of ${tones.length} steps wrong, and the line reads exactly`);
    }
    // The same baud and the same S/N, with and without the code: DominoEX 16 loses
    // characters where Thor 16 reads every one.
    const fs = 12_000;
    const snr = -11;
    const thor = decodeAll(new ThorDemodulator({ sampleRate: fs, centreHz: 1500, mode: "16" }), withNoise(thorWaveform(LINE, { sampleRate: fs, centreHz: 1500, mode: "16", amplitude: 0.5 }), snr, fs, "16", 8));
    const dom = new DominoexDemodulator({ sampleRate: fs, centreHz: 1500, mode: 16 });
    let dtext = "";
    const dwave = withNoise(dominoexWaveform(LINE, { sampleRate: fs, centreHz: 1500, mode: 16, amplitude: 0.5 }), snr, fs, "16", 8);
    for (let i = 0; i < dwave.length; i += 4096) dtext += dom.feed(dwave.subarray(i, i + 4096));
    ok(thor === LINE && dtext !== LINE, `at ${snr} dB Thor 16 reads the line and DominoEX 16, uncoded, does not (${JSON.stringify(dtext)})`);
  }

  console.log("\nnoise alone, and silence: nothing prints");
  for (const mode of ["8", "11", "16", "22", "50x1"] as ThorMode[]) {
    const fs = 12_000;
    const g = noiseSource(99 + mode.length * 7 + Number(mode.slice(0, 2)));
    const wave = new Float32Array(fs * 60);
    for (let i = 0; i < wave.length; i++) wave[i] = 0.3 * g();
    const demod = new ThorDemodulator({ sampleRate: fs, centreHz: 1500, mode });
    const text = decodeAll(demod, wave, 4096);
    ok(text.length <= 3, `Thor ${mode}: sixty seconds of band noise prints next to nothing (${text.length} characters)`, JSON.stringify(text));
    ok(demod.statistics.quality < 0.1, `  quality reads as noise (${demod.statistics.quality.toFixed(2)})`);
    eq(demod.statistics.errors, 0, "  and nothing is counted as unread while the squelch is closed");
    if (mode === "11") {
      const junk = decodeAll(new ThorDemodulator({ sampleRate: fs, centreHz: 1500, mode, squelch: 0 }), wave);
      ok(junk.length > 50, `  with the squelch off the same noise prints junk (${junk.length} characters), which is the squelch's job`);
    }
  }
  for (const mode of ["8", "16", "22", "100"] as ThorMode[]) {
    // An over, then four seconds of exact zeros (a FlexRadio's DAX between overs): the over
    // comes out whole as the silence pushes it through, and the silence prints nothing.
    const fs = 12_000;
    const over = thorWaveform(LINE, { sampleRate: fs, centreHz: 1500, mode, amplitude: 0.5 });
    const demod = new ThorDemodulator({ sampleRate: fs, centreHz: 1500, mode });
    const t = decodeAll(demod, withSilence(over, fs, mode, Math.max(4, drainSeconds(mode))));
    eq(t, LINE, `Thor ${mode}: an over and then digital silence - the over, whole, and nothing more`);
    const more = decodeAll(demod, new Float32Array(fs * 4));
    eq(more, "", "  four more seconds of zeros print nothing");
    ok(!demod.statistics.open && demod.statistics.quality < 0.1, `  and the squelch is shut (quality ${demod.statistics.quality.toFixed(2)})`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
