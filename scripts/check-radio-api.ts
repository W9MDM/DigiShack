/* eslint-disable no-console */
// Assertions on the radio API's contract - what a dial is told and what it may say.
// Run: npm run check:radio-api
//
// The routes under pages/api/v1/radio/ are thin: they call the bridge and run these pure
// functions. So the contract a worker is written against is asserted here, without a
// bridge, a radio or a network: the lock policy and its one exception, the reduction of
// the bridge's status to the documented shape (nulls staying null), the command schema
// (exactly the field each command needs, no more), the idempotency store's bound, and the
// mapping from a command to what the bridge is asked.

import {
  MAX_DELTA_HZ,
  RADIO_COMMANDS,
  RecentCommands,
  bridgeRequestFor,
  bypassesLocks,
  commandSchema,
  locksFor,
  reduceStatus,
  type BridgeStatusPayload,
} from "../lib/radio/api";

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

// ---------------------------------------------------------------------------
console.log("the lock policy: who owns the receiver");
// ---------------------------------------------------------------------------
{
  const free = { qsoActive: false, autoMode: "off", transmitting: false, ft0: false };
  eq(locksFor(free).length, 0, "nothing running: no locks");
  const qso = locksFor({ ...free, qsoActive: true, qsoWith: "K1ABC" });
  eq(qso.length, 1, "a contact in progress is one lock");
  eq(qso[0]?.reason, "qso", "named qso");
  ok(qso[0]!.detail.includes("K1ABC"), "and the detail names the station", qso[0]?.detail);
  eq(locksFor({ ...free, autoMode: "hunt" })[0]?.reason, "auto", "an automatic mode is a lock");
  eq(locksFor({ ...free, autoMode: null })[0], undefined, "an unknown auto mode is not one");
  eq(locksFor({ ...free, transmitting: true })[0]?.reason, "transmitting", "a transmission is a lock");
  eq(locksFor({ ...free, ft0: true })[0]?.reason, "ft0", "FT-0 is a lock");
  const all = locksFor({ qsoActive: true, qsoWith: null, autoMode: "cq", transmitting: true, ft0: true });
  eq(all.map((l) => l.reason).join(","), "ft0,transmitting,qso,auto", "all four, in a fixed order a worker can rely on");
  eq(bypassesLocks("stop-automation"), true, "stop-automation passes through a lock: it is how the auto lock is lifted");
  for (const c of RADIO_COMMANDS.filter((x) => x !== "stop-automation")) {
    eq(bypassesLocks(c), false, `${c} does not`);
  }
}

// ---------------------------------------------------------------------------
console.log("\nthe state: the bridge's status reduced to the contract, nulls staying null");
// ---------------------------------------------------------------------------
{
  const now = new Date("2026-10-14T20:12:33.410Z");
  // The shape the live box answers, trimmed.
  const live: BridgeStatusPayload = {
    running: true,
    status: {
      connected: true,
      lastHeartbeat: 1791965553102,
      dialFrequency: 7074000.4,
      band: "40M",
      mode: "DIGU",
      subMode: "FT8",
      radioMode: "USB-D",
      transmitting: false,
      allowTransmit: true,
      rfPower: 90,
      source: "flex",
      radio: { vendor: "flex", model: "FLEX-6400", host: "somewhere" },
      link: { rttMs: 17.4 },
      voice: { active: false, mode: null },
      ft0: false,
      receiver: { agc: "med", nb: false, nr: null, filterLo: 100, filterHi: 3100, rxAnt: "ANT1", txAnt: null },
    },
    qso: { active: false, theirCall: null, state: null },
    auto: { mode: "hunt", lastAction: "hunting VE9ZK (-15 dB)" },
  };
  const s = reduceStatus(live, now);
  eq(s.api, 1, "api version 1");
  eq(s.at, now.toISOString(), "at is the snapshot time");
  eq(s.bridge.running, true, "bridge running");
  eq(s.connection.source, "flex", "source");
  eq(s.connection.radio?.model, "FLEX-6400", "radio model");
  ok(!("host" in (s.connection.radio ?? {})), "and the radio's network address is not in the contract");
  eq(s.connection.lastHeartbeat, new Date(1791965553102).toISOString(), "last heartbeat as ISO");
  eq(s.connection.linkRttMs, 17, "link round trip rounded to a millisecond");
  eq(s.receiver.frequencyHz, 7074000, "frequency is an integer number of hertz");
  eq(s.receiver.modulation, "USB-D", "modulation is the radio's demodulator");
  eq(s.receiver.digitalMode, "FT8", "digital mode is what DigiShack operates");
  eq(s.receiver.nr, null, "a control the radio has not reported stays null");
  eq(s.receiver.txAntenna, null, "so does an antenna it has not named");
  eq(s.transmitter.armed, true, "armed follows allowTransmit");
  eq(s.automation.mode, "hunt", "automation mode");
  eq(s.locks.length, 1, "one lock, from the automatic mode");
  eq(s.locks[0]?.reason, "auto", "named auto");

  const voice = reduceStatus({ ...live, status: { ...live.status!, voice: { active: true, mode: "USB" } } }, now);
  eq(voice.receiver.digitalMode, null, "in voice mode the digital mode is null, not FT8");
  eq(voice.voice.active, true, "and voice says so");

  const down = reduceStatus({ running: false, reason: "No bridge answering" }, now);
  eq(down.bridge.running, false, "no bridge: running false");
  eq(down.bridge.reason, "No bridge answering", "with the reason");
  eq(down.receiver.frequencyHz, null, "and every reading null");
  eq(down.locks.length, 0, "and no locks, since nothing owns anything");

  const bare = reduceStatus({ running: true, status: { connected: false } }, now);
  eq(bare.receiver.frequencyHz, null, "a status with no readings reports nulls, not zeros");
  eq(bare.automation.mode, "off", "and automation defaults to off");
}

// ---------------------------------------------------------------------------
console.log("\ncommands: exactly the field each needs, and nothing else");
// ---------------------------------------------------------------------------
{
  const accept = (body: unknown, what: string) => ok(commandSchema.safeParse(body).success, what, JSON.stringify(commandSchema.safeParse(body)));
  const reject = (body: unknown, what: string) => ok(!commandSchema.safeParse(body).success, what, "accepted");
  accept({ id: "k-1", command: "tune-relative", deltaHz: 100 }, "tune-relative with deltaHz");
  accept({ id: "k-2", command: "tune-relative", deltaHz: -25 }, "negative deltas");
  reject({ id: "k-3", command: "tune-relative", deltaHz: 0 }, "a zero delta is refused");
  reject({ id: "k-4", command: "tune-relative", deltaHz: 10.5 }, "a fractional hertz is refused");
  reject({ id: "k-5", command: "tune-relative", deltaHz: MAX_DELTA_HZ + 1 }, `a delta beyond ${MAX_DELTA_HZ} is refused`);
  reject({ id: "k-6", command: "tune-relative" }, "tune-relative without deltaHz is refused");
  accept({ id: "k-7", command: "set-frequency", frequencyHz: 14074000 }, "set-frequency with frequencyHz");
  reject({ id: "k-8", command: "set-frequency", frequencyHz: 14074000, deltaHz: 1 }, "set-frequency does not take deltaHz");
  accept({ id: "k-9", command: "set-modulation", modulation: "USB-D" }, "set-modulation with a modulation from the list");
  reject({ id: "k-10", command: "set-modulation", modulation: "DIGU" }, "a radio's own name for a mode is not in the list (USB-D is)");
  accept({ id: "k-11", command: "stop-automation" }, "stop-automation takes nothing");
  reject({ id: "k-12", command: "stop-automation", deltaHz: 1 }, "and refuses extras");
  reject({ id: "k-13", command: "tune", deltaHz: 1 }, "an unknown command is refused");
  reject({ id: "", command: "stop-automation" }, "an empty id is refused");
  reject({ id: "x".repeat(65), command: "stop-automation" }, "an id over 64 characters is refused");
  reject({ id: "k-14", command: "stop-automation", respectLocks: false }, "a field the contract does not name is refused, so nothing can switch the lock policy off from outside");
}

// ---------------------------------------------------------------------------
console.log("\nidempotency: a repeated id answers with the first outcome and is bounded");
// ---------------------------------------------------------------------------
{
  const r = new RecentCommands(3);
  r.remember({ id: "a", command: "tune-relative", status: "accepted" });
  r.remember({ id: "b", command: "tune-relative", status: "rejected", reason: "locked" });
  eq(r.seen("a")?.status, "accepted", "a remembered id is found");
  eq(r.seen("b")?.reason, "locked", "with its outcome");
  eq(r.seen("zzz"), undefined, "an unknown id is not");
  r.remember({ id: "a", command: "tune-relative", status: "accepted" });
  eq(r.size, 2, "remembering an id again does not grow the store");
  r.remember({ id: "c", command: "stop-automation", status: "accepted" });
  r.remember({ id: "d", command: "stop-automation", status: "accepted" });
  eq(r.size, 3, "the store is bounded");
  eq(r.seen("a"), undefined, "and the oldest id is the one forgotten");
  eq(r.seen("d")?.status, "accepted", "while the newest is kept");
}

// ---------------------------------------------------------------------------
console.log("\nwhat the bridge is asked");
// ---------------------------------------------------------------------------
{
  const rel = bridgeRequestFor({ id: "1", command: "tune-relative", deltaHz: 100 });
  eq(rel.path, "rig", "tune-relative goes to /rig");
  eq(rel.payload.deltaHz, 100, "as deltaHz");
  eq(rel.payload.respectLocks, true, "with the lock policy on");
  const abs = bridgeRequestFor({ id: "2", command: "set-frequency", frequencyHz: 14074000 });
  eq(abs.payload.freqHz, 14074000, "set-frequency as freqHz, the field the rig panel sends");
  eq(abs.payload.respectLocks, true, "with the lock policy on");
  const mod = bridgeRequestFor({ id: "3", command: "set-modulation", modulation: "CW" });
  eq(mod.payload.mode, "CW", "set-modulation as mode");
  const stop = bridgeRequestFor({ id: "4", command: "stop-automation" });
  eq(stop.path, "auto", "stop-automation goes to /auto");
  eq(stop.payload.mode, "off", "as mode off");
  eq(stop.payload.respectLocks, undefined, "and asks no lock check, since it is the one that lifts the lock");
}

console.log("");
if (failed > 0) {
  console.log(`${failed} FAILED`);
  process.exit(1);
}
console.log("all radio-api assertions passed");
