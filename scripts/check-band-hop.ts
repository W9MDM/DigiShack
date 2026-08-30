/* eslint-disable no-console */
// Choosing which band to hop to.
//
// The failure this guards against is quiet: a wrong choice costs a band change and
// two dead cycles, and looks exactly like bad propagation. The rule that matters most
// is that only bands on the operator's hop list are ever considered — hopping to a
// band the antenna cannot work would strand an unattended station.

import {
  bandHasNobodyToCall,
  bandIsUnproductive,
  pickBandForSwr,
  pickBusiestBand,
  shouldHopForBetterBand,
  shouldReturnToPreviousBand,
  type BandActivity,
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
  ok(a === b, label, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

const LIST = ["40M", "20M", "30M", "80M"];

const activity = (m: Record<string, number>): BandActivity[] =>
  Object.entries(m).map(([band, transmitting]) => ({ band, transmitting }));

console.log("\npicking the busiest band");
{
  eq(
    pickBusiestBand(LIST, "40M", activity({ "20M": 500, "30M": 40, "40M": 900 })),
    "20M",
    "the busiest band that is not the current one",
  );
  eq(
    pickBusiestBand(LIST, null, activity({ "20M": 500, "40M": 900 })),
    "40M",
    "with no current band, simply the busiest",
  );
  eq(
    pickBusiestBand(LIST, "40M", activity({ "20M": 100, "30M": 100 })),
    "20M",
    "a tie breaks toward the earlier entry, so list order still means something",
  );
}

console.log("\nonly the operator's own list");
{
  // The whole point. 6 m being wide open is worth nothing to a station with no 6 m
  // antenna, and an unattended hop there is a session spent hearing nothing.
  eq(
    pickBusiestBand(LIST, "40M", activity({ "6M": 5000, "20M": 12 })),
    "20M",
    "a band NOT on the hop list is never chosen, however busy",
  );
  eq(
    pickBusiestBand(LIST, "40M", activity({ "6M": 5000 })),
    null,
    "and if the list has nothing at all, it declines rather than inventing one",
  );
}

console.log("\nfalling back to rotation");
{
  // Every null here means "no better answer than rotating", which is what the caller
  // then does. None of them may throw.
  eq(pickBusiestBand(LIST, "40M", null), null, "no data at all");
  eq(pickBusiestBand(LIST, "40M", []), null, "an empty report");
  eq(
    pickBusiestBand(LIST, "40M", activity({ "20M": 0, "30M": 0 })),
    null,
    "bands listed but nobody on them",
  );
  eq(
    pickBusiestBand(LIST, "40M", activity({ "40M": 900 })),
    null,
    "the only busy band is the one we are already on — staying put beats a pointless hop",
  );
  eq(pickBusiestBand([], "40M", activity({ "20M": 500 })), null, "an empty hop list");
}

console.log("\ninput shapes that turn up in real feeds");
{
  eq(
    pickBusiestBand(["40m", "20m"], "40m", activity({ "20M": 30 })),
    "20M",
    "case does not matter on either side",
  );
  eq(
    pickBusiestBand(LIST, "40M", [
      { band: "20M", transmitting: 10 },
      { band: "20M", transmitting: 400 },
    ]),
    "20M",
    "a band reported twice keeps the larger figure, not the last",
  );
}

console.log("\nleaving a band that works because another works better");
{
  // The rule that was missing. Hopping only ever fired on a QUIET pause, so a
  // station making contacts on 40 m at 62 stations stayed there while 20 m ran at
  // 163 — visible on the band strip, invisible to the software.
  const busy = activity({ "40M": 62, "20M": 163, "30M": 15 });

  const move = shouldHopForBetterBand({ current: "40M", bands: LIST, activity: busy, ratio: 2.5 });
  eq(move?.band, "20M", "20M at 163 against 40M at 62 clears a 2.5x bar");
  eq(move?.from, 62, "and reports where we were");
  eq(move?.to, 163, "and where we are going");

  eq(
    shouldHopForBetterBand({ current: "40M", bands: LIST, activity: busy, ratio: 3 })?.band,
    undefined,
    "at 3x it does not — 163 is not three times 62",
  );

  // Ratio, not difference: "twice as busy" has to mean the same at 30 as at 300.
  eq(
    shouldHopForBetterBand({
      current: "40M",
      bands: LIST,
      activity: activity({ "40M": 300, "20M": 380 }),
      ratio: 2.5,
    }),
    null,
    "80 more stations on a busy band is not a rout",
  );
  eq(
    shouldHopForBetterBand({
      current: "40M",
      bands: LIST,
      activity: activity({ "40M": 10, "20M": 90 }),
      ratio: 2.5,
    })?.band,
    "20M",
    "but 80 more on a quiet one is",
  );
}

console.log("\nwhen it must decline to move");
{
  const busy = activity({ "40M": 62, "20M": 163 });
  eq(
    shouldHopForBetterBand({ current: "40M", bands: LIST, activity: busy, ratio: 1 }),
    null,
    "a ratio of 1 is the off switch",
  );
  eq(
    shouldHopForBetterBand({ current: "40M", bands: LIST, activity: busy, ratio: 0 }),
    null,
    "and so is 0",
  );
  eq(
    shouldHopForBetterBand({ current: null, bands: LIST, activity: busy, ratio: 2.5 }),
    null,
    "not knowing which band we are on is not a reason to move",
  );
  eq(
    shouldHopForBetterBand({ current: "40M", bands: LIST, activity: null, ratio: 2.5 }),
    null,
    "nor is having no band report at all",
  );
  // The band we are ON reading zero almost always means the feed has no reports
  // from here yet, not that the band is empty — we are making contacts on it.
  eq(
    shouldHopForBetterBand({
      current: "17M",
      bands: ["17M", "20M"],
      activity: activity({ "20M": 163 }),
      ratio: 2.5,
    }),
    null,
    "an unmeasured current band is missing data, not evidence to move",
  );
  // 15M is not on the hop list, so however good it is the antenna may not reach it.
  eq(
    shouldHopForBetterBand({
      current: "40M",
      bands: ["40M", "30M"],
      activity: activity({ "40M": 20, "15M": 900 }),
      ratio: 2.5,
    }),
    null,
    "a band off the hop list is never a reason to leave, however busy",
  );
}

console.log("\nfinding a band the antenna will actually load");
{
  // High SWR is the one fault a band change genuinely fixes — it is antenna
  // resonance, not something that follows the radio. After the ATU has had its go
  // there is nothing left to try except somewhere else.
  const swr = (m: Record<string, number>) => new Map(Object.entries(m));

  eq(
    pickBandForSwr({
      bands: LIST,
      current: "80M",
      swrByBand: swr({ "80M": 4.2, "20M": 1.3, "30M": 2.1 }),
      limit: 3,
    }),
    "20M",
    "the band with the LOWEST measured SWR wins",
  );
  eq(
    pickBandForSwr({
      bands: LIST,
      current: "80M",
      swrByBand: swr({ "80M": 4.2, "20M": 1.3 }),
      limit: 3,
    }),
    "20M",
    "a band known good beats bands never tried",
  );
  eq(
    pickBandForSwr({ bands: LIST, current: "80M", swrByBand: swr({ "80M": 4.2 }), limit: 3 }),
    "40M",
    "with nothing measured, the first untried band on the list is worth a go",
  );

  // The antenna has already refused these. Going back would key a transmitter into
  // a load that tripped the guard once.
  eq(
    pickBandForSwr({
      bands: ["40M", "20M"],
      current: "80M",
      swrByBand: swr({ "80M": 4.2, "40M": 5.0, "20M": 3.0 }),
      limit: 3,
    }),
    null,
    "a band already measured at or above the limit is never chosen",
  );
  eq(
    pickBandForSwr({
      bands: ["80M"],
      current: "80M",
      swrByBand: swr({ "80M": 4.2 }),
      limit: 3,
    }),
    null,
    "and the band we are on is not an escape from itself",
  );
  // Everywhere refused means a feedline or a switch, not a band. Staying paused for
  // a human is the right answer.
  eq(
    pickBandForSwr({
      bands: ["40M", "20M", "80M"],
      current: "80M",
      swrByBand: swr({ "80M": 4.2, "40M": 4.0, "20M": 3.5 }),
      limit: 3,
    }),
    null,
    "nowhere left to go returns null rather than cycling forever",
  );
}

console.log("\nthe network hearing a band is not the same as US hearing it");
{
  // The correction that matters most here. PSKReporter counts what HUNDREDS of
  // receivers hear, everywhere. A band showing 163 stations worldwide can be dead
  // from one location — wrong time of day for the path, wrong angle for the aerial,
  // a local noise source. Only decodes per cycle in this receiver include us.
  const back = (hereRate: number, thereRate: number) =>
    shouldReturnToPreviousBand({ hereRate, thereRate, keepFraction: 0.6 });

  ok(back(2, 20), "hearing 2 a cycle where the old band gave 20 sends us back");
  ok(!back(18, 20), "hearing 18 against 20 does not — bands need not match");
  ok(!back(12, 20), "nor does 12, which is exactly the 0.6 bar");
  ok(back(11, 20), "just under the bar does");
  ok(!back(50, 20), "and a band that is better is obviously kept");

  // Never measured properly, so there is no evidence the move was wrong.
  ok(!back(0, 0), "with no rate for the old band, nothing is concluded");
  ok(!back(5, 0), "even when the new band is quiet");
  // A genuinely dead new band with a good old one is the clearest case of all.
  ok(back(0, 15), "hearing nothing at all where the old band gave 15 sends us back");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);

console.log("\nleaving a band that is not paying, with nothing having hopped us here");
{
  // The gap every other check missed: they all compare the band we moved TO against
  // the one we left, so a band we simply sat down on and stayed was never questioned.
  // Observed live — 20 m under two decodes a cycle for three hours at a -80 dBm noise
  // floor, while 114 receivers copied our transmit perfectly.
  const steady = (n: number, count = 40) => Array.from({ length: count }, () => n);
  const base = {
    minWindows: 40,
    decayFraction: 0.4,
    minAttempts: 8,
    minSuccess: 0.34,
  };

  // 1. Nobody answers. Measured across ~750 attempts on this station, contacts
  //    complete 48-67% of the time depending on signal — so half is NORMAL and a
  //    band has to be well under it to mean anything.
  ok(
    bandIsUnproductive({ here: { windows: steady(2), made: 1, lost: 9 }, ...base }) !== null,
    "1 contact from 10 attempts on a band hearing 2 a cycle is a band to leave",
  );
  // The lesson of this rule's first afternoon on air. It fired on 20 m at exactly
  // this ratio and moved the radio to 15 m. 20 m had been decoding ELEVEN a cycle;
  // 15 m gave two, then zero. A low completion rate on a band you can HEAR is a busy
  // band rather than a dead one — everybody is calling the same DX and 100 W does not
  // win every pileup — and contacts are lumpy where decodes arrive every cycle.
  ok(
    bandIsUnproductive({ here: { windows: steady(11), made: 2, lost: 8 }, ...base }) === null,
    "the SAME ratio on a band hearing 11 a cycle is one to stay on and keep trying",
  );
  ok(
    bandIsUnproductive({ here: { windows: steady(8), made: 5, lost: 5 }, ...base }) === null,
    "half of them completing is NORMAL here and must not trigger anything",
  );
  ok(
    bandIsUnproductive({ here: { windows: steady(8), made: 0, lost: 3 }, ...base }) === null,
    "three failures in a row is ordinary luck, not evidence",
  );

  // 2. The band fell away under us. Judged against ITSELF, because 3 decodes a cycle
  //    is a dead 20 m afternoon and a busy 160 m night.
  const faded = [...steady(12, 20), ...steady(2, 20)];
  ok(
    bandIsUnproductive({ here: { windows: faded, made: 4, lost: 4 }, ...base }) !== null,
    "decodes collapsing from 12 a cycle to 2 is the band going out",
  );
  ok(
    bandIsUnproductive({ here: { windows: steady(12), made: 4, lost: 4 }, ...base }) === null,
    "a band holding steady is left alone",
  );
  ok(
    bandIsUnproductive({
      here: { windows: [...steady(12, 5), ...steady(2, 5)], made: 4, lost: 4 },
      ...base,
    }) === null,
    "ten windows is too short a look to call a band gone",
  );

  // 3. Buried in noise. Relative to the quietest floor this station has measured
  //    anywhere — no absolute dBm means anything without knowing this receiver.
  const noisy = {
    here: { windows: steady(2), made: 3, lost: 3 },
    ...base,
    noise: { hereDbm: -80, quietestDbm: -105 },
  };
  ok(bandIsUnproductive(noisy) !== null, "a floor 25 dB up with 2 decodes a cycle is buried");
  ok(
    bandIsUnproductive({ ...noisy, noise: { hereDbm: -103, quietestDbm: -105 } }) === null,
    "the same poor decode rate on a QUIET band is just a quiet band",
  );
  // The noise is not the point — what gets through it is.
  ok(
    bandIsUnproductive({
      here: { windows: steady(14), made: 3, lost: 3 },
      ...base,
      noise: { hereDbm: -80, quietestDbm: -105 },
    }) === null,
    "a noisy band still producing 14 a cycle is one to stay on",
  );
  ok(
    bandIsUnproductive({ ...noisy, noise: { hereDbm: -80, quietestDbm: null } }) === null,
    "with nothing to compare against, noise concludes nothing",
  );
}

console.log("\nleaving a band with a trickle of decodes and NOBODY TO CALL");
{
  // THE FAULT, observed live on 30 Aug at 09:08. Settled on 17 m at 09:03 with 3
  // decodes in the window and 17 in the rolling buffer, and 0 calls, 0 contacts, 0
  // abandoned since arriving. A trickle of decodes and nobody workable satisfies
  // NEITHER existing trigger, and it is not that either of them is broken.
  const steady = (n: number, count = 40) => Array.from({ length: count }, () => n);
  const base = {
    minWindows: 40,
    decayFraction: 0.4,
    minAttempts: 8,
    minSuccess: 0.34,
  };

  // First, prove the fault. This is the fixture check-panadapter's noise model argues
  // for: a case that only tested ZERO decodes would be testing the trigger that
  // already worked — it fired correctly twice that same morning, at 07:56 and 08:40.
  ok(
    bandIsUnproductive({ here: { windows: steady(3), made: 0, lost: 0 }, ...base }) === null,
    "the OLD rules are silent on 40 windows of 3 decodes with 0 attempts — the fault",
  );
  ok(
    bandIsUnproductive({
      here: { windows: steady(3, 120), made: 0, lost: 0 },
      ...base,
      noise: { hereDbm: -103, quietestDbm: -105 },
    }) === null,
    "and stay silent for half an hour of it, because there is no ratio without attempts",
  );

  // The third trigger, on WORKABLE STATIONS rather than decodes or attempts.
  const offering = (o: Partial<Parameters<typeof bandHasNobodyToCall>[0]["here"]> = {}) => ({
    windowsWithNobody: 20,
    cqsHeard: 3,
    refused: 60,
    windows: steady(3),
    ...o,
  });

  const refused = bandHasNobodyToCall({ here: offering(), minWindows: 20 });
  ok(refused !== null, "20 windows here with nobody callable is a band to leave");
  ok(
    (refused?.reason ?? "").includes("3 stations called CQ here in 20 windows"),
    "and it says how many stations were actually heard",
    refused?.reason,
  );
  ok(
    (refused?.reason ?? "").includes("3.0 decodes a cycle"),
    "and what the band was giving us while it offered nobody",
    refused?.reason,
  );

  // Threshold in WINDOWS, so the same rule means the same thing at 15 s, 7.5 s and
  // 3.75 s. A window is one complete transmission from everybody on frequency.
  ok(
    bandHasNobodyToCall({ here: offering({ windowsWithNobody: 19 }), minWindows: 20 }) === null,
    "19 windows is not yet 20 — a band change costs two warm-up cycles",
  );
  ok(
    bandHasNobodyToCall({ here: offering(), minWindows: 0 }) === null,
    "a threshold of 0 is the off switch",
  );
  ok(
    bandHasNobodyToCall({ here: offering(), minWindows: -1 }) === null,
    "and so is anything below it",
  );

  // The three ways a band offers nobody are three different facts, and an operator
  // reading the log has to be able to tell which one they are looking at — two of
  // them are their OWN settings talking.
  const silent = bandHasNobodyToCall({
    here: offering({ cqsHeard: 0, refused: 0, windows: steady(0) }),
    minWindows: 20,
  });
  ok(
    (silent?.reason ?? "").includes("without a single CQ to answer"),
    "nobody calling CQ at all is worded as nobody calling CQ at all",
    silent?.reason,
  );
  const trickle = bandHasNobodyToCall({
    here: offering({ cqsHeard: 0, refused: 0 }),
    minWindows: 20,
  });
  ok(
    (trickle?.reason ?? "").includes("3.0 decodes a cycle"),
    "a band decoding 3 a cycle with no CQs in it still reports the 3",
    trickle?.reason,
  );
  const scored = bandHasNobodyToCall({
    here: offering({ cqsHeard: 12, refused: 0 }),
    minWindows: 20,
  });
  ok(
    (scored?.reason ?? "").includes("not one was worth calling"),
    "stations heard but none ranking (new-ones-only, the SNR floor) says so",
    scored?.reason,
  );
  ok(
    (refused?.reason ?? "").includes("every one was refused as a dupe"),
    "stations heard and refused by the guards (dupes, cooldowns) says THAT",
    refused?.reason,
  );
  const one = bandHasNobodyToCall({
    here: offering({ cqsHeard: 1, refused: 4 }),
    minWindows: 20,
  });
  ok(
    (one?.reason ?? "").includes("1 station called CQ here"),
    "one station is not 1 stations",
    one?.reason,
  );
  ok(
    (one?.reason ?? "").includes("and it was refused"),
    "nor is one station every one of them",
    one?.reason,
  );

  // `refused` counts refusals, not stations: the same dupe refused in ten windows is
  // ten. It is only ever asked whether it is zero.
  ok(
    bandHasNobodyToCall({ here: offering({ cqsHeard: 2, refused: 200 }), minWindows: 20 }) !==
      null,
    "more refusals than stations heard is normal and concludes nothing odd",
  );
}

// ---------------------------------------------------------------------------
// End to end, through the real AutoOperator
// ---------------------------------------------------------------------------
//
// The pure rules above were right and the WIRING was wrong: the return check ran at
// the end of warm-up, which is two windows, while a decode rate needs four to mean
// anything. So it asked a question whose answer was always "too early to say" and
// then never asked again — the feature could not fire at all. Testing the rule in
// isolation could never have caught that, which is why this drives the real thing.

import { AutoOperator, type AutoOperatorOptions } from "@/services/radio/auto-operator";
import { emptyWorkedIndex } from "@/lib/digital/worth";
import type { DigitalMode } from "@/lib/ham/digital-freqs";

async function endToEnd() {
  console.log("\nend to end: a band the network loves and we cannot hear");

  const listeners: Record<string, ((p: unknown) => void)[]> = {};
  const retuned: string[] = [];
  let band = "40M";
  let now = 1_000_000;

  const opts = {
    source: {
      on(e: string, cb: (p: unknown) => void) {
        (listeners[e] ??= []).push(cb);
      },
      periodMs: 15_000,
      mode: "FT8" as DigitalMode,
    },
    tx: {},
    guards: {
      pausedReason: null,
      pauseCause: null,
      rearm() {},
      rearmIfQuiet() {},
      afterRxWindow() {},
      async mayCall() {
        return { allowed: false, reason: "not calling anyone in this test" };
      },
      get health() {
        return { swr: null, paTempC: null };
      },
      swrLimit: 3,
    },
    controller: {
      get hasActive() {
        return false;
      },
      get state() {
        return { theirCall: null };
      },
      async startCall() {
        return { ok: false, reason: "no" };
      },
      startAnswer() {},
    },
    identity: { myCall: "K9XYZ", myGrid: "EN61" },
    getBandMode: () => ({ band, mode: "FT8" as DigitalMode, dialHz: null }),
    wasWorked: async () => false,
    // The same omission `check-callback-queue` had, hidden by the same
    // `as unknown as AutoOperatorOptions` cast at the end of this literal: the check died
    // with "this.o.callChecks is not a function" the moment it reached the end-to-end case,
    // which is the one it is named after. Every field of MayCallChecks is optional, so an
    // empty object is a complete stub.
    callChecks: () => ({}),
    retune: async (b: string) => {
      retuned.push(b);
      band = b;
      return true;
    },
    tuneHz: async () => true,
    // 20M looks three times busier than 40M to the whole network.
    bandActivity: async () => [
      { band: "40M", transmitting: 60 },
      { band: "20M", transmitting: 200 },
    ],
    bandHop: async () => ({
      enabled: true,
      bands: ["40M", "20M"],
      toBusiest: true,
      whenBetterRatio: 2.5,
    }),
    workedIndex: async () => emptyWorkedIndex(),
    resolveEntity: async () => null,
    huntPrefs: async () => ({ newOnly: false, minSnr: -30 }),
    potaSpots: async () => [],
    potaPrefs: async () => ({}),
    broadcast: () => {},
    log: () => {},
  } as unknown as AutoOperatorOptions;

  const auto = new AutoOperator(opts);
  auto.setMode("hunt");

  // Decodes per cycle each band really gives THIS receiver. 20M clears the old
  // flat floor comfortably and is still a quarter of what 40M was giving us —
  // which is precisely the gap the rate rule exists to close. A band under the
  // floor is already handled by the blind rotation that predates this.
  // Decodes per cycle each band really gives THIS receiver.
  //
  // 20M at 5 clears the old flat floor comfortably and is still a quarter of what
  // 40M was giving us — precisely the gap this rule exists to close. A band UNDER
  // the floor was already handled by the blind rotation that predates it.
  const RATE: Record<string, number> = { "40M": 20, "20M": 5 };
  const feed = async () => {
    const n = RATE[band] ?? 0;
    const decodes = Array.from({ length: n }, (_, i) => ({
      message: `CQ K${i}ABC EN61`,
      snr: -5,
      freqOffset: 1500 + i,
    }));
    for (const cb of listeners.decodes ?? []) cb({ windowStart: new Date(now), decodes });
    now += 15_000;
    await new Promise((r) => setTimeout(r, 4));
  };

  // 40M is genuinely working for us: 20 decodes a cycle, well measured.
  for (let i = 0; i < 8; i++) await feed();
  eq(retuned.length, 0, "a band that is working is not abandoned on its own");

  // The five-minute gate has to pass before the network figures are consulted.
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 6 * 60_000;
    await feed();
    eq(retuned[0], "20M", "the network says 20M is 3x busier, so it moves");
    eq(band, "20M", "and the radio is there");

    // ...and 20M is deaf from here. Four windows to build a real sample.
    for (let i = 0; i < 6; i++) await feed();
    eq(retuned[1], "40M", "5 a cycle against 20 clears the old floor but still goes back");
    eq(band, "40M", "the radio is home");
  } finally {
    Date.now = realNow;
  }

  // And it must not immediately bounce back to 20M on the same network figures.
  try {
    Date.now = () => realNow() + 12 * 60_000;
    for (let i = 0; i < 6; i++) await feed();
    eq(retuned.length, 2, "20M is marked deaf, so the same figures do not send us back");
  } finally {
    Date.now = realNow;
  }

}

// ---------------------------------------------------------------------------
// End to end: the trickle with nobody to call
// ---------------------------------------------------------------------------

/**
 * A whole auto operator on a bench, with one band and one kind of decode.
 *
 * Written rather than borrowed from the rig above because the interesting knobs are
 * different ones: whether `mayCall` allows anybody, and whether a contact is running.
 * The network figures are switched OFF here (`whenBetterRatio: 0`) so that nothing but
 * the rule under test can move the radio — a hop caused by PSKReporter would pass this
 * check while proving nothing.
 */
function bench(o: { allow: boolean; messages: string[] }) {
  const listeners: Record<string, ((p: unknown) => void)[]> = {};
  const retuned: string[] = [];
  const logs: string[] = [];
  let band = "17M";
  let now = 2_000_000;
  const live = { active: false };

  const opts = {
    source: {
      on(e: string, cb: (p: unknown) => void) {
        (listeners[e] ??= []).push(cb);
      },
      periodMs: 15_000,
      mode: "FT8" as DigitalMode,
    },
    tx: {},
    guards: {
      pausedReason: null,
      pauseCause: null,
      rearm() {},
      rearmIfQuiet() {},
      afterRxWindow() {},
      async mayCall(call: string) {
        return o.allow
          ? { allowed: true }
          : { allowed: false, reason: `${call} already worked on 17M FT8 — a duplicate` };
      },
      get health() {
        return { swr: null, paTempC: null };
      },
      swrLimit: 3,
    },
    controller: {
      get hasActive() {
        return live.active;
      },
      get state() {
        return { theirCall: null };
      },
      // Allowed by the guards and still refused by the transmitter. That is a fact
      // about US, and the band must not be blamed for it — see `callable` in huntWindow.
      async startCall() {
        return { ok: false, reason: "the bench never takes the transmitter" };
      },
      startAnswer() {},
    },
    identity: { myCall: "K9XYZ", myGrid: "EN61" },
    getBandMode: () => ({ band, mode: "FT8" as DigitalMode, dialHz: null }),
    wasWorked: async () => false,
    callChecks: () => ({}),
    retune: async (b: string) => {
      retuned.push(b);
      band = b;
      return true;
    },
    tuneHz: async () => true,
    bandHop: async () => ({
      enabled: true,
      bands: ["17M", "20M"],
      toBusiest: false,
      whenBetterRatio: 0,
    }),
    workedIndex: async () => emptyWorkedIndex(),
    resolveEntity: async () => null,
    huntPrefs: async () => ({ newOnly: false, minSnr: -30 }),
    potaSpots: async () => [],
    potaPrefs: async () => ({}),
    broadcast: () => {},
    log: (line: string) => logs.push(line),
  } as unknown as AutoOperatorOptions;

  const auto = new AutoOperator(opts);
  const feed = async () => {
    const decodes = o.messages.map((message, i) => ({
      message,
      snr: -8,
      freqOffset: 1200 + i * 60,
    }));
    for (const cb of listeners.decodes ?? []) cb({ windowStart: new Date(now), decodes });
    now += 15_000;
    // The window handler is fired and forgotten, and its chain is several awaits deep
    // (mayCall per candidate, then huntPrefs). A macrotask is enough to drain it.
    await new Promise((r) => setTimeout(r, 8));
  };

  return { auto, feed, retuned, logs, live, here: () => band };
}

/** Three stations calling CQ, every window, for as long as anyone listens. */
const TRICKLE = ["CQ K1ABC EN61", "CQ K2DEF FN31", "CQ K3GHI EM12"];

async function nobodyToCall() {
  console.log("\nend to end: 3 decodes a cycle, and not one of them callable");
  {
    // The 09:08 case exactly: the band IS decoding, so nothing is quiet; nobody is
    // callable, so no attempt is ever made and no success rate can ever exist.
    const b = bench({ allow: false, messages: TRICKLE });
    b.auto.setMode("hunt");

    for (let i = 0; i < 15; i++) await b.feed();
    eq(b.retuned.length, 0, "fifteen windows is not yet evidence — the radio stays put");

    for (let i = 0; i < 15; i++) await b.feed();
    eq(b.retuned[0], "20M", "past the bar it leaves, which neither old trigger could do");
    eq(b.here(), "20M", "and the radio is there");

    const line = b.logs.find((l) => l.includes("leaving 17M")) ?? "";
    ok(line.includes("stations called CQ here in"), "the log says how many were heard", line);
    ok(
      line.includes("every one was refused"),
      "and that it was the guards, not the band, that emptied it",
      line,
    );
    ok(
      line.includes("3.0 decodes a cycle are being heard"),
      "and that the band was decoding fine while it offered nobody",
      line,
    );
    ok(line.includes("trying 20M"), "and where it is going", line);
  }

  console.log("\nand it must not fire on a band that IS offering somebody");
  {
    // Same trickle, same three stations, same decode rate. The only difference is
    // that the guards allow the call — which is the whole distinction this rule
    // exists to draw, and the reason it is not a decode-rate floor.
    const b = bench({ allow: true, messages: TRICKLE });
    b.auto.setMode("hunt");
    for (let i = 0; i < 45; i++) await b.feed();
    eq(b.retuned.length, 0, "45 windows at 3 decodes a cycle, all callable, and it stays");
  }

  console.log("\na live QSO suppresses it, as the other band checks are suppressed");
  {
    const b = bench({ allow: false, messages: TRICKLE });
    b.auto.setMode("hunt");
    b.live.active = true;
    for (let i = 0; i < 45; i++) await b.feed();
    eq(b.retuned.length, 0, "45 windows spent working somebody is not 45 empty windows");
  }

  console.log("\nand a contact clears the streak, however it ended");
  {
    // The candidate fast path starts contacts without `huntWindow` ever running, so
    // the streak has to be cleared where the OUTCOME is reported or a station could
    // hop away from a band it had just worked somebody on.
    const b = bench({ allow: false, messages: TRICKLE });
    b.auto.setMode("hunt");
    for (let i = 0; i < 22; i++) await b.feed();
    eq(b.retuned.length, 0, "22 windows in, still deciding");
    b.auto.noteContactOutcome("lost");
    for (let i = 0; i < 18; i++) await b.feed();
    eq(b.retuned.length, 0, "a contact — even an abandoned one — starts the count again");
  }

  console.log("\nnothing calling CQ at all is a different sentence");
  {
    // Decodes, and not one of them a CQ: everybody on frequency is mid-QSO with
    // somebody else. Callable is about who we could CALL, not about how loud the band
    // is, and the log line has to say which of the two it found.
    const b = bench({
      allow: false,
      messages: ["K1ABC K2DEF -09", "K2DEF K1ABC R-11", "K3GHI K4JKL RR73"],
    });
    b.auto.setMode("hunt");
    for (let i = 0; i < 30; i++) await b.feed();
    eq(b.retuned[0], "20M", "a band busy with other people's contacts is still empty for us");
    const line = b.logs.find((l) => l.includes("leaving 17M")) ?? "";
    ok(
      line.includes("without a single CQ to answer"),
      "and it is worded as nobody calling, not as everybody refused",
      line,
    );
    ok(line.includes("3.0 decodes a cycle"), "with the decode rate that proves it was alive", line);
  }
}

void (async () => {
  await endToEnd();
  await nobodyToCall();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
})();
