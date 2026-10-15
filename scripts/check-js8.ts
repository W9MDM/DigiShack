/* eslint-disable no-console */
// JS8 physical-layer checks against the reference encoder built from JS8Call's own
// sources (lib/js8/genjs8.f90, lib/ft8/encode174.f90, lib/crc12.cpp): the 87 information
// bits and the 79 channel symbols for known frames, bit for bit; then the code's own
// consistency (every codeword passes every sparse check), the decoder on clean and
// damaged codewords, and the waveform's length and continuity.
// Run: npm run check:js8

import {
  JS8_ALPHABET,
  JS8_CODEWORD_BITS,
  JS8_COSTAS,
  JS8_INFO_BITS,
  JS8_SUBMODES,
  JS8_SYMBOLS,
  js8BaudFor,
  js8CheckParity,
  js8CodewordFromTones,
  js8Crc12,
  js8Encode,
  js8EncodeFrame,
  js8GfskPulse,
  js8GraphConsistent,
  js8PackFrame,
  js8TonesFor,
  js8TransmissionMs,
  js8UnpackFrame,
  js8Waveform,
  js8WordsFor,
} from "@/lib/digital/js8";
import { js8BpDecode, js8HardLlr } from "@/lib/digital/js8-bp";

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
const bitsOf = (s: string) => s.split("").map((c) => Number(c));
const tonesOf = (s: string) => s.trim().split(/\s+/).map((t) => Number(t));

/**
 * Reference vectors: `js8ref <message> <i3bit> <icos>` on the station, built from the
 * JS8Call sources with gfortran and Boost. msgbits are the 87 information bits; itone the
 * 79 channel symbols.
 */
const REFERENCE: { msg: string; type: number; costas: 1 | 2; msgbits: string; itone: string }[] = [
  {
    msg: "ABCDEFGHIJKL",
    type: 0,
    costas: 1,
    msgbits: "001010001011001100001101001110001111010000010001010010010011010100010101000010010011000",
    itone: "4 2 5 6 1 3 0 4 1 5 3 2 6 1 0 7 2 6 5 7 0 7 0 4 2 7 0 5 3 5 3 6 6 2 6 0 4 2 5 6 1 3 0 1 2 1 3 1 4 1 5 1 6 1 7 2 0 2 1 2 2 2 3 2 4 2 5 0 2 2 3 0 4 2 5 6 1 3 0",
  },
  {
    msg: "000000000000",
    type: 0,
    costas: 1,
    msgbits: "000000000000000000000000000000000000000000000000000000000000000000000000000000000101010",
    itone: "",
  },
  {
    msg: "zzzzzzzzzzzz",
    type: 7,
    costas: 1,
    msgbits: "111101111101111101111101111101111101111101111101111101111101111101111101111101000011010",
    itone: "4 2 5 6 1 3 0 2 2 7 2 6 2 2 1 1 7 0 6 0 0 7 4 4 1 0 4 2 0 0 4 2 0 6 2 5 4 2 5 6 1 3 0 7 5 7 5 7 5 7 5 7 5 7 5 7 5 7 5 7 5 7 5 7 5 7 5 7 5 0 3 2 4 2 5 6 1 3 0",
  },
  {
    msg: "K9XYZEN61AA0",
    type: 1,
    costas: 1,
    msgbits: "100000001001010110001101010110001110010111000110000001010011010011000000001001000110010",
    itone: "4 2 5 6 1 3 0 1 4 4 3 7 2 4 4 2 4 6 6 2 6 2 4 7 6 0 5 3 1 5 6 1 3 3 0 5 4 2 5 6 1 3 0 4 0 1 1 2 6 1 5 2 6 1 6 2 7 0 6 0 1 2 3 2 3 0 0 1 1 0 6 2 4 2 5 6 1 3 0",
  },
  {
    msg: "Hello1234567",
    type: 5,
    costas: 2,
    msgbits: "010001101000101111101111110010000001000010000011000100000101000110000111101100110101100",
    itone: "0 6 2 3 5 4 1 5 1 4 4 2 4 7 3 2 1 2 1 5 6 5 2 2 2 4 6 4 4 6 4 3 3 0 5 5 1 5 0 2 3 6 4 2 1 5 0 5 7 5 7 6 2 0 1 0 2 0 3 0 4 0 5 0 6 0 7 5 4 6 5 4 2 5 0 6 4 1 3",
  },
  {
    msg: "MNOPQRSTUVWX",
    type: 2,
    costas: 1,
    msgbits: "010110010111011000011001011010011011011100011101011110011111100000100001010001000000000",
    itone: "4 2 5 6 1 3 0 4 0 3 5 7 1 7 6 7 6 7 2 5 0 2 1 5 4 7 7 4 7 2 1 6 1 3 7 0 4 2 5 6 1 3 0 2 6 2 7 3 0 3 1 3 2 3 3 3 4 3 5 3 6 3 7 4 0 4 1 2 1 0 0 0 4 2 5 6 1 3 0",
  },
  {
    msg: "yzab98765432",
    type: 6,
    costas: 2,
    msgbits: "111100111101100100100101001001001000000111000110000101000100000011000010110100100001000",
    itone: "0 6 2 3 5 4 1 5 0 3 7 7 4 2 2 0 6 7 2 2 4 6 2 0 5 2 0 1 1 2 0 6 5 0 0 2 1 5 0 2 3 6 4 7 4 7 5 4 4 4 5 1 1 1 0 0 7 0 6 0 5 0 4 0 3 0 2 6 4 4 1 0 2 5 0 6 4 1 3",
  },
  {
    msg: "ZZZZZZZZZZZZ",
    type: 7,
    costas: 2,
    msgbits: "100011100011100011100011100011100011100011100011100011100011100011100011111100100111100",
    itone: "0 6 2 3 5 4 1 5 1 4 1 1 3 5 1 2 3 1 7 1 6 2 4 4 5 6 4 4 5 4 1 4 2 0 1 3 1 5 0 2 3 6 4 4 3 4 3 4 3 4 3 4 3 4 3 4 3 4 3 4 3 4 3 4 3 4 3 7 4 4 7 4 2 5 0 6 4 1 3",
  },
  {
    msg: "0123456789AB",
    type: 0,
    costas: 2,
    msgbits: "000000000001000010000011000100000101000110000111001000001001001010001011000000000001100",
    itone: "0 6 2 3 5 4 1 7 0 3 5 3 6 3 4 1 3 0 2 2 1 5 6 0 1 3 1 3 2 2 0 3 2 6 0 7 1 5 0 2 3 6 4 0 0 0 1 0 2 0 3 0 4 0 5 0 6 0 7 1 0 1 1 1 2 1 3 0 0 0 1 4 2 5 0 6 4 1 3",
  },
];

// ---------------------------------------------------------------------------
console.log("the alphabet and the frame");
// ---------------------------------------------------------------------------
{
  eq(JS8_ALPHABET.length, 68, "68 characters, six bits each with room to spare");
  eq(JS8_ALPHABET.indexOf("A"), 10, "A follows the digits");
  eq(JS8_ALPHABET.indexOf("a"), 36, "lower case after upper");
  eq(JS8_ALPHABET.indexOf("."), 66, "the full stop is 66");
  eq(JS8_ALPHABET.indexOf(" "), 67, "and the 68th character is a space - the Fortran declares 68 and writes 67, and index() finds the blank");
  eq(js8WordsFor("ABCDEFGHIJKL"), [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21], "a message as twelve six-bit values");
  eq(js8WordsFor("A B"), [10, 67, 11, 0, 0, 0, 0, 0, 0, 0, 0, 0], "a space is value 67");
  eq(js8WordsFor("A!B"), [10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], "the reference stops at the first character outside the alphabet and leaves zeros");
  eq(JS8_INFO_BITS, 87, "72 + 3 + 12 information bits");
  eq(JS8_CODEWORD_BITS, 174, "to 174");
  eq(JS8_SYMBOLS, 79, "79 symbols");
  eq(js8BaudFor("A"), 6.25, "normal mode is 6.25 baud (12000 / 1920)");
  eq(js8BaudFor("B"), 10, "fast is 10");
  eq(js8BaudFor("C"), 20, "turbo 20");
  eq(js8BaudFor("E"), 3.125, "slow 3.125");
  eq(js8BaudFor("I"), 31.25, "ultra 31.25");
  eq(js8TransmissionMs("A"), 12_640, "a normal frame is 12.64 s on the air");
  eq(JS8_SUBMODES.A.periodS, 15, "in a 15 s period");
  eq(JS8_COSTAS[1][0], [4, 2, 5, 6, 1, 3, 0], "the normal-mode Costas array, as genjs8 has it");
  eq(JS8_COSTAS[2][1], [1, 5, 0, 2, 3, 6, 4], "the second set's middle array");
}

// ---------------------------------------------------------------------------
console.log("\nthe CRC, as Boost computes it");
// ---------------------------------------------------------------------------
{
  eq(js8Crc12(new Array(12).fill(0), 0), 42, "all zeros: the CRC of nothing is 0, and the XOR with 42 shows");
  const ref = REFERENCE[0]!;
  const refBits = bitsOf(ref.msgbits);
  const refCrc = parseInt(ref.msgbits.slice(75), 2);
  eq(js8Crc12(js8WordsFor(ref.msg), ref.type), refCrc, `the CRC of ${ref.msg} matches the reference's last twelve bits`);
  const unpacked = js8UnpackFrame(refBits);
  ok(unpacked.crcOk, "and the reference frame checks");
  eq(unpacked.text, ref.msg, "reading the text back");
  eq(unpacked.frameType, ref.type, "and the frame type");
  const damaged = refBits.slice();
  damaged[10] = damaged[10] ? 0 : 1;
  ok(!js8UnpackFrame(damaged).crcOk, "one payload bit flipped and the CRC fails");
  ok(js8Crc12(js8WordsFor("ABCDEFGHIJKL"), 1) !== js8Crc12(js8WordsFor("ABCDEFGHIJKL"), 0), "the frame type is under the CRC");
}

// ---------------------------------------------------------------------------
console.log("\ninformation bits and channel symbols against the reference");
// ---------------------------------------------------------------------------
for (const ref of REFERENCE) {
  const info = js8PackFrame(ref.msg, ref.type);
  eq(Array.from(info).join(""), ref.msgbits, `${ref.msg} type ${ref.type}: the 87 information bits`);
  if (ref.itone) {
    const { tones } = js8EncodeFrame(ref.msg, ref.type, ref.costas === 1 ? "A" : "B");
    eq(tones, tonesOf(ref.itone), `and the 79 channel symbols (Costas set ${ref.costas})`);
  }
}

// ---------------------------------------------------------------------------
console.log("\nthe code");
// ---------------------------------------------------------------------------
{
  ok(js8GraphConsistent(), "the sparse graph's two tables agree: every bit is in exactly the checks that list it");
  for (const text of ["ABCDEFGHIJKL", "000000000000", "zzzzzzzzzzzz", "CQCQCQ+-/?.0", "Hello1234567"]) {
    for (const type of [0, 3, 7]) {
      const info = js8PackFrame(text, type);
      const cw = js8Encode(info);
      eq(js8CheckParity(cw), [], `${text}/${type}: the dense generator's codeword satisfies all 87 sparse checks`);
    }
  }
  const info = js8PackFrame("K9XYZEN61AA0", 1);
  const cw = js8Encode(info);
  const tones = js8TonesFor(cw, 1);
  eq(Array.from(js8CodewordFromTones(tones)), Array.from(cw), "tones to codeword bits is the inverse of codeword bits to tones");
  eq(tones.slice(0, 7), [4, 2, 5, 6, 1, 3, 0], "sync at the start");
  eq(tones.slice(36, 43), [4, 2, 5, 6, 1, 3, 0], "in the middle");
  eq(tones.slice(72, 79), [4, 2, 5, 6, 1, 3, 0], "and at the end");
  const flipped = cw.slice();
  flipped[5] = flipped[5] ? 0 : 1;
  ok(js8CheckParity(flipped).length > 0, "one bit flipped and checks fail");
}

// ---------------------------------------------------------------------------
console.log("\nbelief propagation");
// ---------------------------------------------------------------------------
{
  const info = js8PackFrame("K9XYZEN61AA0", 1);
  const cw = js8Encode(info);
  const clean = js8BpDecode(js8HardLlr(cw));
  ok(clean.ok, "a clean codeword decodes in one pass", clean.reason);
  eq(clean.iterations, 0, "with no iterations");
  eq(Array.from(clean.info ?? []), Array.from(info), "to the information bits");
  eq(js8UnpackFrame(clean.info!).text, "K9XYZEN61AA0", "and the text");

  // Damage: flip eight bits at moderate confidence and the decoder must recover them.
  // Measured on this code: up to ten random hard errors decode every time, twelve about
  // half the time, fourteen never - so eight is inside the margin, not at it.
  const llr = js8HardLlr(cw, 1.5);
  const flips = [3, 17, 40, 55, 71, 99, 130, 160];
  for (const i of flips) llr[i] = -llr[i]!;
  const fixed = js8BpDecode(llr);
  ok(fixed.ok, `${flips.length} wrong hard decisions are corrected`, fixed.reason);
  eq(Array.from(fixed.info ?? []), Array.from(info), "to the same information bits");
  ok(fixed.hardErrors === flips.length, "and it reports how many it overruled", fixed.hardErrors);

  // Soft: a noisy LLR vector where the right bits are only mildly favoured.
  let seed = 12345;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const soft = new Float64Array(174);
  for (let i = 0; i < 174; i++) soft[i] = (cw[i] ? 1 : -1) * 1.2 + (rnd() - 0.5) * 2.4;
  const softResult = js8BpDecode(soft);
  ok(softResult.ok, "a noisy soft-decision vector decodes", softResult.reason);

  // Noise alone must not produce a frame.
  const noise = new Float64Array(174);
  for (let i = 0; i < 174; i++) noise[i] = (rnd() - 0.5) * 4;
  const none = js8BpDecode(noise);
  ok(!none.ok, "random LLRs do not decode to a frame", none.reason);
}

// ---------------------------------------------------------------------------
console.log("\nthe waveform");
// ---------------------------------------------------------------------------
{
  ok(Math.abs(js8GfskPulse(2, 0) - 1) < 1e-3, "the GFSK pulse is 1 at the symbol centre (BT 2)");
  ok(js8GfskPulse(2, 1.5) < 1e-6, "and gone a symbol and a half away");
  ok(Math.abs(js8GfskPulse(2, 0.5) - 0.5) < 1e-3, "and half at the symbol edge");
  const { tones } = js8EncodeFrame("CQCQCQ+-/?.0", 3, "A");
  const fs = 12_000;
  const w = js8Waveform(tones, { sampleRate: fs, baseHz: 1000 });
  eq(w.length, 79 * 1920, "79 symbols of 1920 samples at 12 kHz");
  let peak = 0;
  let maxStep = 0;
  for (let n = 1; n < w.length; n++) {
    peak = Math.max(peak, Math.abs(w[n]!));
    maxStep = Math.max(maxStep, Math.abs(w[n]! - w[n - 1]!));
  }
  ok(peak <= 1 && peak > 0.99, "unit amplitude", peak);
  const top = 1000 + 7 * 6.25;
  ok(maxStep < 2 * Math.sin((Math.PI * top) / fs) * 1.02, "phase-continuous: no step beyond the highest tone's own", maxStep);
  const w24 = js8Waveform(tones, { sampleRate: 24_000, baseHz: 1500 });
  eq(w24.length, 79 * 3840, "and at the FlexRadio's 24 kHz, 3840 samples a symbol");
  const fast = js8Waveform(js8EncodeFrame("CQCQCQ+-/?.0", 3, "B").tones, { sampleRate: fs, baseHz: 1000, submode: "B" });
  eq(fast.length, 79 * 1200, "fast mode: 1200 samples a symbol");
}

console.log("");
if (failed > 0) {
  console.log(`${failed} FAILED`);
  process.exit(1);
}
console.log("all JS8 assertions passed");
