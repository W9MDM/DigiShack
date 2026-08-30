/* eslint-disable no-console */
// Byte-level checks for the PSKReporter upload datagram.
//
// Nothing here sends anything: PSKReporter is a volunteer service, and the
// layout is exactly the kind of thing to verify against the spec offline rather
// than by firing packets at someone else's server and hoping.

import {
  MIN_UPLOAD_INTERVAL_MS,
  PskReporterUploader,
  buildDatagram,
  type ReceiverInfo,
  type SpotToReport,
} from "@/lib/pskreporter/upload";

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail = ""): void {
  if (cond) {
    pass++;
    console.log(`  ok    ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const rx: ReceiverInfo = {
  callsign: "K9XYZ",
  // A grid that is NOBODY'S — deliberately not the station's real one. The scrub that
  // builds the public mirror rewrites the real grid wherever it appears, and it rewrote
  // the "EN61aa" this test EXPECTED while leaving the mixed-case "EN61jj" it FED, so the
  // assertion held in the private tree and failed in the mirror. The fifth scrub-break;
  // publish-public.ts documents the first four and predicted this one.
  grid: "FN42xy",
  software: "DigiShack 0.21.0",
  antenna: "dipole",
};

const spot = (call: string, snr: number, freqHz = 7_075_500): SpotToReport => ({
  callsign: call,
  grid: "FN31",
  freqHz,
  snr,
  mode: "FT8",
  at: new Date("2026-08-01T04:30:00Z"),
});

console.log("\ndatagram header");
{
  const d = buildDatagram(rx, [spot("K1ABC", -12)], {
    sequence: 7,
    randomId: 0xdeadbeef,
    now: new Date("2026-08-01T04:30:15Z"),
  });

  ok((d.readUInt32BE(0) >>> 16) === 0x000a, "IPFIX version 10");
  ok((d.readUInt32BE(0) & 0xffff) === d.length, "declared length matches the buffer", `${d.readUInt32BE(0) & 0xffff} vs ${d.length}`);
  ok(d.readUInt32BE(4) === Math.floor(Date.UTC(2026, 7, 1, 4, 30, 15) / 1000), "export timestamp");
  ok(d.readUInt32BE(8) === 7, "sequence number");
  ok(d.readUInt32BE(12) === 0xdeadbeef, "random session id");
  ok(d.length % 4 === 0, "whole datagram is 4-byte aligned", `${d.length}`);
}

console.log("\ntemplate descriptors");
{
  const d = buildDatagram(rx, [spot("K1ABC", -12)], { sequence: 0, randomId: 1 });
  // First set after the 16-byte header must be the template set (id 2).
  ok(d.readUInt16BE(16) === 2, "first set is a template set");
  const txSetLen = d.readUInt16BE(18);
  ok(d.readUInt16BE(20) === 0x5001, "sender template id 0x5001");
  ok(d.readUInt16BE(22) === 7, "sender template declares 7 fields");
  // Then the options template (id 3) for the receiver.
  const rxOff = 16 + txSetLen;
  ok(d.readUInt16BE(rxOff) === 3, "second set is an options template", `${d.readUInt16BE(rxOff)}`);
  ok(d.readUInt16BE(rxOff + 4) === 0x5000, "receiver template id 0x5000");
  ok(d.readUInt16BE(rxOff + 6) === 4, "receiver template declares 4 fields");
  ok(d.readUInt16BE(rxOff + 8) === 1, "one scope field");

  // Every field spec must carry PSKReporter's enterprise number.
  const entAt = 16 + 8 + 2; // first field id(2) + len(2) then enterprise(4)
  ok(d.readUInt32BE(entAt + 2) === 30351, "enterprise number 30351", `${d.readUInt32BE(entAt + 2)}`);
}

console.log("\nrecord sets");
{
  const d = buildDatagram(rx, [spot("K1ABC", -12), spot("VE3XYZ", 3)], {
    sequence: 0,
    randomId: 1,
    now: new Date("2026-08-01T04:30:00Z"),
  });

  // Walk the sets: template, options template, receiver, sender.
  let off = 16;
  const setIds: number[] = [];
  const setLens: number[] = [];
  while (off + 4 <= d.length) {
    const id = d.readUInt16BE(off);
    const len = d.readUInt16BE(off + 2);
    if (len < 4) break;
    setIds.push(id);
    setLens.push(len);
    // Set Length includes padding, so it alone advances to the next set.
    off += len;
  }
  ok(setIds.includes(0x5000), "receiver record set present", setIds.map((i) => i.toString(16)).join(","));
  ok(setIds.includes(0x5001), "sender record set present");
  ok(
    setLens.every((l) => l >= 4),
    "no zero-length sets",
  );

  // The receiver set must contain our callsign as a pascal string.
  const call = Buffer.from("K9XYZ", "utf8");
  const idx = d.indexOf(call);
  ok(idx > 0, "receiver callsign present");
  ok(d[idx - 1] === call.length, "callsign is length-prefixed", `${d[idx - 1]} vs ${call.length}`);

  // Grid must be upper-cased on the wire.
  ok(d.includes(Buffer.from("FN42XY", "utf8")), "grid is upper-cased");
  ok(!d.includes(Buffer.from("FN42xy", "utf8")), "the mixed-case input does not reach the wire");

  // Both spots must appear.
  ok(d.includes(Buffer.from("K1ABC", "utf8")), "first spot present");
  ok(d.includes(Buffer.from("VE3XYZ", "utf8")), "second spot present");
  ok(d.includes(Buffer.from("DigiShack", "utf8")), "info source names DigiShack");
}

console.log("\nSNR encoding (one signed byte)");
{
  for (const [snr, expect] of [
    [-12, 0xf4],
    [3, 0x03],
    [-50, 0xce],
    [0, 0x00],
  ] as [number, number][]) {
    const d = buildDatagram(rx, [spot("K1ABC", snr)], { sequence: 0, randomId: 1 });
    // Find the frequency then the SNR byte right after it.
    const call = d.indexOf(Buffer.from("K1ABC", "utf8"));
    const snrAt = call + 5 + 4; // callsign bytes + uint32 frequency
    ok(d[snrAt] === expect, `SNR ${snr} encodes as 0x${expect.toString(16)}`, `got 0x${d[snrAt]!.toString(16)}`);
  }
}

console.log("\nfrequency encoding");
{
  const d = buildDatagram(rx, [spot("K1ABC", 0, 14_075_123)], { sequence: 0, randomId: 1 });
  const call = d.indexOf(Buffer.from("K1ABC", "utf8"));
  ok(d.readUInt32BE(call + 5) === 14_075_123, "absolute frequency in Hz", `${d.readUInt32BE(call + 5)}`);
}

console.log("\nqueue behaviour");
{
  const up = new PskReporterUploader(rx);
  ok(!up.dueToSend(0), "nothing to send when the queue is empty");

  up.add(spot("K1ABC", -12));
  up.add(spot("K1ABC", -5)); // same station, stronger
  ok(up.queued === 1, "same station on the same band is deduplicated", `${up.queued}`);

  up.add(spot("K1ABC", -5, 14_075_000)); // different band
  ok(up.queued === 2, "same station on another band is a separate spot");

  // The courtesy interval is enforced, not advisory.
  ok(!up.dueToSend(0), "not due immediately");
  ok(up.dueToSend(MIN_UPLOAD_INTERVAL_MS + 1), "due after the interval");
  ok(MIN_UPLOAD_INTERVAL_MS >= 5 * 60_000, "interval is at least PSKReporter's 5 minutes");
}

console.log("\nstring safety");
{
  // An over-long antenna string must not corrupt the length prefix.
  const longRx: ReceiverInfo = { ...rx, antenna: "x".repeat(400) };
  const d = buildDatagram(longRx, [spot("K1ABC", 0)], { sequence: 0, randomId: 1 });
  ok((d.readUInt32BE(0) & 0xffff) === d.length, "over-long strings keep the length consistent");
  ok(d.length % 4 === 0, "and stay aligned");

  // A UTF-8 grid/callsign must be byte-counted, not character-counted.
  const utf: ReceiverInfo = { ...rx, software: "DigiShack ✓" };
  const d2 = buildDatagram(utf, [spot("K1ABC", 0)], { sequence: 0, randomId: 1 });
  const marker = Buffer.from("DigiShack ✓", "utf8");
  const at = d2.indexOf(marker);
  ok(at > 0 && d2[at - 1] === marker.length, "multi-byte strings are byte-length-prefixed", `${d2[at - 1]} vs ${marker.length}`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
