/* eslint-disable no-console */
// MT63: the Walsh code, the interleave, the waveform, and the demodulator on generated
// signals - every mode, at the radios' rates, clean, chunked, off frequency, in noise - and
// on noise alone, where the squelch has to hold. Then what it costs to run.

import {
  MT63_CARRIERS,
  MT63_MODES,
  MT63_SYMBOL_SHAPE,
  Mt63Encoder,
  Mt63FecDecoder,
  mt63CarrierHz,
  mt63Codes,
  mt63DurationMs,
  mt63FirstCarrierBin,
  mt63Params,
  mt63TextToCodes,
  Mt63TextDecoder,
  mt63Waveform,
  type Mt63Mode,
} from "@/lib/digital/mt63";
import { Mt63Demodulator } from "@/lib/digital/mt63demod";
import { fht, ifht } from "@/lib/digital/olivia";

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

/**
 * The signal, then `afterSeconds` more of the same noise (or silence): the receiver prints
 * a character about three integration periods after it arrives, so it needs audio after
 * the transmission ends, as it gets on the air. SNR is measured in 2.5 kHz, the usual SSB
 * reference; null for no noise.
 */
function onAir(wave: Float32Array, sampleRate: number, snrDb: number | null, afterSeconds: number, seed = 7): Float32Array {
  const out = new Float32Array(wave.length + Math.round(afterSeconds * sampleRate));
  out.set(wave);
  if (snrDb === null) return out;
  let p = 0;
  for (const v of wave) p += v * v;
  const signalPower = p / wave.length;
  const noisePower = (signalPower / 10 ** (snrDb / 10)) * (sampleRate / 2 / 2500);
  const g = noiseSource(seed);
  const sigma = Math.sqrt(noisePower);
  for (let i = 0; i < out.length; i++) out[i] = out[i]! + sigma * g();
  return out;
}

/**
 * Move a signal up or down by `hz`, to any fraction of a bin, as a mistuned receiver
 * would: mix the band around 1500 Hz to baseband, low-pass away the image, mix it back
 * up to 1500 + hz.
 */
function shifted(wave: Float32Array, fs: number, hz: number): Float32Array {
  const fc = 1500;
  const len = Math.round((8 * fs) / 300) | 1;
  const mid = (len - 1) / 2;
  const cut = 1300 / fs;
  const h = new Float64Array(len);
  let sum = 0;
  for (let n = 0; n < len; n++) {
    const t = n - mid;
    const x = (2 * Math.PI * n) / (len - 1);
    h[n] = (t === 0 ? 2 * cut : Math.sin(2 * Math.PI * cut * t) / (Math.PI * t)) * (0.35875 - 0.48829 * Math.cos(x) + 0.14128 * Math.cos(2 * x) - 0.01168 * Math.cos(3 * x));
    sum += h[n]!;
  }
  const re = new Float64Array(wave.length);
  const im = new Float64Array(wave.length);
  for (let n = 0; n < wave.length; n++) {
    const ph = (2 * Math.PI * fc * n) / fs;
    re[n] = wave[n]! * Math.cos(ph);
    im[n] = -wave[n]! * Math.sin(ph);
  }
  const out = new Float32Array(wave.length);
  for (let n = 0; n < wave.length; n++) {
    let a = 0;
    let b = 0;
    for (let k = 0; k < len; k++) {
      const j = n + mid - k;
      if (j < 0 || j >= wave.length) continue;
      a += h[k]! * re[j]!;
      b += h[k]! * im[j]!;
    }
    const ph = (2 * Math.PI * (fc + hz) * n) / fs;
    out[n] = (2 / sum) * (a * Math.cos(ph) - b * Math.sin(ph));
  }
  return out;
}

function decodeAll(demod: Mt63Demodulator, wave: Float32Array, chunk = wave.length): string {
  let text = "";
  for (let i = 0; i < wave.length; i += chunk) text += demod.feed(wave.subarray(i, Math.min(wave.length, i + chunk)));
  return text;
}

/** Seconds of audio after a transmission for its last character to print: three integration periods and some. */
function latencySeconds(mode: Mt63Mode, long = false): number {
  return ((long ? 32 : 16) * 3 + 8) / mt63Params(mode).baud;
}

const LINE = "CQ CQ de KC9QRS KC9QRS EM48sq pse K";

function main(): void {
  console.log("\nthe modes");
  {
    const p = mt63Params("1000L");
    eq(p.carrierSpacingHz, 15.625, "MT63-1000: carriers 15.625 Hz apart");
    eq(p.baud, 10, "10 baud, so 10 characters a second");
    eq(p.interleave, 64, "long interleave is 64 symbols");
    eq(mt63Params("1000S").interleave, 32, "short is 32");
    eq(mt63Params("500S").carrierSpacingHz, 7.8125, "MT63-500: 7.8125 Hz and 5 baud");
    eq(mt63Params("500S").baud, 5, "  (5 baud)");
    eq(mt63Params("2000L").carrierSpacingHz, 31.25, "MT63-2000: 31.25 Hz and 20 baud");
    eq(mt63Params("2000L").baud, 20, "  (20 baud)");
    // fldigi: FirstDataCarr = floor((freq - BW/2) * 128 / 500 + 0.5) for 1000 (mt63base.cxx:111).
    eq(mt63FirstCarrierBin(p, 1500), 256, "a 1500 Hz cursor puts the first MT63-1000 carrier in bin 256, as fldigi's");
    eq(mt63CarrierHz(p, 1500, 0), 1000, "  so the bottom carrier is at 1000 Hz, half the width below the cursor");
    eq(mt63CarrierHz(p, 1500, 63), 1984.375, "  and the top at 1500 + 31/64 of the width");
    eq(mt63CarrierHz(mt63Params("2000L"), 1500, 0), 500, "MT63-2000 at 1500: 500 to 2468.75 Hz");
    eq(mt63CarrierHz(mt63Params("500S"), 750, 0), 500, "MT63-500 with fldigi's 'lowest tone at 500 Hz' (cursor 750)");
    eq(MT63_SYMBOL_SHAPE.length, 512, "the symbol shape is symbol.dat's 512 points");
    ok(MT63_SYMBOL_SHAPE[256] === 0.99999 && MT63_SYMBOL_SHAPE[1] === MT63_SYMBOL_SHAPE[511], "peaking at the middle and symmetric");
  }

  console.log("\nthe Walsh code");
  {
    // Each of the 128 codes is a +-1 row of the 64-point Hadamard matrix, upper 64 inverted:
    // the transform of the bits finds it again with the whole energy in one place.
    let allRound = true;
    let allClean = true;
    const rows = new Set<string>();
    for (let code = 0; code < 128; code++) {
      const w = new Float64Array(64);
      if (code < 64) w[code] = 1;
      else w[code - 64] = -1;
      ifht(w, 64);
      // On the air: bit 1 for a negative value (keep phase), 0 for positive (flip).
      const bits = Array.from(w, (v) => (v < 0 ? 1 : 0));
      rows.add(bits.join(""));
      // The receiver's soft value is +1 for a kept phase.
      const soft = new Float64Array(bits.map((b) => (b ? 1 : -1)));
      fht(soft, 64);
      let maxPos = 0;
      let minPos = 0;
      for (let i = 1; i < 64; i++) {
        if (soft[i]! > soft[maxPos]!) maxPos = i;
        if (soft[i]! < soft[minPos]!) minPos = i;
      }
      const back = Math.abs(soft[maxPos]!) > Math.abs(soft[minPos]!) ? maxPos + 64 : minPos;
      if (back !== code) allRound = false;
      const peak = Math.max(Math.abs(soft[maxPos]!), Math.abs(soft[minPos]!));
      let rest = 0;
      for (let i = 0; i < 64; i++) rest += Math.abs(soft[i]!);
      if (peak !== 64 || rest !== 64) allClean = false;
    }
    ok(allRound, "all 128 codes come back through the transform");
    ok(allClean, "each with all 64 of its bits in one bin and nothing in the others");
    eq(rows.size, 128, "and no two codes send the same bits");
    // Any two different codes differ in at least 32 of the 64 bits: why a third can be lost.
    let minDist = 64;
    const list = [...rows];
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        let d = 0;
        for (let i = 0; i < 64; i++) if (list[a]![i] !== list[b]![i]) d++;
        minDist = Math.min(minDist, d);
      }
    }
    eq(minDist, 32, "any two codes differ in at least 32 bits");
  }

  console.log("\nthe interleave");
  for (const il of [32, 64] as const) {
    // Code 64 is all bits 1, code 0 all bits 0 (as on the air with no prefill): sending one
    // 64 among 0s shows when each carrier's bit for it goes out.
    const enc = new Mt63Encoder(il);
    const delays = new Array<number>(MT63_CARRIERS).fill(-1);
    for (let t = 0; t < il + 2; t++) {
      const bits = enc.process(t === 0 ? 64 : 0);
      for (let i = 0; i < MT63_CARRIERS; i++) if (bits[i] && delays[i] === -1) delays[i] = t;
    }
    ok(delays.every((d) => d >= 0 && d < il), `${il === 32 ? "short" : "long"}: every carrier's bit goes out within ${il} symbols`, delays.join(","));
    eq(Math.max(...delays), il - 1, `  the last ${il - 1} symbols after the character`);
    const per = new Map<number, number>();
    for (const d of delays) per.set(d, (per.get(d) ?? 0) + 1);
    eq(per.size, il, `  and the delays use every one of the ${il} symbols`);
    eq(
      Math.max(...per.values()),
      MT63_CARRIERS / il,
      `  ${MT63_CARRIERS / il} carrier${il === 64 ? "" : "s"} per symbol, so a fade of a symbol or two costs any one character a bit or two`,
    );

    // Round trip in the code domain: all 128 codes through the interleaver and the decoder.
    const enc2 = new Mt63Encoder(il);
    const dec = new Mt63FecDecoder(il, 8, 16);
    const sent: number[] = [];
    for (let i = 0; i < 128; i++) sent.push(i);
    const stream = [...new Array<number>(il).fill(0), ...sent, ...new Array<number>(il + 16).fill(0)];
    const got: number[] = [];
    let minSnr = Infinity;
    for (const c of stream) {
      const bits = enc2.process(c);
      const data = new Float64Array(MT63_CARRIERS + 16);
      for (let i = 0; i < MT63_CARRIERS; i++) data[8 + i] = bits[i] ? 1 : -1;
      got.push(dec.process(data));
      if (got.length > il + 40) minSnr = Math.min(minSnr, dec.signalToNoise);
    }
    const at = got.indexOf(1);
    eq(got.slice(at - 1, at + 127).join(","), sent.join(","), `  all 128 codes come back out of the deinterleaver in order (${il})`);
    eq(dec.carrOfs, 0, "  found at the right carrier");
    // Shifted two carriers up, the decoder finds them there.
    const enc3 = new Mt63Encoder(il);
    const dec3 = new Mt63FecDecoder(il, 8, 16);
    const got3: number[] = [];
    for (const c of stream) {
      const bits = enc3.process(c);
      const data = new Float64Array(MT63_CARRIERS + 16);
      for (let i = 0; i < MT63_CARRIERS; i++) data[10 + i] = bits[i] ? 1 : -1;
      got3.push(dec3.process(data));
    }
    const at3 = got3.indexOf(1);
    ok(at3 > 0 && got3.slice(at3 - 1, at3 + 127).join(",") === sent.join(","), `  and two carriers off, still (offset ${dec3.carrOfs})`);
  }

  console.log("\nthe text");
  {
    const codes = mt63TextToCodes("KC9QRS\nEM48sq");
    eq(codes.join(","), [..."KC9QRS"].map((c) => c.charCodeAt(0)).concat(13, 10, ...[..."EM48sq"].map((c) => c.charCodeAt(0))).join(","), "ASCII as itself, a newline as CR LF");
    eq(mt63TextToCodes("é").join(","), "127,67,127,41", "é as its UTF-8 bytes C3 A9, each escaped with 127 (fldigi's 8-bit default)");
    eq(mt63TextToCodes("é", false).join(","), "46,46", "and as full stops with 8-bit off, as fldigi");
    const d = new Mt63TextDecoder();
    let s = "";
    for (const c of [0, 0, ...mt63TextToCodes("Café 73\nJürgen"), 0]) s += d.push(c);
    eq(s, "Café 73\nJürgen", "codes back to text: idle dropped, the escapes and UTF-8 put back");
    eq(d.errors, 0, "  with nothing counted as a misread");
  }

  console.log("\nthe waveform");
  for (const mode of ["1000L", "2000S", "500L"] as const) {
    for (const fs of [12_000, 24_000, 48_000]) {
      const opts = { sampleRate: fs, centreHz: 1500, mode };
      const wave = mt63Waveform("CQ", opts);
      const ms = mt63DurationMs("CQ", opts);
      if (fs !== 24_000 && mode !== "1000L") continue;
      eq(wave.length, Math.round((ms * fs) / 1000), `MT63-${mode} at ${fs / 1000} kHz: the length is the duration`);
    }
  }
  {
    const fs = 12_000;
    const p = mt63Params("1000L");
    const codes = mt63Codes("CQ", { mode: "1000L" });
    eq(codes.length, 64 + 2 + 63, "preamble of 64 idle, the text, 63 idle to flush the interleaver (fldigi's tx_process)");
    const ms = mt63DurationMs("CQ", { sampleRate: fs, centreHz: 1500, mode: "1000L" });
    // Plus the jamming symbol and the shape's 412-sample overlap run out.
    eq(Math.round(ms), Math.round(((codes.length + 1) / p.baud) * 1000 + (412 / p.basebandRate) * 1000), "  then the jamming symbol and the overlap run out to silence");
    const wave = mt63Waveform("CQ", { sampleRate: fs, centreHz: 1500, mode: "1000L" });
    let peak = 0;
    for (const v of wave) peak = Math.max(peak, Math.abs(v));
    ok(Math.abs(peak - 1) < 1e-6, "full scale and no more", `${peak}`);
    ok(Math.abs(wave[0]!) < 0.01 && Math.abs(wave[wave.length - 1]!) < 0.01, "starts and ends at zero: no click");
    // The energy is inside the band: 1000 to 1984 Hz for a 1500 Hz cursor.
    const tone = (hz: number) => {
      let re = 0;
      let im = 0;
      for (let i = 0; i < wave.length; i++) {
        re += wave[i]! * Math.cos((2 * Math.PI * hz * i) / fs);
        im -= wave[i]! * Math.sin((2 * Math.PI * hz * i) / fs);
      }
      return (re * re + im * im) / wave.length;
    };
    let inside = 0;
    let outside = 0;
    for (let f = 600; f <= 2400; f += 15.625) {
      if (f >= 1000 && f <= 1984.375) inside += tone(f);
      else if (f < 960 || f > 2030) outside += tone(f);
    }
    ok(outside < inside * 1e-3, `the signal stays between its edge carriers (out of band ${(10 * Math.log10(outside / inside)).toFixed(0)} dB)`);
    const tw = mt63Waveform("", { sampleRate: fs, centreHz: 1500, mode: "1000L", toneSeconds: 2 });
    eq(tw.length - mt63Waveform("", { sampleRate: fs, centreHz: 1500, mode: "1000L" }).length, 2 * fs, "fldigi's tuning tones, when asked for, go first for the time asked");
  }

  console.log("\nthe demodulator on a clean signal");
  {
    const fs = 12_000;
    const mode = "1000L";
    const wave = onAir(mt63Waveform(LINE, { sampleRate: fs, centreHz: 1500, mode }), fs, null, latencySeconds(mode));
    const demod = new Mt63Demodulator({ sampleRate: fs, centreHz: 1500, mode });
    const text = decodeAll(demod, wave);
    ok(text.includes(LINE), "MT63-1000L at 12 kHz: the line reads back, every character", JSON.stringify(text));
    ok(Math.abs(demod.statistics.afcHz) < 0.5, `found on frequency (${demod.statistics.afcHz.toFixed(2)} Hz)`);
    const chunked = decodeAll(new Mt63Demodulator({ sampleRate: fs, centreHz: 1500, mode }), wave, 97);
    eq(chunked, text, "fed in chunks of 97 the text is the same");
    const one = decodeAll(new Mt63Demodulator({ sampleRate: fs, centreHz: 1500, mode }), wave, 1);
    eq(one, text, "and one sample at a time");
    // A transmission followed by silence: flush() prints the rest, as fldigi's rx_flush.
    const bare = mt63Waveform(LINE, { sampleRate: fs, centreHz: 1500, mode });
    const fd = new Mt63Demodulator({ sampleRate: fs, centreHz: 1500, mode });
    const before = fd.feed(bare);
    const after = fd.flush();
    ok(!before.includes("pse K") && (before + after).includes(LINE), "without audio after it, flush() prints what was still in the pipeline", JSON.stringify(before + " | " + after));
  }
  for (const mode of MT63_MODES) {
    for (const fs of [12_000, 24_000, 48_000]) {
      if (fs !== 24_000 && !mode.endsWith("L")) continue;
      if (fs !== 24_000 && mode === "500L") continue;
      const wave = onAir(mt63Waveform(LINE, { sampleRate: fs, centreHz: 1500, mode }), fs, null, latencySeconds(mode));
      const demod = new Mt63Demodulator({ sampleRate: fs, centreHz: 1500, mode });
      const text = decodeAll(demod, wave, 4096);
      ok(text.includes(LINE), `MT63-${mode} at ${fs / 1000} kHz reads back`, JSON.stringify(text));
    }
  }
  {
    const fs = 24_000;
    const wave = onAir(mt63Waveform(LINE, { sampleRate: fs, centreHz: 1500, mode: "1000L" }), fs, null, latencySeconds("1000L", true));
    const text = decodeAll(new Mt63Demodulator({ sampleRate: fs, centreHz: 1500, mode: "1000L", longIntegration: true }), wave, 4096);
    ok(text.includes(LINE), "with long integration (32 symbols) too", JSON.stringify(text));
    const w8 = onAir(mt63Waveform("Café 73 Jürgen", { sampleRate: fs, centreHz: 1500, mode: "2000L" }), fs, null, latencySeconds("2000L"));
    const t8 = decodeAll(new Mt63Demodulator({ sampleRate: fs, centreHz: 1500, mode: "2000L" }), w8, 4096);
    ok(t8.includes("Café 73 Jürgen"), `8-bit characters come through whole (${JSON.stringify(t8)})`);
    const w2 = onAir(mt63Waveform("KC9QRS\nEM48sq", { sampleRate: fs, centreHz: 1500, mode: "2000L" }), fs, null, latencySeconds("2000L"));
    const t2 = decodeAll(new Mt63Demodulator({ sampleRate: fs, centreHz: 1500, mode: "2000L" }), w2, 4096);
    ok(t2.includes("KC9QRS\nEM48sq"), "a newline comes back as one newline");
  }

  console.log("\noff frequency");
  for (const [mode, off] of [
    ["1000L", 10],
    ["1000L", -13.3],
    ["1000L", 20],
    ["2000L", 17.5],
    ["2000L", -20],
    ["1000S", 15],
  ] as const) {
    const fs = 12_000;
    const wave = shifted(onAir(mt63Waveform(LINE + " " + LINE, { sampleRate: fs, centreHz: 1500, mode }), fs, null, latencySeconds(mode)), fs, off);
    const demod = new Mt63Demodulator({ sampleRate: fs, centreHz: 1500, mode });
    const text = decodeAll(demod, wave, 4096);
    ok(text.includes(LINE), `MT63-${mode} ${off > 0 ? "+" : ""}${off} Hz off reads`, JSON.stringify(text));
    const bin = mt63Params(mode).binHz;
    ok(Math.abs(demod.statistics.afcHz - off) < bin / 6, `  and says where it is, to a sixth of an FFT bin (${demod.statistics.afcHz.toFixed(2)} Hz)`);
  }
  {
    // retune() to where the signal is: on frequency again.
    const fs = 12_000;
    const wave = onAir(mt63Waveform(LINE, { sampleRate: fs, centreHz: 1600, mode: "1000L" }), fs, null, latencySeconds("1000L"));
    const demod = new Mt63Demodulator({ sampleRate: fs, centreHz: 1500, mode: "1000L" });
    demod.retune(1600);
    const text = decodeAll(demod, wave, 4096);
    ok(text.includes(LINE) && Math.abs(demod.statistics.afcHz) < 0.5, "retuned to a signal at 1600 Hz, it reads on frequency", JSON.stringify(text));
  }

  console.log("\nin noise (SNR in 2.5 kHz)");
  const fs = 12_000;
  for (const [mode, snr] of [
    ["1000L", 0],
    ["1000L", -6],
    ["2000L", -3],
    ["1000S", -4],
    ["500L", -9],
  ] as const) {
    const wave = onAir(mt63Waveform(LINE, { sampleRate: fs, centreHz: 1500, mode, amplitude: 0.3 }), fs, snr, latencySeconds(mode));
    const demod = new Mt63Demodulator({ sampleRate: fs, centreHz: 1500, mode });
    const text = decodeAll(demod, wave, 4096);
    const inBand = snr + 10 * Math.log10(2500 / mt63Params(mode).bandwidth);
    ok(text.includes(LINE), `MT63-${mode} at ${snr} dB (${inBand.toFixed(0)} dB in its ${mt63Params(mode).bandwidth} Hz) reads back`, JSON.stringify(text));
  }
  {
    // The weakest that still copies: the words of the line that come through, stepping down.
    const report: string[] = [];
    for (const mode of ["1000L", "2000L"] as const) {
      let weakest: number | null = null;
      for (let snr = -4; snr >= -14; snr -= 1) {
        const wave = onAir(mt63Waveform(LINE, { sampleRate: fs, centreHz: 1500, mode, amplitude: 0.3 }), fs, snr, latencySeconds(mode), 11);
        const text = decodeAll(new Mt63Demodulator({ sampleRate: fs, centreHz: 1500, mode }), wave, 4096);
        let hits = 0;
        const words = LINE.split(" ");
        for (const w of words) if (text.includes(` ${w} `) || text.includes(`${w} `) || text.endsWith(w)) hits++;
        if (hits >= words.length - 1) weakest = snr;
        else break;
      }
      const bw = mt63Params(mode).bandwidth;
      report.push(`${mode} ${weakest} dB (${weakest === null ? "-" : (weakest + 10 * Math.log10(2500 / bw)).toFixed(0)} dB in ${bw} Hz)`);
      // 2000 has half the time per character, so 3 dB less energy in each at the same SNR.
      const floor = mode === "1000L" ? -7 : -4;
      ok(weakest !== null && weakest <= floor, `MT63-${mode}: all but one word still copies at ${weakest} dB in 2.5 kHz (at least ${floor})`);
    }
    console.log(`  weakest that copies: ${report.join(", ")}`);
  }

  console.log("\nnoise alone: the squelch holds");
  {
    const g = noiseSource(99);
    const wave = new Float32Array(fs * 60);
    for (let i = 0; i < wave.length; i++) wave[i] = 0.3 * g();
    for (const mode of ["1000L", "2000S"] as const) {
      const demod = new Mt63Demodulator({ sampleRate: fs, centreHz: 1500, mode });
      const text = decodeAll(demod, wave, 4096);
      ok(text.length <= 3, `MT63-${mode}: sixty seconds of band noise prints next to nothing (${text.length} characters)`, JSON.stringify(text));
      eq(demod.statistics.errors, 0, "  and nothing is counted as a misread while the squelch is closed");
      ok(demod.statistics.level > 0.25 && demod.statistics.level < 0.35, `  the level reads the noise (${demod.statistics.level.toFixed(3)})`);
    }
    const open = new Mt63Demodulator({ sampleRate: fs, centreHz: 1500, mode: "1000L", squelch: 0 });
    const junk = decodeAll(open, wave, 4096);
    ok(junk.length > 200, `with the squelch off the same noise prints junk (${junk.length} characters), which is the squelch's job`);
  }

  console.log("\nwhat it costs");
  for (const [mode, rate] of [
    ["1000L", 24_000],
    ["2000L", 24_000],
    ["500L", 24_000],
    ["1000L", 48_000],
  ] as const) {
    const wave = onAir(mt63Waveform(LINE + " " + LINE, { sampleRate: rate, centreHz: 1500, mode, amplitude: 0.3 }), rate, 0, 2);
    // At least a minute of audio, so the CPU clock's tick (15.6 ms on Windows) does not matter.
    let seconds = 0;
    const t0 = process.cpuUsage();
    while (seconds < 60) {
      decodeAll(new Mt63Demodulator({ sampleRate: rate, centreHz: 1500, mode }), wave, 2400);
      seconds += wave.length / rate;
    }
    const used = process.cpuUsage(t0);
    const perSecond = (used.user + used.system) / 1e6 / seconds;
    console.log(`  MT63-${mode} at ${rate / 1000} kHz: ${perSecond.toFixed(4)} s of CPU per second of audio (${(perSecond * 100).toFixed(1)}% of a core)`);
    ok(perSecond < 0.2, `  well under 20% of a core`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main();
