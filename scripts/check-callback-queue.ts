/* eslint-disable no-console */
// Calling back the people who called us mid-contact.
//
// A tail-ender used to be dropped outright: the auto operator hands the transmitter
// to the QSO controller for the duration of a contact and returned before ever
// looking at the decodes, so somebody calling into the gap was heard, ignored, and
// never called back. On a busy band that is the commonest way to lose a contact that
// was offered to you.
//
// Everything here decides who gets TRANSMITTED to, so the rules are pinned: the
// station we are already working must never be queued as a caller, the queue is
// served oldest-first, a station the guards refuse must not block the ones behind
// it, and nobody is called back from so long ago that they have gone.

import { AutoOperator, type AutoOperatorOptions } from "@/services/radio/auto-operator";
import { emptyWorkedIndex } from "@/lib/digital/worth";
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
function eqArr(a: unknown[], b: unknown[], label: string): void {
  ok(JSON.stringify(a) === JSON.stringify(b), label, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

const PERIOD = 15_000;

interface Harness {
  auto: AutoOperator;
  called: string[];
  /** Feed one receive window. */
  window(messages: { message: string; snr: number; freqOffset: number }[], at: number): Promise<void>;
  /** Feed the two warm-up windows so the operator will transmit. */
  settle(from: number): Promise<void>;
  setActive(v: boolean): void;
  setWorking(call: string | null): void;
  refuse(calls: string[]): void;
}

function harness(): Harness {
  const listeners: Record<string, ((p: unknown) => void)[]> = {};
  const source = {
    on(event: string, cb: (p: unknown) => void) {
      (listeners[event] ??= []).push(cb);
    },
    periodMs: PERIOD,
    mode: "FT8" as DigitalMode,
  };
  const called: string[] = [];
  let active = false;
  let working: string | null = null;
  let refused: string[] = [];

  const options: AutoOperatorOptions = {
    source: source as unknown as AutoOperatorOptions["source"],
    tx: {} as unknown as AutoOperatorOptions["tx"],
    guards: {
      pausedReason: null,
      pauseCause: null,
      rearm() {},
      rearmIfQuiet() {},
      afterRxWindow() {},
      // The operator samples the antenna every window; a mock without these throws.
      get health() {
        return { swr: null, paTempC: null };
      },
      swrLimit: 3,
      async mayCall(call: string) {
        return refused.includes(call)
          ? { allowed: false, reason: "worked already" }
          : { allowed: true };
      },
    } as unknown as AutoOperatorOptions["guards"],
    controller: {
      get hasActive() {
        return active;
      },
      get state() {
        return { theirCall: working };
      },
      async startCall({ theirCall }: { theirCall: string }) {
        called.push(theirCall);
        active = true;
        working = theirCall;
        return { ok: true };
      },
      startAnswer() {},
    } as unknown as AutoOperatorOptions["controller"],
    identity: { myCall: "K9XYZ", myGrid: "EN61" },
    getBandMode: () => ({ band: "20M", mode: "FT8" as DigitalMode, dialHz: null }),
    wasWorked: async () => false,
    // Required by the operator, and absent here — which the `as unknown as
    // AutoOperatorOptions` cast at the end of this literal hid from the compiler. The
    // result was a check that passed its first three assertions and then died with
    // "this.o.callChecks is not a function" the moment it reached callBackWaiting, i.e.
    // the moment it tested the thing it is named after. Every field of MayCallChecks is
    // optional, so an empty object is a complete stub.
    callChecks: () => ({}),
    retune: async () => true,
    tuneHz: async () => true,
    bandHop: async () => ({ enabled: false, bands: [], toBusiest: false, whenBetterRatio: 0 }),
    workedIndex: async () => emptyWorkedIndex(),
    resolveEntity: async () => null,
    huntPrefs: async () => ({ newOnly: false, minSnr: -30 }),
    potaSpots: async () => [],
    potaPrefs: async () => ({}) as never,
    broadcast: () => {},
    log: () => {},
  } as unknown as AutoOperatorOptions;

  const auto = new AutoOperator(options);
  auto.setMode("hunt");

  const feed = async (messages: ReturnType<typeof dm>[], at: number) => {
    for (const cb of listeners.decodes ?? []) {
      cb({ windowStart: new Date(at), decodes: messages });
    }
    // The handler is async inside the emitter; let it settle.
    await new Promise((r) => setTimeout(r, 5));
  };

  return {
    auto,
    called,
    async window(messages, at) {
      await feed(messages, at);
    },
    /**
     * Burn off the warm-up windows.
     *
     * Enabling a mode makes the operator listen for two windows before it will
     * transmit on what may be a fresh band. That is a real safety property and not
     * something to weaken for a test — but a contact ends many windows later, so in
     * practice warm-up is long over before anyone is called back. Feeding the two
     * windows here puts the harness in the state a real session is actually in.
     */
    async settle(from: number) {
      await feed([], from);
      await feed([], from + PERIOD);
    },
    setActive(v) {
      active = v;
      if (!v) working = null;
    },
    setWorking(c) {
      working = c;
    },
    refuse(c) {
      refused = c;
    },
  };
}

const dm = (message: string, snr = -5, freqOffset = 1500) => ({ message, snr, freqOffset });

async function main() {
  console.log("\nsomeone calls while we are busy");
  {
    const h = harness();
    await h.settle(900_000);
    h.setActive(true);
    h.setWorking("K1AAA");

    // K1AAA is the contact in progress; K2BBB is a tail-ender.
    await h.window([dm("K9XYZ K1AAA -12"), dm("K9XYZ K2BBB EN61")], 1_000_000);
    eqArr(h.auto.state.waiting, ["K2BBB"], "the tail-ender is queued");
    ok(
      !h.auto.state.waiting.includes("K1AAA"),
      "the station we are ALREADY working is not queued as a caller",
    );
    eqArr(h.called, [], "and nothing is transmitted while the contact is running");

    // Contact ends: the queue is worked before hunting for anyone new.
    h.setActive(false);
    await h.window([dm("CQ K9NEW EN52")], 1_015_000);
    eqArr(h.called, ["K2BBB"], "they are called back as soon as the transmitter is free");
    eqArr(h.auto.state.waiting, [], "and leave the queue");
  }

  console.log("\nseveral callers, oldest first");
  {
    const h = harness();
    await h.settle(900_000);
    h.setActive(true);
    h.setWorking("K1AAA");
    await h.window([dm("K9XYZ K2BBB EN61")], 1_000_000);
    await h.window([dm("K9XYZ K3CCC EN61")], 1_015_000);
    await h.window([dm("K9XYZ K4DDD EN61")], 1_030_000);
    eqArr(h.auto.state.waiting, ["K2BBB", "K3CCC", "K4DDD"], "queued in the order they called");

    // Calling again must not send someone to the back — they have waited LONGER.
    await h.window([dm("K9XYZ K2BBB EN61")], 1_045_000);
    eqArr(h.auto.state.waiting, ["K2BBB", "K3CCC", "K4DDD"], "a repeat call keeps its place");

    h.setActive(false);
    await h.window([], 1_060_000);
    eqArr(h.called, ["K2BBB"], "the longest waiter is worked first");
  }

  console.log("\na caller the guards refuse must not block the queue");
  {
    const h = harness();
    await h.settle(900_000);
    h.setActive(true);
    h.setWorking("K1AAA");
    await h.window([dm("K9XYZ K2DUPE EN61"), dm("K9XYZ K3CCC EN61")], 1_000_000);
    eqArr(h.auto.state.waiting, ["K2DUPE", "K3CCC"], "both queued");

    // K2DUPE turns out to be a dupe by the time we get to them.
    h.refuse(["K2DUPE"]);
    h.setActive(false);
    await h.window([], 1_015_000);
    eqArr(h.called, ["K3CCC"], "the refused caller is skipped and the next one worked");
    eqArr(h.auto.state.waiting, [], "neither is left stuck at the head of the queue");
  }

  console.log("\nnobody waits forever");
  {
    const h = harness();
    await h.settle(900_000);
    h.setActive(true);
    h.setWorking("K1AAA");
    await h.window([dm("K9XYZ K2OLD EN61")], 1_000_000);
    eqArr(h.auto.state.waiting, ["K2OLD"], "queued");

    // Eleven minutes later they have worked someone else or changed band, and
    // calling into empty air costs a full give-up period of unanswered transmissions.
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 11 * 60_000;
      h.setActive(false);
      await h.window([], 1_015_000);
      eqArr(h.called, [], "a stale caller is not called back");
      eqArr(h.auto.state.waiting, [], "and is dropped from the queue");
    } finally {
      Date.now = realNow;
    }
  }

  console.log("\nchanging mode clears the queue");
  {
    const h = harness();
    await h.settle(900_000);
    h.setActive(true);
    h.setWorking("K1AAA");
    await h.window([dm("K9XYZ K2BBB EN61")], 1_000_000);
    eqArr(h.auto.state.waiting, ["K2BBB"], "queued");
    // Turning the automation off, or moving band via chase, means anyone waiting was
    // waiting for operating that has now ended.
    h.auto.setMode("off");
    eqArr(h.auto.state.waiting, [], "switching mode drops them rather than calling later");
  }

  console.log("\nthe operator names a station while a contact is running");
  {
    const h = harness();
    await h.settle(900_000);
    h.setActive(true);
    h.setWorking("K1AAA");

    // Two tail-enders arrive on their own; the machine picked both.
    await h.window([dm("K9XYZ K2BBB EN61"), dm("K9XYZ K3CCC EN61")], 1_000_000);
    eqArr(h.auto.state.waiting, ["K2BBB", "K3CCC"], "both queued in the order they called");

    // The operator presses Call on a decode. A person chose this one, so it goes to the
    // FRONT — ahead of stations that arrived unbidden. This is the whole difference
    // between the queue and what the button used to do, which was nothing.
    h.auto.queueOperatorCall({
      call: "K9WANT",
      grid: "EN52",
      snr: -8,
      offsetHz: 1200,
      windowStart: 1_000_000,
      message: "CQ K9WANT EN52",
    });
    eqArr(
      h.auto.state.waiting,
      ["K9WANT", "K2BBB", "K3CCC"],
      "the operator's choice goes to the front, not the back",
    );
    eqArr(h.called, [], "and nothing is transmitted while the contact is still running");

    // Pressing Call twice promotes rather than queueing them behind themselves.
    h.auto.queueOperatorCall({
      call: "K3CCC",
      grid: null,
      snr: -8,
      offsetHz: 1200,
      windowStart: 1_000_000,
      message: "",
    });
    eqArr(
      h.auto.state.waiting,
      ["K3CCC", "K9WANT", "K2BBB"],
      "a second request promotes rather than duplicating",
    );

    h.setActive(false);
    await h.window([], 1_015_000);
    eqArr(h.called, ["K3CCC"], "the operator's station is worked first when the air is free");
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

void main();
