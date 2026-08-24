/* eslint-disable no-console */
// Offline checks for POTA chase mode.
//
// This exists because the bug it covers cost an hour of air time and was invisible
// from the outside: the chaser was working perfectly, following the spot feed exactly
// as written, and the only symptom was a log with no new contacts in it. Every
// assertion below is a decision that looked reasonable in isolation and is wrong on
// the air:
//
//   * following a spot to any band the feed offers
//   * ignoring an audible CQ POTA because it is not in the feed yet
//   * staying on the last activator's frequency once the chase ends
//   * ordering spots by nothing but which was posted most recently
//
// The harness drives the real AutoOperator through fake radio plumbing, so the
// scheduling, the guards and the ordering under test are the shipped code paths.

import { EventEmitter } from "node:events";
import { AutoOperator, type AutoOperatorOptions, type PotaChasePrefs } from "@/services/radio/auto-operator";
import { emptyWorkedIndex, type WorkedIndex } from "@/lib/digital/worth";
import type { DigitalMode } from "@/lib/ham/digital-freqs";

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

interface Spot {
  activator: string;
  freqHz: number;
  band: string | null;
  mode: string;
  reference: string;
  parkName: string | null;
}

const DEFAULT_PREFS: PotaChasePrefs = {
  bands: null,
  giveUpMs: 90_000,
  retryMs: 30 * 60_000,
  workAudible: true,
  preferNew: true,
  returnToCalling: true,
};

interface Harness {
  op: AutoOperator;
  /** Deliver one receive window and let the operator's async work settle. */
  window(decodes: { message: string; snr: number; freqOffset: number }[]): Promise<void>;
  /** Every `slice tune` the operator asked for, in order. */
  tuned: number[];
  /** Every retune-to-calling-frequency the operator asked for. */
  retuned: { band: string; mode: DigitalMode }[];
  /** Every station the operator started calling. */
  called: string[];
  /** Set what the fake radio reports as its current band. */
  setBand(band: string | null): void;
  finishQso(): void;
  lastAction(): string | null;
  log: string[];
}

function harness(opts: {
  spots: Spot[];
  prefs?: Partial<PotaChasePrefs>;
  band?: string;
  mode?: DigitalMode;
  worked?: (i: WorkedIndex) => void;
  /** Entity lookup, so novelty ranking can be exercised without cty data. */
  entities?: Record<string, number>;
}): Harness {
  const source = new EventEmitter();
  const tuned: number[] = [];
  const retuned: { band: string; mode: DigitalMode }[] = [];
  const called: string[] = [];
  const log: string[] = [];
  let band: string | null = opts.band ?? "20M";
  const mode: DigitalMode = opts.mode ?? "FT8";
  let active = false;

  const worked = emptyWorkedIndex();
  opts.worked?.(worked);

  const options: AutoOperatorOptions = {
    source: source as unknown as AutoOperatorOptions["source"],
    tx: {} as unknown as AutoOperatorOptions["tx"],
    guards: {
      pausedReason: null,
      pauseCause: null,
      rearm() {},
      afterRxWindow() {},
      // The operator samples the antenna every window; a mock without these throws.
      get health() {
        return { swr: null, paTempC: null };
      },
      swrLimit: 3,
      async mayCall() {
        return { allowed: true };
      },
    } as unknown as AutoOperatorOptions["guards"],
    controller: {
      get hasActive() {
        return active;
      },
      async startCall({ theirCall }: { theirCall: string }) {
        called.push(theirCall);
        active = true;
        return { ok: true };
      },
      startAnswer() {},
    } as unknown as AutoOperatorOptions["controller"],
    identity: { myCall: "K9XYZ", myGrid: "EN61" },
    getBandMode: () => ({ band, mode, dialHz: null }),
    wasWorked: async () => false,
    callChecks: () => ({}),
    retune: async (b, m) => {
      retuned.push({ band: b, mode: m });
      band = b;
      return true;
    },
    bandHop: async () => ({ enabled: false, bands: [], toBusiest: false, whenBetterRatio: 0 }),
    workedIndex: async () => worked,
    resolveEntity: async (call) => {
      const adif = opts.entities?.[call];
      return adif === undefined
        ? null
        : { adif, name: `entity ${adif}`, cqZone: null, continent: null };
    },
    huntPrefs: async () => ({ newOnly: false, minSnr: -30 }),
    potaSpots: async () => opts.spots,
    tuneHz: async (hz) => {
      tuned.push(hz);
      // A real tune changes band; the fake must too, or the same-band bonus and the
      // "am I parked away from home" test would both read the wrong band.
      band = bandOf(hz);
      return true;
    },
    potaPrefs: async () => ({ ...DEFAULT_PREFS, ...opts.prefs }),
    broadcast: () => {},
    log: (line) => log.push(line),
  };

  const op = new AutoOperator(options);
  let t = 0;

  return {
    op,
    tuned,
    retuned,
    called,
    log,
    setBand: (b) => {
      band = b;
    },
    finishQso: () => {
      active = false;
    },
    lastAction: () => op.state.lastAction,
    async window(decodes) {
      t += 15_000;
      source.emit("decodes", { windowStart: new Date(t), decodes });
      // The operator's window handler is async and fire-and-forget. Draining the
      // microtask queue a few times is enough: it awaits settings, guards and the
      // worked index, none of which use timers in this harness.
      for (let i = 0; i < 20; i++) await Promise.resolve();
      // Real time has to advance, not just the promise queue. AutoOperator reads
      // Date.now() directly for the give-up timer, and a window that completes in
      // under a millisecond makes a 1 ms give-up unreachable — which looked exactly
      // like the give-up being broken.
      await new Promise((r) => setTimeout(r, 2));
    },
  };
}

/** Just enough band mapping for the frequencies used below. */
function bandOf(hz: number): string {
  const mhz = hz / 1e6;
  if (mhz < 2) return "160M";
  if (mhz < 7.5) return "40M";
  if (mhz < 14.5) return "20M";
  if (mhz < 18.5) return "17M";
  if (mhz < 21.5) return "15M";
  if (mhz < 25) return "12M";
  return "10M";
}

const spot = (activator: string, freqHz: number, mode = "FT8", reference = "US-0001"): Spot => ({
  activator,
  freqHz,
  band: bandOf(freqHz),
  mode,
  reference,
  parkName: null,
});

/** Get past the two warm-up windows a fresh mode requires. */
async function warmUp(h: Harness): Promise<void> {
  await h.window([]);
  await h.window([]);
}

async function main(): Promise<void> {
  console.log("\nband restriction");
  {
    // The live failure: 20 m was producing hundreds of decodes an hour and the chaser
    // retuned to 18.100 MHz for an Argentine park, then sat there deaf.
    const h = harness({
      spots: [spot("LW5DR", 18_100_000, "FT8", "AR-0373"), spot("KF0U", 14_074_000, "FT8", "US-6518")],
    });
    h.op.setMode("pota-chase");
    await warmUp(h);
    await h.window([{ message: "CQ K1ABC FN42", snr: -10, freqOffset: 1200 }]);

    ok(h.tuned.length === 1, "one retune", `tuned ${h.tuned.join(",")}`);
    ok(h.tuned[0] === 14_074_000, "stays on the band it started on", `went to ${h.tuned[0]}`);
  }

  {
    const h = harness({
      spots: [spot("LW5DR", 18_100_000)],
      prefs: { bands: [] }, // "any"
    });
    h.op.setMode("pota-chase");
    await warmUp(h);
    await h.window([{ message: "CQ K1ABC FN42", snr: -10, freqOffset: 1200 }]);
    ok(h.tuned[0] === 18_100_000, "\"any\" follows a spot off-band", `tuned ${h.tuned.join(",")}`);
  }

  {
    const h = harness({
      spots: [spot("KF8DZL", 21_076_000), spot("W8KFW", 18_100_000)],
      prefs: { bands: ["15M"] },
    });
    h.op.setMode("pota-chase");
    await warmUp(h);
    await h.window([{ message: "CQ K1ABC FN42", snr: -10, freqOffset: 1200 }]);
    ok(h.tuned.length === 1 && h.tuned[0] === 21_076_000, "an explicit list is honoured");
  }

  {
    // Blank must mean the band chase STARTED on, not the band we have drifted to —
    // otherwise one accepted cross-band spot silently redefines home and the
    // restriction follows the drift, one band at a time, until it means nothing.
    const h = harness({
      spots: [spot("A1AA", 14_074_000), spot("B2BB", 18_100_000), spot("C3CC", 21_074_000)],
      prefs: { giveUpMs: 1 },
    });
    h.op.setMode("pota-chase");
    await warmUp(h);
    for (let i = 0; i < 4; i++) {
      await h.window([{ message: "CQ K1ABC FN42", snr: -10, freqOffset: 1200 }]);
      h.finishQso();
    }
    ok(
      h.tuned.every((hz) => bandOf(hz) === "20M"),
      "home band cannot drift",
      `tuned ${h.tuned.map(bandOf).join(",")}`,
    );
  }

  console.log("\naudible CQ POTA");
  {
    // An activator is regularly audible before the feed catches up, and working one
    // costs no retune and no listening time. The first version ignored them entirely.
    const h = harness({ spots: [] });
    h.op.setMode("pota-chase");
    await warmUp(h);
    await h.window([{ message: "CQ POTA KB1ABC FN31", snr: -16, freqOffset: 1138 }]);

    ok(h.called[0] === "KB1ABC", "works a POTA CQ heard on frequency", `called ${h.called.join(",")}`);
    ok(h.tuned.length === 0, "without moving the dial");
  }

  {
    const h = harness({ spots: [] });
    h.op.setMode("pota-chase");
    await warmUp(h);
    await h.window([{ message: "CQ KE2UK FN30", snr: -8, freqOffset: 900 }]);
    ok(h.called.length === 0, "a plain CQ is not a POTA CQ", `called ${h.called.join(",")}`);
  }

  {
    const h = harness({ spots: [], prefs: { workAudible: false } });
    h.op.setMode("pota-chase");
    await warmUp(h);
    await h.window([{ message: "CQ POTA KB1ABC FN31", snr: -16, freqOffset: 1138 }]);
    ok(h.called.length === 0, "the setting turns it off");
  }

  console.log("\nparked, but not deaf");
  {
    // The four-hour bug, exactly as it happened. Parked on a spot whose activator
    // cannot be heard, while a never-worked activator calls CQ POTA at -6 dB on the
    // same band. The parked branch used to return before the audible path, so every
    // window went to a station that was not there.
    const h = harness({
      spots: [spot("N0SIL", 7_074_000, "FT8", "US-13515")],
      prefs: { bands: [] },
    });
    h.op.setMode("pota-chase");
    await warmUp(h);
    await h.window([{ message: "CQ K1ABC FN42", snr: -10, freqOffset: 1200 }]);
    ok(h.tuned.length === 1, "parked on the spotted activator");

    // Two warm-up windows after the retune, then the one that matters.
    await h.window([]);
    await h.window([]);
    await h.window([{ message: "CQ POTA AE2NY EN52", snr: -6, freqOffset: 1400 }]);

    ok(
      h.called.includes("AE2NY"),
      "an audible CQ POTA is worked while parked on someone silent",
      `called ${h.called.join(",") || "nobody"}`,
    );
    ok(h.tuned.length === 1, "without abandoning the frequency");
  }
  {
    // The target being audible still wins: we retuned for them, and they are the
    // reason we are on this frequency at all.
    const h = harness({
      spots: [spot("W1WNT", 7_074_000, "FT8", "US-0001")],
      prefs: { bands: [] },
    });
    h.op.setMode("pota-chase");
    await warmUp(h);
    await h.window([{ message: "CQ K1ABC FN42", snr: -10, freqOffset: 1200 }]);
    await h.window([]);
    await h.window([]);
    await h.window([
      { message: "CQ POTA K9OTH EN52", snr: -2, freqOffset: 1400 },
      { message: "CQ POTA W1WNT EN61", snr: -18, freqOffset: 900 },
    ]);
    ok(
      h.called[0] === "W1WNT",
      "the activator we retuned for is preferred, even weaker",
      `called ${h.called.join(",")}`,
    );
  }
  {
    // Taking a better option must not blacklist the one we were waiting for: nothing
    // failed with them, and they are still worth chasing.
    const h = harness({
      spots: [spot("N0SIL", 7_074_000, "FT8", "US-13515")],
      prefs: { bands: [] },
    });
    h.op.setMode("pota-chase");
    await warmUp(h);
    await h.window([{ message: "CQ K1ABC FN42", snr: -10, freqOffset: 1200 }]);
    await h.window([]);
    await h.window([]);
    await h.window([{ message: "CQ POTA AE2NY EN52", snr: -6, freqOffset: 1400 }]);
    h.finishQso();
    // Now the original target speaks up.
    await h.window([{ message: "CQ POTA N0SIL EN61", snr: -9, freqOffset: 1100 }]);
    ok(
      h.called.includes("N0SIL"),
      "and the original target is still worked when it appears",
      `called ${h.called.join(",")}`,
    );
  }

  console.log("\nreturning home");
  {
    const h = harness({
      spots: [spot("KF0U", 14_074_000, "FT8", "US-6518")],
      prefs: { giveUpMs: 1 },
    });
    h.op.setMode("pota-chase");
    await warmUp(h);

    // Chase it, then let the give-up fire with the spot now on cooldown.
    await h.window([{ message: "CQ K1ABC FN42", snr: -10, freqOffset: 1200 }]);
    h.finishQso();
    ok(h.tuned.length === 1, "parked on the activator");

    await h.window([]);
    await h.window([]);
    await h.window([]);
    ok(h.retuned.length >= 1, "comes back to the calling frequency", h.lastAction() ?? "");
    ok(h.retuned[0]?.band === "20M", "to the band it started on", h.retuned[0]?.band ?? "none");
  }

  {
    const h = harness({
      spots: [spot("KF0U", 14_074_000)],
      prefs: { giveUpMs: 1, returnToCalling: false },
    });
    h.op.setMode("pota-chase");
    await warmUp(h);
    await h.window([{ message: "CQ K1ABC FN42", snr: -10, freqOffset: 1200 }]);
    h.finishQso();
    for (let i = 0; i < 3; i++) await h.window([]);
    ok(h.retuned.length === 0, "the setting turns it off");
  }

  {
    // Never retuned away: there is nothing to come back from, and a pointless retune
    // would cost two warm-up windows of not transmitting every minute.
    const h = harness({ spots: [] });
    h.op.setMode("pota-chase");
    await warmUp(h);
    await h.window([]);
    ok(h.retuned.length === 0, "no retune when the dial never moved");
  }

  console.log("\nspot ranking");
  {
    // Freshest-first is the feed's order. A spot on the band we are already decoding
    // costs nothing to try, so it goes first regardless of age.
    const h = harness({
      spots: [spot("FRESH", 18_100_000), spot("SAMEBAND", 14_074_000)],
      prefs: { bands: [] },
    });
    h.op.setMode("pota-chase");
    await warmUp(h);
    await h.window([{ message: "CQ K1ABC FN42", snr: -10, freqOffset: 1200 }]);
    ok(h.tuned[0] === 14_074_000, "same band beats fresher", `tuned ${h.tuned[0]}`);
  }

  {
    // Both off-band, so the tiebreak is award value: an unworked entity wins.
    const h = harness({
      spots: [spot("WORKED", 18_100_000), spot("NEWDX", 21_074_000)],
      prefs: { bands: [] },
      entities: { WORKED: 291, NEWDX: 100 },
      worked: (w) => w.dxcc.add(291),
    });
    h.op.setMode("pota-chase");
    await warmUp(h);
    await h.window([{ message: "CQ K1ABC FN42", snr: -10, freqOffset: 1200 }]);
    ok(h.tuned[0] === 21_074_000, "a new entity outranks a worked one", `tuned ${h.tuned[0]}`);
  }

  {
    const h = harness({
      spots: [spot("WORKED", 18_100_000), spot("NEWDX", 21_074_000)],
      prefs: { bands: [], preferNew: false },
      entities: { WORKED: 291, NEWDX: 100 },
      worked: (w) => w.dxcc.add(291),
    });
    h.op.setMode("pota-chase");
    await warmUp(h);
    await h.window([{ message: "CQ K1ABC FN42", snr: -10, freqOffset: 1200 }]);
    ok(h.tuned[0] === 18_100_000, "with preferNew off, the feed's order stands");
  }

  console.log("\nmode and cooldown");
  {
    const h = harness({
      spots: [spot("FT4GUY", 14_080_000, "FT4"), spot("FT8GUY", 14_074_000, "FT8")],
      mode: "FT8",
    });
    h.op.setMode("pota-chase");
    await warmUp(h);
    await h.window([{ message: "CQ K1ABC FN42", snr: -10, freqOffset: 1200 }]);
    ok(h.tuned.length === 1 && h.tuned[0] === 14_074_000, "an FT8 chase ignores FT4 spots");
  }

  {
    const h = harness({
      spots: [spot("GONE", 14_074_000), spot("NEXT", 14_075_000)],
      prefs: { giveUpMs: 1 },
    });
    h.op.setMode("pota-chase");
    await warmUp(h);
    await h.window([{ message: "CQ K1ABC FN42", snr: -10, freqOffset: 1200 }]);
    h.finishQso();
    for (let i = 0; i < 4; i++) await h.window([]);
    ok(
      h.tuned.length >= 2 && h.tuned[1] === 14_075_000,
      "moves on to the next spot after giving up",
      `tuned ${h.tuned.join(",")}`,
    );
    ok(
      !h.tuned.slice(1).includes(14_074_000),
      "and does not immediately retry the one it abandoned",
    );
  }

  {
    // Chase mode must not leak into hunt mode. It borrows huntWindow to work audible
    // POTA CQs, and if the borrowed mode were left set, a chase would silently become
    // a hunt and the operator would see the wrong mode on the status line.
    const h = harness({ spots: [] });
    h.op.setMode("pota-chase");
    await warmUp(h);
    await h.window([{ message: "CQ POTA KB1ABC FN31", snr: -16, freqOffset: 1138 }]);
    ok(h.op.state.mode === "pota-chase", "mode is restored after borrowing hunt", h.op.state.mode);
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

void main();
