// Receiver audio: the conversion, and the round trip through it.
//
// The bridge converts float samples to 16-bit PCM and the browser converts them back. A
// mistake in either direction is audible but not obvious — a factor of two reads as quiet
// rather than wrong, and a sign error reads as noise rather than as inverted audio — so the
// two halves are checked against each other here rather than by ear.

import { float32ToS16le } from "@/lib/icom/audio-stream";
import { s16leToFloat } from "@/lib/client/audio-player";

let pass = 0;
let fail = 0;

function ok(cond: boolean, what: string, detail = ""): void {
  if (cond) { pass++; console.log(`  ok    ${what}`); }
  else { fail++; console.log(`  FAIL  ${what}${detail ? ` — ${detail}` : ""}`); }
}

function eq(got: unknown, want: unknown, what: string): void {
  const a = JSON.stringify(got); const b = JSON.stringify(want);
  ok(a === b, what, a === b ? "" : `got ${a}, want ${b}`);
}

/** The bridge sends a Buffer; the browser receives an ArrayBuffer. */
function asArrayBuffer(b: Buffer): ArrayBuffer {
  const out = new ArrayBuffer(b.length);
  new Uint8Array(out).set(b);
  return out;
}

console.log("\nthe wire format");
{
  const pcm = float32ToS16le(new Float32Array([0, 0.5, -0.5]));
  eq(pcm.length, 6, "two bytes per sample");
  // Little-endian, which is what the browser's DataView is told to expect. Getting this
  // backwards produces full-scale noise, not quiet audio.
  eq(pcm.readInt16LE(0), 0, "silence is zero");
  ok(pcm.readInt16LE(2) > 16_000, "and half scale is about half of 32767", `${pcm.readInt16LE(2)}`);
  ok(pcm.readInt16LE(4) < -16_000, "negative stays negative", `${pcm.readInt16LE(4)}`);
}

console.log("\nthere and back");
{
  // A ramp across the whole range, which catches a scale error anywhere in it.
  const original = new Float32Array(64);
  for (let i = 0; i < original.length; i++) original[i] = -1 + (2 * i) / (original.length - 1);

  const back = s16leToFloat(asArrayBuffer(float32ToS16le(original)));
  eq(back.length, original.length, "every sample survives");

  // 16 bits gives about 3e-5 of resolution; anything worse than that is a real error rather
  // than quantisation.
  let worst = 0;
  for (let i = 0; i < original.length; i++) {
    worst = Math.max(worst, Math.abs(back[i]! - original[i]!));
  }
  ok(worst < 1e-4, "and comes back within quantisation error", `worst ${worst.toExponential(1)}`);
}

console.log("\nthe edges, where clipping lives");
{
  const loud = s16leToFloat(asArrayBuffer(float32ToS16le(new Float32Array([1, -1]))));
  ok(Math.abs(loud[0]!) <= 1, "full scale positive stays inside range", `${loud[0]}`);
  ok(loud[1]! >= -1, "and full scale negative", `${loud[1]}`);

  // A source hotter than full scale must clip, not wrap. Wrapping turns the loudest part of
  // a signal into the opposite polarity, which is not distortion — it is destruction.
  const over = float32ToS16le(new Float32Array([2, -2]));
  ok(over.readInt16LE(0) > 0, "an over-range sample clips positive rather than wrapping", `${over.readInt16LE(0)}`);
  ok(over.readInt16LE(2) < 0, "and negative", `${over.readInt16LE(2)}`);
}

console.log("\nodd-length and empty frames");
{
  eq(s16leToFloat(new ArrayBuffer(0)).length, 0, "an empty frame yields no samples");
  // A truncated packet must not read past the end and invent a sample.
  eq(s16leToFloat(new ArrayBuffer(3)).length, 1, "an odd byte count drops the partial sample");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
