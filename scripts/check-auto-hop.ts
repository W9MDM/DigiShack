/* eslint-disable no-console */
// The automatic operator on the evening of 2026-10-23, and the three rules that end it.
//
// What the bridge log showed, 19:45 to 20:01 local, every four minutes:
//
//     [auto] leaving 20M: 1 station called CQ here in 20 windows and it was refused as a
//            dupe, a cooldown or a do-not-call, while 0.7 decodes a cycle are being heard
//     [auto] band hop -> 40M ... band too quiet (0 decodes) - hopping on ...
//     [auto] busiest band on the hop list: 20M (39 stations seen) ...
//     [auto] settled on new band (8 decodes) ... leaving 20M ...
//
// The sub-mode had been left on FT4 and nobody was on FT4. 40 m FT8 had 22 stations on it
// and the operator was in a contact within a minute of tuning there by hand. Three rules:
//
//   1. a quiet FT4 band is tried on FT8 before it is called quiet
//   2. a band left as unproductive is not picked again for a cool-off
//   3. plain hunt calls CQ when nobody has been callable for a while
//
// The pure rules are checked directly. The evening itself is replayed through a real
// AutoOperator and the real OperatingGuards - the dupe rule and the dead-band brake are
// the guards' own, not stubs - because the loop was an interaction between five rules,
// each of which was correct on its own.

import { AutoOperator, type AutoOperatorOptions } from "@/services/radio/auto-operator";
import { OperatingGuards } from "@/lib/digital/qso";
import { emptyWorkedIndex } from "@/lib/digital/worth";
import type { DigitalMode } from "@/lib/ham/digital-freqs";
import {
  activityIfFresh,
  bandsFreeToHop,
  cqFallbackStep,
  pickBandToStayOn,
  shouldTryFt8,
} from "@/lib/radio/band-hop";

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
function eq(a: unknown, b: unknown, label: string): void {
  ok(JSON.stringify(a) === JSON.stringify(b), label, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

// ---------------------------------------------------------------------------
// The pure rules
// ---------------------------------------------------------------------------

console.log("\nFT4 empty -> FT8, one way only");
{
  const on = { enabled: true, band: "40M", unavailable: false };
  eq(shouldTryFt8({ ...on, mode: "FT4" }), true, "a quiet FT4 band is tried on FT8");
  eq(shouldTryFt8({ ...on, mode: "ft4" }), true, "whatever the case of the mode name");
  eq(shouldTryFt8({ ...on, mode: "FT8" }), false, "FT8 is never sent anywhere - so FT4->FT8->FT4 cannot loop");
  eq(shouldTryFt8({ ...on, mode: "FT2" }), false, "nor is any other mode moved to FT8 by this rule");
  eq(shouldTryFt8({ ...on, mode: "FT4", enabled: false }), false, "the setting switches it off");
  eq(shouldTryFt8({ ...on, mode: "FT4", unavailable: true }), false, "a decoder that would not follow is not asked again");
  eq(shouldTryFt8({ ...on, mode: "FT4", band: null }), false, "nor with the dial off any band");
}

console.log("\ncool-off: the band just left is not a hop target");
{
  const now = 1_000_000;
  const blocked = new Map([["20M", now + 60_000]]);
  eq(bandsFreeToHop(["40M", "20M", "30M"], "40M", blocked, now), ["30M"], "20M cooling, 40M is where we are");
  eq(bandsFreeToHop(["40M", "20M", "30M"], "40M", blocked, now + 60_000), ["20M", "30M"], "and free again when it expires");
  eq(bandsFreeToHop(["40m", "20m"], "40M", new Map([["20M", now + 1]]), now), [], "case does not matter");
  eq(bandsFreeToHop(["40M"], null, new Map(), now), ["40M"], "nothing blocked, nothing current: the whole list");
}

console.log("\nnowhere to hop: stay on the best band this receiver measured");
{
  const rates = new Map([["20M", 0.7], ["40M", 0], ["30M", 0]]);
  eq(pickBandToStayOn({ bands: ["40M", "20M", "30M"], current: "30M", currentRate: 0, rates }), "20M", "0.7 a cycle beats 0");
  eq(pickBandToStayOn({ bands: ["40M", "20M"], current: "40M", currentRate: 0.7, rates }), "40M", "a tie stays put - moving costs a warm-up");
  eq(pickBandToStayOn({ bands: ["40M", "17M"], current: "40M", currentRate: null, rates }), "40M", "a band never measured here is no evidence");
}

console.log("\nstale network figures are not used to pick a band");
{
  const a = [{ band: "20M", transmitting: 39 }];
  eq(activityIfFresh(a, 0, 20 * 60_000, 30 * 60_000), a, "20 minutes old: still the current picture");
  eq(activityIfFresh(a, 0, 31 * 60_000, 30 * 60_000), null, "31 minutes old: rotate instead");
  eq(activityIfFresh(a, null, 99 * 60_000, 30 * 60_000), a, "an unknown age is not evidence of staleness");
  eq(activityIfFresh(null, 0, 0, 30 * 60_000), null, "no figures stay no figures");
}

console.log("\nthe hunt's CQ fallback, decided one window at a time");
{
  const base = { mode: "hunt", active: false, limit: 10, nobodyWindows: 0, callable: false, held: false };
  eq(cqFallbackStep({ ...base, nobodyWindows: 9 }), null, "nine empty windows: still hunting");
  eq(cqFallbackStep({ ...base, nobodyWindows: 10 }), "enter", "ten: call CQ");
  eq(cqFallbackStep({ ...base, nobodyWindows: 10, callable: true }), null, "not when this window had somebody");
  eq(cqFallbackStep({ ...base, nobodyWindows: 50, held: true }), null, "not where the dead-band brake already stopped it");
  eq(cqFallbackStep({ ...base, nobodyWindows: 50, limit: 0 }), null, "0 switches it off");
  eq(cqFallbackStep({ ...base, nobodyWindows: 50, mode: "hunt-pota" }), null, "hunt-pota never - it exists to work parks");
  eq(cqFallbackStep({ ...base, nobodyWindows: 50, mode: "cq" }), null, "and it is not a cq-mode rule");
  eq(cqFallbackStep({ ...base, active: true }), "stay", "running, nobody callable: keep calling CQ");
  eq(cqFallbackStep({ ...base, active: true, callable: true }), "leave", "somebody callable: back to hunting");
  eq(cqFallbackStep({ ...base, active: true, limit: 0 }), "leave", "switched off mid-run: stops at once");
  eq(cqFallbackStep({ ...base, active: true, mode: "hunt-pota" }), "leave", "and never survives a change to hunt-pota");
}

// ---------------------------------------------------------------------------
// The evening, replayed
// ---------------------------------------------------------------------------

/** Calling frequencies, as `callingFrequencyFor` lists them for these bands. */
const FREQ: Record<string, Record<"FT8" | "FT4", number>> = {
  "40M": { FT8: 7_074_000, FT4: 7_047_500 },
  "30M": { FT8: 10_136_000, FT4: 10_140_000 },
  "20M": { FT8: 14_074_000, FT4: 14_080_000 },
};

interface Scenario {
  start: { band: string; mode: "FT8" | "FT4" };
  autoMode: "hunt" | "hunt-pota";
  /** Messages heard each window, per "BAND MODE". Missing means nothing heard. */
  traffic: Record<string, string[]>;
  /** Callsigns already worked - the guards' own dupe rule refuses them. */
  worked: Set<string>;
  /** What PSKReporter says, per mode. */
  activity: Record<string, { band: string; transmitting: number }[]>;
  hop?: { enabled?: boolean; ft4ToFt8?: boolean; coolOffMs?: number };
  cqFallbackWindows?: number;
  /** The decoder follows the dial onto FT8, as it does with Digital mode on auto. */
  decoderFollows?: boolean;
}

interface Sent {
  message: string;
  mode: string;
  band: string;
  dial: number;
  decoder: string;
}

function evening(sc: Scenario) {
  const listeners: Record<string, ((p: unknown) => void)[]> = {};
  let band = sc.start.band;
  let mode: DigitalMode = sc.start.mode;
  let dial = FREQ[band]![sc.start.mode];
  let clock = Date.UTC(2026, 9, 24, 0, 45, 0); // 19:45 CDT
  const logs: string[] = [];
  const retunes: { band: string; mode: string; at: number }[] = [];
  const calls: { call: string; band: string; mode: string }[] = [];
  const sent: Sent[] = [];
  let active = false;

  const follows = sc.decoderFollows !== false;
  const place = (hz: number) => {
    for (const [b, m] of Object.entries(FREQ)) {
      for (const [md, f] of Object.entries(m)) if (f === hz) return { band: b, mode: md as DigitalMode };
    }
    return null;
  };

  const guards = new OperatingGuards();

  const opts = {
    source: {
      on(e: string, cb: (p: unknown) => void) {
        (listeners[e] ??= []).push(cb);
      },
      get periodMs() {
        return mode === "FT4" ? 7_500 : 15_000;
      },
      get mode() {
        return mode;
      },
    },
    tx: {
      async transmit(t: { message: string; mode: string }) {
        sent.push({ message: t.message, mode: t.mode, band, dial, decoder: mode });
        return { sent: true, timingErrorMs: 0 };
      },
      unkey() {},
    },
    guards,
    controller: {
      get hasActive() {
        return active;
      },
      get state() {
        return { theirCall: null };
      },
      async startCall(c: { theirCall: string }) {
        calls.push({ call: c.theirCall, band, mode });
        // Taken, and then over at once: the bench cares who was called, not the contact.
        return { ok: true };
      },
      startAnswer() {},
    },
    identity: { myCall: "K9XYZ", myGrid: "EN61" },
    getBandMode: () => ({ band, mode, dialHz: dial }),
    wasWorked: async (call: string) => sc.worked.has(call),
    callChecks: () => ({}),
    callingHz: (b: string, m: DigitalMode) => FREQ[b]?.[m as "FT8" | "FT4"] ?? null,
    retune: async (b: string, m: DigitalMode) => {
      const md = m === "FT4" ? "FT4" : "FT8";
      band = b;
      dial = FREQ[b]![md];
      mode = md;
      retunes.push({ band: b, mode: md, at: clock });
      return true;
    },
    tuneHz: async (hz: number) => {
      const p = place(hz);
      if (!p) return false;
      dial = hz;
      band = p.band;
      if (follows) mode = p.mode;
      retunes.push({ band: p.band, mode: p.mode, at: clock });
      return true;
    },
    bandActivity: async () => sc.activity[mode] ?? [],
    bandHop: async () => ({
      enabled: sc.hop?.enabled ?? true,
      bands: ["40M", "20M", "30M"],
      toBusiest: true,
      whenBetterRatio: 0,
      ft4ToFt8: sc.hop?.ft4ToFt8 ?? true,
      coolOffMs: sc.hop?.coolOffMs ?? 20 * 60_000,
    }),
    workedIndex: async () => emptyWorkedIndex(),
    resolveEntity: async () => null,
    huntPrefs: async () => ({ newOnly: false, minSnr: -30, cqFallbackWindows: sc.cqFallbackWindows ?? 10 }),
    potaSpots: async () => [],
    potaPrefs: async () => ({}),
    broadcast: () => {},
    log: (line: string) => logs.push(line),
  } as unknown as AutoOperatorOptions;

  const realNow = Date.now;
  Date.now = () => clock;
  const auto = new AutoOperator(opts);
  auto.setMode(sc.autoMode);

  const extra: string[][] = [];
  const window = async () => {
    const period = mode === "FT4" ? 7_500 : 15_000;
    // Aligned to the period, as real windows are, so parity means what it does on air.
    const start = Math.floor(clock / period) * period;
    // Our own transmit window carries no receive audio: nothing is decoded in it.
    const keyedHere = lastTxAt === start;
    const heard = keyedHere ? [] : [...(sc.traffic[`${band} ${mode}`] ?? []), ...(extra.shift() ?? [])];
    const decodes = heard.map((message, i) => ({ message, snr: -8, freqOffset: 800 + i * 70 }));
    const before = sent.length;
    for (const cb of listeners.decodes ?? []) cb({ windowStart: new Date(start), decodes });
    await new Promise((r) => setTimeout(r, 6));
    if (sent.length > before) lastTxAt = start + period;
    clock = start + period;
  };
  let lastTxAt = -1;

  return {
    auto,
    guards,
    logs,
    retunes,
    calls,
    sent,
    window,
    /** Queue messages to be heard in an upcoming window, on top of the band's traffic. */
    hear(messages: string[]) {
      extra.push(messages);
    },
    here: () => ({ band, mode, dial }),
    setActive(v: boolean) {
      active = v;
    },
    advance(ms: number) {
      clock += ms;
    },
    done() {
      Date.now = realNow;
    },
  };
}

const cqs = (calls: string[]) => calls.map((c) => `CQ ${c} EM10`);
const FT8_40 = cqs(["K4AAA", "K4BBB", "N4CCC", "W4DDD", "KD4EEE", "AA4FFF", "K5GGG", "N5HHH"]);
const FT8_30 = cqs(["K8AAA", "K8BBB", "N8CCC"]);
const FT8_20 = cqs(["DL1AAA", "G4BBB", "F5CCC", "EA3DDD", "I2EEE", "OH1FFF"]);
const DUPES_20 = new Set(["K1DUP", "DL1AAA", "G4BBB", "F5CCC", "EA3DDD", "I2EEE", "OH1FFF"]);
const PSK = {
  // "39 stations seen" was FT4 on 20 m - and only 20 m had any FT4 at all.
  FT4: [{ band: "20M", transmitting: 39 }],
  // On FT8 20 m is busier still, which is exactly what made the pick dangerous.
  FT8: [
    { band: "20M", transmitting: 310 },
    { band: "40M", transmitting: 140 },
    { band: "30M", transmitting: 60 },
  ],
};

async function theEvening(): Promise<void> {
  console.log("\nthe evening: 20M FT4 all dupes, 40M/30M empty on FT4, FT8 busy everywhere");
  const b = evening({
    start: { band: "20M", mode: "FT4" },
    autoMode: "hunt",
    traffic: { "20M FT4": ["CQ K1DUP EN61"], "20M FT8": FT8_20, "40M FT8": FT8_40, "30M FT8": FT8_30 },
    worked: DUPES_20,
    activity: PSK,
  });
  try {
    for (let i = 0; i < 400 && b.calls.length === 0; i++) await b.window();
    const first = b.calls[0];
    ok(first !== undefined, "a station is called", b.logs.slice(-6).join(" | "));
    eq(first?.mode, "FT8", "on FT8");
    eq(first?.band, "40M", "on 40M, where the callable stations are");
    ok(
      b.logs.some((l) => l.includes("20M FT4") && l.includes("trying 20M FT8")),
      "20M FT4 was tried on FT8 before being given up on",
    );
    ok(b.retunes.every((r) => r.mode === "FT8"), "and nothing ever went back to FT4", JSON.stringify(b.retunes));
    const back = b.retunes.filter((r, i) => i > 0 && r.band === "20M").length;
    eq(back, 0, "20M, once left, was not picked again - however busy the network says it is");
    ok(b.sent.every((s) => s.decoder === "FT8" && s.dial === FREQ[s.band]!.FT8), "every CQ went out on FT8, on the FT8 frequency");
    ok(
      b.logs.some((l) => l.includes("hunt: nobody callable on 20M FT8") && l.includes("calling CQ")),
      "with 20M FT8 all dupes the hunt called CQ there first",
    );
    ok(b.logs.some((l) => /stations seen on FT8 in the last 15 min/.test(l)), "and the busiest-band line says which mode it counted");
  } finally {
    b.done();
  }
}

async function noFallbackStillNoLoop(): Promise<void> {
  console.log("\nthe same evening with the CQ fallback off: FT8, then 40M - no loop");
  const b = evening({
    start: { band: "20M", mode: "FT4" },
    autoMode: "hunt",
    traffic: { "20M FT4": ["CQ K1DUP EN61"], "20M FT8": FT8_20, "40M FT8": FT8_40, "30M FT8": FT8_30 },
    worked: DUPES_20,
    activity: PSK,
    cqFallbackWindows: 0,
  });
  try {
    for (let i = 0; i < 400 && b.calls.length === 0; i++) await b.window();
    eq(b.calls[0]?.band, "40M", "it ends up working 40M");
    eq(b.calls[0]?.mode, "FT8", "on FT8");
    eq(b.sent.length, 0, "and with the fallback off, hunt never transmitted a CQ");
    ok(b.retunes.length <= 2, `at most two moves: 20M FT8, then 40M (${b.retunes.length})`, JSON.stringify(b.retunes));
  } finally {
    b.done();
  }
}

async function ft8OffCoolOffStillStops(): Promise<void> {
  console.log("\nFT8 rule off, nobody on FT4 anywhere: it stops hopping and calls CQ");
  // The pure ping-pong case. Every band is FT4 and empty except 20M, which is all dupes;
  // without the cool-off the busiest-band pick sent it back to 20M every four minutes.
  const b = evening({
    start: { band: "20M", mode: "FT4" },
    autoMode: "hunt",
    traffic: { "20M FT4": ["CQ K1DUP EN61"] },
    worked: DUPES_20,
    activity: PSK,
    hop: { ft4ToFt8: false },
    cqFallbackWindows: 0,
  });
  try {
    // 40 minutes of FT4 windows.
    for (let i = 0; i < 320; i++) await b.window();
    const moves = b.retunes.map((r) => r.band);
    const t0 = b.retunes[0]?.at ?? 0;
    const timeline = b.retunes.map((r) => `${r.band}@${Math.round((r.at - t0) / 60_000)}m`).join(" -> ");
    // The old code toured every four minutes: ten band changes in these forty minutes.
    // Now one tour, then it stays until the cool-off lets the bands be looked at again.
    const firstTwenty = b.retunes.filter((r) => r.at - t0 < 20 * 60_000).length;
    ok(firstTwenty <= 3, `one tour in the first 20 minutes, then it stays: ${timeline}`);
    ok(moves.length <= 6, `and at most one more once the cool-off has run out: ${timeline}`);
    const leftAt = b.retunes
      .map((r, i) => (i > 0 && b.retunes[i - 1]!.band === "20M" ? r.at : null))
      .filter((x): x is number => x !== null);
    ok(
      leftAt.every((t, i) => i === 0 || t - leftAt[i - 1]! >= 20 * 60_000),
      "20M is never abandoned twice inside its cool-off",
      timeline,
    );
    ok(
      !b.logs.some((l) => l.includes("bands in a row heard nothing")),
      "and a station that hears 20M fine is not told its receiver is dead",
    );
    ok(
      b.logs.some((l) => l.includes("cooling off or quiet")),
      "and the log says why it stopped",
    );
    ok(b.retunes.every((r) => r.mode === "FT4"), "with the rule off, FT4 is left alone");
  } finally {
    b.done();
  }
  console.log("\n...and with the CQ fallback on, it calls CQ where it stopped");
  const c = evening({
    start: { band: "20M", mode: "FT4" },
    autoMode: "hunt",
    traffic: { "20M FT4": ["CQ K1DUP EN61"] },
    worked: DUPES_20,
    activity: PSK,
    hop: { ft4ToFt8: false },
  });
  try {
    for (let i = 0; i < 320 && c.sent.length === 0; i++) await c.window();
    ok(c.sent.length > 0, "a CQ goes out", c.logs.slice(-5).join(" | "));
    ok(c.sent[0]?.message.startsWith("CQ K9XYZ") === true, "and it is our CQ", c.sent[0]?.message);
  } finally {
    c.done();
  }
}

async function pinnedDecoder(): Promise<void> {
  console.log("\na decoder that does not follow the dial: back to FT4, never transmits on the FT8 frequency");
  const b = evening({
    start: { band: "40M", mode: "FT4" },
    autoMode: "hunt",
    traffic: {},
    worked: new Set(),
    activity: PSK,
    hop: { enabled: false },
    decoderFollows: false,
  });
  try {
    for (let i = 0; i < 120; i++) await b.window();
    ok(b.logs.some((l) => l.includes("decoder stayed on FT4")), "the stuck decoder is noticed and said");
    eq(b.here().dial, FREQ["40M"]!.FT4, "the dial is back on the FT4 calling frequency");
    ok(
      b.sent.every((s) => s.dial !== FREQ[s.band]!.FT8),
      "nothing was ever sent from the FT8 frequency with an FT4 decoder",
    );
    eq(
      b.logs.filter((l) => l.includes("trying 40M FT8")).length,
      1,
      "and FT8 is not tried again this run",
    );
  } finally {
    b.done();
  }
}

async function potaNeverCqs(): Promise<void> {
  console.log("\nhunt-pota never falls back to CQ");
  const b = evening({
    start: { band: "20M", mode: "FT8" },
    autoMode: "hunt-pota",
    traffic: { "20M FT8": FT8_20 },
    worked: DUPES_20,
    activity: PSK,
    hop: { enabled: false },
  });
  try {
    for (let i = 0; i < 120; i++) await b.window();
    eq(b.sent.length, 0, "120 windows with nobody callable and not one CQ");
  } finally {
    b.done();
  }
}

async function fallbackLifecycle(): Promise<void> {
  console.log("\nthe CQ fallback ends the moment somebody is callable");
  const b = evening({
    start: { band: "20M", mode: "FT8" },
    autoMode: "hunt",
    traffic: { "20M FT8": FT8_20 },
    worked: DUPES_20,
    activity: PSK,
    hop: { enabled: false },
  });
  try {
    for (let i = 0; i < 60 && b.sent.length === 0; i++) await b.window();
    ok(b.sent.length > 0, "nobody callable: hunt calls CQ");
    ok(b.logs.some((l) => l.includes("hunt: nobody callable on 20M FT8 for 10 settled windows")), "and says so");

    // Somebody answers our CQ.
    await b.window();
    b.hear(["K9XYZ K5XYZ EM10"]);
    await b.window();
    eq(b.calls[b.calls.length - 1]?.call, "K5XYZ", "a station calling us is worked, exactly as cq mode does");
    ok(b.logs.some((l) => l.includes("leaving the CQ fallback") && l.includes("K5XYZ")), "and the fallback ends, with a reason");

    const sentBefore = b.sent.length;
    for (let i = 0; i < 6; i++) await b.window();
    eq(b.sent.length, sentBefore, "back to hunting: no CQ on the windows after");

    // A new, callable CQ appears.
    for (let i = 0; i < 20; i++) await b.window();
    ok(b.sent.length > sentBefore, "nobody again: CQ resumes");
    const callsBefore = b.calls.length;
    b.hear(["CQ VK2NEW QF56"]);
    await b.window();
    eq(b.calls.slice(callsBefore).map((c) => c.call), ["VK2NEW"], "a new CQ we may work is called");
    ok(
      b.logs.filter((l) => l.includes("leaving the CQ fallback")).length >= 2,
      "and the fallback ends again",
    );
  } finally {
    b.done();
  }

  console.log("\nthe dead-band brake still stops the CQs, and hunt keeps hunting");
  const c = evening({
    start: { band: "20M", mode: "FT8" },
    autoMode: "hunt",
    traffic: { "20M FT8": FT8_20 },
    worked: DUPES_20,
    activity: PSK,
    hop: { enabled: false },
  });
  try {
    for (let i = 0; i < 80; i++) await c.window();
    // The guard counts every listening window after a CQ against it, so its limit of
    // fifteen arrives after about eight CQs on alternate windows. Same as Auto CQ.
    ok(c.sent.length > 0 && c.sent.length <= 15, `the guard's own limit stops the CQs (${c.sent.length} sent)`);
    ok(c.logs.some((l) => l.includes("no CQ here for 30 min")), "the station says it will hunt only");
    eq(c.guards.pausedReason, null, "and is not left paused: hunting can still call the next new station");
    const n = c.sent.length;
    for (let i = 0; i < 80; i++) await c.window();
    eq(c.sent.length, n, "twenty more minutes, still no CQ on that band");
  } finally {
    c.done();
  }

  console.log("\na fault pause stops the fallback cold");
  const d = evening({
    start: { band: "20M", mode: "FT8" },
    autoMode: "hunt",
    traffic: { "20M FT8": FT8_20 },
    worked: DUPES_20,
    activity: PSK,
  });
  try {
    for (let i = 0; i < 60 && d.sent.length === 0; i++) await d.window();
    ok(d.sent.length > 0, "calling CQ");
    // A hot PA, not high SWR: an SWR trip deliberately hops band and re-arms, which is
    // its own rule. A hot PA follows the radio everywhere and needs a human.
    d.guards.onTelemetry({ swr: null, paTempC: 90, transmitting: false });
    ok(d.guards.pauseCause === "fault", "a hot PA is a fault");
    const n = d.sent.length;
    for (let i = 0; i < 40; i++) await d.window();
    eq(d.sent.length, n, "and not one CQ follows it");
  } finally {
    d.done();
  }
}

void (async () => {
  await theEvening();
  await noFallbackStillNoLoop();
  await ft8OffCoolOffStillStops();
  await pinnedDecoder();
  await potaNeverCqs();
  await fallbackLifecycle();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
})();
