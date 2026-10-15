/* eslint-disable no-console */
// CW checks: the Morse table against ITU-R M.1677, the PARIS timing, the keyed waveform,
// and the decoder end to end - at four speeds from one starting guess, off pitch, in
// noise, one sample at a time, through a speed change, on prosigns, and on silence and
// noise alone (which must print nothing).
// Run: npm run check:cw

import {
  CW_UNKNOWN,
  CwDemodulator,
} from "@/lib/digital/cwdemod";
import {
  MORSE,
  charForPattern,
  cwDurationMs,
  cwKeying,
  cwWaveform,
  ditMsFor,
  morseFor,
  wpmFor,
} from "@/lib/digital/cw";

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

function gaussian(seed: number): () => number {
  let s = seed >>> 0;
  const u = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s + 1) / 4294967297;
  };
  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}

// ---------------------------------------------------------------------------
console.log("the table");
// ---------------------------------------------------------------------------
{
  const letters = Object.keys(MORSE).filter((k) => /^[A-Z]$/.test(k));
  eq(letters.length, 26, "26 letters");
  eq(Object.keys(MORSE).filter((k) => /^[0-9]$/.test(k)).length, 10, "10 digits");
  const patterns = Object.entries(MORSE).filter(([k]) => /^[A-Z0-9]$/.test(k)).map(([, p]) => p);
  eq(new Set(patterns).size, patterns.length, "no two letters or digits share a pattern");
  eq(morseFor("A"), ".-", "A is di-dah");
  eq(morseFor("e"), ".", "E is the single dit (case does not matter)");
  eq(morseFor("T"), "-", "T is the single dah");
  eq(morseFor("S"), "...", "S");
  eq(morseFor("O"), "---", "O");
  eq(morseFor("1"), ".----", "1");
  eq(morseFor("0"), "-----", "0");
  eq(morseFor("?"), "..--..", "the question mark");
  eq(morseFor("/"), "-..-.", "the stroke, for portable and mobile calls");
  eq(morseFor("<AR>"), ".-.-.", "AR, end of message");
  eq(morseFor("<SK>"), "...-.-", "SK, end of contact");
  eq(morseFor("<BT>"), "-...-", "BT, the break");
  eq(morseFor("<KN>"), "-.--.", "KN, go ahead named station");
  eq(morseFor("<HH>"), "........", "the error prosign, eight dits");
  eq(morseFor("~"), null, "a character with no code is null");
  eq(charForPattern(".-.-."), "+", "reading back, the plain character wins over the prosign that shares it");
  eq(charForPattern("-...-"), "=", "= over BT");
  eq(charForPattern("...-.-"), "<SK>", "SK has no plain twin and reads as itself");
  eq(charForPattern("........"), "<HH>", "and so does the error");
  eq(charForPattern("..........."), null, "an unknown pattern is null");
}

// ---------------------------------------------------------------------------
console.log("\ntiming");
// ---------------------------------------------------------------------------
{
  eq(ditMsFor(20), 60, "a dit is 60 ms at 20 WPM");
  eq(ditMsFor(30), 40, "40 ms at 30");
  eq(wpmFor(60), 20, "and back");
  eq(cwKeying("E"), [{ on: true, units: 1 }], "E is one unit on");
  eq(cwKeying("T"), [{ on: true, units: 3 }], "T is three");
  eq(
    cwKeying("ET").map((r) => r.units),
    [1, 3, 3],
    "between characters, three units off",
  );
  eq(
    cwKeying("E T").map((r) => r.units),
    [1, 7, 3],
    "between words, seven",
  );
  eq(
    cwKeying("A").map((r) => `${r.on ? "on" : "off"}${r.units}`),
    ["on1", "off1", "on3"],
    "inside a character, one unit off between elements",
  );
  eq(cwKeying("<AR>").length, 9, "a prosign is one character: five elements, four gaps, no gap inside it");
  eq(cwDurationMs("PARIS", 20), 3000, "PARIS with its word gap is fifty units: three seconds at 20 WPM");
  eq(cwKeying("~").length, 0, "a character with no code sends nothing");
  eq(cwKeying("a  b").filter((r) => !r.on && r.units === 7).length, 1, "a run of spaces is one word gap");
}

// ---------------------------------------------------------------------------
console.log("\nthe keyed waveform");
// ---------------------------------------------------------------------------
{
  const fs = 12_000;
  const w = cwWaveform("PARIS", { sampleRate: fs, wpm: 20 });
  eq(w.length, 1200 + 36_000, "100 ms of lead, then fifty units at 60 ms");
  let peak = 0;
  let maxStep = 0;
  for (let n = 1; n < w.length; n++) {
    peak = Math.max(peak, Math.abs(w[n]!));
    maxStep = Math.max(maxStep, Math.abs(w[n]! - w[n - 1]!));
  }
  ok(peak <= 1 && peak > 0.99, "unit amplitude", peak);
  ok(maxStep < 2 * Math.sin((Math.PI * 600) / fs) * 1.05, "no clicks: the edges are shaped, so no step exceeds the tone's own", maxStep);
  let silentLead = true;
  for (let n = 0; n < 1200; n++) if (w[n] !== 0) silentLead = false;
  ok(silentLead, "silence before the first element");
}

// ---------------------------------------------------------------------------
console.log("\nthe decoder, end to end");
// ---------------------------------------------------------------------------
{
  const fs = 12_000;
  const TEXT = "CQ CQ DE W1AW W1AW K";
  function decode(
    text: string,
    wpm: number,
    gen: { pitchHz?: number; amplitude?: number } = {},
    demod: { pitchHz?: number; wpm?: number } = {},
    mutate?: (w: Float32Array) => void,
    chunk = 0,
  ): { text: string; demod: CwDemodulator } {
    const w = cwWaveform(text, { sampleRate: fs, wpm, ...gen });
    if (mutate) mutate(w);
    const d = new CwDemodulator({ sampleRate: fs, pitchHz: 600, ...demod });
    let out = "";
    if (chunk > 0) {
      for (let i = 0; i < w.length; i += chunk) out += d.feed(w.subarray(i, Math.min(w.length, i + chunk)));
    } else {
      out = d.feed(w);
    }
    return { text: out.trim(), demod: d };
  }

  const clean = decode(TEXT, 20);
  eq(clean.text, TEXT, "20 WPM, clean, from a 20 WPM guess");
  ok(Math.abs(clean.demod.statistics.wpm - 20) < 1.5, "and the speed estimate says 20", clean.demod.statistics.wpm);
  eq(clean.demod.statistics.chars, TEXT.replace(/ /g, "").length, "character count agrees");
  eq(clean.demod.statistics.unknown, 0, "nothing unreadable");
  ok(!clean.demod.statistics.keyed, "key up at the end");

  for (const wpm of [12, 30, 40]) {
    const r = decode(TEXT, wpm);
    eq(r.text, TEXT, `${wpm} WPM from the same 20 WPM guess - the first character re-estimates the dit`);
    ok(Math.abs(r.demod.statistics.wpm - wpm) < wpm * 0.08, `and the estimate lands near ${wpm}`, r.demod.statistics.wpm);
  }
  eq(decode(TEXT, 20, {}, {}, undefined, 1).text, TEXT, "one sample at a time gives the same text");
  eq(decode(TEXT, 20, {}, {}, undefined, 256).text, TEXT, "and 256-sample packets");
  eq(decode(TEXT, 25, { pitchHz: 630 }).text, TEXT, "30 Hz above the pitch still decodes");
  eq(decode(TEXT, 25, { pitchHz: 570 }).text, TEXT, "and 30 Hz below");
  eq(decode(TEXT, 25, { amplitude: 0.1 }).text, TEXT, "a weak signal decodes: the trackers are relative");

  const noisy = decode(TEXT, 25, { amplitude: 0.5 }, {}, (w) => {
    const g = gaussian(5);
    for (let n = 0; n < w.length; n++) w[n] = w[n]! + 0.15 * g();
  });
  eq(noisy.text, TEXT, "amplitude 0.5 under Gaussian noise of sigma 0.15 per sample decodes");

  eq(decode("W1AW <AR>", 20).text, "W1AW +", "AR reads as the plus sign it shares a pattern with");
  eq(decode("73 <SK>", 20).text, "73 <SK>", "SK reads as SK");
  eq(decode("CQ TEST", 20).text, "CQ TEST", "digits and letters together");
  eq(decode("599 001", 25).text, "599 001", "a contest exchange");

  // A speed change mid-stream. The first character at the new speed may be misread - a
  // lone dah at 35 WPM is as long as a dit at 20, and nothing but context could tell -
  // but the estimate moves within a character and the rest reads.
  const a = cwWaveform("CQ DE W1AW", { sampleRate: fs, wpm: 20 });
  const b = cwWaveform("TEST TEST", { sampleRate: fs, wpm: 35 });
  const joined = new Float32Array(a.length + b.length);
  joined.set(a, 0);
  joined.set(b, a.length);
  const d = new CwDemodulator({ sampleRate: fs, pitchHz: 600 });
  const changed = d.feed(joined).trim();
  ok(changed.startsWith("CQ DE W1AW"), "before a speed change the text is right", changed);
  ok(changed.endsWith("TEST"), "and after it, the decoder has followed the new speed", changed);
  ok(Math.abs(d.statistics.wpm - 35) < 3, "the estimate moved from 20 to 35", d.statistics.wpm);

  const silent = new CwDemodulator({ sampleRate: fs, pitchHz: 600 });
  eq(silent.feed(new Float32Array(fs * 3)), "", "three seconds of silence print nothing");
  const g = gaussian(9);
  const noise = new Float32Array(fs * 5);
  for (let n = 0; n < noise.length; n++) noise[n] = 0.3 * g();
  const onNoise = new CwDemodulator({ sampleRate: fs, pitchHz: 600 });
  const garbage = onNoise.feed(noise).trim();
  ok(garbage.length <= 2, "five seconds of noise alone print at most a character or two: no signal stands over the floor", JSON.stringify(garbage));

  const retuned = new CwDemodulator({ sampleRate: fs, pitchHz: 600 });
  retuned.retune(700);
  eq(retuned.feed(cwWaveform("RETUNED", { sampleRate: fs, wpm: 20, pitchHz: 700 })).trim(), "RETUNED", "retune moves the tone filter");
  retuned.reset();
  eq(retuned.feed(cwWaveform("AGAIN", { sampleRate: fs, wpm: 20, pitchHz: 700 })).trim(), "AGAIN", "reset clears the character in progress and decoding resumes");

  const unknown = new CwDemodulator({ sampleRate: fs, pitchHz: 600 });
  // Nine dits is nothing in the table.
  const nine = cwWaveform("<HH>", { sampleRate: fs, wpm: 20 });
  eq(unknown.feed(nine).trim(), "<HH>", "eight dits is the error prosign");
  const w9 = new Float32Array(nine.length + 12_000);
  w9.set(nine);
  eq(CW_UNKNOWN, "#", "an unreadable pattern prints as # - not ?, which is a letter");
}

console.log("");
if (failed > 0) {
  console.log(`${failed} FAILED`);
  process.exit(1);
}
console.log("all CW assertions passed");
