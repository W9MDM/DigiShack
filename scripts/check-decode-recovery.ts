/* eslint-disable no-console */
// The decoder thread recovers from a worker that stops answering or goes away.
// Run: npx tsx scripts/check-decode-recovery.ts
//
// THE FAULT (code review R06). On the 20-second timeout the caller got an empty window, but
// the worker that swallowed it stayed installed, so every later window was posted to the same
// wedged thread and timed out in its turn. A deaf station that looked alive: the window
// watchdog is fed before a decode finishes, so it never noticed. An unexpected exit with code
// 0 was ignored outright, leaving a thread that no longer existed as the one windows went to.
//
// Fake workers hang, exit and crash on cue; the real decoder cannot be made to. The last two
// sections use REAL worker threads (plain JavaScript, eval'd — what Node 20 on the box runs)
// so that terminate() and the exit event it causes are the genuine article, not a model.

import { EventEmitter } from "node:events";
import { Worker } from "node:worker_threads";

import {
  DecodeThread,
  type DecodeJob,
  type DecodeWorker,
  type DecodeWorkerReply,
} from "../lib/radio/decode-thread";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}`, extra ?? "");
  }
}

/** A worker that does only what the test tells it to. */
class FakeWorker extends EventEmitter implements DecodeWorker {
  readonly posted: number[] = [];
  terminations = 0;
  constructor(private readonly answers: boolean) {
    super();
  }
  postMessage(value: unknown): void {
    const { id } = value as { id: number };
    this.posted.push(id);
    if (this.answers) setImmediate(() => this.reply(id));
  }
  reply(id: number, msg = ""): void {
    const reply: DecodeWorkerReply = {
      id,
      ms: 1,
      decodes: msg ? [{ freq: 1500, snr: -10, dt: 0.1, msg }] : [],
    };
    this.emit("message", reply);
  }
  ref(): void {}
  unref(): void {}
  async terminate(): Promise<number> {
    this.terminations++;
    // What a real worker does after terminate(): it exits, with code 1.
    setImmediate(() => this.emit("exit", 1));
    return 1;
  }
}

function job(): DecodeJob {
  return { audio: new Float32Array(16), mode: "FT8", sampleRate: 12_000, depth: 1 };
}

/** A DecodeThread whose workers come from `plan`, in order. */
function harness(plan: boolean[], timeoutMs: number) {
  const spawned: FakeWorker[] = [];
  const logs: string[] = [];
  const thread = new DecodeThread((l) => logs.push(l), {
    timeoutMs,
    spawn: () => {
      const w = new FakeWorker(plan[spawned.length] ?? true);
      spawned.push(w);
      return w;
    },
  });
  const restarts = () => logs.filter((l) => l.includes("restarting")).length;
  return { thread, spawned, logs, restarts };
}

const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// The job timeout is unref'd in production and a fake worker's ref() holds nothing, so while
// a test waits on a fake there may be NOTHING keeping the process alive - and Node then exits
// with code 0 part way through, which reads as a pass. Hold it open, and treat ending early
// as the failure it is.
const keepAlive = setInterval(() => {}, 1_000);
let finished = false;
process.on("exit", (code) => {
  if (!finished && code === 0) {
    console.log("  FAIL the check ended before it finished");
    process.exitCode = 1;
  }
});

async function main(): Promise<void> {
  console.log("1. a worker that never answers is retired, terminated and replaced");
  {
    const h = harness([false, true], 100);
    const r1 = await h.thread.decode(job());
    check("the window comes back as a timeout", r1.error === "timeout", r1);
    check("the wedged worker is terminated", h.spawned[0]?.terminations === 1, h.spawned[0]?.terminations);
    const r2 = await h.thread.decode(job());
    check("the next window gets a FRESH worker", h.spawned.length === 2, h.spawned.length);
    check("and is decoded rather than timing out too", r2.error === undefined, r2);
    check("nothing more was posted to the wedged one", h.spawned[0]?.posted.length === 1, h.spawned[0]?.posted);
    await tick(10); // let the terminated worker's own exit event arrive
    check("our own terminate() is one restart, not a second crash", h.restarts() === 1, h.logs);
    await h.thread.close();
  }

  console.log("");
  console.log("2. windows queued behind a wedged one are failed with it, not one timeout at a time");
  {
    const h = harness([false, true], 300);
    const started = Date.now();
    const first = h.thread.decode(job());
    await tick(150);
    const secondStarted = Date.now();
    const second = h.thread.decode(job());
    const [r1, r2] = await Promise.all([first, second]);
    const secondWaited = Date.now() - secondStarted;
    check("the first times out", r1.error === "timeout", r1);
    check("the second is failed by the retirement, not its own timer", r2.error !== undefined && r2.error !== "timeout", r2);
    check(
      `and promptly: ${secondWaited} ms, against its own 300 ms timeout`,
      secondWaited < 250,
      { secondWaited, total: Date.now() - started },
    );
    await h.thread.close();
  }

  console.log("");
  console.log("3. a late answer from a retired worker is ignored, even one naming a live job");
  {
    const h = harness([false, false], 100);
    await h.thread.decode(job()); // times out; worker 0 retired
    const pending = h.thread.decode(job());
    await tick(5);
    const liveId = h.spawned[1]?.posted[0];
    check("the next window went to a fresh worker", typeof liveId === "number", h.spawned.map((w) => w.posted));
    let settled = false;
    void pending.then(() => (settled = true));
    // The retired worker finally speaks — with the id the live worker is working on. Ids
    // are never reused, but a generation check that relied on that would be no check.
    h.spawned[0]?.reply(liveId ?? -1, "LATE K1ABC FN42");
    await tick(10);
    check("the live window is not resolved by the retired worker", !settled);
    h.spawned[1]?.reply(liveId ?? -1);
    const r = await pending;
    check("it is resolved by its own worker", r.error === undefined && r.decodes.length === 0, r);
    await h.thread.close();
  }

  console.log("");
  console.log("4. an unexpected exit with code 0 fails the window at once and is replaced");
  {
    const h = harness([false, true], 5_000);
    const started = Date.now();
    const pending = h.thread.decode(job());
    await tick(5);
    h.spawned[0]?.emit("exit", 0);
    const r = await pending;
    const waited = Date.now() - started;
    check("the window is failed, not left to its 5 s timeout", waited < 1_000 && r.error !== undefined, { waited, r });
    check("and says why", (r.error ?? "").includes("code 0"), r.error);
    const next = await h.thread.decode(job());
    check("the next window gets a fresh worker and is decoded", h.spawned.length === 2 && next.error === undefined, next);
    check("one restart is counted", h.restarts() === 1, h.logs);
    await h.thread.close();
  }

  console.log("");
  console.log("5. an IDLE worker that exits cleanly is replaced on the next window");
  {
    const h = harness([true, true], 1_000);
    await h.thread.decode(job());
    h.spawned[0]?.emit("exit", 0);
    const r = await h.thread.decode(job());
    check("a fresh worker decodes it", h.spawned.length === 2 && r.error === undefined, { spawned: h.spawned.length, r });
    await h.thread.close();
  }

  console.log("");
  console.log("6. a crash (error, then exit 1) is one restart, and the next window recovers");
  {
    const h = harness([false, true], 5_000);
    const pending = h.thread.decode(job());
    await tick(5);
    h.spawned[0]?.emit("error", new Error("synthetic crash"));
    h.spawned[0]?.emit("exit", 1);
    const r = await pending;
    check("the window fails with the crash's reason", (r.error ?? "").includes("synthetic crash"), r);
    check("counted once, not once for the error and again for the exit", h.restarts() === 1, h.logs);
    const next = await h.thread.decode(job());
    check("and the next window is decoded", next.error === undefined, next);
    await h.thread.close();
  }

  console.log("");
  console.log("7. close() still means closed");
  {
    const h = harness([false], 5_000);
    const pending = h.thread.decode(job());
    await tick(5);
    await h.thread.close();
    const r = await pending;
    check("work in flight resolves as closed", r.error === "decoder closed", r);
    check("the worker is terminated", h.spawned[0]?.terminations === 1, h.spawned[0]?.terminations);
    const after = await h.thread.decode(job());
    check("and new work is refused rather than spawning", after.error === "decoder closed" && h.spawned.length === 1, after);
    await tick(10);
    check("closing is not reported as a crash", h.restarts() === 0, h.logs);
  }

  // REAL THREADS from here: the same plain-JavaScript kind decode-worker.mjs is.
  const real = (body: string) => () =>
    new Worker(`const { parentPort } = require("node:worker_threads");\n${body}`, { eval: true });
  const answering = real(`parentPort.on("message", (j) => parentPort.postMessage({ id: j.id, ms: 0, decodes: [] }));`);
  const silent = real(`parentPort.on("message", () => {});`);
  const quitter = real(`parentPort.on("message", () => process.exit(0));`);

  console.log("");
  console.log("8. a real thread that stops answering is terminated and replaced");
  {
    const logs: string[] = [];
    const queue = [silent, answering];
    const t = new DecodeThread((l) => logs.push(l), { timeoutMs: 300, spawn: () => (queue.shift() ?? answering)() });
    const r1 = await t.decode(job());
    check("the window times out", r1.error === "timeout", r1);
    const r2 = await t.decode(job());
    check("a fresh real thread decodes the next one", r2.error === undefined, r2);
    await tick(100); // the terminated thread's exit event, which must not count
    check("one restart, the real exit from terminate() ignored", logs.filter((l) => l.includes("restarting")).length === 1, logs);
    await t.close();
  }

  console.log("");
  console.log("9. a real thread that exits with code 0 mid-window");
  {
    const logs: string[] = [];
    const queue = [quitter, answering];
    const t = new DecodeThread((l) => logs.push(l), { timeoutMs: 5_000, spawn: () => (queue.shift() ?? answering)() });
    const started = Date.now();
    const r1 = await t.decode(job());
    const waited = Date.now() - started;
    check(`the window fails at the exit (${waited} ms), not at the 5 s timeout`, waited < 2_000 && (r1.error ?? "").includes("code 0"), r1);
    const r2 = await t.decode(job());
    check("and the next window is decoded by a fresh thread", r2.error === undefined, r2);
    await t.close();
  }

  console.log("");
  finished = true;
  clearInterval(keepAlive);
  if (failures > 0) {
    console.log(`${failures} failed`);
    process.exit(1);
  }
  console.log("all passed");
  process.exit(0);
}

main().catch((err: unknown) => {
  console.log("  FAIL threw:", err);
  finished = true;
  process.exit(1);
});
