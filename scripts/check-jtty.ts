/* eslint-disable no-console */
// JTTY: the specification's ten 34-bit vectors, bit for bit; the codec's validity rules; the
// automatic packing's frame counts against the specification's own examples; the code
// (CRC, tail-biting encoder, wrap-around Viterbi) clean and in noise; the waveform's
// length and width; and the receiver on three stations at once, at the three radios'
// rates, in pieces, in noise, and on noise alone.
// Run: npm run check:jtty

import {
  JTTY_FRAME_MS,
  jttyDecodeEnergies,
  jttyEncodePayload,
  jttyJoinAtoms,
  jttyPackAtom,
  jttyPackText,
  jttyPayloads,
  jttyRenderAtom,
  jttyStandardCall,
  jttyUnpackAtom,
  jttyWaveform,
  type JttyAtom,
} from "@/lib/digital/jtty";
import { JttyDemodulator } from "@/lib/digital/jttydemod";

let failed = 0;
function ok(cond: boolean, what: string, extra?: unknown): void {
  if (cond) console.log(`  ok    ${what}`);
  else {
    failed++;
    console.log(`  FAIL  ${what}`, extra ?? "");
  }
}

function noise(seed: number): () => number {
  let s = seed >>> 0;
  const r = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s + 1) / 4294967297;
  };
  return () => Math.sqrt(-2 * Math.log(r())) * Math.cos(2 * Math.PI * r());
}

console.log("the specification's vectors (jtty_source_encoding.txt)");
const VECTORS: [string, JttyAtom, boolean, string][] = [
  ["CQ K1ABC CQ", { kind: "call", action: 0, call: "K1ABC" }, true, "0000100110111101111000110101000001"],
  ["599 123", { kind: "num", role: 1, numKind: 0, value: 123 }, false, "1000000000000001111011000000001000"],
  ["599 123", { kind: "num", role: 1, numKind: 0, value: 123 }, true, "1000000000000001111011000000001001"],
  ["599 CA", { kind: "loc", role: 1, locKind: 0, token: "CA" }, true, "1000000000000110111010000000011001"],
  ["599 05 NWT", { kind: "zoneLoc", zone: 5, token: "NWT" }, true, "0000001011011110010000110100101001"],
  ["1D EMA", { kind: "classSection", count: 1, cls: "D", section: 11 }, true, "0010000010110001011000000000101001"],
  ["599 156 1749", { kind: "numTime", role: 1, serial: 156, minute: 17 * 60 + 49 }, true, "1000000100111001000010110100111001"],
  ["AGN?", { kind: "control", phrase: 0 }, true, "0000000000000000000000000001001001"],
  ["FN42", { kind: "grid", role: 0, grid: "FN42" }, true, "0001001010000110011000000001001001"],
  ["HELLO", { kind: "text", text: "HELLO" }, true, "0100010011100101010101010110001101"],
];
for (const [text, atom, eom, want] of VECTORS) {
  const got = jttyPackAtom(atom, eom)?.join("") ?? "null";
  const back = jttyUnpackAtom(want.split("").map(Number));
  ok(got === want && back !== null && jttyRenderAtom(back.atom) === text && back.eom === eom, `${text}${eom ? " (end of message)" : " (more to come)"}: packs to the vector and reads back`, { got, want });
}

console.log("\nwhat is not valid on the wire");
const bits = (s: string) => s.split("").map(Number);
ok(jttyUnpackAtom(bits("0".repeat(32) + "01")) === null, "the all-zero grammar word is a sentinel");
ok(jttyUnpackAtom(bits(VECTORS[7]![3].slice(0, 32) + "11")) === null, "the reserved bit set: rejected");
ok(jttyUnpackAtom(bits("1".repeat(27) + "111" + "10" + "01")) === null, "family 111, the guard: rejected");
ok(jttyUnpackAtom(bits("0000" + "1111111" + "0".repeat(16) + "100" + "10" + "01")) === null, "control phrase 127: rejected");
ok(jttyPackAtom({ kind: "call", action: 1, call: "K1ABC/P" }, true) === null, "a portable call is not a standard call");
ok(jttyStandardCall("K9XYZ") && jttyStandardCall("K1ABC") && !jttyStandardCall("QRZ") && !jttyStandardCall("CQ"), "K9XYZ and K1ABC are standard calls; QRZ and CQ are not");
ok(jttyPackAtom({ kind: "grid", role: 0, grid: "SA00" }, true) === null, "a grid past RR99 is refused");

console.log("\nautomatic packing, against the specification's examples");
const frames = (t: string) => jttyPackText(t)?.length ?? 0;
for (const [t, n] of [
  ["CQ K1ABC CQ", 1],
  ["599 123", 1],
  ["599 MA", 1],
  ["599 FN42", 1],
  ["1D EMA", 1],
  ["599 001", 2],
  ["599 05", 2],
  ["599 BRUCE", 2],
] as const) ok(frames(t) === n, `"${t}" is ${n} frame${n > 1 ? "s" : ""}`, frames(t));
for (const t of ["CQ K9XYZ CQ", "K9XYZ 599 123", "TU NOW K1ABC 599 007", "hello from en61 - 73!", "QSL TU K9XYZ AGN?", "a~b"]) {
  const atoms = jttyPackText(t)!;
  const back = atoms.map((a, i) => jttyUnpackAtom(jttyPackAtom(a, i === atoms.length - 1)!)!.atom);
  const want = t.toUpperCase().replace(/~/g, "#");
  ok(jttyJoinAtoms(back) === want, `"${t}" reads back as sent (${atoms.length} frames)`, jttyJoinAtoms(back));
}
ok(jttyPackText("x".repeat(200))!.length === 16, "200 characters: cut to 80, sixteen frames");

console.log("\nthe code");
{
  const payload = jttyPayloads("CQ K9XYZ CQ")[0]!;
  const tones = jttyEncodePayload(payload);
  ok(tones.length === 46 && tones.every((t) => t >= 0 && t <= 3), "34 bits become 46 four-level symbols");
  const clean = tones.map((t) => [0, 1, 2, 3].map((k) => (k === t ? 1 : 0)));
  ok(jttyDecodeEnergies(clean)?.join("") === payload.join(""), "clean symbols decode to the payload");
  const g = noise(5);
  let right = 0;
  for (let trial = 0; trial < 20; trial++) {
    const e = tones.map((t) => [0, 1, 2, 3].map((k) => (k === t ? 2.2 : 0) + Math.abs(g()) + Math.abs(g())));
    if (jttyDecodeEnergies(e)?.join("") === payload.join("")) right++;
  }
  ok(right >= 18, `noisy symbols still decode (${right} of 20)`);
  const wrong = jttyDecodeEnergies(tones.map(() => [1, 1, 1, 1].map(() => Math.abs(g()))));
  ok(wrong === null, "pure noise decodes to nothing: CRC, reserved bit and sentinel");
}

console.log("\nthe waveform");
{
  const rate = 24_000;
  const w = jttyWaveform("CQ K9XYZ CQ", { sampleRate: rate, baseHz: 1500 });
  ok(Math.abs(w.length / rate - JTTY_FRAME_MS / 1000) < 1e-6, "one frame is 1.888 s");
  ok(Math.abs(w[0]!) < 1e-3 && Math.abs(w[w.length - 1]!) < 0.05, "ramped at both ends");
  ok(jttyWaveform("K9XYZ 599 123", { sampleRate: rate }).length === 2 * w.length, "two atoms, two frames back to back");
  const power = (f: number) => {
    let re = 0;
    let im = 0;
    for (let i = 0; i < w.length; i++) {
      re += w[i]! * Math.cos((2 * Math.PI * f * i) / rate);
      im += w[i]! * Math.sin((2 * Math.PI * f * i) / rate);
    }
    return re * re + im * im;
  };
  const inBand = power(1500) + power(1531.25) + power(1562.5) + power(1593.75);
  const out = power(1400) + power(1700);
  ok(10 * Math.log10(out / inBand) < -30, `100 Hz outside the four tones is over 30 dB down (${(10 * Math.log10(out / inBand)).toFixed(0)} dB)`);
}

console.log("\nthe receiver");
function band(rate: number, snr: number | null, seed: number): Float32Array {
  const len = rate * 14;
  const a = new Float32Array(len);
  const msgs: [string, number, number][] = [
    ["CQ K9XYZ CQ", 1500, 1.0],
    ["K1ABC 599 123", 900, 1.37],
    ["HELLO WORLD 73", 2100, 1.74],
  ];
  for (const [m, hz, t] of msgs) {
    const w = jttyWaveform(m, { sampleRate: rate, baseHz: hz, amplitude: 0.1 });
    const at = Math.round(rate * t);
    for (let k = 0; k < w.length; k++) a[at + k] = a[at + k]! + w[k]!;
  }
  if (snr !== null) {
    const g = noise(seed);
    const sigma = Math.sqrt(((0.1 * 0.1) / 2 / 10 ** (snr / 10)) * (rate / 2 / 2500));
    for (let i = 0; i < len; i++) a[i] = a[i]! + sigma * g();
  }
  return a;
}
for (const [rate, snr, chunk] of [
  [24_000, null, 512],
  [48_000, -8, 960],
  [12_000, -10, 77],
  [24_000, -12, 256],
] as const) {
  const d = new JttyDemodulator(rate);
  const a = band(rate, snr, 21);
  let out = "";
  for (let i = 0; i < a.length; i += chunk) out += d.feed(a.subarray(i, i + chunk));
  const lines = out.trim().split("\n");
  const has = (hz: number, text: string) => lines.some((l) => l.includes(text) && Math.abs(Number(l.trim().split(" ")[0]) - hz) <= 3);
  ok(
    lines.length === 3 && has(1500, "CQ K9XYZ CQ") && has(900, "K1ABC 599 123") && has(2100, "HELLO WORLD 73"),
    `${rate / 1000} kHz, ${snr === null ? "clean" : `${snr} dB`}, in ${chunk}-sample pieces: three stations, three messages`,
    out,
  );
}
{
  const d = new JttyDemodulator(24_000);
  const a = band(24_000, -10, 4);
  const snrs: number[] = [];
  const dd = new JttyDemodulator(24_000, { onMessage: (m) => snrs.push(m.snr) });
  for (let i = 0; i < a.length; i += 512) dd.feed(a.subarray(i, i + 512));
  void d;
  ok(snrs.length === 3 && snrs.every((s) => Math.abs(s + 10) <= 2), `S/N reported within 2 dB of -10 (${snrs.join(", ")})`);
}
{
  const rate = 24_000;
  const g = noise(77);
  const a = new Float32Array(rate * 30);
  for (let i = 0; i < a.length; i++) a[i] = 0.05 * g();
  const d = new JttyDemodulator(rate);
  let out = "";
  const t0 = Date.now();
  for (let i = 0; i < a.length; i += 512) out += d.feed(a.subarray(i, i + 512));
  const ms = Date.now() - t0;
  ok(out === "" && d.statistics.frames === 0, `30 s of noise: nothing printed (${d.statistics.candidates} sync peaks tried)`);
  ok(ms < 6_000, `and it keeps up: ${ms} ms for 30 s of audio`);
}
{
  // A message cut off: printed after two frames of silence, marked as incomplete.
  const rate = 24_000;
  const w = jttyWaveform("K9XYZ 599 123", { sampleRate: rate, baseHz: 1200, amplitude: 0.1 });
  const a = new Float32Array(rate * 10);
  a.set(w.subarray(0, Math.round(rate * 1.888)), rate);
  const d = new JttyDemodulator(rate);
  let out = "";
  for (let i = 0; i < a.length; i += 512) out += d.feed(a.subarray(i, i + 512));
  ok(/K9XYZ …/.test(out), "a message whose end never came prints what arrived, marked …", out);
}

console.log("");
if (failed > 0) {
  console.log(`${failed} FAILED`);
  process.exit(1);
}
console.log("all JTTY assertions passed");
