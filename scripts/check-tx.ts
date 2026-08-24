/* eslint-disable no-console */
// Offline checks for the native FT8/FT4 transmit chain.
//
// Nothing here touches a radio or a network. The point is that by the time the
// transmitter keys for the first time, every part that CAN be verified without RF
// already has been — waveform, packetisation, timing, and the safety refusals.
//
// The central test is the round trip: take the exact bytes that would go out on the
// wire, reassemble the audio from them, and put it through the decoder. If the
// decoder recovers the message, the encoder, the sample-rate scaling, the stereo
// interleave, the big-endian float conversion and the packet framing are all right.

import { decodeFT4, decodeFT8 } from "@e04/ft8ts";

import {
  FlexDaxTransmitter,
  nextWindowStart,
  transmitDurationMs,
} from "@/lib/flex/tx";

let pass = 0;
let fail = 0;

function ok(cond: boolean, label: string, detail = ""): void {
  if (cond) {
    pass++;
    console.log(`  ok    ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function near(a: number, b: number, tol: number, label: string): void {
  ok(Math.abs(a - b) <= tol, label, `${a.toFixed(2)} vs ${b.toFixed(2)} (±${tol})`);
}

// A transmitter that is never started, so it cannot key anything.
const tx = new FlexDaxTransmitter({ host: "0.0.0.0", allowTransmit: false });

const VITA_HEADER_BYTES = 28;
const DAX_RATE = 24_000;

/**
 * Reassemble mono audio from the packets, as the radio's DAX input would.
 *
 * The TX wire format is reduced-bandwidth DAX: mono int16 big-endian. Unpacking
 * therefore includes the float -> int16 quantisation, which is exactly what the
 * round-trip test should exercise.
 */
function packetsToAudio(packets: Buffer[]): Float32Array {
  const out: number[] = [];
  for (const p of packets) {
    for (let o = VITA_HEADER_BYTES; o + 2 <= p.length; o += 2) {
      out.push(p.readInt16BE(o) / 32767);
    }
  }
  return Float32Array.from(out);
}

/** Reach the private packetiser without loosening its visibility for callers. */
type Packetiser = (w: Float32Array, offset: number, frames: number) => Buffer;
const buildPacket = (
  tx as unknown as { buildPacket: Packetiser }
).buildPacket.bind(tx);

function packetise(wave: Float32Array): Buffer[] {
  const FRAMES = 128;
  const packets: Buffer[] = [];
  for (let off = 0; off < wave.length; off += FRAMES) {
    packets.push(buildPacket(wave, off, Math.min(FRAMES, wave.length - off)));
  }
  return packets;
}

console.log("\nwaveform generation at 24 kHz");
{
  // These durations are the whole reason samplesPerSymbol is scaled explicitly.
  // A regression here means transmitting at the wrong symbol rate.
  const ft8 = tx.buildWaveform("CQ K9XYZ EN61", "FT8", 1500);
  near(ft8.length / DAX_RATE, 12.64, 0.01, "FT8 is 12.64 s long");
  ok(ft8.length === 79 * 3840, "FT8 is 79 symbols x 3840 samples", `${ft8.length}`);

  const ft4 = tx.buildWaveform("CQ K9XYZ EN61", "FT4", 1500);
  near(ft4.length / DAX_RATE, 5.04, 0.01, "FT4 is 5.04 s long");
  ok(ft4.length === 105 * 1152, "FT4 is 105 symbols x 1152 samples", `${ft4.length}`);

  let peak = 0;
  for (const v of ft8) peak = Math.max(peak, Math.abs(v));
  ok(
    peak <= 1.0001 && peak > 0.5,
    "amplitude is within ±1.0 full scale",
    `peak ${peak.toFixed(3)}`,
  );
}

console.log("\noffset validation (a signal outside the filter would be clipped)");
for (const bad of [0, 100, 199, 2801, 5000, NaN, Infinity]) {
  let threw = false;
  try {
    tx.buildWaveform("CQ K9XYZ EN61", "FT8", bad);
  } catch {
    threw = true;
  }
  ok(threw, `rejects ${bad} Hz`);
}
for (const good of [200, 1500, 2800]) {
  let threw = false;
  try {
    tx.buildWaveform("CQ K9XYZ EN61", "FT8", good);
  } catch {
    threw = true;
  }
  ok(!threw, `accepts ${good} Hz`);
}

console.log("\nVITA-49 packet structure (TX format: type 1, mono int16, class 0x0123)");
{
  // The TX format is NOT what the radio sends on receive. Verified against two
  // independent working implementations (nDAX and xLib6000): packet type 1 with
  // TSI=other/TSF=sampleCount (bytes 0x18, 0xd0|count), reduced-bandwidth DAX
  // payload of mono int16 BE at 24 kHz under class 0x0123, zero timestamps.
  const wave = tx.buildWaveform("CQ K9XYZ EN61", "FT8", 1500);
  const packets = packetise(wave);

  ok(
    packets.length === Math.ceil(wave.length / 128),
    "packet count matches the waveform",
    `${packets.length}`,
  );

  const p = packets[0]!;
  ok(p.length === VITA_HEADER_BYTES + 128 * 2, "full packet is 284 bytes", `${p.length}`);

  const word0 = p.readUInt32BE(0);
  ok(((word0 >>> 28) & 0xf) === 1, "packet type 1 (IF data with stream id)");
  ok(((word0 >>> 27) & 1) === 1, "class id present");
  ok(((word0 >>> 22) & 3) === 3, "TSI is 'other'");
  ok(((word0 >>> 20) & 3) === 1, "TSF is sample-count");
  ok(
    (word0 & 0xffff) === p.length / 4,
    "size field is the packet length in 32-bit words",
    `${word0 & 0xffff}`,
  );
  ok(p.readUInt32BE(8) === 0x001c2d, "FlexRadio OUI");
  ok(p.readUInt16BE(14) === 0x0123, "reduced-bandwidth DAX packet class");
  ok(
    p.readUInt32BE(16) === 0 && p.readUInt32BE(20) === 0 && p.readUInt32BE(24) === 0,
    "timestamps are zero",
  );

  // The 4-bit counter lets the radio detect loss; it must advance and wrap.
  const counts = packets.slice(0, 20).map((q) => (q.readUInt32BE(0) >>> 16) & 0xf);
  const sequential = counts.every((c, i) => c === (counts[0]! + i) % 16);
  ok(sequential, "packet count increments and wraps at 16", counts.join(","));

  // A short final packet is normal; it must still declare its true size.
  const short = buildPacket(wave, 0, 8);
  ok(
    short.length === VITA_HEADER_BYTES + 8 * 2,
    "a partial packet is sized correctly",
    `${short.length}`,
  );
  ok(
    (short.readUInt32BE(0) & 0xffff) === short.length / 4,
    "partial packet declares its real word count",
  );
}

console.log("\nround trip: packet bytes back through the decoder");
{
  for (const [mode, offset] of [
    ["FT8", 1500],
    ["FT8", 700],
    ["FT4", 1500],
  ] as ["FT8" | "FT4", number][]) {
    const msg = "CQ K9XYZ EN61";
    const wave = tx.buildWaveform(msg, mode, offset);
    const packets = packetise(wave);
    const rebuilt = packetsToAudio(packets);

    ok(rebuilt.length === wave.length, `${mode} @${offset}: sample count survives packetisation`);

    let maxErr = 0;
    for (let i = 0; i < wave.length; i++) {
      maxErr = Math.max(maxErr, Math.abs(rebuilt[i]! - wave[i]!));
    }
    // int16 on the wire: the error bound is one quantisation step (1/32767), not
    // zero. FT8 needs nothing like 96 dB of dynamic range, so this is harmless —
    // and the decode assertion below is the real proof of that.
    ok(
      maxErr <= 1 / 32767 + 1e-9,
      `${mode} @${offset}: audio survives int16 quantisation`,
      `max err ${maxErr.toExponential(2)}`,
    );

    const decoded =
      mode === "FT4"
        ? decodeFT4(rebuilt, { sampleRate: DAX_RATE, depth: 2 })
        : decodeFT8(rebuilt, { sampleRate: DAX_RATE, depth: 2 });
    const hit = decoded.find((d) => d.msg.trim() === msg);
    ok(
      hit !== undefined,
      `${mode} @${offset}: decoder recovers "${msg}" from the wire bytes`,
      hit
        ? `df=${hit.freq.toFixed(1)} Hz`
        : `got ${decoded.map((d) => d.msg).join("/") || "nothing"}`,
    );
    if (hit) near(hit.freq, offset, 5, `${mode} @${offset}: offset is accurate on the air`);
  }
}

console.log("\nmessage forms needed for a full QSO");
{
  for (const msg of [
    "CQ K9XYZ EN61",
    "CQ DX K9XYZ EN61",
    "DL1ABC K9XYZ EN61",
    "DL1ABC K9XYZ -07",
    "DL1ABC K9XYZ R-07",
    "DL1ABC K9XYZ RR73",
    "DL1ABC K9XYZ 73",
  ]) {
    const wave = tx.buildWaveform(msg, "FT8", 1500);
    const decoded = decodeFT8(packetsToAudio(packetise(wave)), {
      sampleRate: DAX_RATE,
      depth: 2,
    });
    ok(decoded.some((d) => d.msg.trim() === msg), `"${msg}"`);
  }
}

console.log("\nwindow alignment");
{
  // FT8 transmits in the first 12.64 s of each 15 s window; FT4 in each 7.5 s.
  const t = Date.UTC(2026, 6, 31, 1, 33, 47, 250);
  ok(
    nextWindowStart("FT8", t) === Date.UTC(2026, 6, 31, 1, 34, 0),
    "FT8 rounds up to the next 15 s boundary",
  );
  ok(
    nextWindowStart("FT4", t) === Date.UTC(2026, 6, 31, 1, 33, 52, 500),
    "FT4 rounds up to the next 7.5 s boundary",
  );

  for (const mode of ["FT8", "FT4"] as const) {
    const period = mode === "FT4" ? 7_500 : 15_000;
    const w = nextWindowStart(mode, t);
    ok(w % period === 0, `${mode} boundary is a multiple of ${period} ms`);
    ok(w > t && w - t <= period, `${mode} boundary is the next one, not a later one`);
    // The transmission must finish inside its own window.
    ok(
      transmitDurationMs(mode) < period,
      `${mode} transmission (${transmitDurationMs(mode)} ms) fits in its window`,
    );
  }
  near(transmitDurationMs("FT8"), 12_640, 1, "FT8 duration is 12.64 s");
  near(transmitDurationMs("FT4"), 5_040, 1, "FT4 duration is 5.04 s");

  // Exactly on a boundary is usable as-is; rounding it up would skip a window.
  const exact = Date.UTC(2026, 6, 31, 1, 33, 45);
  ok(nextWindowStart("FT8", exact) === exact, "an exact boundary is usable immediately");
}

async function safetyChecks(): Promise<void> {
  console.log("\nsafety refusals (none of these may key a radio)");

  const disabled = new FlexDaxTransmitter({ host: "0.0.0.0", allowTransmit: false });
  const r1 = await disabled.transmit({
    message: "CQ K9XYZ EN61",
    mode: "FT8",
    offsetHz: 1500,
    startAt: Date.now() + 1000,
  });
  ok(!r1.sent, "refuses when allowTransmit is false");
  ok(/disabled/i.test(r1.reason ?? ""), "and says why", r1.reason);

  const enabled = new FlexDaxTransmitter({ host: "0.0.0.0", allowTransmit: true });
  const r2 = await enabled.transmit({
    message: "CQ K9XYZ EN61",
    mode: "FT8",
    offsetHz: 1500,
    startAt: Date.now() + 1000,
  });
  ok(!r2.sent, "refuses when not started (no stream, no socket)");
  ok(/not started/i.test(r2.reason ?? ""), "and says why", r2.reason);

  // A message that cannot be encoded must be caught before keying, not during.
  const badMsg = await enabled.transmit({
    message: "CQ K9XYZ EN61",
    mode: "FT8",
    offsetHz: 9999,
    startAt: Date.now() + 1000,
  });
  ok(!badMsg.sent, "refuses an out-of-range offset");

  ok(!enabled.isKeyed, "never reports keyed after a refusal");
  ok(!enabled.isBusy, "does not stay busy after a refusal");

  // unkey must be safe at any time, including when never connected.
  await enabled.unkey();
  ok(!enabled.isKeyed, "unkey is safe when not connected");
  await enabled.unkey();
  ok(true, "unkey is idempotent");
}

void safetyChecks().then(() => {
  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
});
