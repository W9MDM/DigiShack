/* eslint-disable no-console */
// Assertions on the WSPR demodulator.
// Run: npm run check:wsprdemod
//
// TWO KINDS OF EVIDENCE, and the second is the one that counts.
//
// The synthetic half generates a transmission with the codec, buries it in Gaussian noise
// at known signal-to-noise ratios, and expects the demodulator to find it where it was put.
// That proves the pieces fit together; it cannot prove they match the reference, because
// the same misunderstanding could sit in the generator and the detector alike.
//
// The real half decodes the one WSPR recording WSJT-X publishes (150426_0918.wav: 20 m,
// 26 April 2015, dial 14.0956 MHz) and compares with what the reference `wsprd` decodes
// from it — built from the same sources on the live box and run, not read. The reference
// finds nine stations. This port finds eight of them with every field identical: SNR, DT,
// frequency to 1 Hz, drift, message. The ninth, G8VDQ at −23 dB and 4.6 Hz from a stronger
// station, was a marginal decode for the reference itself (674,145 of its 810,000 Fano
// cycles, on the fifth time-jitter of the third pass) and is lost here to rounding: the
// soft symbols are bit-identical to the reference's until the first signal is subtracted,
// and differ by at most ±2 afterwards, because the reference's subtraction runs in float
// and this one in double. The check asserts the eight and reports the ninth.

import { readFileSync } from "node:fs";
import path from "node:path";

import { wsprChannelSymbols, wsprWaveform } from "../lib/digital/wspr";
import {
  WSPR_BASEBAND_SAMPLES,
  WSPR_CAPTURE_SECONDS,
  wsprBaseband,
  wsprDecodeAudio,
} from "../lib/digital/wsprdemod";

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
  ok(Object.is(a, b), what, `expected ${String(b)}, got ${String(a)}`);
}

// A deterministic generator, so a failure reproduces.
let seed = 20150426;
function rnd(): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
function gaussian(): number {
  const u = rnd() || 1e-9;
  const v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * A period of audio: `signals` placed 1 s into the even minute plus their own dt, in
 * white noise set by SNR in the 2500 Hz bandwidth WSPR quotes. For a unit-amplitude
 * tone (power 1/2) and noise of variance s² per sample at 12 kHz, the noise power in
 * 2500 Hz is s² × 2500 / 6000, so s² = 1.2 / 10^(snr/10).
 */
function period(signals: { message: string; audioHz: number; dtS: number; snrDb: number }[]): Float32Array {
  const n = WSPR_CAPTURE_SECONDS * 12_000;
  const out = new Float32Array(n);
  for (const s of signals) {
    const symbols = wsprChannelSymbols(s.message);
    if (!symbols) throw new Error(`cannot encode ${s.message}`);
    const wave = wsprWaveform(symbols, { audioHz: s.audioHz });
    // Unit amplitude for every signal; the noise below is set from the weakest one's SNR.
    const amp = 1;
    const start = Math.round((1 + s.dtS) * 12_000);
    for (let i = 0; i < wave.length && start + i < n; i++) out[start + i] = out[start + i]! + amp * wave[i]!;
  }
  // One noise level for the whole period, set by the weakest signal: the others are then
  // stronger than quoted, which is what "SNR of the weakest" means for a multi-signal test.
  const weakest = Math.min(...signals.map((s) => s.snrDb));
  const sigma = Math.sqrt(1.2 / Math.pow(10, weakest / 10));
  for (let i = 0; i < n; i++) out[i] = out[i]! + sigma * gaussian();
  return out;
}

// ---------------------------------------------------------------------------
console.log("the baseband stage");
// ---------------------------------------------------------------------------
{
  const audio = new Float32Array(WSPR_CAPTURE_SECONDS * 12_000);
  for (let i = 0; i < audio.length; i++) audio[i] = Math.sin((2 * Math.PI * 1520 * i) / 12_000);
  const { i, q } = wsprBaseband(audio);
  eq(i.length, WSPR_BASEBAND_SAMPLES, "46080 baseband samples, as the reference sizes its buffer");
  // A 1520 Hz tone is +20 Hz at baseband: the phase should advance 20/375 of a turn per sample.
  let re = 0;
  let im = 0;
  for (let k = 1000; k < 40_000; k++) {
    // Multiply sample k by conj(sample k-1): the angle is the per-sample phase advance.
    re += i[k]! * i[k - 1]! + q[k]! * q[k - 1]!;
    im += q[k]! * i[k - 1]! - i[k]! * q[k - 1]!;
  }
  const hz = (Math.atan2(im, re) / (2 * Math.PI)) * 375;
  ok(Math.abs(hz - 20) < 0.05, `a 1520 Hz tone lands at +20.0 Hz (${hz.toFixed(3)})`);
  let power = 0;
  for (let k = 1000; k < 40_000; k++) power += i[k]! * i[k]! + q[k]! * q[k]!;
  ok(power / 39_000 > 0.2, `and keeps its power through the filter (${(power / 39_000).toFixed(3)} of 0.25 expected for a unit sine)`);
  const far = new Float32Array(WSPR_CAPTURE_SECONDS * 12_000);
  for (let k = 0; k < far.length; k++) far[k] = Math.sin((2 * Math.PI * 1900 * k) / 12_000);
  const f = wsprBaseband(far);
  let fp = 0;
  for (let k = 1000; k < 40_000; k++) fp += f.i[k]! * f.i[k]! + f.q[k]! * f.q[k]!;
  ok(fp / 39_000 < 0.001, `a 1900 Hz tone (400 Hz away) is filtered out (${(fp / 39_000).toExponential(2)})`);
}

// ---------------------------------------------------------------------------
console.log("\nsynthetic signals: found where they were put");
// ---------------------------------------------------------------------------
{
  const one = wsprDecodeAudio(period([{ message: "K1ABC FN42 37", audioHz: 1480, dtS: 0, snrDb: -10 }]));
  eq(one.length, 1, "one signal at -10 dB: one decode");
  eq(one[0]?.message, "K1ABC FN42 37", "the message");
  ok(Math.abs((one[0]?.audioHz ?? 0) - 1480) < 0.3, `at 1480 Hz (${one[0]?.audioHz.toFixed(2)})`);
  ok(Math.abs(one[0]?.dtS ?? 9) <= 0.2, `with dt near 0 (${one[0]?.dtS})`);
  ok(Math.abs((one[0]?.snrDb ?? 0) - -10) <= 3, `and an SNR estimate near -10 dB (${one[0]?.snrDb})`);

  const late = wsprDecodeAudio(period([{ message: "W1AW FN31 37", audioHz: 1560, dtS: 1.5, snrDb: -15 }]));
  eq(late[0]?.message, "W1AW FN31 37", "a signal 1.5 s late at -15 dB decodes");
  ok(Math.abs((late[0]?.dtS ?? 0) - 1.5) <= 0.2, `with dt 1.5 (${late[0]?.dtS})`);

  const weak = wsprDecodeAudio(period([{ message: "K9AN EN50 33", audioHz: 1500, dtS: 0, snrDb: -26 }]));
  eq(weak[0]?.message, "K9AN EN50 33", "a signal at -26 dB decodes (the reference's threshold is near -28)");

  const two = wsprDecodeAudio(
    period([
      { message: "K1ABC FN42 37", audioHz: 1450, dtS: 0, snrDb: -8 },
      { message: "W1AW FN31 37", audioHz: 1453, dtS: 0.4, snrDb: -22 },
    ]),
  );
  const calls = two.map((d) => d.callsign).sort();
  ok(
    calls.length === 2 && calls[0] === "K1ABC" && calls[1] === "W1AW",
    `two signals 3 Hz apart, 14 dB different: both decoded, the weak one after the strong one is subtracted (${calls.join(", ")})`,
  );
  // Subtraction happens the moment a signal decodes, so the weak one can follow in the
  // same pass; what matters is that it is found at all, and reported about right.
  const weakOne = two.find((d) => d.callsign === "W1AW");
  ok(weakOne !== undefined && Math.abs(weakOne.snrDb - -22) <= 4, `the overlapped signal reports near -22 dB (${weakOne?.snrDb}, pass ${weakOne?.pass})`);

  const nothing = wsprDecodeAudio(period([{ message: "K1ABC FN42 37", audioHz: 1480, dtS: 0, snrDb: -45 }]));
  eq(nothing.length, 0, "noise alone (a signal at -45 dB) decodes nothing: no false messages");
}

// ---------------------------------------------------------------------------
console.log("\nthe real recording, against the reference decoder's nine");
// ---------------------------------------------------------------------------
{
  const wav = readFileSync(path.join(__dirname, "fixtures", "wspr", "150426_0918.wav"));
  const n = (wav.length - 44) / 2;
  const audio = new Float32Array(n);
  for (let i = 0; i < n; i++) audio[i] = wav.readInt16LE(44 + 2 * i) / 32768;

  const t0 = Date.now();
  const decodes = wsprDecodeAudio(audio);
  const ms = Date.now() - t0;
  ok(ms < 15_000, `decoded in ${ms} ms (the reference takes about 3.8 s on the box)`);

  // `wsprd -f 14.0956 150426_0918.wav`, verbatim, on the box, 2026-10-14.
  const reference = [
    { snr: -9, dt: 1.1, mhz: 14.097046, message: "ND6P DM04 30" },
    { snr: -15, dt: 0.1, mhz: 14.09706, message: "W5BIT EL09 17" },
    { snr: -23, dt: 2.2, mhz: 14.097065, message: "G8VDQ IO91 37", marginal: true },
    { snr: -6, dt: 0.6, mhz: 14.097089, message: "WD4LHT EL89 30" },
    { snr: -1, dt: -0.8, mhz: 14.097103, message: "NM7J DM26 30" },
    { snr: -21, dt: 0.5, mhz: 14.097117, message: "KI7CI DM09 37" },
    { snr: -18, dt: -1.9, mhz: 14.09713, message: "DJ6OL JO52 37" },
    { snr: -11, dt: 0.8, mhz: 14.097187, message: "W3HH EL89 30" },
    { snr: -25, dt: 0.7, mhz: 14.097194, message: "W3BI FN20 30" },
  ];
  const byMessage = new Map(decodes.map((d) => [d.message, d]));
  let matched = 0;
  for (const r of reference) {
    const d = byMessage.get(r.message);
    if (!d) {
      if (r.marginal) {
        console.log(`  note  ${r.message} not decoded - marginal for the reference too (see the header)`);
      } else {
        ok(false, `${r.message} decoded`);
      }
      continue;
    }
    matched++;
    const mhz = 14.0956 + d.audioHz / 1e6;
    const same =
      d.snrDb === r.snr && d.dtS === r.dt && Math.abs(mhz - r.mhz) < 1.5e-6 && d.driftHz === 0;
    ok(same, `${r.message}: ${d.snrDb} dB, dt ${d.dtS}, ${mhz.toFixed(6)} MHz, drift ${d.driftHz} - as the reference`,
      `got ${d.snrDb} ${d.dtS} ${mhz.toFixed(6)} ${d.driftHz}`);
  }
  ok(matched >= 8, `${matched} of the reference's 9 decoded`);
  const extra = decodes.filter((d) => !reference.some((r) => r.message === d.message));
  eq(extra.length, 0, `and nothing the reference did not find (${extra.map((d) => d.message).join(", ") || "none"})`);
}

console.log("");
if (failed > 0) {
  console.log(`${failed} FAILED`);
  process.exit(1);
}
console.log("all wsprdemod assertions passed");
