/* eslint-disable no-console */
// MFSK: the Varicode, the convolutional code and its Viterbi decoder, the interleaver, the
// waveform (checked tone by tone against a sequence worked out by hand from fldigi's
// source), and the demodulator on generated signals - clean, chunked, at the radios'
// rates, off frequency, in noise - and on noise alone, where the squelch has to hold.

import { ConvEncoder, Interleaver, NASA_POLY1, NASA_POLY2, parity, PUNCTURE, ViterbiDecoder } from "@/lib/digital/fec";
import {
  MFSK_MODES,
  mfskDurationMs,
  mfskGrayDecode,
  mfskGrayEncode,
  mfskSymbols,
  mfskToneHz,
  mfskWaveform,
  type MfskModeName,
} from "@/lib/digital/mfsk";
import { MFSK_VARICODE, MfskVaricodeDecoder, mfskEncodeText, mfskVaricodeByte, mfskVaricodeFor } from "@/lib/digital/mfsk-varicode";
import { MfskDemodulator } from "@/lib/digital/mfskdemod";

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

/** Deterministic uniform numbers. */
function uniformSource(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Deterministic Gaussian noise. */
function noiseSource(seed: number): () => number {
  const rnd = uniformSource(seed);
  return () => {
    const u = Math.max(rnd(), 1e-12);
    const v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

/**
 * Add white noise for a signal-to-noise ratio measured in a 2.5 kHz bandwidth, the usual
 * SSB reference, and a few seconds of the same noise after the signal so the decoder's
 * pipeline (interleaver and Viterbi, about three seconds at MFSK16) runs out on noise, as
 * it would on the air.
 */
function withNoise(wave: Float32Array, snrDb: number, sampleRate: number, seed = 7, afterS = 4): Float32Array {
  let p = 0;
  for (const v of wave) p += v * v;
  const signalPower = p / wave.length;
  const noisePower = (signalPower / 10 ** (snrDb / 10)) * (sampleRate / 2 / 2500);
  const g = noiseSource(seed);
  const sigma = Math.sqrt(noisePower);
  const out = new Float32Array(wave.length + Math.round(afterS * sampleRate));
  for (let i = 0; i < out.length; i++) out[i] = (wave[i] ?? 0) + sigma * g();
  return out;
}

/** Silence after the signal, for the clean runs. */
function padded(wave: Float32Array, sampleRate: number, afterS = 1): Float32Array {
  const out = new Float32Array(wave.length + Math.round(afterS * sampleRate));
  out.set(wave);
  return out;
}

function decodeAll(demod: MfskDemodulator, wave: Float32Array, chunk = wave.length): string {
  let text = "";
  for (let i = 0; i < wave.length; i += chunk) text += demod.feed(wave.subarray(i, Math.min(wave.length, i + chunk)));
  return text;
}

/** Magnitude of one frequency in a stretch of audio, as a share of full scale. */
function toneLevel(x: Float32Array, from: number, to: number, hz: number, fs: number): number {
  let re = 0;
  let im = 0;
  for (let i = from; i < to; i++) {
    re += x[i]! * Math.cos((2 * Math.PI * hz * i) / fs);
    im -= x[i]! * Math.sin((2 * Math.PI * hz * i) / fs);
  }
  return (2 * Math.hypot(re, im)) / (to - from);
}

async function main(): Promise<void> {
  console.log("\nthe Varicode table");
  {
    eq(MFSK_VARICODE.length, 256, "256 codes, one per byte");
    eq(new Set(MFSK_VARICODE).size, 256, "no two bytes share one");
    ok(
      MFSK_VARICODE.every((c) => c.startsWith("1") && c.endsWith("00") && !c.slice(0, -2).includes("001")),
      "every code starts with 1, ends with 00, and has no 001 before its end",
    );
    ok(MFSK_VARICODE.every((c) => c.length >= 3 && c.length <= 12), "and is 3 to 12 bits");
    eq(mfskVaricodeFor(32), "100", "space is the shortest, 100");
    eq(mfskVaricodeFor(101), "1000", "e is 1000");
    eq(mfskVaricodeFor(13), "10101100", "CR");
    eq(mfskVaricodeFor(10), "11110100000", "LF");
    eq(mfskVaricodeFor(2), "11101101000", "STX, which fldigi sends before the text");
    eq(mfskVaricodeFor(4), "11101110000", "EOT, which it sends after");
    eq(mfskVaricodeFor(67), "11010100", "C");
    eq(mfskVaricodeFor(81), "110110000", "Q");
    eq(mfskVaricodeByte("1000"), 101, "and a code reads back to its byte");
    eq(mfskVaricodeByte("1001"), -1, "a string no byte has reads as none");

    // Every byte, one after another, through the bit-stream decoder. The register starts as
    // if a 1 had just arrived; on the air the preamble's 0s (more than 32) shift that out
    // before the first code, and fldigi's idle does the same between overs, so 32 0s first.
    const ZEROS = new Array<number>(32).fill(0);
    const bits: number[] = [...ZEROS];
    for (let b = 0; b < 256; b++) for (const c of mfskVaricodeFor(b)) bits.push(c === "1" ? 1 : 0);
    bits.push(1); // the next code's first bit ends the last one
    const d = new MfskVaricodeDecoder();
    const got: number[] = [];
    for (const b of bits) {
      const c = d.pushBitByte(b);
      if (c >= 0) got.push(c);
    }
    const ok256 = got.length === 256 && got.every((c, i) => c === i);
    ok(ok256, "all 256 bytes, sent back to back, read back in order", `${got.length} read, first ${got.slice(0, 4).join(",")}`);
    eq(d.errors, 0, "with no code unread");

    const d2 = new MfskVaricodeDecoder();
    let s = "";
    for (const b of [...ZEROS, ...mfskEncodeText("CQ de KC9QRS EM48sq\nok"), 1]) s += d2.pushBit(b);
    eq(s, "CQ de KC9QRS EM48sq\nok", "text reads back; a newline goes as CR LF and comes back as one newline");
    const d3 = new MfskVaricodeDecoder();
    let s3 = "";
    for (const b of [...ZEROS, ...mfskEncodeText("Café Jürgen"), 1]) s3 += d3.pushBit(b);
    eq(s3, "Café Jürgen", "UTF-8, as fldigi sends it: an accented letter is two codes and comes back whole");
    const d4 = new MfskVaricodeDecoder();
    let s4 = "";
    for (let i = 0; i < 200; i++) s4 += d4.pushBit(0);
    for (const b of [...mfskEncodeText("hi"), 1]) s4 += d4.pushBit(b);
    eq(s4, "hi", "a long run of 0s (the idle) prints nothing and the next character still reads");
  }

  console.log("\nthe convolutional code");
  {
    eq(NASA_POLY1, 0x6d, "first polynomial 0x6d (fldigi mfsk.h POLY1)");
    eq(NASA_POLY2, 0x4f, "second 0x4f (POLY2)");
    const e = new ConvEncoder();
    eq(e.encode(1), 3, "a 1 into an empty register sets both parities: both polynomials tap the newest bit");
    eq(e.encode(0), 2, "then a 0: only the second (0x4f) taps the bit before");
    eq(e.encode(0), 3, "then another: both tap the bit two back");
    eq(parity(0b1011), 1, "parity counts set bits");

    const rnd = uniformSource(3);
    const data: number[] = [];
    for (let i = 0; i < 2000; i++) data.push(rnd() < 0.5 ? 1 : 0);
    const tail = 60;
    const enc = new ConvEncoder();
    const coded: [number, number][] = [...data, ...new Array<number>(tail).fill(0)].map((b) => {
      const c = enc.encode(b);
      return [c & 1, (c >> 1) & 1];
    });
    const run = (soft: [number, number][], trace: number, chunk: number): number[] => {
      const v = new ViterbiDecoder();
      v.setTraceback(trace);
      v.setChunkSize(chunk);
      const out: number[] = [];
      for (const [a, b] of soft) {
        const r = v.decode(a, b);
        if (r >= 0) for (let i = chunk - 1; i >= 0; i--) out.push((r >> i) & 1);
      }
      return out;
    };
    const hard = coded.map(([a, b]) => [a ? 255 : 0, b ? 255 : 0] as [number, number]);
    // With a traceback of 45 and one bit a step, the bit out is the one 45 steps back.
    const out = run(hard, 45, 1).slice(45, 45 + data.length);
    const errs = out.reduce((n, b, i) => n + (b !== data[i] ? 1 : 0), 0);
    ok(out.length === data.length && errs === 0, "2000 random bits encode and decode back exactly (fldigi's MFSK settings: traceback 45, a bit a step)", `${errs} wrong of ${out.length}`);
    const out8 = run(hard, 84, 8);
    const off = out8.findIndex((_, i) => data.slice(0, 64).every((b, j) => out8[i + j] === b));
    ok(off >= 0, "and with fldigi's defaults (traceback 84, eight bits a step)", `offset ${off}`);

    // Errors: flip 1 coded bit in 25, never two close together, and make the rest unsure.
    const flipped = hard.map(([a, b], i) => {
      const fa = i % 25 === 3;
      const fb = i % 25 === 16;
      return [fa ? 255 - a : a, fb ? 255 - b : b] as [number, number];
    });
    const nflip = flipped.reduce((n, p, i) => n + (p[0] !== hard[i]![0] ? 1 : 0) + (p[1] !== hard[i]![1] ? 1 : 0), 0);
    const outE = run(flipped, 45, 1).slice(45, 45 + data.length);
    const errsE = outE.reduce((n, b, i) => n + (b !== data[i] ? 1 : 0), 0);
    ok(errsE === 0, `${nflip} hard bit errors (4% of the code bits) are all corrected`, `${errsE} data bits wrong`);
    const softNoisy = hard.map(([a, b]) => {
      const g = () => (rnd() - 0.5) * 300;
      const s = (x: number) => Math.max(0, Math.min(255, Math.round(x + g())));
      return [s(a), s(b)] as [number, number];
    });
    const rawErr = softNoisy.reduce((n, p, i) => n + ((p[0] >= 128 ? 255 : 0) !== hard[i]![0] ? 1 : 0) + ((p[1] >= 128 ? 255 : 0) !== hard[i]![1] ? 1 : 0), 0);
    const outS = run(softNoisy, 45, 1).slice(45, 45 + data.length);
    const errsS = outS.reduce((n, b, i) => n + (b !== data[i] ? 1 : 0), 0);
    ok(errsS === 0, `soft decisions with ${((100 * rawErr) / (2 * hard.length)).toFixed(1)}% of them on the wrong side decode clean`, `${errsS} data bits wrong`);
    const punct = hard.map(([a, b], i) => (i % 4 === 1 ? [PUNCTURE, b] : [a, b]) as [number, number]);
    const outP = run(punct, 45, 1).slice(45, 45 + data.length);
    eq(outP.reduce((n, b, i) => n + (b !== data[i] ? 1 : 0), 0), 0, "a quarter of the first code bits erased (128) decode clean too");
    const v = new ViterbiDecoder();
    v.setTraceback(45);
    v.setChunkSize(1);
    for (const [a, b] of hard.slice(0, 200)) v.decode(a, b);
    ok(v.metric >= 254, `the metric on a clean stream is the most a step can score, 254 to 256 (${v.metric})`);
  }

  console.log("\nthe interleaver");
  {
    for (const [size, depth] of [[4, 10], [5, 5]] as const) {
      const tx = new Interleaver(size, depth, "fwd");
      const rx = new Interleaver(size, depth, "rev");
      const rnd = uniformSource(11);
      const sent: number[] = [];
      const back: number[] = [];
      for (let t = 0; t < 300; t++) {
        const v = Math.floor(rnd() * (1 << size));
        sent.push(v);
        const air = tx.bits(v);
        const s = new Uint8Array(size);
        for (let i = 0; i < size; i++) s[i] = (air >> (size - 1 - i)) & 1 ? 255 : 0;
        rx.symbols(s);
        let r = 0;
        for (let i = 0; i < size; i++) r = (r << 1) | (s[i]! >= 128 ? 1 : 0);
        back.push(r);
      }
      const delay = depth * (size - 1);
      const good = sent.slice(0, 300 - delay).every((v, t) => back[t + delay] === v);
      ok(good, `${size} bits, depth ${depth}: every symbol comes back ${delay} symbols later, whole`);
      // On the air, one symbol's bits come from symbols spread over the depth.
      const probe = new Interleaver(size, depth, "fwd");
      const firstSeen: number[] = [];
      for (let t = 0; t < delay + 2; t++) {
        const air = probe.bits(t === 0 ? (1 << size) - 1 : 0);
        for (let i = 0; i < size; i++) if ((air >> (size - 1 - i)) & 1) firstSeen[i] = t;
      }
      eq(firstSeen.join(","), Array.from({ length: size }, (_, i) => i * depth).join(","), `  and bit i of a symbol goes out i x ${depth} symbols later`);
    }
    const rx = new Interleaver(4, 10, "rev");
    const s = new Uint8Array([255, 255, 255, 255]);
    rx.symbols(s);
    eq(Array.from(s).join(","), "128,128,128,255", "the receiver starts full of punctures: only the last bit, which the sender held back longest, is known at once");
  }

  console.log("\nGray coding, as fldigi's misc.cxx does it");
  {
    let inverse = true;
    let neighbours = true;
    for (let t = 0; t < 32; t++) {
      if (mfskGrayDecode(mfskGrayEncode(t)) !== t) inverse = false;
      if (t > 0) {
        const x = mfskGrayDecode(t) ^ mfskGrayDecode(t - 1);
        if ((x & (x - 1)) !== 0) neighbours = false;
      }
    }
    ok(inverse, "the tone for a value decodes back to it");
    ok(neighbours, "and neighbouring tones differ in one bit: the likeliest error costs one bit");
    eq(mfskGrayEncode(8), 15, "grayencode(8) is 15: the running XOR from the top, as fldigi names it");
  }

  console.log("\nthe modes, from fldigi's mfsk::mfsk()");
  {
    const m16 = MFSK_MODES.MFSK16;
    eq(m16.tones, 16, "MFSK16: 16 tones");
    eq(m16.baud, 15.625, "15.625 baud (8000 / 512)");
    eq(m16.toneSpacingHz, 15.625, "tones a baud apart");
    eq(m16.bandwidthHz, 234.375, "234 Hz from the lowest tone to the highest");
    eq(m16.depth, 10, "interleaver depth 10");
    eq(MFSK_MODES.MFSK32.baud, 31.25, "MFSK32: 31.25 baud (8000 / 256), 16 tones");
    eq(MFSK_MODES.MFSK32.bandwidthHz, 468.75, "  469 Hz wide");
    eq(MFSK_MODES.MFSK8.tones, 32, "MFSK8: 32 tones");
    eq(MFSK_MODES.MFSK8.baud, 7.8125, "  7.8125 baud (8000 / 1024)");
    eq(MFSK_MODES.MFSK8.depth, 5, "  depth 5");
    eq(MFSK_MODES.MFSK11.baud.toFixed(3), "10.767", "MFSK11: 11025 / 1024 baud");
    eq(MFSK_MODES.MFSK22.baud.toFixed(3), "21.533", "MFSK22: 11025 / 512 baud");
  }

  console.log("\nthe tones on the air, against fldigi worked by hand");
  {
    // From fldigi's tx_process(), with a fresh modem: clearbits() pushes 107 pairs of 0s
    // through the interleaver (214 bits: 53 symbols and half of one), then 35 more 0 bits
    // go out - 72 code bits with the half, 18 symbols, all value 0, all tone 0. Then CR
    // (10101100) STX (11101101000) CR. In the first ten symbols after that only the first
    // bit of each symbol is new - bit i is held back i x 10 symbols - and it is the first
    // polynomial (0x6d: this bit and the ones 2, 3, 5 and 6 back) over the first of the
    // symbol's two data bits. For data bits 1,0,1,0,1,1,0,0,1,1,1,0,1,1,0,1,0,0,0 that is
    // 1,0,0,0,1,0,1,1,0,1, and a value of 1000 is grayencode(8) = tone 15.
    const { tones } = mfskSymbols("CQ", { mode: "MFSK16" });
    const want = [...new Array<number>(18).fill(0), 15, 0, 0, 0, 15, 0, 15, 15, 0, 15];
    eq(Array.from(tones.slice(0, want.length)).join(","), want.join(","), "MFSK16 \"CQ\": 18 symbols of tone 0, then 15,0,0,0,15,0,15,15,0,15");
    // The over's length: 18 preamble + the text's code bits / 2 bits a symbol, + the flush
    // (a 1 and 107 0s, part symbol dropped) + 2 symbols of soft-start tail.
    const dataBits = [13, 2, 13, 67, 81, 13, 4, 13].reduce((n, b) => n + mfskVaricodeFor(b).length, 0);
    eq(tones.length, 18 + Math.floor((dataBits + 108) / 2) + 2, `and ${tones.length} symbols in all: preamble, CR STX CR CQ CR EOT CR, the flush and the tail`);
    const t32 = mfskSymbols("CQ", { mode: "MFSK32" });
    eq(Array.from(t32.tones).join(","), Array.from(tones.slice(0, tones.length - 2)).join(",") + "," + Array.from(t32.tones.slice(-4)).join(","), "MFSK32 sends the same tones, with a four-symbol tail (100 ms at 31.25 baud)");
    const t8 = mfskSymbols("CQ", { mode: "MFSK8" });
    // MFSK8, 5 bits a symbol: 214 leaves 4 over, and 70 more make 14 symbols and 4 over.
    // The first data bit's pair splits: its first code bit goes last in symbol 14 (held
    // back 20 symbols), its second (0x4f over a lone 1: 1) first in symbol 15, value 10000,
    // grayencode 31.
    eq(Array.from(t8.tones.slice(0, 16)).join(","), [...new Array<number>(15).fill(0), 31].join(","), "MFSK8: 15 symbols of tone 0, then tone 31");

    // Placement: the tone set is centred on the frequency asked for.
    const fs = 12_000;
    const wave = mfskWaveform("CQ", { sampleRate: fs, centreHz: 1500 });
    const sym = 768;
    const lowHz = mfskToneHz(MFSK_MODES.MFSK16, 1500, 0);
    eq(lowHz, 1500 - 117.1875, "tone 0 is half the bandwidth below the centre (sendsymbol(): carrier - bandwidth / 2)");
    const at = toneLevel(wave, 4 * sym, 16 * sym, lowHz, fs);
    const above = toneLevel(wave, 4 * sym, 16 * sym, lowHz + 15.625, fs);
    ok(at > 0.9 && above < 0.01, `the preamble is that one tone (${at.toFixed(3)} on it, ${above.toFixed(4)} a spacing up)`);
    const s18 = toneLevel(wave, 18 * sym, 19 * sym, mfskToneHz(MFSK_MODES.MFSK16, 1500, 15), fs);
    ok(s18 > 0.9, `and the first data symbol is tone 15, ${(1500 + 117.1875).toFixed(1)} Hz (${s18.toFixed(3)})`);
  }

  console.log("\nthe waveform");
  for (const fs of [12_000, 24_000, 48_000]) {
    for (const mode of ["MFSK16", "MFSK32", "MFSK11"] as MfskModeName[]) {
      const wave = mfskWaveform("CQ CQ de KC9QRS", { sampleRate: fs, centreHz: 1500, mode });
      const ms = mfskDurationMs("CQ CQ de KC9QRS", { sampleRate: fs, centreHz: 1500, mode });
      ok(Math.abs(wave.length - (ms / 1000) * fs) <= 1, `${mode} at ${fs / 1000} kHz: ${wave.length} samples is ${ms.toFixed(1)} ms`);
    }
  }
  {
    const fs = 12_000;
    const wave = mfskWaveform("CQ CQ de KC9QRS", { sampleRate: fs, centreHz: 1500 });
    let peak = 0;
    let jump = 0;
    for (let i = 0; i < wave.length; i++) {
      peak = Math.max(peak, Math.abs(wave[i]!));
      if (i > 0) jump = Math.max(jump, Math.abs(wave[i]! - wave[i - 1]!));
    }
    ok(peak <= 1.0001 && peak > 0.99, "full scale and no more", `${peak}`);
    // The largest step a 1617 Hz tone can take between samples at 12 kHz is 2 sin(pi f / fs).
    ok(jump <= 2 * Math.sin((Math.PI * 1620) / fs) + 1e-6, "no step bigger than the highest tone makes: the phase is continuous through every change", `${jump.toFixed(4)}`);
    ok(Math.abs(wave[0]!) < 0.01 && Math.abs(wave[wave.length - 1]!) < 0.01, "starts and ends at zero: the 100 ms soft start and stop");
    const half = mfskWaveform("x", { sampleRate: fs, amplitude: 0.5 });
    ok(Math.max(...half.map(Math.abs)) <= 0.5001, "amplitude scales it");
  }

  const LINE = "CQ CQ CQ de KC9QRS KC9QRS EM48sq pse K";
  console.log("\nthe demodulator on a clean signal");
  for (const mode of ["MFSK16", "MFSK32"] as MfskModeName[]) {
    for (const fs of [12_000, 24_000, 48_000]) {
      const wave = padded(mfskWaveform(LINE, { sampleRate: fs, centreHz: 1500, mode }), fs);
      const demod = new MfskDemodulator({ sampleRate: fs, centreHz: 1500, mode });
      const text = decodeAll(demod, wave);
      eq(text, LINE, `${mode} at ${fs / 1000} kHz reads back, every character and nothing else`);
      if (fs === 12_000) {
        ok(demod.statistics.errors <= 1, `  nothing dropped but, at most, the first bits before the decoder settles (${demod.statistics.errors})`);
        ok(Math.abs(demod.statistics.afcHz) < 0.5, `  the AFC stays put on an on-frequency signal (${demod.statistics.afcHz.toFixed(2)} Hz)`);
        eq(demod.statistics.chars, LINE.length, "  and counts what it printed");
      }
    }
  }
  {
    const fs = 12_000;
    const wave = mfskWaveform(LINE, { sampleRate: fs, centreHz: 1500 });
    let best = 0;
    const demod = new MfskDemodulator({ sampleRate: fs, centreHz: 1500, onBit: (q) => (best = Math.max(best, q)) });
    decodeAll(demod, wave);
    ok(best > 0.95, `quality reaches 1 on a clean signal (${best.toFixed(3)})`);
    ok(demod.statistics.level > 0.4 && demod.statistics.level < 1.1, `level reads the tone's amplitude (${demod.statistics.level.toFixed(2)}, sent at 1)`);
  }
  for (const mode of ["MFSK8", "MFSK11", "MFSK22"] as MfskModeName[]) {
    for (const fs of [12_000, 48_000]) {
      const wave = padded(mfskWaveform(LINE, { sampleRate: fs, centreHz: 1500, mode }), fs, 2);
      const text = decodeAll(new MfskDemodulator({ sampleRate: fs, centreHz: 1500, mode }), wave);
      eq(text, LINE, `${mode} at ${fs / 1000} kHz reads back too`);
    }
  }
  {
    const fs = 24_000;
    const wave = padded(mfskWaveform(LINE + "\n73", { sampleRate: fs, centreHz: 1000 }), fs);
    const text = decodeAll(new MfskDemodulator({ sampleRate: fs, centreHz: 1000 }), wave);
    eq(text, LINE + "\n73", "at a 1000 Hz centre, with a newline");
  }

  console.log("\nchunked: the same text whatever the chunk size");
  for (const mode of ["MFSK16", "MFSK32"] as MfskModeName[]) {
    const fs = 12_000;
    const wave = withNoise(mfskWaveform(LINE, { sampleRate: fs, centreHz: 1500, mode, amplitude: 0.5 }), -6, fs);
    const whole = decodeAll(new MfskDemodulator({ sampleRate: fs, centreHz: 1500, mode }), wave);
    ok(whole.includes(LINE), `${mode} in noise, one call`, JSON.stringify(whole));
    eq(decodeAll(new MfskDemodulator({ sampleRate: fs, centreHz: 1500, mode }), wave, 97), whole, `${mode} fed 97 samples at a time gives the same`);
    eq(decodeAll(new MfskDemodulator({ sampleRate: fs, centreHz: 1500, mode }), wave, 1), whole, `${mode} fed one sample at a time gives the same`);
  }

  console.log("\noff the click: the AFC");
  for (const [mode, off] of [["MFSK16", 3], ["MFSK16", -5], ["MFSK32", 8], ["MFSK32", -10], ["MFSK8", 2.5]] as [MfskModeName, number][]) {
    const fs = 12_000;
    const wave = padded(mfskWaveform(LINE + " " + LINE, { sampleRate: fs, centreHz: 1500 + off, mode }), fs, 2);
    const demod = new MfskDemodulator({ sampleRate: fs, centreHz: 1500, mode });
    const text = decodeAll(demod, wave);
    ok(text.includes(LINE), `${mode} ${off > 0 ? "+" : ""}${off} Hz off the centre reads back`, JSON.stringify(text));
    ok(Math.abs(demod.statistics.afcHz - off) < 1, `  and the AFC found it (${demod.statistics.afcHz.toFixed(2)} Hz)`);
  }
  {
    const fs = 12_000;
    const wave = padded(mfskWaveform(LINE, { sampleRate: fs, centreHz: 1503 }), fs);
    const demod = new MfskDemodulator({ sampleRate: fs, centreHz: 1500, afc: false });
    eq(decodeAll(demod, wave), LINE, "MFSK16 3 Hz off with the AFC off still reads: a fifth of a bin costs little");
    eq(demod.statistics.afcHz, 0, "  with the oscillator left alone");
  }
  {
    const fs = 12_000;
    const wave = padded(mfskWaveform(LINE, { sampleRate: fs, centreHz: 1200 }), fs);
    const demod = new MfskDemodulator({ sampleRate: fs, centreHz: 1500 });
    const before = decodeAll(demod, wave.subarray(0, 1000));
    demod.retune(1200);
    const text = before + decodeAll(demod, wave.subarray(1000));
    eq(text, LINE, "retuned to the signal while running, it reads");
  }
  {
    // A slightly fast sound card at the far end: 50 ppm, the symbol clock drifts.
    const fs = 12_000;
    const wave = mfskWaveform(LINE + " " + LINE, { sampleRate: fs * 1.00005, centreHz: 1500 });
    const text = decodeAll(new MfskDemodulator({ sampleRate: fs, centreHz: 1500 }), padded(wave, fs));
    ok(text.includes(LINE + " " + LINE), "a far end whose sample clock is 50 ppm off still reads: the timing follows it", JSON.stringify(text));
  }

  console.log("\nin noise (SNR in 2.5 kHz)");
  const words = LINE.split(" ");
  const copied = (text: string) => words.filter((w) => text.includes(w)).length;
  for (const [mode, snr] of [["MFSK16", -6], ["MFSK16", -10], ["MFSK16", -12], ["MFSK32", -6], ["MFSK32", -9], ["MFSK8", -12], ["MFSK11", -12], ["MFSK22", -10]] as [MfskModeName, number][]) {
    for (const seed of [7, 8]) {
      const fs = 12_000;
      const wave = withNoise(mfskWaveform(LINE, { sampleRate: fs, centreHz: 1500, mode, amplitude: 0.5 }), snr, fs, seed);
      const demod = new MfskDemodulator({ sampleRate: fs, centreHz: 1500, mode });
      const text = decodeAll(demod, wave);
      ok(text.includes(LINE), `${mode} at ${snr} dB (noise ${seed}) reads the whole line`, JSON.stringify(text));
      ok(text.length <= LINE.length + 4, `  with at most a few stray characters around it (${text.length - LINE.length})`, JSON.stringify(text));
    }
  }
  for (const [mode, snr, atLeast] of [["MFSK16", -13, 6], ["MFSK32", -10, 5]] as [MfskModeName, number, number][]) {
    const fs = 12_000;
    const wave = withNoise(mfskWaveform(LINE, { sampleRate: fs, centreHz: 1500, mode, amplitude: 0.5 }), snr, fs, 9);
    const text = decodeAll(new MfskDemodulator({ sampleRate: fs, centreHz: 1500, mode }), wave);
    ok(copied(text) >= atLeast, `${mode} at ${snr} dB, at the edge, still prints most of the words (${copied(text)} of ${words.length})`, JSON.stringify(text));
  }

  console.log("\nnoise alone: the squelch holds");
  for (const mode of ["MFSK16", "MFSK32", "MFSK8"] as MfskModeName[]) {
    const fs = 12_000;
    const g = noiseSource(99);
    const wave = new Float32Array(fs * 60);
    for (let i = 0; i < wave.length; i++) wave[i] = 0.3 * g();
    const demod = new MfskDemodulator({ sampleRate: fs, centreHz: 1500, mode });
    const text = decodeAll(demod, wave, 4096);
    ok(text.length <= 3, `${mode}: sixty seconds of band noise prints next to nothing (${text.length} characters)`, JSON.stringify(text));
    ok(demod.statistics.quality < 0.15, `  quality reads as noise (${demod.statistics.quality.toFixed(2)})`);
    eq(demod.statistics.errors, 0, "  nothing is counted as unread while the squelch is closed");
    ok(Math.abs(demod.statistics.afcHz) < 0.01, `  and the AFC has not moved (${demod.statistics.afcHz.toFixed(2)} Hz)`);
    if (mode === "MFSK16") {
      const junk = decodeAll(new MfskDemodulator({ sampleRate: fs, centreHz: 1500, mode, squelch: 0 }), wave, 4096);
      ok(junk.length > 50, `  with the squelch off the same noise prints junk (${junk.length} characters), which is the squelch's job`);
    }
  }
  {
    const fs = 12_000;
    const g = noiseSource(5);
    const wave = new Float32Array(fs * 20);
    for (let i = 0; i < wave.length; i++) wave[i] = 0.3 * g() + 0.2 * Math.cos((2 * Math.PI * 1530 * i) / fs);
    const text = decodeAll(new MfskDemodulator({ sampleRate: fs, centreHz: 1500 }), wave);
    ok(text.length <= 3, `a steady carrier inside the tone set, in noise, prints next to nothing (${text.length})`, JSON.stringify(text));
  }
  {
    // After a signal, back to noise: the line, then quiet.
    const fs = 12_000;
    const wave = withNoise(mfskWaveform(LINE, { sampleRate: fs, centreHz: 1500, amplitude: 0.5 }), -6, fs, 3, 20);
    const demod = new MfskDemodulator({ sampleRate: fs, centreHz: 1500 });
    const text = decodeAll(demod, wave);
    ok(text.includes(LINE) && text.length <= LINE.length + 4, "a signal and then 20 s of its noise: the line, and the squelch closes behind it", JSON.stringify(text));
    eq(demod.statistics.open, false, "  closed at the end");
    demod.reset();
    eq(demod.statistics.quality, 0, "reset() clears the quality");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
