// Prove the audio stream's true sample rate, using a station that keeps time for a living.
//
// Run it with the radio tuned to WWV — 2.5, 5, 10, 15 or 20 MHz, AM. WWV transmits a tick
// every second, on the second, permanently. So the interval between ticks measured IN SAMPLES
// is the stream's real sample rate, with nothing assumed.
//
// The question it exists to settle: the Icom connection packet asks for 48 kHz 16-bit MONO and
// 48,000 int16 per second arrive — but that is also exactly what 24 kHz STEREO looks like on
// the wire, and playing that as mono runs at double speed. Nothing in the code can tell the
// difference; a clock on the air can.
//
//   npm run check:audio-rate
//
// Needs the bridge running with a radio connected and audio flowing. It is a measurement, not
// a unit test, so it is not in the `check` chain.

import WebSocket from "ws";

// WWV transmits a tick every second, on the second, permanently. So the interval between
// ticks measured IN SAMPLES is the stream's true sample rate — no assumption required.
//
// This settles a question the code cannot answer on its own: the connection packet asks for
// 48 kHz 16-bit MONO, and 48,000 int16 per second arrive. That is also exactly what 24 kHz
// STEREO looks like on the wire, and playing that as mono runs at double speed.
const CLAIMED = 48_000;
const ws = new WebSocket("ws://127.0.0.1:3101/ws/audio");
const samples: number[] = [];

ws.on("message", (d: Buffer, isBinary: boolean) => {
  if (!isBinary) { console.log("hello:", d.toString()); return; }
  for (let i = 0; i + 1 < d.length; i += 2) samples.push(d.readInt16LE(i) / 32768);
});

setTimeout(() => {
  ws.close();
  const n = samples.length;
  console.log(`captured ${n.toLocaleString()} samples`);

  // Energy in 5 ms windows at the claimed rate. A tick is a short loud pulse against the
  // station's steady tone, so it stands out as a local maximum.
  const win = Math.round(CLAIMED * 0.005);
  const env: number[] = [];
  for (let i = 0; i + win <= n; i += win) {
    let s = 0;
    for (let j = i; j < i + win; j++) s += samples[j]! * samples[j]!;
    env.push(Math.sqrt(s / win));
  }
  const sorted = [...env].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const peak = sorted.at(-1) ?? 0;
  const threshold = median + (peak - median) * 0.45;

  // Onsets: a window over threshold whose predecessor was not.
  const onsets: number[] = [];
  for (let i = 1; i < env.length; i++) {
    if (env[i]! > threshold && env[i - 1]! <= threshold) onsets.push(i * win);
  }
  console.log(`${onsets.length} tick(s) detected`);
  if (onsets.length < 3) {
    console.log("Not enough ticks — is the radio actually hearing WWV? Try again or check the band.");
    process.exit(0);
  }

  const gaps: number[] = [];
  for (let i = 1; i < onsets.length; i++) gaps.push(onsets[i]! - onsets[i - 1]!);
  gaps.sort((a, b) => a - b);
  const mid = gaps[Math.floor(gaps.length / 2)]!;
  console.log(`median gap: ${mid.toLocaleString()} samples`);
  console.log(`gaps: ${gaps.map((g) => g.toLocaleString()).join(", ")}`);
  console.log(
    `\nAt the claimed ${CLAIMED.toLocaleString()} Hz that is ${(mid / CLAIMED).toFixed(3)} s between ticks.`,
  );
  const err = Math.abs(mid / CLAIMED - 1);
  console.log(
    err < 0.06
      ? "VERDICT: one second apart. The stream really is 48 kHz mono — framing is correct."
      : Math.abs(mid / CLAIMED - 0.5) < 0.06
        ? "VERDICT: HALF a second. The stream is 24 kHz, or stereo read as mono — playback runs 2x fast."
        : `VERDICT: neither 1.0 s nor 0.5 s (${(mid / CLAIMED).toFixed(3)} s). Look at the gaps above.`,
  );
  process.exit(0);
}, 12_000);
