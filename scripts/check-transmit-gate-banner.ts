/* eslint-disable no-console */
// The "The radio will not transmit" banner on /rig, and the slice blockers behind it.
//
// The false alarm this pins: on the K9XYZ FLEX-6400, with one slice on 14.074 carrying
// transmit and the station on the air working people, /rig said "The transmit slice is on
// 14.074000 MHz but this station is operating on 7.074000 MHz". The 7.074 was the
// transmitter's fallback for creating a slice, which the bridge never sets, so every attach
// on any band but 40 m raised it. Nothing here touches a radio or a network: the shared
// connection is a stand-in that answers every command with success.

import type dgram from "node:dgram";

import type { FlexClient, FlexSlice } from "@/lib/flex/client";
import { FlexDaxTransmitter } from "@/lib/flex/tx";
import { OFF_FREQUENCY_HZ, replaceTxSliceBlockers, txSliceBlockers } from "@/lib/flex/tx-slice";

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

function slice(index: number, mhz: number, opts: { tx?: boolean; active?: boolean; mode?: string } = {}): FlexSlice {
  return {
    index,
    freqHz: Math.round(mhz * 1e6),
    mode: opts.mode ?? "DIGU",
    rxAnt: "ANT1",
    txAnt: "ANT1",
    antennas: { rx: ["ANT1"], tx: ["ANT1"] },
    active: opts.active ?? false,
    tx: opts.tx ?? false,
    filterLo: 100,
    filterHi: 3100,
    raw: {},
  };
}

const offFrequency = (bs: readonly string[]): string[] => bs.filter((b) => b.startsWith("The transmit slice is on"));

console.log("Slice blockers");

// The live report: one slice, on 20 m, carrying transmit, and it is ours.
{
  const bs = txSliceBlockers({ slices: [slice(0, 14.074, { tx: true, active: true })], operatingSliceIndex: 0 });
  ok(bs.length === 0, "one transmit slice on 14.074 that is ours: nothing blocks", bs.join(" · "));
}

// The 2026-08-30 fault, which must still block: transmit bound to a 40 m slice while the
// station decodes and operates on a 20 m one.
{
  const bs = txSliceBlockers({
    slices: [slice(0, 7.074, { tx: true }), slice(1, 14.074, { active: true, mode: "CW" })],
    operatingSliceIndex: 1,
  });
  const off = offFrequency(bs);
  ok(off.length === 1, "transmit slice on 40 m, ours on 20 m: blocks", bs.join(" · "));
  ok(
    /on 7\.074000 MHz but this station is operating on 14\.074000 MHz/.test(off[0] ?? ""),
    "and names the transmit slice and the slice we are on, not a fallback",
    off[0],
  );
}

{
  const bs = txSliceBlockers({ slices: [slice(0, 14.074), slice(1, 7.074)], operatingSliceIndex: 0 });
  ok(bs.some((b) => b.startsWith("No slice is set as the transmit slice")), "no slice carries transmit: blocks", bs.join(" · "));
}

{
  const nudge = 14.074 + (OFF_FREQUENCY_HZ - 1_000) / 1e6;
  const bs = txSliceBlockers({ slices: [slice(0, nudge, { tx: true }), slice(1, 14.074)], operatingSliceIndex: 1 });
  ok(offFrequency(bs).length === 0, "a transmit slice nudged within the tolerance does not block", bs.join(" · "));
}

{
  const bs = txSliceBlockers({ slices: [slice(0, 14.074, { tx: true })], operatingSliceIndex: null });
  ok(bs.length === 0, "with no slice of ours known, the frequency is not compared against a guess", bs.join(" · "));
}

// A caller that explicitly asked for a frequency (scripts/tx-once.ts) keeps the old check.
{
  const bs = txSliceBlockers({ slices: [slice(0, 14.074, { tx: true })], operatingSliceIndex: 0, intendedHz: 7_074_000 });
  ok(offFrequency(bs).length === 1, "an explicitly requested 7.074 against a 20 m transmit slice still blocks", bs.join(" · "));
}

console.log("\nRe-checking on a slice update");
{
  const stale = [
    "Transmit is inhibited on the radio",
    "The transmit slice is on 14.074000 MHz but this station is operating on 7.074000 MHz — transmissions would go out on the wrong frequency, or nowhere",
  ];
  const cleared = replaceTxSliceBlockers(stale, []);
  ok(
    cleared.length === 1 && cleared[0] === "Transmit is inhibited on the radio",
    "a fresh clean reading clears the stale slice blocker and keeps the radio's own",
    cleared.join(" · "),
  );
  const fresh = txSliceBlockers({
    slices: [slice(0, 7.074, { tx: true }), slice(1, 14.074)],
    operatingSliceIndex: 1,
  });
  const replaced = replaceTxSliceBlockers(stale, fresh);
  ok(
    replaced.length === 2 && offFrequency(replaced).length === 1 && /operating on 14\.074000/.test(offFrequency(replaced)[0] ?? ""),
    "a genuine mismatch replaces it rather than stacking a second copy",
    replaced.join(" · "),
  );
}

// End to end, built the way services/radio/index.ts builds it: shared mode, no `freqHz`.
// The stand-in connection answers every command with success and reports nothing, so the
// only blockers that can appear are the slice ones (and DAX, which nobody reported).
function fakeClient(slices: FlexSlice[]): FlexClient {
  const state = { slices: new Map(slices.map((s) => [s.index, s])), handle: null as string | null };
  const fake = {
    state,
    on: () => fake,
    off: () => fake,
    command: async () => ({ status: 0, message: "84000000" }),
  };
  return fake as unknown as FlexClient;
}

async function preflightOffFrequency(slices: FlexSlice[], sliceIndex: number): Promise<string[]> {
  const tx = new FlexDaxTransmitter({
    host: "0.0.0.0",
    allowTransmit: false,
    shared: { client: fakeClient(slices), socket: {} as dgram.Socket, sliceIndex },
  });
  await tx.start();
  const pre = await tx.preflight();
  return offFrequency(pre.blockers);
}

async function endToEnd(): Promise<void> {
  console.log("\nThe bridge's transmitter (shared mode, no frequency given)");
  const live = await preflightOffFrequency([slice(0, 14.074, { tx: true, active: true })], 0);
  ok(live.length === 0, "the K9XYZ report: 20 m transmit slice, ours, raises no wrong-frequency blocker", live.join(" · "));

  const wrong = await preflightOffFrequency(
    [slice(0, 7.074, { tx: true }), slice(1, 14.074, { active: true })],
    1,
  );
  ok(wrong.length === 1, "a transmit slice on another band than ours still blocks", wrong.join(" · "));
}

void endToEnd().then(() => {
  console.log(`\n${pass} passed, ${fail} failed\n`);
  // The transmitter registers exit handlers; leave without waiting on anything else.
  process.exit(fail > 0 ? 1 : 0);
});
