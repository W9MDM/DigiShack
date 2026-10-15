/* eslint-disable no-console */
// The JS8 sender: one frame per window, in order, at one offset, stopping at the first
// refusal. Driven with a fake clock and fake timers, so every window boundary here is a
// number and not a wait.

import type { Js8OutFrame } from "@/lib/digital/js8-message";
import { JS8_ARM_MS, JS8_LEAD_MS, Js8Sender, type Js8SendResult, type Js8SenderState } from "@/lib/radio/js8-sender";
import { PERIOD_MS } from "@/lib/radio/timing";

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  ok    ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
function eq<T>(got: T, want: T, label: string): void {
  ok(got === want, label, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

const PERIOD = PERIOD_MS.JS8;
/** A boundary, chosen so the arithmetic below reads: 15:00:00Z on the day JS8 first decoded here. */
const BOUNDARY = Date.UTC(2026, 9, 15, 15, 0, 0);

/** A fake clock and a timer queue the sender runs against. */
function harness(opts: { startAt: number; results?: (Js8SendResult | Error)[]; txMs?: number }) {
  let clock = opts.startAt;
  const timers: { id: number; at: number; fn: () => void }[] = [];
  let nextId = 1;
  const sends: { index: number; windowStart: number; frame: string }[] = [];
  const progress: Js8SenderState[] = [];
  const results = opts.results ?? [];
  const sender = new Js8Sender({
    now: () => clock,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.push({ id, at: clock + ms, fn });
      return id;
    },
    clearTimer: (id) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    send: async (frame, index, windowStart) => {
      sends.push({ index, windowStart, frame: frame.frame });
      // The transmitter resolves after the frame has gone out: 0.5 s in, 12.64 s long.
      clock = windowStart + (opts.txMs ?? 13_200);
      const r = results[index] ?? { sent: true };
      if (r instanceof Error) throw r;
      return r;
    },
    onProgress: (s) => progress.push(s),
  });
  /** Advance the clock, running every timer that comes due on the way, then let promises settle. */
  const runTo = async (t: number): Promise<void> => {
    for (;;) {
      const due = timers.filter((x) => x.at <= t).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      clock = Math.max(clock, due.at);
      due.fn();
      await new Promise<void>((r) => setImmediate(r));
    }
    clock = Math.max(clock, t);
    await new Promise<void>((r) => setImmediate(r));
  };
  return { sender, timers, sends, progress, runTo, clock: () => clock };
}

const frames = (n: number): Js8OutFrame[] =>
  Array.from({ length: n }, (_, i) => ({ frame: `FRAME${i + 1}`.padEnd(12, " "), txType: i === 0 ? 1 : i === n - 1 ? 2 : 0 }));

async function main(): Promise<void> {
  console.log("\nwhich window a message starts in");
  {
    const h = harness({ startAt: BOUNDARY + 5_000 });
    const r = h.sender.start("HELLO", frames(3));
    ok(r.ok, "a message starts");
    if (r.ok) {
      eq(r.firstWindow, BOUNDARY + PERIOD, "five seconds past a boundary, the first frame goes in the next window");
      eq(r.frames, 3, "and the reply says how many frames");
      eq(r.durationMs, 3 * PERIOD, "and how long they take: a window each");
    }
    eq(h.timers.length, 1, "one timer is armed");
    eq(h.timers[0]!.at, BOUNDARY + PERIOD - JS8_ARM_MS, "for two seconds before that boundary: the transmitter waits the rest");
    const s = h.sender.current;
    ok(s.sending && s.frames === 3 && s.sent === 0 && s.text === "HELLO", "the state says so", JSON.stringify(s));
    eq(s.nextWindow, BOUNDARY + PERIOD, "with the next window");
  }
  {
    const h = harness({ startAt: BOUNDARY + PERIOD - JS8_LEAD_MS + 1 });
    const r = h.sender.start("LATE", frames(1));
    ok(r.ok && r.firstWindow === BOUNDARY + 2 * PERIOD, "asked for inside the lead, it waits for the window after");
  }
  {
    const h = harness({ startAt: BOUNDARY + PERIOD - JS8_LEAD_MS });
    const r = h.sender.start("JUST", frames(1));
    ok(r.ok && r.firstWindow === BOUNDARY + PERIOD, "asked for exactly a lead before the boundary, it takes that boundary");
  }
  {
    const h = harness({ startAt: BOUNDARY });
    ok(!h.sender.start("", []).ok, "nothing to send is refused");
  }

  console.log("\nframes go out one per window, in order, and the message finishes");
  {
    const h = harness({ startAt: BOUNDARY + 5_000 });
    h.sender.start("THREE", frames(3));
    const first = BOUNDARY + PERIOD;
    await h.runTo(first - JS8_ARM_MS);
    eq(h.sends.length, 1, "at the arm time the first frame is handed to the transmitter");
    eq(h.sends[0]!.index, 0, "frame one");
    eq(h.sends[0]!.windowStart, first, "for the first window");
    eq(h.sender.current.sent, 1, "once it is out the count says one");
    eq(h.sender.current.nextWindow, first + PERIOD, "and the next window is the one after");
    eq(h.timers.length, 1, "the second frame is armed");
    // The frame before ends 13.2 s into its window, inside the two-second lead the next one
    // would get from an idle start; the next is armed the moment the transmitter is free.
    eq(h.timers[0]!.at, first + 13_200, "the moment the frame before has gone out, since that is already inside the lead");
    await h.runTo(first + 2 * PERIOD);
    eq(h.sends.length, 3, "all three frames went");
    eq(h.sends.map((s) => s.windowStart).join(","), [first, first + PERIOD, first + 2 * PERIOD].join(","), "in consecutive windows");
    eq(h.sends.map((s) => s.index).join(","), "0,1,2", "in order");
    const s = h.sender.current;
    ok(!s.sending && s.sent === 3 && s.stopped === null && s.nextWindow === null, "then the sender is idle and nothing stopped it", JSON.stringify(s));
    eq(h.timers.length, 0, "with no timer left");
    ok(h.progress.length >= 4, "progress was reported along the way", `${h.progress.length} reports`);
  }

  console.log("\na refusal stops the message: no tail without its head");
  {
    const h = harness({ startAt: BOUNDARY + 5_000, results: [{ sent: true }, { sent: false, reason: "Transmit is disabled" }] });
    h.sender.start("THREE", frames(3));
    await h.runTo(BOUNDARY + 3 * PERIOD);
    eq(h.sends.length, 2, "the second frame was asked for and refused; the third never was");
    const s = h.sender.current;
    ok(!s.sending, "the sender is idle");
    eq(s.sent, 1, "one frame went");
    ok((s.stopped ?? "").includes("frame 2 of 3") && (s.stopped ?? "").includes("Transmit is disabled"), "and the state says which frame and why", s.stopped ?? "");
    eq(h.timers.length, 0, "no timer left");
  }
  {
    const h = harness({ startAt: BOUNDARY + 5_000, results: [new Error("socket closed")] });
    h.sender.start("ONE", frames(2));
    await h.runTo(BOUNDARY + 2 * PERIOD);
    eq(h.sends.length, 1, "a transmitter that throws is a refusal");
    ok((h.sender.current.stopped ?? "").includes("socket closed"), "with the error as the reason", h.sender.current.stopped ?? "");
  }

  console.log("\ncancel, and a second message while one is going");
  {
    const h = harness({ startAt: BOUNDARY + 5_000 });
    h.sender.start("THREE", frames(3));
    const second = h.sender.start("OTHER", frames(1));
    ok(!second.ok && /already sending/.test(second.ok ? "" : second.reason), "a second message while one is going is refused", second.ok ? "" : second.reason);
    await h.runTo(BOUNDARY + PERIOD - JS8_ARM_MS);
    eq(h.sends.length, 1, "the first frame is out");
    ok(h.sender.cancel(), "cancel while the second is armed");
    eq(h.timers.length, 0, "clears the timer");
    const s = h.sender.current;
    ok(!s.sending && s.stopped === "cancelled after 1 of 3 frames", "and says where it stopped", s.stopped ?? "");
    await h.runTo(BOUNDARY + 4 * PERIOD);
    eq(h.sends.length, 1, "nothing more goes out");
    ok(!h.sender.cancel(), "cancel when idle does nothing");
    const again = h.sender.start("AGAIN", frames(1));
    ok(again.ok, "and a new message can start after a cancel");
  }
  {
    // Cancelled while a frame is on the air: that frame finishes, its result is dropped.
    const h = harness({ startAt: BOUNDARY + 5_000 });
    h.sender.start("TWO", frames(2));
    const sendsBefore = h.sends.length;
    const timer = h.timers[0]!;
    h.timers.splice(0, 1);
    timer.fn();
    // The fake transmitter resolved at once; cancel before the sender's continuation runs.
    h.sender.cancel();
    await h.runTo(BOUNDARY + 3 * PERIOD);
    eq(h.sends.length - sendsBefore, 1, "the frame on the air went; the second never did");
    ok(!h.sender.current.sending && (h.sender.current.stopped ?? "").startsWith("cancelled"), "and the state is the cancel's, not the frame's");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
