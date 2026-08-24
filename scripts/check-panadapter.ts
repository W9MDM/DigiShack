/* eslint-disable no-console */
// Panadapter framing and the FlexRadio status parser.
//
// Framing is exactly the kind of thing this project tests heavily, because a parser
// that is wrong by four bytes produces a spectrum that looks like spectrum. Every
// case here is a mistake that was actually available to make while writing
// lib/flex/panadapter.ts, and several were made.

import {
  PAN_MAX_BINS,
  PAN_PACKET_CLASS,
  panNeedsRecentre,
  PanFrameAssembler,
  parsePanPacket,
  WATERFALL_PACKET_CLASS,
} from "@/lib/flex/panadapter";
import { parseStatusBody } from "@/lib/flex/client";
import { PanadapterScaler, remapAxis } from "@/lib/radio/panadapter";
import { filterEdgesFor, filterMatches } from "@/lib/radio/receiver-controls";
import { labelledSpots, snapHz, tuneStepFor } from "@/components/digital/Panadapter";
import { formatFreqDial, formatFreqMHz } from "@/lib/ham/bands";
import {
  isEcho,
  parseFrames,
  readScopeDataOutput,
  readScopeSpan,
  ScopeSub,
  setScopeDataOutput,
  setScopeMode,
  setScopeSpan,
} from "@/lib/icom/civ";

let failures = 0;

/**
 * A deterministic uniform generator, so a scaling assertion cannot pass on Tuesday.
 * Numerical Recipes' LCG constants; the quality demanded here is "not correlated with
 * bin index", which this clears easily.
 */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Noise as an FFT bin actually produces it.
 *
 * THIS IS THE PART THE OLD TEST GOT WRONG, and getting it wrong is what let a display
 * ship as a full-colour confetti of noise while these assertions passed. The band here
 * used to be `-100 + ((i * 7919) % 100) / 25` — uniform scatter 4 dB wide. A real
 * unaveraged bin containing only noise has exponentially distributed POWER, whose dB
 * spread from p25 to p99.5 is 12.65 dB: three times wider, with a long upper tail that
 * uniform scatter has no version of. Every conclusion about how much of the palette the
 * noise occupies depends on that number, so a synthetic band that understates it cannot
 * detect the fault it is supposed to be guarding.
 *
 * @param averaged how many frames the radio averaged before sending. 1 is what the
 *   bridge asked for until it was found to be a mistake; higher values narrow the
 *   distribution, which is exactly the property the scaler is supposed to exploit.
 */
function noiseBand(
  n: number,
  floorDb: number,
  rand: () => number,
  averaged = 1,
): Float32Array {
  const bins = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    // Mean of `averaged` independent exponentials: the chi-square-2k/2k shape a real
    // averaging panadapter produces.
    let power = 0;
    for (let k = 0; k < averaged; k++) power += -Math.log(1 - rand());
    bins[i] = floorDb + 10 * Math.log10(power / averaged);
  }
  return bins;
}

/** Percentile of a byte row, for asserting where the palette actually got used. */
function pct(bins: Uint8Array, p: number): number {
  const s = Uint8Array.from(bins).sort();
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]!;
}

function ok(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    console.log(`ok   ${name}`);
  } else {
    failures++;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function eq<T>(name: string, actual: T, expected: T): void {
  ok(
    name,
    Object.is(actual, expected),
    `expected ${String(expected)}, got ${String(actual)}`,
  );
}

/**
 * Build a VITA-49 panadapter datagram the way the radio does.
 *
 * Including the four trailing zero bytes, which are the point of several tests
 * below: a payload is 12 header bytes, num_bins uint16, then a tail that is NOT a bin.
 */
function panPacket(opts: {
  streamId?: number;
  startBin?: number;
  totalBins?: number;
  frameIndex?: number;
  bins: number[];
  binSize?: number;
  packetClass?: number;
  trailer?: number;
}): Buffer {
  const {
    streamId = 0x40000001,
    startBin = 0,
    totalBins = opts.bins.length,
    frameIndex = 1,
    bins,
    binSize = 2,
    packetClass = PAN_PACKET_CLASS,
    trailer = 4,
  } = opts;

  const header = Buffer.alloc(28);
  header.writeUInt32BE(0x38520000, 0);
  header.writeUInt32BE(streamId, 4);
  header.writeUInt32BE(0x00001c2d, 8);
  header.writeUInt16BE(0x534c, 12);
  header.writeUInt16BE(packetClass, 14);

  const payload = Buffer.alloc(12 + bins.length * 2 + trailer);
  payload.writeUInt16BE(startBin, 0);
  payload.writeUInt16BE(bins.length, 2);
  payload.writeUInt16BE(binSize, 4);
  payload.writeUInt16BE(totalBins, 6);
  payload.writeUInt32BE(frameIndex, 8);
  bins.forEach((v, i) => payload.writeUInt16BE(v, 12 + i * 2));

  return Buffer.concat([header, payload]);
}

// --------------------------------------------------------------- packet parsing

{
  const pkt = parsePanPacket(panPacket({ bins: [11, 12, 13, 14] }));
  ok("a well-formed packet parses", pkt !== null);
  eq("  stream id is the panadapter object id", pkt?.streamId, 0x40000001);
  eq("  num_bins", pkt?.numBins, 4);
  eq("  total_bins", pkt?.totalBins, 4);
  eq("  frame_index", pkt?.frameIndex, 1);
  eq("  bins are big-endian uint16", pkt?.bins.join(","), "11,12,13,14");
}

{
  // THE FOUR-BYTE TAIL. Every payload carries four trailing zero bytes past the last
  // bin. Counting them as two more bins puts a pair of zeroes — the bottom of the dBm
  // window — at the end of every packet. On a waterfall that is a black stripe down
  // the display at each packet boundary, and it looks like a hardware fault rather
  // than an off-by-four.
  const pkt = parsePanPacket(panPacket({ bins: [500, 501, 502], trailer: 4 }));
  eq("the four-byte tail is not read as bins", pkt?.bins.length, 3);
  eq("  and the last bin is the last real one", pkt?.bins[2], 502);
}

{
  const pkt = parsePanPacket(panPacket({ bins: [500, 501, 502], trailer: 0 }));
  ok(
    "a payload with no tail still parses",
    pkt !== null && pkt.bins.length === 3,
  );
}

ok(
  "a waterfall packet is not read as a panadapter packet",
  parsePanPacket(
    panPacket({ bins: [1, 2], packetClass: WATERFALL_PACKET_CLASS }),
  ) === null,
);

ok(
  "an audio packet is not read as a panadapter packet",
  parsePanPacket(panPacket({ bins: [1, 2], packetClass: 0x03e3 })) === null,
);

ok(
  "a bin_size the parser does not know is refused, not guessed",
  parsePanPacket(panPacket({ bins: [1, 2], binSize: 4 })) === null,
);

ok(
  "a truncated datagram is refused",
  parsePanPacket(panPacket({ bins: [1, 2, 3, 4] }).subarray(0, 30)) === null,
);

ok(
  "a packet claiming more bins than the frame holds is refused",
  parsePanPacket(panPacket({ bins: [1, 2, 3], startBin: 8, totalBins: 4 })) ===
    null,
);

ok(
  "a header-only datagram is refused",
  parsePanPacket(Buffer.alloc(28)) === null,
);

// ------------------------------------------------------------------- reassembly

{
  // The real shape: 4096 bins arrive as seven packets, six of 670 and a remainder.
  const a = new PanFrameAssembler();
  const total = 4096;
  let sent = 0;
  let done: Uint16Array | null = null;
  while (sent < total) {
    const n = Math.min(670, total - sent);
    const bins = Array.from({ length: n }, (_, i) => (sent + i) % 4096);
    const out = a.push(
      parsePanPacket(panPacket({ startBin: sent, totalBins: total, bins }))!,
    );
    if (out) done = out;
    sent += n;
  }
  ok("a frame split across seven packets reassembles", done !== null);
  eq("  and has every bin", done?.length, total);
  eq("  in the right order", done?.[0], 0);
  eq("  including the last", done?.[total - 1], (total - 1) % 4096);
  eq("  counted as complete", a.completed, 1);
  eq("  with none dropped", a.incomplete, 0);
}

{
  // A frame is NOT released early. Releasing a partial frame draws a row that is half
  // spectrum and half zero, which on a scrolling display reads as interference.
  const a = new PanFrameAssembler();
  const first = a.push(
    parsePanPacket(
      panPacket({ startBin: 0, totalBins: 100, bins: Array(60).fill(7) }),
    )!,
  );
  ok("an incomplete frame is not released", first === null);
  const second = a.push(
    parsePanPacket(
      panPacket({ startBin: 60, totalBins: 100, bins: Array(40).fill(9) }),
    )!,
  );
  ok("  and is released once the last packet lands", second !== null);
  eq("  with both halves present", `${second?.[0]},${second?.[99]}`, "7,9");
}

{
  // Packet loss: a new frame_index proves the previous frame will never complete.
  const a = new PanFrameAssembler();
  a.push(
    parsePanPacket(
      panPacket({
        frameIndex: 1,
        startBin: 0,
        totalBins: 100,
        bins: Array(60).fill(7),
      }),
    )!,
  );
  const out = a.push(
    parsePanPacket(
      panPacket({
        frameIndex: 2,
        startBin: 0,
        totalBins: 100,
        bins: Array(100).fill(3),
      }),
    )!,
  );
  eq("a frame abandoned mid-way is counted", a.incomplete, 1);
  ok("  and the next frame still completes", out !== null && out[0] === 3);
}

{
  // A duplicated packet must not count twice, or the frame "completes" with a hole in
  // it — and a hole reads as a dead notch across the band.
  const a = new PanFrameAssembler();
  const p = parsePanPacket(
    panPacket({ startBin: 0, totalBins: 100, bins: Array(50).fill(7) }),
  )!;
  a.push(p);
  const again = a.push(p);
  ok("a duplicated packet does not complete a frame early", again === null);
  const rest = a.push(
    parsePanPacket(
      panPacket({ startBin: 50, totalBins: 100, bins: Array(50).fill(9) }),
    )!,
  );
  ok(
    "  and the frame completes when the real remainder arrives",
    rest !== null,
  );
}

// -------------------------------------------------------------- measured limits

eq("the measured bin ceiling is recorded", PAN_MAX_BINS, 4096);

// -------------------------------------------------- FlexRadio status line parsing

{
  // The line that started this: `display pan 0x40000000 …` used to arrive as object
  // `display` with the sub-type and the id dropped, because neither contains an `=`.
  // Two panadapters were then indistinguishable.
  const s = parseStatusBody(
    "display pan 0x40000000 center=14.100000 bandwidth=0.200000 x_pixels=50",
  );
  eq("a panadapter status keeps its sub-type", s.object, "display pan");
  eq("  and its id", s.id, "0x40000000");
  eq("  and its fields", s.fields.center, "14.100000");
}

{
  const s = parseStatusBody(
    "display waterfall 0x42000000 panadapter=0x40000000 line_duration=100",
  );
  eq(
    "a waterfall is not confused with a panadapter",
    s.object,
    "display waterfall",
  );
  eq("  and keeps its own id", s.id, "0x42000000");
}

{
  const s = parseStatusBody(
    "slice 0 RF_frequency=14.074000 mode=DIGU in_use=1",
  );
  eq("a slice status still parses as it always did", s.object, "slice");
  eq("  with a numeric index", s.index, 0);
  eq("  and its fields", s.fields.mode, "DIGU");
}

{
  const s = parseStatusBody("interlock state=TRANSMITTING reason=");
  eq("an object with no id parses", s.object, "interlock");
  eq("  with a null id", s.id, null);
  eq("  and keeps its fields", s.fields.state, "TRANSMITTING");
}

{
  // `client 0x… connected client_id=…` — the id is in the MIDDLE, followed by a bare
  // word. Taking the last leading token as the id would make this object
  // `client 0x74C8037A` and break the GUI-client count the DAX source depends on.
  const s = parseStatusBody(
    "client 0x74C8037A connected client_id=ABC program=SmartSDR",
  );
  eq("a client status keeps the object name", s.object, "client");
  eq("  the id", s.id, "0x74C8037A");
  eq("  the bare word as a flag", s.flags.join(","), "connected");
  eq("  and the fields", s.fields.program, "SmartSDR");
}

{
  const s = parseStatusBody("radio slices=1 lineout_gain=50");
  eq("a bare object parses", s.object, "radio");
  eq("  with no id", s.id, null);
  eq("  and its fields", s.fields.slices, "1");
}

// ------------------------------------------------------- Icom scope CI-V framing
//
// Framing only. Whether the RADIO honours these — and what the scope costs the poll
// it shares a stream with — is `scripts/probe-icom-scope.ts`, which needs hardware
// and has not yet been able to run. See docs/panadapter.md.

{
  eq(
    "scope data output on is 0x27 0x11 0x01",
    setScopeDataOutput(0x94, true).toString("hex"),
    "fefe94e0271101fd",
  );
  eq(
    "scope data output off is 0x27 0x11 0x00",
    setScopeDataOutput(0x94, false).toString("hex"),
    "fefe94e0271100fd",
  );
  eq(
    "reading it sends no data byte",
    readScopeDataOutput(0x94).toString("hex"),
    "fefe94e02711fd",
  );
}

{
  // The scope selector byte comes BEFORE the mode, and dropping it addresses the mode
  // command at the wrong argument — which the radio would accept.
  eq(
    "centre mode carries the scope selector first",
    setScopeMode(0x94, "centre").toString("hex"),
    "fefe94e027120000fd",
  );
  eq(
    "fixed mode",
    setScopeMode(0x94, "fixed").toString("hex"),
    "fefe94e027120001fd",
  );
}

{
  // Span is a five-byte little-endian BCD frequency, exactly like a dial frequency.
  // 100 kHz is `00 00 10 00 00`; big-endian would be `00 00 10 00 00` reversed and
  // would ask for a 10 GHz span, which the radio would refuse — loudly, at least.
  eq(
    "a 100 kHz span encodes as BCD",
    setScopeSpan(0x94, 100_000).toString("hex"),
    "fefe94e02713000000100000fd",
  );
  eq(
    "the smallest span the radio offers",
    setScopeSpan(0x94, 2_500).toString("hex"),
    "fefe94e02713000025000000fd",
  );
  eq(
    "reading the span carries the selector",
    readScopeSpan(0x94).toString("hex"),
    "fefe94e0271300fd",
  );
}

{
  // A scope frame must never be mistaken for a reply. It matches no read, and the
  // waveform command shares 0x27 with every scope setting — so the SUB-command is the
  // only thing separating "here is 475 points of spectrum" from "yes, the span is set".
  const f = parseFrames(
    Buffer.from("fefee094270000010b" + "00".repeat(8) + "fd", "hex"),
  );
  eq("a waveform frame parses", f.frames.length, 1);
  eq("  command is 0x27", f.frames[0]?.command, 0x27);
  eq(
    "  sub-command is 0x00, the waveform",
    f.frames[0]?.sub,
    ScopeSub.waveform,
  );
  ok(
    "  and it is not an echo of ours",
    f.frames[0] !== undefined && !isEcho(f.frames[0]),
  );
}

console.log("\nthe scaler uses the whole palette");
{
  // Pins the fix for a display where the strongest station on the band rendered green
  // while SmartSDR showed it red. Two causes, both asserted here:
  //
  //   1. The ceiling reserved 6 dB of "headroom" above the 99.5th percentile. But that
  //      percentile is already chosen to exclude outliers — the bins above it SHOULD
  //      clip to the top of the ramp, because 255 is what a peak looks like. The
  //      reservation made the top of the palette unreachable by construction.
  //   2. MIN_SPAN_DB was 20, wider than a real quiet band's whole dynamic range
  //      (~14 dB on 40 m), so the clamp was always the active constraint and every
  //      row shipped with exactly the same washed-out scale.
  //
  // Measured on air before the fix: ceiling-floor pinned at 20.0 dB on every row, no
  // byte above 210, the top three sixteenths of the ramp empty. After: peaks at
  // 227-234 with the noise median still below byte 25.
  const scaler = new PanadapterScaler((raw) => raw); // identity: test in dB directly

  // A synthetic band: noise around -100 dB with scatter, and one strong carrier
  // 14 dB above it — the shape of real 40 m in daylight.
  const bins = new Float32Array(2048);
  for (let i = 0; i < bins.length; i++)
    bins[i] = -100 + ((i * 7919) % 100) / 25; // -100..-96
  for (let i = 1000; i < 1010; i++) bins[i] = -86; // the carrier

  // Feed it a few times so the tracked floor and peak settle.
  let row = scaler.row(bins, 7_074_000, 100_000);
  for (let k = 0; k < 10; k++) row = scaler.row(bins, 7_074_000, 100_000);

  let maxByte = 0;
  for (const v of row.bins) maxByte = Math.max(maxByte, v);
  // 225, not 255: the ceiling tracks the 99.5th percentile with slow-downward
  // smoothing, so the carrier's own bins land a few steps under the very top rather
  // than exactly on it. On-air measurements after the fix showed peaks at 227-234.
  // What matters is reaching the red half of the ramp at all — before the fix the
  // maximum ever observed was 210 into a 20 dB span, i.e. the top three sixteenths
  // of the palette were structurally unreachable.
  ok(
    `the strongest signal reaches the red end of the ramp (max ${maxByte})`,
    maxByte >= 225,
  );

  const sortedB = Uint8Array.from(row.bins).sort();
  const p50 = sortedB[Math.floor(sortedB.length * 0.5)]!;
  ok(
    `while the noise median stays in the dark bottom fifth (p50 ${p50})`,
    p50 < 52,
  );

  ok(
    `and the span tracks the real range instead of a fixed 20 dB (${(row.ceilingDb - row.floorDb).toFixed(1)} dB)`,
    row.ceilingDb - row.floorDb < 19,
  );

  // The floor still exists: a genuinely empty band must not paint itself in colour.
  const flat = new Float32Array(2048);
  for (let i = 0; i < flat.length; i++)
    flat[i] = -100 + ((i * 104729) % 100) / 50; // 2 dB scatter
  const empty = new PanadapterScaler((raw) => raw);
  let er = empty.row(flat, 7_074_000, 100_000);
  for (let k = 0; k < 10; k++) er = empty.row(flat, 7_074_000, 100_000);
  const esorted = Uint8Array.from(er.bins).sort();
  const ep95 = esorted[Math.floor(esorted.length * 0.95)]!;
  ok(
    `an empty band keeps even its brightest noise out of the signal colours (p95 ${ep95})`,
    ep95 < 128,
  );
}

console.log("\nnoise stays dark against a REALISTIC bin distribution");
{
  // The display this pins was reported against Aether on the same band: ours a
  // full-colour confetti of blue, green, yellow and red across the whole 50 kHz with no
  // signal distinguishable in it, Aether's a near-black waterfall with a dozen separate
  // carriers. Nothing above was able to see it, because the synthetic band above is
  // uniform 4 dB scatter and a real unaveraged FFT bin has a 12.65 dB exponential
  // spread. See noiseBand.
  //
  // The failure was structural rather than a bad constant. With the ramp floored at
  // 12 dB and the noise reaching 12.65 dB above its own 25th percentile, the palette was
  // being spent almost entirely on the difference between one noise sample and the next.
  const N = 4096;

  const quiet = new PanadapterScaler((raw) => raw);
  const rq = lcg(20260810);
  let q = quiet.row(noiseBand(N, -100, rq), 14_285_000, 50_000);
  for (let k = 0; k < 40; k++) q = quiet.row(noiseBand(N, -100, rq), 14_285_000, 50_000);

  // The MEDIAN is the assertion, not the upper tail. Demanding the 99.5th percentile be
  // dark instead is what shipped a 45 dB ramp onto a band holding 12.55 dB and blanked
  // the display — see the second rejected-attempt note in lib/radio/panadapter.ts.
  const q50 = pct(q.bins, 0.5);
  ok(
    `an empty band's median noise stays in the dark bottom fifth (p50 ${q50})`,
    q50 <= 51,
  );
  // And the ramp must stay SANE. An unbounded noise term is the failure mode this file
  // now exists to catch: every constant here is allowed to darken the display, and none
  // of them is allowed to darken all of it.
  ok(
    `without inflating the ramp beyond reason (${(q.ceilingDb - q.floorDb).toFixed(1)} dB)`,
    q.ceilingDb - q.floorDb < 30,
  );

  // And the point of all that darkness: signals have somewhere to go. A carrier 25 dB
  // over the noise should be plainly visible, not one shade off the background.
  const withSignal = new PanadapterScaler((raw) => raw);
  const rs = lcg(778899);
  let s = withSignal.row(noiseBand(N, -100, rs), 14_285_000, 50_000);
  for (let k = 0; k < 40; k++) {
    const band = noiseBand(N, -100, rs, 1);
    // Three carriers of different strengths, each a few bins wide, as 20 m looks.
    for (let i = 1000; i < 1006; i++) band[i] = -75; // 25 dB up
    for (let i = 2000; i < 2006; i++) band[i] = -62; // 38 dB up
    for (let i = 3000; i < 3006; i++) band[i] = -88; // 12 dB up, a weak one
    s = withSignal.row(band, 14_285_000, 50_000);
  }
  const strong = s.bins[2002]!;
  const mid = s.bins[1002]!;
  const weak = s.bins[3002]!;
  const bg = pct(s.bins, 0.5);
  ok(
    `the strongest carrier reaches the hot end of the ramp (byte ${strong})`,
    strong > 180,
  );
  ok(
    `a 25 dB carrier is clearly above the noise (byte ${mid} against a ${bg} background)`,
    mid > 100 && mid - bg > 80,
  );
  // The one that matters for actually finding a contact: a weak signal must be
  // DISTINGUISHABLE, which is a different and much weaker claim than "bright".
  ok(
    `and a 12 dB carrier is still separable from it (byte ${weak} against ${bg})`,
    weak - bg > 30,
  );

  // Averaging is the other half of the fix, and the scaler has to REWARD it rather than
  // cancel it out: narrower noise must buy contrast, not just a darker picture.
  const avg = new PanadapterScaler((raw) => raw);
  const ra = lcg(31337);
  let a = avg.row(noiseBand(N, -100, ra, 4), 14_285_000, 50_000);
  for (let k = 0; k < 40; k++) {
    const band = noiseBand(N, -100, ra, 4);
    for (let i = 1000; i < 1006; i++) band[i] = -75;
    a = avg.row(band, 14_285_000, 50_000);
  }
  ok(
    `four-frame averaging keeps the ramp no taller (${(a.ceilingDb - a.floorDb).toFixed(1)} dB against ${(q.ceilingDb - q.floorDb).toFixed(1)} unaveraged)`,
    a.ceilingDb - a.floorDb <= q.ceilingDb - q.floorDb,
  );
  ok(
    `and its carrier is at least as bright (byte ${a.bins[1002]} against ${mid})`,
    a.bins[1002]! >= mid,
  );
  ok(
    `while its noise median stays dark too (p50 ${pct(a.bins, 0.5)})`,
    pct(a.bins, 0.5) <= 51,
  );
}

console.log("\nthe 40 m band that was rendered blank");
{
  // A REAL frame, captured off the FlexRadio at 7.2114 MHz with a 100 kHz span while the
  // display was being reported as "blank like its not hearing". Reduced to the numbers
  // that decide the scale, so the regression is pinned without carrying 4096 bins around.
  //
  // Measured across twelve consecutive frames: the whole band held 12.55 dB from p25 to
  // its strongest bin, with the noise median 3.35 dB up. The scaler drew 45 dB for it and
  // the loudest pixel on the display came out at byte 60.
  const FLOOR = -100;
  const N = 4096;
  const rand = lcg(5150);
  const band = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    // Noise with the measured width: p50 3.35 dB above p25, a far tighter distribution
    // than an unaveraged bin, because the radio is averaging now.
    band[i] = FLOOR + 10 * Math.log10(-Math.log(1 - rand())) * 0.88;
  }
  // The band's strongest content, 12.55 dB above p25 — this is what has to stay visible.
  for (let i = 2000; i < 2010; i++) band[i] = FLOOR + 12.55;

  const s = new PanadapterScaler((raw) => raw);
  let r = s.row(band, 7_211_426, 100_000);
  for (let k = 0; k < 40; k++) r = s.row(band, 7_211_426, 100_000);

  const ramp = r.ceilingDb - r.floorDb;
  const peak = r.bins[2005]!;
  const median = pct(r.bins, 0.5);
  ok(`the ramp fits the band rather than dwarfing it (${ramp.toFixed(1)} dB)`, ramp < 20);
  ok(
    `so the strongest signal is actually visible (byte ${peak}, was 60 when this was reported)`,
    peak > 150,
  );
  ok(`while the noise median stays dark (p50 ${median})`, median <= 51);
}

console.log("\nthe 40 m evening that came out too dim to read voice on");
{
  // The second real capture, and the one that pins the FLOOR OFFSET. Reported against
  // RemoteHamRadio on the SAME BAND AND THE SAME RADIO: theirs shows SSB voice as broad
  // orange blobs over a live blue noise floor, ours showed faint specks on black.
  //
  // Measured across twelve frames at 7.2612 MHz, 100 kHz span, dB above p25:
  //
  //     p50 2.69   p95 6.42   p99.5 8.51   max 10.53   noiseWidth 2.69
  //
  // Two constants were wrong and both had been right before the radio's frame averaging
  // was turned on, which narrowed every one of those numbers:
  //
  //   * FLOOR_OFFSET_DB was a flat 2 dB against a noise only 2.69 dB wide, so the drawn
  //     floor landed almost ON the noise median and over half of every frame clipped to
  //     byte 0. That is the black background.
  //   * MIN_SPAN_DB was 12 while the whole band spanned 10.53, so the peak was capped
  //     around byte 136 and voice never reached the hot colours.
  const N = 4096;
  const rand = lcg(72612);
  const band = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    // Averaged noise: p50 - p25 of 2.69 dB, as measured.
    band[i] = -100 + 10 * Math.log10(-Math.log(1 - rand())) * 0.7;
  }
  // An SSB voice signal: 2.7 kHz wide at ~24 Hz/bin is about 110 bins, and unlike a
  // carrier it is a broad ragged blob rather than a spike.
  for (let i = 1500; i < 1610; i++) {
    band[i] = -100 + 10.53 - rand() * 2;
  }

  const s = new PanadapterScaler((raw) => raw);
  let r = s.row(band, 7_261_200, 100_000);
  for (let k = 0; k < 40; k++) r = s.row(band, 7_261_200, 100_000);

  const median = pct(r.bins, 0.5);
  const p95 = pct(r.bins, 0.95);
  const voice = r.bins[1550]!;
  const black = Array.from(r.bins).filter((v) => v === 0).length / N;

  // The headline: the noise floor must be VISIBLE, not black. This is the assertion that
  // would have caught the dim display, and no previous test made it — every one of them
  // only ever checked that noise was dark ENOUGH, never that it was there at all.
  ok(
    `the noise floor is a live blue rather than black (p50 ${median})`,
    median >= 15 && median <= 51,
  );
  ok(
    `less than half the frame clips to black (${(black * 100).toFixed(0)}%)`,
    black < 0.45,
  );
  ok(`voice reaches the hot end of the ramp (byte ${voice}, was ~136)`, voice > 200);
  ok(`and stands well clear of the noise (p95 ${p95})`, voice - p95 > 60);
}

console.log("\nclicking the spectrum lands on a frequency somebody would choose");
{
  // "There's too much granularity to pick a freq while clicking." The evidence was the
  // dial reading 7.502553 MHz — a pixel mapped straight through to Hz, so the odds of
  // landing on a number anybody would call CQ on were about one in a thousand.
  eq("CW snaps to 10 Hz", tuneStepFor("CW"), 10);
  eq("  and CWL too", tuneStepFor("CWL"), 10);
  eq("SSB snaps to 100 Hz", tuneStepFor("USB"), 100);
  eq("  on either sideband", tuneStepFor("LSB"), 100);
  eq("the data modes snap to 500 Hz", tuneStepFor("DIGU"), 500);
  eq("  including the -D modulations the FlexRadio reports", tuneStepFor("USB-D"), 500);
  eq("AM uses its channel spacing", tuneStepFor("AM"), 1_000);
  eq("FM uses its own", tuneStepFor("NFM"), 5_000);
  // Never zero, and never "no snap" — an unknown mode still gets a usable step.
  eq("an unrecognised mode still snaps", tuneStepFor("WEIRD"), 100);
  eq("as does a missing one", tuneStepFor(null), 100);

  // The reported case, end to end.
  eq(
    "the frequency that prompted this rounds to something tunable",
    snapHz(7_502_553, "LSB"),
    7_502_600,
  );
  eq("a CW click keeps 10 Hz resolution", snapHz(7_030_123, "CW"), 7_030_120);
  eq(
    "and a data-mode click lands on the watering hole",
    snapHz(7_074_140, "DIGU"),
    7_074_000,
  );
  // Snapping must not drift a frequency that is ALREADY on step.
  eq("a frequency already on step is untouched", snapHz(14_074_000, "DIGU"), 14_074_000);
  eq("and so is an exact SSB one", snapHz(7_200_000, "LSB"), 7_200_000);
}

console.log("\nthe dial reads like a radio's own display");
{
  // 14.3 and 14.03 differ by one character and by 270 kHz. An operator reading a dial
  // mid-contact is not parsing decimal places, so the dial is grouped and fixed width.
  eq("a round frequency groups into MHz.kHz.Hz", formatFreqDial(14_300_000), "14.300.000");
  eq("the FT8 watering hole", formatFreqDial(7_074_000), "7.074.000");
  eq("hertz are kept, not rounded away", formatFreqDial(7_261_200), "7.261.200");
  // Padding is the whole point: an unpadded 7.74.0 would read as 7.740 MHz.
  eq("kHz below 100 keep their leading zeros", formatFreqDial(7_074_500), "7.074.500");
  eq("and so do hertz", formatFreqDial(14_000_050), "14.000.050");
  eq("a whole megahertz", formatFreqDial(14_000_000), "14.000.000");
  eq("sub-megahertz still works", formatFreqDial(472_000), "0.472.000");
  eq("nonsense is a dash, not NaN", formatFreqDial(0), "—");
  // The compact form is untouched — it is still right for lists, rulers and logs.
  eq("the compact form still trims", formatFreqMHz(14_300_000), "14.3");
}

console.log("\nspot labels thin out instead of piling up");
{
  const spot = (key: string, freqHz: number) => ({ key, callsign: key, freqHz });
  const LOW = 7_000_000;
  const SPAN = 100_000; // 6% of this is 6 kHz

  // Well separated: everybody gets a name.
  const spread = [
    spot("A", 7_010_000),
    spot("B", 7_040_000),
    spot("C", 7_080_000),
  ];
  eq("three spots across the span all get labels", labelledSpots(spread, LOW, SPAN).size, 3);

  // A pile-up inside one label's width: one name, and the others keep their marker.
  const cluster = [
    spot("A", 7_050_000),
    spot("B", 7_050_500),
    spot("C", 7_051_000),
    spot("D", 7_051_500),
  ];
  const got = labelledSpots(cluster, LOW, SPAN);
  eq("four spots within 1.5 kHz collapse to one label", got.size, 1);
  ok("  and it is the lowest in frequency", got.has("A"));

  // Zooming in must reveal them — the property that makes the zoom worth pressing.
  eq(
    "the same cluster at a 5 kHz span labels every one",
    labelledSpots(cluster, 7_048_000, 5_000).size,
    4,
  );

  // Exactly on the threshold counts as separated, so a spot does not flicker in and out
  // as the display is retuned by a hair.
  eq(
    "a gap of exactly the label width is enough",
    labelledSpots([spot("A", 7_000_000), spot("B", 7_006_000)], LOW, SPAN).size,
    2,
  );
  eq(
    "and a hair under it is not",
    labelledSpots([spot("A", 7_000_000), spot("B", 7_005_900)], LOW, SPAN).size,
    1,
  );

  eq("no spots, no labels", labelledSpots([], LOW, SPAN).size, 0);
}

console.log("\nfilter presets carry the sideband's sign");
{
  // Reported as "none of the SSB etc buttons show which is active", which turned out to
  // have a worse fault behind it than the missing highlight. The presets are written the
  // way a filter is spoken about — SSB is 100 to 2800 — and that is the UPPER sideband
  // convention. They were being sent to the radio unsigned, so pressing SSB while the
  // slice was on LSB asked it to listen 100-2800 Hz above a dial whose signal is entirely
  // below it. The highlight could not work either: the radio reports -2800..-100 there.
  eq("USB keeps the preset as written", JSON.stringify(filterEdgesFor("USB", 100, 2800)), '{"lo":100,"hi":2800}');
  eq("DIGU too", JSON.stringify(filterEdgesFor("DIGU", 0, 3000)), '{"lo":0,"hi":3000}');
  eq(
    "LSB mirrors it below the dial",
    JSON.stringify(filterEdgesFor("LSB", 100, 2800)),
    '{"lo":-2800,"hi":-100}',
  );
  eq(
    "and so does the data mode on that sideband",
    JSON.stringify(filterEdgesFor("DIGL", 0, 3000)),
    '{"lo":-3000,"hi":0}',
  );
  // The mirror must not narrow a filter that already straddles the dial.
  eq(
    "CW straddles the dial and is left alone",
    JSON.stringify(filterEdgesFor("CWL", -250, 250)),
    '{"lo":-250,"hi":250}',
  );

  const usb = { agc: "med", nb: false, nr: false, filterLo: 100, filterHi: 2800 };
  ok("a USB slice lights its own preset", filterMatches(usb, "USB", 100, 2800));
  ok("and not a different one", !filterMatches(usb, "USB", 0, 3000));

  const lsb = { agc: "med", nb: false, nr: false, filterLo: -2800, filterHi: -100 };
  ok(
    "an LSB slice lights the same button, mirrored",
    filterMatches(lsb, "LSB", 100, 2800),
  );
  ok(
    "which is the case that could never light before",
    !filterMatches(lsb, "USB", 100, 2800),
  );

  // "Not reported" must never light a button — that was the original complaint's
  // failure mode, a row of controls implying a state nothing had read.
  ok(
    "a radio that has not reported its filter lights nothing",
    !filterMatches({ agc: null, nb: null, nr: null }, "USB", 100, 2800),
  );
  ok("nor does a missing receiver", !filterMatches(undefined, "USB", 100, 2800));
  // A custom width lights nothing rather than the nearest preset.
  ok(
    "and a width that is not a preset lights nothing rather than the nearest",
    !filterMatches(
      { agc: null, nb: null, nr: null, filterLo: 200, filterHi: 2500 },
      "USB",
      100,
      2800,
    ),
  );
}

// ---------------------------------------------------------------------------
// Following the dial
// ---------------------------------------------------------------------------
//
// The panadapter was caught reporting 7.074 MHz while the slice read 7.200 LSB, and
// drawing a confident 7.024-7.124 ruler under it. Reported as "top waterfall doesn't
// update when freq changes" — which is exactly how a display parked on the wrong band
// with correct-looking labels presents.
//
// The cause: following the dial was edge-triggered on slice status messages only, so a
// single dropped or coalesced status parked it indefinitely. It is now checked on a
// timer as well, and the rule both paths share is asserted here.
console.log("\nfollowing the dial");
{
  const SPAN = 200_000;
  const CENTRE = 7_074_000;

  ok(
    "a dial sitting at the centre needs no move",
    !panNeedsRecentre(CENTRE, SPAN, CENTRE),
  );

  // Why the threshold is not zero: a slice status arrives for every field the radio
  // touches, and re-centring on each one restarts the sweep several times a second —
  // the "waterfall randomly refreshes" complaint.
  ok(
    "nor does tuning 5 kHz away inside a 200 kHz view — the cursor moves, not the view",
    !panNeedsRecentre(CENTRE, SPAN, CENTRE + 5_000),
  );

  ok("but a band change does", panNeedsRecentre(CENTRE, SPAN, 14_074_000));

  // The case actually observed on the air.
  ok(
    "and so does 7.074 -> 7.200, the move that was being missed",
    panNeedsRecentre(CENTRE, SPAN, 7_200_000),
  );

  // Scaling with the span means zooming in follows more eagerly, rather than keeping a
  // signal that has already left the window.
  ok(
    "the threshold scales with the span: 5 kHz off centre DOES move a 20 kHz view",
    panNeedsRecentre(CENTRE, 20_000, CENTRE + 5_000),
  );

  ok(
    "and it is symmetric — tuning down is the same as tuning up",
    panNeedsRecentre(CENTRE, SPAN, CENTRE - 126_000) &&
      panNeedsRecentre(CENTRE, SPAN, CENTRE + 126_000),
  );
}

// ---------------------------------------------------------------------------
// A slice status does not have to carry the frequency
// ---------------------------------------------------------------------------
//
// This is the finding that made "the panadapter doesn't follow the dial" a two-day
// puzzle rather than a typo, and it is worth an assertion because the fix looks
// gratuitous without it.
//
// A FlexRadio does NOT echo `slice tune` back to the connection that issued it. That
// connection gets `RF_frequency` once, in the subscription snapshot, and never again.
// Captured on the wire from a FLEX-6400 on SmartSDR 4.2.18: one slice status carrying
// RF_frequency, then fifteen carrying mode, filters, antennas, the TX flag and the FM
// settings — and no frequency at all.
//
// DigiShack tunes through that same connection, so its slice cache is stale for every
// band change the operator makes. The panadapter takes the dial from the bridge's
// separate tracking connection instead, which is not the originator and does get the
// updates. The parser must therefore preserve a known frequency across an update that
// omits it, and must not invent one.
console.log("\na slice status need not carry the frequency");
{
  // Verbatim shapes from the capture.
  const withFreq = parseStatusBody(
    "slice 0 in_use=1 sample_rate=24000 RF_frequency=7.074000 client_handle=0x5EC3631F mode=DIGU",
  );
  ok(
    "the connect-time snapshot carries RF_frequency",
    withFreq.fields.RF_frequency === "7.074000",
  );
  ok(
    "and identifies the slice by index",
    withFreq.object === "slice" && withFreq.index === 0,
  );

  // The three real update shapes seen after a tune. None of them mentions frequency.
  const updates = [
    "slice 0 mode=DIGU filter_lo=0 filter_hi=3000 agc_mode=med agc_threshold=65 step=250",
    "slice 0 txant=ANT1 rxant=ANT1 loopa=0 loopb=0 ant_list=ANT1,ANT2,RX_A,XVTA qsk=0",
    "slice 0 pan=0x40000000 mode=DIGU qsk=0 tx=1",
  ];
  for (const line of updates) {
    const u = parseStatusBody(line);
    ok(
      `an update carrying "${line.slice(7, 30)}..." has no frequency in it`,
      u.fields.RF_frequency === undefined,
    );
  }

  // Which is why the frequency is the ONE field a slice update cannot be trusted to
  // refresh — and why reading it out of this connection had to stop.
  const tuneReport = parseStatusBody(
    "transmit freq=21.074000 rfpower=100 tunepower=10 tx_slice_mode=DIGU dax=1",
  );
  ok(
    "the new frequency turns up on the `transmit` object instead, for the TX slice only",
    tuneReport.object === "transmit" && tuneReport.fields.freq === "21.074000",
  );
}

// ---------------------------------------------------------------------------
// Re-centring slides the history, it does not wipe it
// ---------------------------------------------------------------------------
//
// "Everytime i click to the side the waterfall re renders — it should only re render the
// missing part and continue scrolling up." Which is right, and is what every hardware
// panadapter does: clicking a signal off to one side re-centres by a few tens of kHz, and
// wiping minutes of history to shift the picture by a fifth of a screen loses far more
// than it redraws.
//
// The rule that has to hold for any of it to be honest: A FREQUENCY MUST LAND ON ITS OWN
// PIXEL. Get the sign of the shift wrong, or clip the destination by a different
// proportion than the source, and the result is a plausible-looking waterfall with signals
// at frequencies they were never on — the one thing this display must never do.
console.log("\nre-centring slides the history");
{
  const W = 1024;

  // A frequency's pixel position under an axis, which is what the assertions check.
  const px = (a: { lowHz: number; spanHz: number }, hz: number): number =>
    ((hz - a.lowHz) / a.spanHz) * W;

  const was = { lowHz: 7_000_000, spanHz: 200_000 };

  {
    // Standing still must be a no-op that covers the whole canvas.
    const m = remapAxis(was, was, W);
    ok(
      "an unchanged axis maps the whole image onto itself",
      m !== null &&
        m.srcX0 === 0 &&
        m.srcX1 === W &&
        m.dstX0 === 0 &&
        m.dstX1 === W,
    );
  }

  {
    // Tune UP by a quarter of the span. The content must move LEFT by a quarter of the
    // width, which means reading from a quarter in and writing from the left edge.
    const now = { lowHz: 7_050_000, spanHz: 200_000 };
    const m = remapAxis(was, now, W);
    ok(
      "tuning up a quarter span reads from a quarter in and lands at the left edge",
      m !== null &&
        Math.abs(m.srcX0 - W / 4) < 0.01 &&
        Math.abs(m.dstX0) < 0.01,
    );
    ok(
      "and keeps three quarters of the history",
      m !== null &&
        Math.abs(m.srcX1 - W) < 0.01 &&
        Math.abs(m.dstX1 - (W * 3) / 4) < 0.01,
    );
    // The property that matters. 7.100 MHz is in both windows; it must come out at the
    // same place the new axis puts it.
    if (m) {
      const carrier = 7_100_000;
      const fromOld = px(was, carrier);
      const mapped =
        m.dstX0 +
        ((fromOld - m.srcX0) / (m.srcX1 - m.srcX0)) * (m.dstX1 - m.dstX0);
      ok(
        `a 7.100 MHz carrier lands where the new axis puts it (${mapped.toFixed(1)} vs ${px(now, carrier).toFixed(1)})`,
        Math.abs(mapped - px(now, carrier)) < 0.01,
      );
    }
  }

  {
    // Tuning DOWN is the mirror image: read from the left edge, write a quarter in.
    const now = { lowHz: 6_950_000, spanHz: 200_000 };
    const m = remapAxis(was, now, W);
    ok(
      "tuning down reads from the left edge and lands a quarter in",
      m !== null &&
        Math.abs(m.srcX0) < 0.01 &&
        Math.abs(m.dstX0 - W / 4) < 0.01,
    );
  }

  {
    // Zooming in halves the span. Half the old image stretches across the whole canvas,
    // which is what keeps the context an operator just zoomed into.
    const now = { lowHz: 7_050_000, spanHz: 100_000 };
    const m = remapAxis(was, now, W);
    // 100 kHz out of 200 is HALF the old image, and it is stretched to the full width.
    ok(
      "zooming in stretches the half that survives across the whole canvas",
      m !== null &&
        Math.abs(m.srcX1 - m.srcX0 - W / 2) < 0.01 &&
        Math.abs(m.dstX1 - m.dstX0 - W) < 0.01,
    );
    if (m) {
      const carrier = 7_074_000;
      const fromOld = px(was, carrier);
      const mapped =
        m.dstX0 +
        ((fromOld - m.srcX0) / (m.srcX1 - m.srcX0)) * (m.dstX1 - m.dstX0);
      ok(
        "and a carrier inside it still lands on its own pixel",
        Math.abs(mapped - px(now, carrier)) < 0.01,
      );
    }
  }

  {
    // Zooming OUT: the old content shrinks into the middle, with new blank either side.
    const now = { lowHz: 6_900_000, spanHz: 400_000 };
    const m = remapAxis(was, now, W);
    ok(
      "zooming out shrinks the history into the middle, blank either side",
      m !== null &&
        Math.abs(m.srcX0) < 0.01 &&
        Math.abs(m.srcX1 - W) < 0.01 &&
        m.dstX0 > 0 &&
        m.dstX1 < W,
    );
  }

  {
    // A band change shares nothing. Null tells the caller to leave the blank canvas
    // alone, rather than smearing one edge pixel across the width.
    ok(
      "a band change shares no frequency and returns null",
      remapAxis(was, { lowHz: 14_000_000, spanHz: 200_000 }, W) === null,
    );
    // Exactly adjacent is the boundary case: touching, not overlapping.
    ok(
      "and so does a window that is exactly adjacent",
      remapAxis(was, { lowHz: 7_200_000, spanHz: 200_000 }, W) === null,
    );
  }

  // Degenerate inputs return null rather than dividing by zero and painting NaN.
  ok(
    "a zero span returns null instead of dividing by zero",
    remapAxis(was, { lowHz: 7_000_000, spanHz: 0 }, W) === null,
  );
  ok("as does a zero-width canvas", remapAxis(was, was, 0) === null);
}

console.log(
  failures === 0
    ? "\nok — panadapter"
    : `\nFAIL — ${failures} panadapter assertion(s)`,
);
process.exit(failures === 0 ? 0 : 1);
