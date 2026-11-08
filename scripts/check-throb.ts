/* eslint-disable no-console */
// Throb and ThrobX: the tables, the transmit sequence against tone pairs worked by hand
// from fldigi's code, the waveform, and the demodulator on generated signals - clean, at
// every rate the radios give, chunked, off frequency, in noise - and on noise alone and
// digital silence, where the squelch has to hold.

import {
  THROBX_CHARSET,
  THROBX_TONE_PAIRS,
  THROB_CHARSET,
  THROB_MODES,
  THROB_TONE_PAIRS,
  ThrobCharDecoder,
  throbDurationMs,
  throbParams,
  throbPulse,
  throbSymbols,
  throbToneHz,
  throbTonePairs,
  throbWaveform,
  type ThrobMode,
} from "@/lib/digital/throb";
import { ThrobDemodulator } from "@/lib/digital/throbdemod";

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

/** Add white noise for a signal-to-noise ratio measured in a 2.5 kHz bandwidth, the usual SSB reference. */
function withNoise(wave: Float32Array, snrDb: number, sampleRate: number, seed = 7): Float32Array {
  let p = 0;
  for (const v of wave) p += v * v;
  const signalPower = p / wave.length;
  const noisePower = (signalPower / 10 ** (snrDb / 10)) * (sampleRate / 2 / 2500);
  const g = noiseSource(seed);
  const sigma = Math.sqrt(noisePower);
  // Two seconds of noise either side, so the decoder starts and ends on an empty channel.
  const pad = 2 * sampleRate;
  const out = new Float32Array(wave.length + 2 * pad);
  for (let i = 0; i < out.length; i++) out[i] = (wave[i - pad] ?? 0) + sigma * g();
  return out;
}

/**
 * The over and then a quarter of a second of silence. A received character prints once
 * the next symbol has been heard, and the closing idle is only complete once the
 * baseband filter has emptied, some 40 ms after the audio ends; a radio's stream never
 * stops dead at the end of an over, so the test does not either.
 */
function tail(wave: Float32Array, fs: number, seconds = 0.25): Float32Array {
  const out = new Float32Array(wave.length + Math.round(seconds * fs));
  out.set(wave);
  return out;
}

function decodeAll(demod: ThrobDemodulator, wave: Float32Array, chunk = wave.length): string {
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

const LINE = "CQ CQ DE KC9QRS KC9QRS PSE K";
const SLOW = new Set<ThrobMode>(["THROB1", "THROBX1"]);

async function main(): Promise<void> {
  console.log("\nthe submodes, as fldigi's constructor sets them (throb.cxx:141-220)");
  {
    const want: Record<ThrobMode, [number, number, number, string, number]> = {
      THROB1: [8000 / 8192, 8, 64, "semi", 9],
      THROB2: [8000 / 4096, 8, 64, "semi", 9],
      THROB4: [8000 / 2048, 16, 128, "full", 9],
      THROBX1: [8000 / 8192, 7.8125, 78.125, "semi", 11],
      THROBX2: [8000 / 4096, 7.8125, 78.125, "semi", 11],
      THROBX4: [8000 / 2048, 15.625, 156.25, "full", 11],
    };
    for (const m of THROB_MODES) {
      const p = throbParams(m);
      const [baud, sp, bw, pulse, tones] = want[m];
      ok(
        Math.abs(p.baud - baud) < 1e-12 && p.toneSpacingHz === sp && p.bandwidthHz === bw && p.pulse === pulse && p.tones === tones,
        `${p.label}: ${p.baud.toFixed(3)} baud, ${p.tones} tones ${p.toneSpacingHz} Hz apart, ${p.bandwidthHz} Hz wide, ${p.pulse} pulse`,
      );
    }
    // The middle tone sits on the operator's frequency and the set is symmetric (send, throb.cxx:609).
    ok(throbToneHz(4, 1500, "THROB1") === 1500 && throbToneHz(5, 1500, "THROBX4") === 1500, "the middle tone is on the frequency");
    ok(throbToneHz(0, 1500, "THROB2") === 1468 && throbToneHz(8, 1500, "THROB2") === 1532, "Throb 2 on 1500 runs 1468 to 1532 Hz");
    ok(throbToneHz(0, 1500, "THROBX4") === 1421.875 && throbToneHz(10, 1500, "THROBX4") === 1578.125, "ThrobX 4 on 1500 runs 1421.875 to 1578.125 Hz");
  }

  console.log("\nthe tables (throb.cxx:729-939)");
  {
    eq([THROB_TONE_PAIRS.length, THROB_CHARSET.length], [45, 45], "Throb: 45 symbols, 45 characters");
    eq([THROBX_TONE_PAIRS.length, THROBX_CHARSET.length], [55, 55], "ThrobX: 55 symbols, 55 characters");
    const key = ([a, b]: readonly [number, number]) => `${a},${b}`;
    const tp = new Set(THROB_TONE_PAIRS.map(key));
    const all9: string[] = [];
    for (let a = 1; a <= 9; a++) for (let b = a; b <= 9; b++) all9.push(`${a},${b}`);
    ok(tp.size === 45 && all9.every((k) => tp.has(k)), "Throb uses every pair of its nine tones and every single tone, once each");
    const xp = new Set(THROBX_TONE_PAIRS.map(key));
    const all11: string[] = [];
    for (let a = 1; a <= 11; a++) for (let b = a + 1; b <= 11; b++) all11.push(`${a},${b}`);
    ok(xp.size === 55 && all11.every((k) => xp.has(k)), "ThrobX uses every pair of its eleven tones, once each, and no single tone");
    eq([THROB_CHARSET[0], THROB_CHARSET[5], THROB_CHARSET[43], THROB_CHARSET[44]], ["\0", "\0", "E", " "], "Throb: idle at 0, SHIFT at 5 (where E was), E at 43, space at 44");
    eq([THROBX_CHARSET[0], THROBX_CHARSET[1], THROBX_CHARSET[54]], ["\0", " ", "\n"], "ThrobX: idle 0, space 1, newline 54");
  }

  console.log("\nevery character round-trips through its table");
  {
    const throbText = "ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789 ,.'/() ?@-\nE";
    for (const m of ["THROB1", "THROB4"] as ThrobMode[]) {
      const d = new ThrobCharDecoder(m);
      const got = throbTonePairs(throbText, m).map(([a, b]) => d.push(a, b)).join("");
      eq(got, throbText, `${m}: every Throb character, the shifted ? @ - and newline among them`);
    }
    const xText = "ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789 ,.'/)(#\"+-;:?!@=\nE";
    for (const m of ["THROBX2", "THROBX4"] as ThrobMode[]) {
      const d = new ThrobCharDecoder(m);
      const got = throbTonePairs(xText, m).map(([a, b]) => d.push(a, b)).join("");
      // The closing idle follows a character, so fldigi's receiver prints a space for it.
      eq(got, xText + " ", `${m}: every ThrobX character, and the closing idle reads as a space as fldigi reads it`);
    }
    {
      const d = new ThrobCharDecoder("THROB2");
      const got = throbTonePairs("de kc9qrs = ~", "THROB2").map(([a, b]) => d.push(a, b)).join("");
      eq(got, "DE KC9QRS    ", "lower case goes as capitals; a character Throb lacks goes as a space");
    }
    {
      const d = new ThrobCharDecoder("THROBX1");
      const got = throbTonePairs("A  B", "THROBX1").map(([a, b]) => d.push(a, b)).join("");
      eq(got, "A B ", "ThrobX: two spaces read as one, as fldigi reads a run of spaces and idles");
    }
    eq(throbSymbols("é", "THROB1"), [0, 0, 0, 0, 44, 44, 0], "a character outside the alphabet is a space per UTF-8 byte, as fldigi reads its buffer");
  }

  console.log("\nknown answers, worked by hand from tx_process and the tables");
  {
    // Throb "CQ?": four idles (symbol 0, tones 5 5), C (symbol 3, {1,3}), Q (17, {2,9}),
    // ? as SHIFT (5, {4,6}) then T (20, {1,9}), and the closing idle. 0-based tones.
    eq(throbSymbols("CQ?", "THROB1"), [0, 0, 0, 0, 3, 17, 5, 20, 0], "Throb 'CQ?' is idle x4, C, Q, SHIFT T, idle");
    eq(
      throbTonePairs("CQ?", "THROB1"),
      [[4, 4], [4, 4], [4, 4], [4, 4], [0, 2], [1, 8], [3, 5], [0, 8], [4, 4]],
      "and the tones are 44 44 44 44 02 18 35 08 44",
    );
    eq(throbTonePairs("-", "THROB4").slice(4, 6), [[3, 5], [2, 6]], "Throb '-' is SHIFT then the pair of I");
    // ThrobX "A B": the idle (0, {6,11}) and space (1, {1,6}) swap every time either goes.
    // Preamble 0 1 0 1 leaves them as they started; A (2, {2,6}); the space is symbol 1 and
    // swaps them; B (3, {2,5}); the closing idle is now symbol 1.
    eq(throbSymbols("A B", "THROBX1"), [0, 1, 0, 1, 2, 1, 3, 1], "ThrobX 'A B' is idle space idle space, A, space, B, and the closing idle is the other pair");
    eq(
      throbTonePairs("A B", "THROBX1"),
      [[5, 10], [0, 5], [5, 10], [0, 5], [1, 5], [0, 5], [1, 4], [0, 5]],
      "and the tones are 5A 05 5A 05 15 05 14 05",
    );
    eq(throbSymbols("A  B", "THROBX2"), [0, 1, 0, 1, 2, 1, 0, 3, 0], "two spaces go as the two different pairs");
  }

  console.log("\nthe pulse (mk_semi_pulse, mk_full_pulse: throb.cxx:542-579)");
  {
    ok(throbPulse(0, 8192, "semi") === 0 && throbPulse(1638, 8192, "semi") === 1 && throbPulse(6552, 8192, "semi") === 1, "semi: rises from 0 over the first fifth, flat to 4/5");
    ok(Math.abs(throbPulse(819, 8192, "semi") - 0.5 * (1 - Math.cos((Math.PI * 819) / 1638.4))) < 1e-15, "with fldigi's divisor, len / 5.0");
    ok(throbPulse(6553, 8192, "semi") === 1 && throbPulse(8191, 8192, "semi") < 1e-5, "and falls back to nothing by the end");
    ok(throbPulse(0, 2048, "full") === 0 && throbPulse(1024, 2048, "full") === 1, "full: a raised cosine, peak mid-symbol");
  }

  console.log("\nthe waveform");
  for (const fs of [12_000, 24_000, 48_000]) {
    for (const mode of THROB_MODES) {
      const wave = throbWaveform("CQ", { sampleRate: fs, centreHz: 1500, mode });
      const ms = throbDurationMs("CQ", { mode });
      if (fs === 12_000 || mode === "THROB4") ok(wave.length === (ms * fs) / 1000, `${mode} at ${fs} Hz: ${wave.length} samples is the ${ms} ms the duration says`);
      else if (wave.length !== (ms * fs) / 1000) ok(false, `${mode} at ${fs} Hz: length`, `${wave.length} vs ${(ms * fs) / 1000}`);
    }
  }
  {
    const fs = 12_000;
    for (const mode of ["THROB4", "THROBX2"] as ThrobMode[]) {
      const p = throbParams(mode);
      const wave = throbWaveform("KC9QRS", { sampleRate: fs, centreHz: 1500, mode });
      const sym = (p.symbolLen * fs) / 8000;
      const want = throbTonePairs("KC9QRS", mode);
      const heard: [number, number][] = [];
      for (let k = 0; k < want.length; k++) {
        const mags = Array.from({ length: p.tones }, (_, t) => toneMag(wave, k * sym, (k + 1) * sym, throbToneHz(t, 1500, mode), fs));
        const order = mags.map((m, t) => [m, t] as const).sort((a, b) => b[0] - a[0]);
        const a = order[0]![1];
        const b = order[0]![0] > 2 * order[1]![0] ? a : order[1]![1];
        heard.push([Math.min(a, b), Math.max(a, b)]);
      }
      eq(heard, want, `${mode}: the audio carries those tone pairs, symbol by symbol`);
      let peak = 0;
      for (const v of wave) peak = Math.max(peak, Math.abs(v));
      ok(peak <= 1 && peak > 0.9, `${mode}: full scale and no more (${peak.toFixed(3)})`);
      let edges = 0;
      for (let k = 0; k <= want.length; k++) edges = Math.max(edges, Math.abs(wave[Math.min(wave.length - 1, k * sym)] ?? 0));
      ok(edges < 0.01, `${mode}: every symbol starts at nothing, so no click between throbs`);
    }
  }

  console.log("\nthe demodulator on a clean signal");
  for (const fs of [12_000, 24_000, 48_000]) {
    for (const mode of THROB_MODES) {
      const wave = tail(throbWaveform(LINE, { sampleRate: fs, centreHz: 1500, mode, amplitude: 0.5 }), fs);
      const text = decodeAll(new ThrobDemodulator({ sampleRate: fs, centreHz: 1500, mode }), wave);
      ok(text === LINE, `${mode} at ${fs} Hz reads back exactly`, JSON.stringify(text));
    }
  }
  {
    const fs = 12_000;
    const mode: ThrobMode = "THROBX4";
    const said = "KC9QRS: 73, GL!\nQTH? #2 @ \"HOME\"";
    const wave = tail(throbWaveform(said, { sampleRate: fs, centreHz: 1500, mode }), fs, 0.6);
    const demod = new ThrobDemodulator({ sampleRate: fs, centreHz: 1500, mode });
    const text = decodeAll(demod, wave);
    eq(text, said, "ThrobX: punctuation and a newline, and the closing idle's space does not print");
    ok(!demod.statistics.open, "after the over the squelch is shut again");
    eq(demod.statistics.chars, text.length, "the character count says what printed");
    const t4 = decodeAll(new ThrobDemodulator({ sampleRate: fs, centreHz: 1500, mode: "THROB4" }), tail(throbWaveform("WHO? KC9QRS-1 @ HOME\nOK", { sampleRate: fs, centreHz: 1500, mode: "THROB4" }), fs));
    eq(t4, "WHO? KC9QRS-1 @ HOME\nOK", "Throb: the shifted characters and the newline");
    for (const chunk of [1, 97]) {
      const t = decodeAll(new ThrobDemodulator({ sampleRate: fs, centreHz: 1500, mode }), wave, chunk);
      eq(t, text, `fed ${chunk === 1 ? "one sample at a time" : `in chunks of ${chunk}`} the text is the same`);
    }
    const w48 = tail(throbWaveform(LINE, { sampleRate: 48_000, centreHz: 1500, mode: "THROB2" }), 48_000);
    const whole = decodeAll(new ThrobDemodulator({ sampleRate: 48_000, centreHz: 1500, mode: "THROB2" }), w48);
    const ones = decodeAll(new ThrobDemodulator({ sampleRate: 48_000, centreHz: 1500, mode: "THROB2" }), w48, 1);
    const odd = decodeAll(new ThrobDemodulator({ sampleRate: 48_000, centreHz: 1500, mode: "THROB2" }), w48, 97);
    ok(whole === LINE && ones === whole && odd === whole, "and at 48 kHz in Throb 2: whole, one sample at a time and in 97s all read the same");
    // The level: a ThrobX symbol is two tones of half the amplitude each.
    const lv = new ThrobDemodulator({ sampleRate: fs, centreHz: 1500, mode });
    lv.feed(throbWaveform(LINE, { sampleRate: fs, centreHz: 1500, mode }));
    ok(Math.abs(lv.statistics.level - 0.5) < 0.05, `the level reads the strongest tone's amplitude (${lv.statistics.level.toFixed(2)}, each of two tones at 0.5)`);
    ok(lv.statistics.quality > 0.9, `quality near 1 on a clean signal (${lv.statistics.quality.toFixed(2)})`);
  }
  {
    const fs = 24_000;
    const mode: ThrobMode = "THROB2";
    const demod = new ThrobDemodulator({ sampleRate: fs, centreHz: 1000, mode });
    demod.retune(1800);
    const t = decodeAll(demod, tail(throbWaveform(LINE, { sampleRate: fs, centreHz: 1800, mode }), fs));
    eq(t, LINE, "retuned to 1800 Hz, it reads a signal there");
    demod.reset();
    eq(
      [demod.statistics.chars, demod.statistics.quality, demod.statistics.afcHz, demod.statistics.open, demod.statistics.level],
      [0, 0, 0, false, 0],
      "a reset clears the statistics too",
    );
    const t2 = decodeAll(demod, tail(throbWaveform("DE KC9QRS", { sampleRate: fs, centreHz: 1800, mode }), fs));
    eq(t2, "DE KC9QRS", "and after it, the next over reads as if the demodulator were new");
    const fresh = decodeAll(new ThrobDemodulator({ sampleRate: fs, centreHz: 1800, mode }), tail(throbWaveform("DE KC9QRS", { sampleRate: fs, centreHz: 1800, mode }), fs));
    eq(t2, fresh, "  (the same text a new one gives)");
  }

  console.log("\noff frequency");
  for (const mode of THROB_MODES) {
    const fs = 12_000;
    // A few hertz: three at the slow speeds, where the tones are 8 Hz apart, six where they are 16.
    const few = throbParams(mode).toneSpacingHz > 10 ? 6 : 3;
    for (const off of [few, -few]) {
      const wave = tail(throbWaveform(LINE, { sampleRate: fs, centreHz: 1500 + off, mode, amplitude: 0.5 }), fs);
      const demod = new ThrobDemodulator({ sampleRate: fs, centreHz: 1500, mode });
      const t = decodeAll(demod, wave);
      ok(
        t === LINE && Math.abs(demod.statistics.afcHz - off) <= 0.5,
        `${mode} ${off > 0 ? "+" : ""}${off} Hz off reads, and the AFC finds it (${demod.statistics.afcHz.toFixed(2)} Hz)`,
        JSON.stringify(t),
      );
    }
  }

  console.log("\nin noise (S/N in 2.5 kHz)");
  {
    // Levels where each submode copies cleanly, nothing printed before or after the over.
    const levels: [ThrobMode, number][] = [["THROB1", -17], ["THROB2", -14], ["THROB4", -10], ["THROBX1", -19], ["THROBX2", -15], ["THROBX4", -12]];
    for (const [mode, snr] of levels) {
      const fs = 12_000;
      const clean = throbWaveform(LINE, { sampleRate: fs, centreHz: 1500, mode, amplitude: 0.5 });
      for (const seed of [7, 8]) {
        const t = decodeAll(new ThrobDemodulator({ sampleRate: fs, centreHz: 1500, mode }), withNoise(clean, snr, fs, seed));
        ok(t === LINE, `${mode} at ${snr} dB reads back, nothing before or after it (seed ${seed})`, JSON.stringify(t));
      }
    }
    // The edge: most words still read 2 to 3 dB further down.
    for (const [mode, snr] of [["THROB1", -20], ["THROB4", -13], ["THROBX2", -18], ["THROBX4", -14]] as [ThrobMode, number][]) {
      const fs = 24_000;
      const clean = throbWaveform(LINE, { sampleRate: fs, centreHz: 1500, mode, amplitude: 0.5 });
      const t = decodeAll(new ThrobDemodulator({ sampleRate: fs, centreHz: 1500, mode }), withNoise(clean, snr, fs));
      const words = LINE.split(" ");
      let hits = 0;
      for (const w of words) if (t.includes(w)) hits++;
      ok(hits >= words.length / 2, `${mode} at ${snr} dB: half the words or more still read (${hits} of ${words.length})`, JSON.stringify(t));
    }
  }

  console.log("\nnoise alone: the squelch holds");
  for (const mode of THROB_MODES) {
    const fs = 12_000;
    const g = noiseSource(99 + mode.length * 7 + mode.charCodeAt(mode.length - 1));
    const wave = new Float32Array(fs * 60);
    for (let i = 0; i < wave.length; i++) wave[i] = 0.3 * g();
    const demod = new ThrobDemodulator({ sampleRate: fs, centreHz: 1500, mode });
    const text = decodeAll(demod, wave, 4096);
    ok(text.length <= 2, `${mode}: sixty seconds of band noise prints next to nothing (${text.length} characters)`, JSON.stringify(text));
    ok(demod.statistics.quality < 0.1, `  quality reads as noise (${demod.statistics.quality.toFixed(2)})`);
    if (mode === "THROBX4") {
      const junk = decodeAll(new ThrobDemodulator({ sampleRate: fs, centreHz: 1500, mode, squelch: 0 }), wave);
      ok(junk.length > 50, `  with the squelch off the same noise prints junk (${junk.length} characters), which is the squelch's job`);
    }
  }

  console.log("\ndigital silence (a FlexRadio's DAX between overs is exact zeros)");
  for (const mode of THROB_MODES) {
    const fs = 12_000;
    const over = throbWaveform(LINE, { sampleRate: fs, centreHz: 1500, mode, amplitude: 0.5 });
    const wave = new Float32Array(over.length + 4 * fs);
    wave.set(over);
    const demod = new ThrobDemodulator({ sampleRate: fs, centreHz: 1500, mode });
    const text = decodeAll(demod, wave, 4096);
    ok(text === LINE && !demod.statistics.open, `${mode}: four seconds of exact zeros after an over print nothing, and the squelch shuts`, JSON.stringify(text));
  }
  {
    const fs = 48_000;
    const demod = new ThrobDemodulator({ sampleRate: fs, centreHz: 1500, mode: "THROBX4" });
    const t = decodeAll(demod, new Float32Array(fs * 10), 4800);
    ok(t === "" && demod.statistics.quality === 0, "ten seconds of nothing but zeros prints nothing and reads quality 0");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
