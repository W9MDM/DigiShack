/* eslint-disable no-console */
// DominoEX: the Varicode, the IFK+ tone arithmetic against sequences worked by hand from
// fldigi's code, the waveform, and the demodulator on generated signals - clean, at every
// rate the radios give, chunked, off frequency, on a mismatched clock, in noise - and on
// noise alone, where the squelch has to hold.

import {
  DOMINOEX_MODES,
  DOMINOEX_TONES,
  DominoexVaricodeDecoder,
  dominoexCharForCode,
  dominoexCodeFor,
  dominoexDurationMs,
  dominoexEncodeBytes,
  dominoexNibbleBetween,
  dominoexNibbles,
  dominoexParams,
  dominoexTextBytes,
  dominoexToneHz,
  dominoexTones,
  dominoexWaveform,
  type DominoexMode,
} from "@/lib/digital/dominoex";
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

/** Add white noise for a signal-to-noise ratio measured in a 2.5 kHz bandwidth, the usual SSB reference. */
function withNoise(wave: Float32Array, snrDb: number, sampleRate: number, seed = 7): Float32Array {
  let p = 0;
  for (const v of wave) p += v * v;
  const signalPower = p / wave.length;
  const noisePower = (signalPower / 10 ** (snrDb / 10)) * (sampleRate / 2 / 2500);
  const g = noiseSource(seed);
  const sigma = Math.sqrt(noisePower);
  // A second of noise either side, so the decoder starts and ends on an empty channel.
  const pad = sampleRate;
  const out = new Float32Array(wave.length + 2 * pad);
  for (let i = 0; i < out.length; i++) out[i] = (wave[i - pad] ?? 0) + sigma * g();
  return out;
}

function decodeAll(demod: DominoexDemodulator, wave: Float32Array, chunk = wave.length): string {
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
  console.log("\nthe submodes, as fldigi's constructor sets them (dominoex.cxx:223-282)");
  {
    const want: Record<DominoexMode, [number, number]> = {
      4: [3.90625, 7.8125],
      5: [11025 / 2048, 11025 / 1024],
      8: [7.8125, 15.625],
      11: [11025 / 1024, 11025 / 1024],
      16: [15.625, 15.625],
      22: [11025 / 512, 11025 / 512],
    };
    for (const m of DOMINOEX_MODES) {
      const p = dominoexParams(m);
      ok(
        Math.abs(p.baud - want[m][0]) < 1e-9 && Math.abs(p.toneSpacingHz - want[m][1]) < 1e-9,
        `DominoEX ${m}: ${p.baud.toFixed(3)} baud, tones ${p.toneSpacingHz.toFixed(3)} Hz apart, ${p.bandwidthHz.toFixed(1)} Hz wide`,
      );
    }
    // Centred on the operator's frequency: tone n at (n + 0.5) spacings above centre - bandwidth/2.
    const t0 = dominoexToneHz(0, 1500, 11);
    const t17 = dominoexToneHz(17, 1500, 11);
    ok(Math.abs(t0 - (1500 - 8.5 * (11025 / 1024))) < 1e-9, `tone 0 of DominoEX 11 on 1500 is 8.5 spacings down (${t0.toFixed(2)} Hz)`);
    ok(Math.abs((t0 + t17) / 2 - 1500) < 1e-9, "and the tone set is centred on the frequency, not started from it");
  }

  console.log("\nthe Varicode (dominovar.cxx)");
  {
    let shape = true;
    for (let i = 0; i < 512; i++) {
      const c = dominoexCodeFor(i & 0xff, i >= 256);
      if (c.length < 1 || c.length > 3 || c[0]! & 8 || c.slice(1).some((n) => !(n & 8))) shape = false;
    }
    ok(shape, "every code is 1-3 nibbles: the first with its top bit clear, the rest with it set");
    let primary = 0;
    for (let b = 0; b < 256; b++) if (dominoexCharForCode(dominoexCodeFor(b)) === b) primary++;
    eq(primary, 256, "every primary character reads back to itself");
    let secondary = 0;
    const odd: number[] = [];
    for (let b = 0; b < 256; b++) {
      const got = dominoexCharForCode(dominoexCodeFor(b, true));
      if (got === b + 256) secondary++;
      else odd.push(b, got - 256);
    }
    eq(secondary, 255, "every secondary character reads back to itself, flagged secondary, but one");
    eq(odd, [123, 125], "the one: fldigi's table gives secondary { and } the same code, which reads as }");
    eq(dominoexCodeFor(32), [0], "space is the one-nibble code 0");
    eq(dominoexCodeFor("e".charCodeAt(0)), [1], "e is 1");
    eq(dominoexCodeFor("t".charCodeAt(0)), [2], "t is 2");
    eq(dominoexCodeFor("E".charCodeAt(0)), [3, 8], "E, the capital, is two nibbles");
    eq(dominoexCodeFor(13), [2, 13], "CR");
    eq(dominoexCodeFor(0, true), [6, 15, 9], "the idle, a secondary NUL, is three nibbles");
    eq(dominoexCharForCode([7, 7]), -1, "a code no character has reads as -1");

    // Every printable character, as a stream through the nibble decoder.
    const printable: number[] = [];
    for (let c = 32; c < 127; c++) printable.push(c);
    for (const sec of [false, true]) {
      const d = new DominoexVaricodeDecoder();
      const got: number[] = [];
      for (const n of [...dominoexEncodeBytes(printable, sec), 0]) {
        const r = d.push(n);
        if (r !== null) got.push(r);
      }
      const want = printable.map((c) => (sec ? (c === 123 ? 125 : c) + 256 : c));
      eq(got, want, `all 95 printable characters stream through the decoder (${sec ? "secondary" : "primary"} alphabet)`);
    }
    eq(dominoexTextBytes("a\nb"), [97, 13, 10, 98], "a newline goes as CR LF");
    eq(dominoexTextBytes("é"), [0xc3, 0xa9], "and é as its two UTF-8 bytes, as fldigi sends it");
  }

  console.log("\nIFK+, known answers worked by hand from sendsymbol (dominoex.cxx:676)");
  {
    // tx_init starts at tone 0. The over is: idle (secondary NUL 6 15 9), CR (2 13), STX
    // (1 15 11), CR (2 13), then "e" (1) and "t" (2). Each tone is the last + 2 + nibble, mod 18:
    //   0+2+6=8, 8+2+15=25->7, 7+2+9=18->0, 0+2+2=4, 4+2+13=19->1, 1+2+1=4, 4+2+15=21->3,
    //   3+2+11=16, 16+2+2=20->2, 2+2+13=17, 17+2+1=20->2, 2+2+2=6.
    const nib = dominoexNibbles("et");
    eq(nib.slice(0, 12), [6, 15, 9, 2, 13, 1, 15, 11, 2, 13, 1, 2], "the nibbles of the over 'et' start idle, CR STX CR, e, t");
    eq(dominoexTones(nib).slice(0, 12), [8, 7, 0, 4, 1, 4, 3, 16, 2, 17, 2, 6], "and the tones are 8 7 0 4 1 4 3 16 2 17 2 6");
    eq(nib.slice(12, 19), [2, 13, 1, 15, 13, 2, 13], "then CR EOT CR");
    eq(nib.slice(19), [6, 15, 9, 6, 15, 9, 6, 15, 9, 6, 15, 9], "then four idles to flush the far end (flushtx)");
    const tones = dominoexTones(nib);
    let inverse = true;
    let minStep = DOMINOEX_TONES;
    for (let i = 0; i < nib.length; i++) {
      const prev = i === 0 ? 0 : tones[i - 1]!;
      if (dominoexNibbleBetween(prev, tones[i]!) !== nib[i]) inverse = false;
      minStep = Math.min(minStep, (tones[i]! - prev + DOMINOEX_TONES) % DOMINOEX_TONES);
    }
    ok(inverse, "the receiver's difference reads every nibble back");
    ok(minStep >= 2, `and no tone is ever repeated or followed by its neighbour (smallest step ${minStep})`);
  }

  console.log("\nthe waveform");
  for (const fs of [12_000, 24_000, 48_000]) {
    for (const mode of [11, 8] as DominoexMode[]) {
      const wave = dominoexWaveform("CQ", { sampleRate: fs, centreHz: 1500, mode });
      const ms = dominoexDurationMs("CQ", { mode });
      ok(Math.abs(wave.length - (ms * fs) / 1000) <= 0.5, `DominoEX ${mode} at ${fs} Hz: ${wave.length} samples is the ${ms.toFixed(1)} ms the duration says`);
    }
  }
  {
    const fs = 12_000;
    const mode: DominoexMode = 16;
    const wave = dominoexWaveform("et", { sampleRate: fs, centreHz: 1500, mode });
    const p = dominoexParams(mode);
    const sym = (fs * p.symbolLen) / p.baseRate;
    const want = [8, 7, 0, 4, 1, 4, 3, 16, 2, 17, 2, 6];
    const heard: number[] = [];
    for (let k = 0; k < want.length; k++) {
      let best = 0;
      let bestMag = 0;
      for (let t = 0; t < DOMINOEX_TONES; t++) {
        const m = toneMag(wave, Math.round(k * sym), Math.round((k + 1) * sym), dominoexToneHz(t, 1500, mode), fs);
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
    ok(Math.abs(wave[0]!) < 0.01 && Math.abs(wave[wave.length - 1]!) < 0.05, "starts and ends at zero: no click");
    // Phase-continuous: no sample-to-sample jump bigger than the fastest tone allows.
    const maxStep = (2 * Math.PI * dominoexToneHz(17, 1500, mode)) / fs;
    let jump = 0;
    for (let i = 1; i < wave.length; i++) jump = Math.max(jump, Math.abs(wave[i]! - wave[i - 1]!));
    ok(jump <= maxStep * 1.01, `phase-continuous across tone changes (largest step ${jump.toFixed(3)}, limit ${maxStep.toFixed(3)})`);
  }

  console.log("\nthe demodulator on a clean signal");
  for (const fs of [12_000, 24_000, 48_000]) {
    for (const mode of [8, 11, 16] as DominoexMode[]) {
      const wave = dominoexWaveform(LINE, { sampleRate: fs, centreHz: 1500, mode, amplitude: 0.5 });
      const demod = new DominoexDemodulator({ sampleRate: fs, centreHz: 1500, mode });
      const text = decodeAll(demod, wave);
      ok(text === LINE, `DominoEX ${mode} at ${fs} Hz reads back exactly`, JSON.stringify(text));
    }
  }
  for (const mode of [4, 5, 22] as DominoexMode[]) {
    const fs = 12_000;
    const wave = dominoexWaveform(LINE, { sampleRate: fs, centreHz: 1500, mode, amplitude: 0.5 });
    const text = decodeAll(new DominoexDemodulator({ sampleRate: fs, centreHz: 1500, mode }), wave);
    ok(text === LINE, `DominoEX ${mode} at ${fs} Hz too`, JSON.stringify(text));
  }
  {
    const fs = 12_000;
    const mode: DominoexMode = 11;
    const wave = dominoexWaveform(LINE + "\n73 Café", { sampleRate: fs, centreHz: 1500, mode });
    const demod = new DominoexDemodulator({ sampleRate: fs, centreHz: 1500, mode });
    const text = decodeAll(demod, wave);
    eq(text, LINE + "\n73 Café", "a newline and UTF-8 come back whole; the STX and EOT framing prints nothing");
    ok(demod.statistics.quality > 0.9, `quality near 1 (${demod.statistics.quality.toFixed(2)})`);
    eq(demod.statistics.errors, 0, "nothing unread");
    eq(demod.statistics.chars, text.length, "and the character count says so");
    ok(Math.abs(demod.statistics.level - 1) < 0.1, `the level reads the tone's amplitude (${demod.statistics.level.toFixed(2)})`);
    for (const chunk of [1, 97]) {
      const t = decodeAll(new DominoexDemodulator({ sampleRate: fs, centreHz: 1500, mode }), wave, chunk);
      eq(t, text, `fed ${chunk === 1 ? "one sample at a time" : `in chunks of ${chunk}`} the text is the same`);
    }
    const w48 = dominoexWaveform(LINE, { sampleRate: 48_000, centreHz: 1500, mode: 8 });
    const whole = decodeAll(new DominoexDemodulator({ sampleRate: 48_000, centreHz: 1500, mode: 8 }), w48);
    const ones = decodeAll(new DominoexDemodulator({ sampleRate: 48_000, centreHz: 1500, mode: 8 }), w48, 1);
    eq(ones, whole, "and at 48 kHz in DominoEX 8, one sample at a time");
  }
  {
    const fs = 24_000;
    const mode: DominoexMode = 16;
    const demod = new DominoexDemodulator({ sampleRate: fs, centreHz: 1000, mode });
    demod.retune(1800);
    const t = decodeAll(demod, dominoexWaveform(LINE, { sampleRate: fs, centreHz: 1800, mode }));
    eq(t, LINE, "retuned to 1800 Hz, it reads a signal there");
    demod.reset();
    const t2 = decodeAll(demod, dominoexWaveform("de KC9QRS", { sampleRate: fs, centreHz: 1800, mode }));
    eq(t2, "de KC9QRS", "and after a reset, the next over");
  }

  console.log("\noff frequency and off clock");
  for (const mode of [8, 11, 16] as DominoexMode[]) {
    for (const off of [4, -7, 30]) {
      const fs = 12_000;
      const wave = dominoexWaveform(LINE, { sampleRate: fs, centreHz: 1500 + off, mode, amplitude: 0.5 });
      const demod = new DominoexDemodulator({ sampleRate: fs, centreHz: 1500, mode });
      const t = decodeAll(demod, wave);
      const sp = dominoexParams(mode).toneSpacingHz;
      ok(
        t === LINE && Math.abs(demod.statistics.afcHz - off) <= sp / 2,
        `DominoEX ${mode} ${off > 0 ? "+" : ""}${off} Hz off reads, and the offset is seen (${demod.statistics.afcHz.toFixed(1)} Hz)`,
        JSON.stringify(t),
      );
    }
  }
  for (const mode of [11, 22] as DominoexMode[]) {
    // Generated at 12 006 Hz and read at 12 000: a sound card 500 ppm off, which the
    // symbol timing has to follow - about a symbol's worth of slip every 2000 symbols.
    const wave = dominoexWaveform(LINE + " " + LINE, { sampleRate: 12_006, centreHz: 1500, mode });
    const t = decodeAll(new DominoexDemodulator({ sampleRate: 12_000, centreHz: 1500, mode }), wave);
    eq(t, LINE + " " + LINE, `DominoEX ${mode} from a sound card 500 ppm fast reads back`);
  }

  console.log("\nin noise (S/N in 2.5 kHz)");
  {
    // Levels where each submode copies cleanly; it copies every time 2 to 3 dB lower still.
    const levels: [DominoexMode, number][] = [[4, -12], [5, -11], [8, -9], [11, -8], [16, -6], [22, -5]];
    for (const [mode, snr] of levels) {
      const fs = 12_000;
      const clean = dominoexWaveform(LINE, { sampleRate: fs, centreHz: 1500, mode, amplitude: 0.5 });
      for (const seed of [7, 8]) {
        const demod = new DominoexDemodulator({ sampleRate: fs, centreHz: 1500, mode });
        const t = decodeAll(demod, withNoise(clean, snr, fs, seed));
        ok(t === LINE, `DominoEX ${mode} at ${snr} dB reads back, nothing before or after it (seed ${seed})`, JSON.stringify(t));
      }
    }
    // The edge: most words still read 3 dB further down.
    for (const [mode, snr] of [[8, -12], [11, -11], [16, -9]] as [DominoexMode, number][]) {
      const fs = 24_000;
      const clean = dominoexWaveform(LINE, { sampleRate: fs, centreHz: 1500, mode, amplitude: 0.5 });
      const t = decodeAll(new DominoexDemodulator({ sampleRate: fs, centreHz: 1500, mode }), withNoise(clean, snr, fs));
      let hits = 0;
      const words = LINE.split(" ");
      for (const w of words) if (t.includes(w)) hits++;
      ok(hits >= words.length / 2, `DominoEX ${mode} at ${snr} dB: half the words or more still read (${hits} of ${words.length})`, JSON.stringify(t));
    }
  }

  console.log("\nnoise alone: the squelch holds");
  for (const mode of [8, 11, 16, 22] as DominoexMode[]) {
    const fs = 12_000;
    const g = noiseSource(99 + mode);
    const wave = new Float32Array(fs * 60);
    for (let i = 0; i < wave.length; i++) wave[i] = 0.3 * g();
    const demod = new DominoexDemodulator({ sampleRate: fs, centreHz: 1500, mode });
    const text = decodeAll(demod, wave, 4096);
    ok(text.length <= 3, `DominoEX ${mode}: sixty seconds of band noise prints next to nothing (${text.length} characters)`, JSON.stringify(text));
    ok(demod.statistics.quality < 0.15, `  quality reads as noise (${demod.statistics.quality.toFixed(2)})`);
    eq(demod.statistics.errors, 0, "  and nothing is counted as unread while the squelch is closed");
    if (mode === 11) {
      const junk = decodeAll(new DominoexDemodulator({ sampleRate: fs, centreHz: 1500, mode, squelch: 0 }), wave);
      ok(junk.length > 50, `  with the squelch off the same noise prints junk (${junk.length} characters), which is the squelch's job`);
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
