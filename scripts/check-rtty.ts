/* eslint-disable no-console */
// RTTY checks: the ITA2 tables against their published values, the character frame
// against the RY test pattern, the waveform's timing and phase continuity, and the
// demodulator end to end - clean, in small chunks, through noise, with a speed error, off
// frequency, at 24 kHz, and on the wrong sideband (which must NOT decode, because that is
// how a page tells the operator to flip it).
// Run: npm run check:rtty
//
// There is no reference binary for a code from the 1930s. The tables are asserted
// against the ITA2 standard and the US TTY variant as MMTTY and fldigi ship them, and the
// frame against what every RTTY operator knows: R and Y are the complementary alternating
// patterns that make RYRY the line test.

import {
  ITA2_CR,
  ITA2_FIGS,
  ITA2_FIGURES_ITA2,
  ITA2_FIGURES_US,
  ITA2_LETTERS,
  ITA2_LF,
  ITA2_LTRS,
  ITA2_SPACE,
  Ita2Decoder,
  RTTY_BAUD,
  RTTY_BITS_PER_CHAR,
  RTTY_CENTRE_HZ,
  RTTY_SHIFT_HZ,
  rttyCharacterFrame,
  rttyCodeName,
  rttyDataBits,
  rttyDecodeCodes,
  rttyDurationMs,
  rttyEncodeText,
  rttyTones,
  rttyWaveform,
  type RttyWaveformOptions,
} from "@/lib/digital/rtty";
import { RttyDemodulator, type RttyDemodOptions } from "@/lib/digital/rttydemod";

let failed = 0;
function ok(cond: boolean, what: string, extra?: unknown): void {
  if (cond) {
    console.log(`  ok    ${what}`);
  } else {
    failed++;
    console.log(`  FAIL  ${what}`, extra ?? "");
  }
}
function eq(a: unknown, b: unknown, what: string): void {
  ok(JSON.stringify(a) === JSON.stringify(b), what, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

/** Deterministic Gaussian noise: an LCG under Box-Muller, so a noise assertion is repeatable. */
function gaussian(seed: number): () => number {
  let s = seed >>> 0;
  const u = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s + 1) / 4294967297;
  };
  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}

// ---------------------------------------------------------------------------
console.log("the ITA2 tables");
// ---------------------------------------------------------------------------
{
  eq(ITA2_LETTERS.length, 32, "letters: 32 codes");
  eq(ITA2_FIGURES_US.length, 32, "US figures: 32 codes");
  eq(ITA2_FIGURES_ITA2.length, 32, "ITA2 figures: 32 codes");
  const letters = ITA2_LETTERS.filter((c) => /^[A-Z]$/.test(c));
  eq(letters.length, 26, "every letter of the alphabet is in the letters case");
  eq(new Set(letters).size, 26, "each exactly once");
  eq(ITA2_LETTERS[3], "A", "A is 00011 (bit 1 the least significant)");
  eq(ITA2_LETTERS[1], "E", "E is 00001, the most frequent letter on the fewest marks");
  eq(ITA2_LETTERS[16], "T", "T is 10000");
  eq(ITA2_LETTERS[10], "R", "R is 01010");
  eq(ITA2_LETTERS[21], "Y", "Y is 10101");
  eq(ITA2_LETTERS[ITA2_SPACE], " ", "space is 00100");
  eq(ITA2_LETTERS[ITA2_CR], "\r", "CR is 01000");
  eq(ITA2_LETTERS[ITA2_LF], "\n", "LF is 00010");
  eq(ITA2_LTRS, 31, "LTRS is 11111");
  eq(ITA2_FIGS, 27, "FIGS is 11011");
  const digits = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => ITA2_FIGURES_US.indexOf(d));
  eq(digits, [22, 23, 19, 1, 10, 16, 21, 7, 6, 24], "the digits sit on P Q W E R T Y U I O - the top row of a keyboard");
  eq(ITA2_FIGURES_ITA2.indexOf("1"), 23, "and the same in ITA2 proper");
  eq(ITA2_FIGURES_US[3], "-", "- on A");
  eq(ITA2_FIGURES_US[29], "/", "/ on X");
  eq(ITA2_FIGURES_US[25], "?", "? on B");
  eq(ITA2_FIGURES_US[28], ".", ". on M");
  eq(ITA2_FIGURES_US[12], ",", ", on N");
  eq(ITA2_FIGURES_US[14], ":", ": on C");
  eq(ITA2_FIGURES_US[9], "$", "US: $ on D");
  eq(ITA2_FIGURES_ITA2[9], "\x05", "ITA2: WRU on D");
  eq(ITA2_FIGURES_US[30], ";", "US: ; on V");
  eq(ITA2_FIGURES_ITA2[30], "=", "ITA2: = on V");
  eq(ITA2_FIGURES_US[17], '"', "US: quote on Z");
  eq(ITA2_FIGURES_ITA2[17], "+", "ITA2: + on Z");
  eq(ITA2_FIGURES_US[5], "\x07", "US: BELL on S");
  eq(ITA2_FIGURES_ITA2[5], "'", "ITA2: apostrophe on S");
  eq(rttyCodeName(31), "LTRS", "code names: LTRS");
  eq(rttyCodeName(27), "FIGS", "FIGS");
  eq(rttyCodeName(10), "R", "a letter");
  eq(rttyCodeName(23, "figures"), "1", "a figure");
}

// ---------------------------------------------------------------------------
console.log("\nthe frame, and RY");
// ---------------------------------------------------------------------------
{
  eq(RTTY_BITS_PER_CHAR, 7.5, "start + 5 data + 1.5 stop = 7.5 bits per character");
  ok(Math.abs(RTTY_BAUD - 45.4545) < 0.001, "45.45 baud is a 22 ms bit", RTTY_BAUD);
  eq(RTTY_SHIFT_HZ, 170, "170 Hz shift");
  eq(rttyEncodeText("RY"), [ITA2_LTRS, 10, 21], "RY encodes as LTRS R Y - the shift first, because the far end's state is unknown");
  eq(rttyDataBits(10), [0, 1, 0, 1, 0], "R's data bits alternate 01010 on the line");
  eq(rttyDataBits(21), [1, 0, 1, 0, 1], "and Y's are the complement, 10101 - together the RYRY line test");
  const frame = rttyCharacterFrame(10);
  eq(frame.length, 7, "a frame is start, five data, stop");
  eq(frame[0], { level: 0, bits: 1 }, "the start bit is one bit of space");
  eq(frame[6], { level: 1, bits: 1.5 }, "the stop is one and a half bits of mark");
  eq(frame.slice(1, 6).map((f) => f.level), [0, 1, 0, 1, 0], "data least-significant bit first");
}

// ---------------------------------------------------------------------------
console.log("\nencoding text: shifts, case, newlines, unshift on space");
// ---------------------------------------------------------------------------
{
  const codes = rttyEncodeText("CQ CQ DE W1AW");
  eq(rttyDecodeCodes(codes), "CQ CQ DE W1AW", "CQ CQ DE W1AW round-trips");
  eq(codes.filter((c) => c === ITA2_FIGS).length, 1, "one FIGS, before the 1");
  eq(codes.filter((c) => c === ITA2_LTRS).length, 2, "two LTRS: at the start and after the 1");
  eq(rttyDecodeCodes(rttyEncodeText("cq de w1aw")), "CQ DE W1AW", "lower case is sent as upper - ITA2 has no case");
  const nl = rttyEncodeText("A\nB");
  ok(nl.includes(ITA2_CR) && nl.includes(ITA2_LF), "a newline is CR LF on the line");
  eq(rttyDecodeCodes(nl), "A\nB", "and comes back as a newline");
  eq(rttyDecodeCodes(rttyEncodeText("A~B")), "AB", "a character ITA2 cannot carry is dropped, not guessed");
  eq(rttyDecodeCodes(rttyEncodeText("599 001")), "599 001", "a contest exchange");
  const usos = rttyEncodeText("TEST 1 2");
  eq(usos.filter((c) => c === ITA2_FIGS).length, 2, "FIGS is re-sent after the space before the 2: the far end may have unshifted");
  eq(rttyDecodeCodes(usos, { usos: true }), "TEST 1 2", "which a receiver that unshifts on space reads correctly");
  eq(rttyDecodeCodes(usos, { usos: false }), "TEST 1 2", "and so does one that does not");
  const noReshift = [ITA2_LTRS, 16, 1, 5, 16, ITA2_SPACE, ITA2_FIGS, 23, ITA2_SPACE, 19];
  eq(rttyDecodeCodes(noReshift, { usos: true }), "TEST 1 W", "a sender that does NOT re-shift loses its 2 to a receiver that unshifts - the W is why both default to the safe side");
  eq(rttyDecodeCodes(noReshift, { usos: false }), "TEST 1 2", "and keeps it on one that does not");
  const d = new Ita2Decoder();
  eq(d.push(ITA2_FIGS), "", "a shift produces no text");
  eq(d.currentShift, "figures", "but changes the state");
  eq(d.push(23), "1", "which the next code uses");
  eq(d.push(ITA2_SPACE), " ", "a space");
  eq(d.currentShift, "letters", "unshifts by default");
  eq(d.push(ITA2_CR), "", "CR is silent");
  eq(d.push(ITA2_LF), "\n", "LF is the newline");
  eq(rttyEncodeText("A", {}, "letters"), [3], "told the far end is already in letters, no shift is sent");
}

// ---------------------------------------------------------------------------
console.log("\ntones and the waveform");
// ---------------------------------------------------------------------------
{
  eq(rttyTones(2210, 170, "USB"), { markHz: 2295, spaceHz: 2125 }, "USB: mark is the higher audio tone (the higher radio frequency)");
  eq(rttyTones(2210, 170, "LSB"), { markHz: 2125, spaceHz: 2295 }, "LSB: the classic 2125 mark / 2295 space");
  eq(RTTY_CENTRE_HZ, 2210, "the classic pair's centre");
  const fs = 12_000;
  const w = rttyWaveform("RYRY", { sampleRate: fs });
  const ms = rttyDurationMs("RYRY");
  eq(ms, 1620, "RYRY: 300 ms preamble + 7 characters (LTRS LTRS R Y R Y LTRS) at 165 ms + a 165 ms tail");
  ok(Math.abs(w.length - (ms / 1000) * fs) <= 2, "the waveform is that long to within two samples", w.length);
  let peak = 0;
  let maxStep = 0;
  for (let n = 0; n < w.length; n++) {
    peak = Math.max(peak, Math.abs(w[n]!));
    if (n > 0) maxStep = Math.max(maxStep, Math.abs(w[n]! - w[n - 1]!));
  }
  ok(peak <= 1 && peak > 0.99, "unit amplitude", peak);
  const limit = 2 * Math.sin((Math.PI * 2295) / fs) * 1.01;
  ok(maxStep <= limit, "phase-continuous: no sample-to-sample step larger than the higher tone's own", `${maxStep} vs ${limit}`);
  const long = rttyDurationMs("CQ CQ CQ DE W1AW W1AW W1AW K");
  ok(long > 6000 && long < 7000, "a CQ line takes about six and a half seconds at 45.45 baud", long);
}

// ---------------------------------------------------------------------------
console.log("\nthe demodulator, end to end");
// ---------------------------------------------------------------------------
{
  const TEXT = "CQ TEST DE W1AW W1AW K";
  function decode(
    text: string,
    gen: Partial<RttyWaveformOptions> & { sampleRate?: number } = {},
    demod: Partial<RttyDemodOptions> = {},
    mutate?: (w: Float32Array) => void,
    chunk = 0,
  ): { text: string; demod: RttyDemodulator } {
    const fs = gen.sampleRate ?? 12_000;
    const w = rttyWaveform(text, { sampleRate: fs, ...gen });
    if (mutate) mutate(w);
    const tones = rttyTones(RTTY_CENTRE_HZ, RTTY_SHIFT_HZ, "USB");
    const d = new RttyDemodulator({ sampleRate: fs, ...tones, ...demod });
    let out = "";
    if (chunk > 0) {
      for (let i = 0; i < w.length; i += chunk) out += d.feed(w.subarray(i, Math.min(w.length, i + chunk)));
    } else {
      out = d.feed(w);
    }
    return { text: out, demod: d };
  }

  const clean = decode(TEXT);
  eq(clean.text, TEXT, "a clean signal decodes exactly");
  eq(clean.demod.statistics.chars, TEXT.length, "and the character count agrees");
  eq(clean.demod.statistics.framingErrors, 0, "with no framing errors");
  ok(clean.demod.statistics.decision > 0.9, "the line rests on mark when the text ends", clean.demod.statistics.decision);

  eq(decode(TEXT, {}, {}, undefined, 97).text, TEXT, "97-sample chunks give the same text as one call - the state carries across feeds");
  eq(decode(TEXT, {}, {}, undefined, 1).text, TEXT, "and so does one sample at a time");

  const noisy = decode(
    TEXT,
    { amplitude: 0.5 },
    {},
    (w) => {
      const g = gaussian(7);
      for (let n = 0; n < w.length; n++) w[n] = w[n]! + 0.25 * g();
    },
  );
  eq(noisy.text, TEXT, "amplitude 0.5 under Gaussian noise of sigma 0.25 per sample (about 0 dB in the whole passband) still decodes");

  eq(decode(TEXT, { baud: RTTY_BAUD * 1.015 }).text, TEXT, "a sender 1.5 % fast decodes - the clock restarts at every start bit");
  eq(decode(TEXT, { baud: RTTY_BAUD * 0.985 }).text, TEXT, "and 1.5 % slow");
  eq(decode(TEXT, { centreHz: RTTY_CENTRE_HZ + 20 }).text, TEXT, "20 Hz off frequency decodes - inside the one-bit filter's main lobe");
  eq(decode(TEXT, { centreHz: RTTY_CENTRE_HZ - 20 }).text, TEXT, "either way");
  eq(decode(TEXT, { sampleRate: 24_000 }).text, TEXT, "at 24 kHz as well as 12 - the demodulator takes the rate it is given");

  const wrongSideband = decode(TEXT, { sideband: "LSB" });
  ok(wrongSideband.text !== TEXT, "a signal on the other sideband does NOT decode - the tones are swapped", wrongSideband.text);
  const lsbTones = rttyTones(RTTY_CENTRE_HZ, RTTY_SHIFT_HZ, "LSB");
  eq(decode(TEXT, { sideband: "LSB" }, lsbTones).text, TEXT, "and decodes once the demodulator is told LSB");

  // Two transmissions with a second of idle mark between: the stream carries on.
  const fs = 12_000;
  const a = rttyWaveform("CQ", { sampleRate: fs });
  const b = rttyWaveform("DX", { sampleRate: fs });
  const idle = new Float32Array(fs);
  let ph = 0;
  for (let n = 0; n < idle.length; n++) {
    idle[n] = Math.sin(ph);
    ph += (2 * Math.PI * 2295) / fs;
  }
  const tones = rttyTones(RTTY_CENTRE_HZ, RTTY_SHIFT_HZ, "USB");
  const d = new RttyDemodulator({ sampleRate: fs, ...tones });
  const streamed = d.feed(a) + d.feed(idle) + d.feed(b);
  eq(streamed, "CQDX", "two transmissions a second apart decode as one stream; idle mark produces nothing");
  d.reset();
  eq(d.feed(rttyWaveform("OK", { sampleRate: fs })), "OK", "reset forgets the clock and the shift, and decoding resumes");

  const silence = new RttyDemodulator({ sampleRate: fs, ...tones });
  eq(silence.feed(new Float32Array(fs * 2)), "", "two seconds of silence produce no text");
  const g = gaussian(11);
  const noiseOnly = new Float32Array(fs * 5);
  for (let n = 0; n < noiseOnly.length; n++) noiseOnly[n] = 0.3 * g();
  const garbage = silence.feed(noiseOnly);
  ok(garbage.length <= 3, "five seconds of noise alone print almost nothing: the squelch drops what the frame check lets through", `${garbage.length} chars, ${silence.statistics.framingErrors} framing errors, ${silence.statistics.weak} weak`);
  ok(silence.statistics.weak > 5, "and counts what it dropped", silence.statistics.weak);
  const open = new RttyDemodulator({ sampleRate: fs, ...tones, squelch: 0 });
  const unsquelched = open.feed(noiseOnly);
  ok(unsquelched.length > garbage.length + 5, "with the squelch off the same noise prints characters - about two a second on the live station", `${unsquelched.length} chars`);
  const strict = new RttyDemodulator({ sampleRate: fs, ...tones, squelch: 0.9 });
  eq(strict.feed(rttyWaveform(TEXT, { sampleRate: fs })), TEXT, "a clean signal passes even a 0.9 squelch: its bits carry conviction");
  eq(strict.statistics.weak, 0, "and loses nothing to it");
}

console.log("");
if (failed > 0) {
  console.log(`${failed} FAILED`);
  process.exit(1);
}
console.log("all RTTY assertions passed");
