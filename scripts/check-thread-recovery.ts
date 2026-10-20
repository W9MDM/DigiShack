/* eslint-disable no-console */
// The WSPR and JS8 decoder threads recover from a worker that stops answering or goes away.
// Run: npx tsx scripts/check-thread-recovery.ts
//
// THE FAULT (code review R06, the same one check-decode-recovery covers for FT8/FT4). On the
// timeout the caller got an empty window, but the worker that swallowed it stayed installed,
// so every later window was posted to the same wedged thread and timed out in its turn. An
// unexpected exit with code 0 was ignored outright, leaving a thread that no longer existed
// as the one windows went to. All three threads now share lib/radio/worker-supervisor.ts;
// this proves the WSPR and JS8 threads are actually wired through it.
//
// Fake workers hang, exit and crash on cue. The last two sections per thread use REAL worker
// threads (plain JavaScript, eval'd - what Node 20 on the box runs) so that terminate() and
// the exit event it causes are the genuine article.

import { EventEmitter } from "node:events";
import { Worker } from "node:worker_threads";

import { Js8Thread, type Js8Worker } from "../lib/radio/js8-thread";
import { WsprThread, type WsprWorker } from "../lib/radio/wspr-thread";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}`, extra ?? "");
  }
}

/** A worker that does only what the test tells it to. Structurally both a WsprWorker and a Js8Worker. */
class FakeWorker extends EventEmitter {
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
  /** `tag` marks a reply that must never be accepted: it carries one decode. */
  reply(id: number, tag = ""): void {
    this.emit("message", { id, ms: 1, decodes: tag ? [{ tag }] : [] });
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

/** The surface both threads share, so every case runs against each. */
interface AnyThread {
  decode(audio: Float32Array, sampleRate: number): Promise<{ decodes: unknown[]; ms: number; error?: string }>;
  close(): Promise<void>;
}
type Spawn = () => EventEmitter & {
  postMessage(value: unknown, transferList?: readonly ArrayBuffer[]): void;
  ref(): void;
  unref(): void;
  terminate(): Promise<number>;
};
interface Kind {
  name: string;
  make(onLog: (l: string) => void, timeoutMs: number, spawn: Spawn): AnyThread;
}

const KINDS: Kind[] = [
  {
    name: "WSPR",
    make: (onLog, timeoutMs, spawn) => new WsprThread(onLog, { timeoutMs, spawn: spawn as unknown as () => WsprWorker }),
  },
  {
    name: "JS8",
    make: (onLog, timeoutMs, spawn) => new Js8Thread(onLog, { timeoutMs, spawn: spawn as unknown as () => Js8Worker }),
  },
];

const audio = () => new Float32Array(16);
const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A thread whose workers come from `plan`, in order. */
function harness(kind: Kind, plan: boolean[], timeoutMs: number) {
  const spawned: FakeWorker[] = [];
  const logs: string[] = [];
  const thread = kind.make((l) => logs.push(l), timeoutMs, () => {
    const w = new FakeWorker(plan[spawned.length] ?? true);
    spawned.push(w);
    return w;
  });
  const restarts = () => logs.filter((l) => l.includes("restarting")).length;
  return { thread, spawned, logs, restarts };
}

/**
 * Bounded wait. Against a thread that ignores the injected worker and its timeout (the code
 * before this fix), a decode would otherwise sit on the production 60 s timer.
 */
async function within<T>(p: Promise<T>, ms: number): Promise<T | "hung"> {
  let t: NodeJS.Timeout | undefined;
  const hung = new Promise<"hung">((r) => (t = setTimeout(() => r("hung"), ms)));
  try {
    return await Promise.race([p, hung]);
  } finally {
    clearTimeout(t);
  }
}
const err = (r: { error?: string } | "hung") => (r === "hung" ? "hung" : r.error);

// The job timeout is unref'd and a fake worker's ref() holds nothing, so while a test waits
// on a fake there may be NOTHING keeping the process alive - and Node then exits with code 0
// part way through, which reads as a pass. Hold it open, and treat ending early as failure.
const keepAlive = setInterval(() => {}, 1_000);
let finished = false;
process.on("exit", (code) => {
  if (!finished && code === 0) {
    console.log("  FAIL the check ended before it finished");
    process.exitCode = 1;
  }
});

async function cases(kind: Kind): Promise<void> {
  const n = kind.name;

  console.log(`${n} 1. a worker that never answers is retired, terminated and replaced`);
  {
    const h = harness(kind, [false, true], 100);
    const r1 = await within(h.thread.decode(audio(), 12_000), 2_000);
    check("the window comes back as a timeout", err(r1) === "timeout", r1);
    check("the wedged worker is terminated", h.spawned[0]?.terminations === 1, h.spawned[0]?.terminations);
    const r2 = await within(h.thread.decode(audio(), 12_000), 2_000);
    check("the next window gets a FRESH worker", h.spawned.length === 2, h.spawned.length);
    check("and is decoded rather than timing out too", r2 !== "hung" && r2.error === undefined, r2);
    check("nothing more was posted to the wedged one", h.spawned[0]?.posted.length === 1, h.spawned[0]?.posted);
    await tick(10); // let the terminated worker's own exit event arrive
    check("our own terminate() is one restart, not a second crash", h.restarts() === 1, h.logs);
    await h.thread.close();
  }

  console.log("");
  console.log(`${n} 2. windows queued behind a wedged one are failed with it, not one timeout at a time`);
  {
    const h = harness(kind, [false, true], 300);
    const first = h.thread.decode(audio(), 12_000);
    await tick(150);
    const secondStarted = Date.now();
    const second = h.thread.decode(audio(), 12_000);
    const [r1, r2] = await Promise.all([within(first, 2_000), within(second, 2_000)]);
    const secondWaited = Date.now() - secondStarted;
    check("the first times out", err(r1) === "timeout", r1);
    check("the second is failed by the retirement, not its own timer", r2 !== "hung" && r2.error !== undefined && r2.error !== "timeout", r2);
    check(`and promptly: ${secondWaited} ms, against its own 300 ms timeout`, secondWaited < 250, { secondWaited });
    await h.thread.close();
  }

  console.log("");
  console.log(`${n} 3. a late answer from a retired worker is ignored, even one naming a live job`);
  {
    const h = harness(kind, [false, false], 100);
    await within(h.thread.decode(audio(), 12_000), 2_000); // times out; worker 0 retired
    const pending = h.thread.decode(audio(), 12_000);
    await tick(5);
    const liveId = h.spawned[1]?.posted[0];
    check("the next window went to a fresh worker", typeof liveId === "number", h.spawned.map((w) => w.posted));
    let settled = false;
    void pending.then(() => (settled = true));
    h.spawned[0]?.reply(liveId ?? -1, "LATE");
    await tick(10);
    check("the live window is not resolved by the retired worker", !settled);
    h.spawned[1]?.reply(liveId ?? -1);
    const r = await within(pending, 2_000);
    check("it is resolved by its own worker", r !== "hung" && r.error === undefined && r.decodes.length === 0, r);
    await h.thread.close();
  }

  console.log("");
  console.log(`${n} 4. an unexpected exit with code 0 fails the window at once and is replaced`);
  {
    const h = harness(kind, [false, true], 5_000);
    const started = Date.now();
    const pending = h.thread.decode(audio(), 12_000);
    await tick(5);
    h.spawned[0]?.emit("exit", 0);
    const r = await within(pending, 2_000);
    const waited = Date.now() - started;
    check("the window is failed, not left to its timeout", waited < 1_000 && r !== "hung" && r.error !== undefined, { waited, r });
    check("and says why", (err(r) ?? "").includes("code 0"), r);
    const next = await within(h.thread.decode(audio(), 12_000), 2_000);
    check("the next window gets a fresh worker and is decoded", h.spawned.length === 2 && next !== "hung" && next.error === undefined, next);
    check("one restart is counted", h.restarts() === 1, h.logs);
    await h.thread.close();
  }

  console.log("");
  console.log(`${n} 5. an IDLE worker that exits cleanly is replaced on the next window`);
  {
    const h = harness(kind, [true, true], 1_000);
    await within(h.thread.decode(audio(), 12_000), 2_000);
    h.spawned[0]?.emit("exit", 0);
    const r = await within(h.thread.decode(audio(), 12_000), 2_000);
    check("a fresh worker decodes it", h.spawned.length === 2 && r !== "hung" && r.error === undefined, { spawned: h.spawned.length, r });
    await h.thread.close();
  }

  console.log("");
  console.log(`${n} 6. a crash (error, then exit 1) is one restart, and the next window recovers`);
  {
    const h = harness(kind, [false, true], 5_000);
    const pending = h.thread.decode(audio(), 12_000);
    await tick(5);
    h.spawned[0]?.emit("error", new Error("synthetic crash"));
    h.spawned[0]?.emit("exit", 1);
    const r = await within(pending, 2_000);
    check("the window fails with the crash's reason", (err(r) ?? "").includes("synthetic crash"), r);
    check("counted once, not once for the error and again for the exit", h.restarts() === 1, h.logs);
    const next = await within(h.thread.decode(audio(), 12_000), 2_000);
    check("and the next window is decoded", next !== "hung" && next.error === undefined, next);
    await h.thread.close();
  }

  console.log("");
  console.log(`${n} 7. close() still means closed`);
  {
    const h = harness(kind, [false], 5_000);
    const pending = h.thread.decode(audio(), 12_000);
    await tick(5);
    await h.thread.close();
    const r = await within(pending, 2_000);
    check("work in flight resolves as closed", err(r) === "decoder closed", r);
    check("the worker is terminated", h.spawned[0]?.terminations === 1, h.spawned[0]?.terminations);
    const after = await within(h.thread.decode(audio(), 12_000), 2_000);
    check("and new work is refused rather than spawning", err(after) === "decoder closed" && h.spawned.length === 1, after);
    await tick(10);
    check("closing is not reported as a crash", h.restarts() === 0, h.logs);
  }

  // REAL THREADS from here: the same plain-JavaScript kind the worker bundles are.
  const real = (body: string) => () =>
    new Worker(`const { parentPort } = require("node:worker_threads");\n${body}`, { eval: true });
  const answering = real(`parentPort.on("message", (j) => parentPort.postMessage({ id: j.id, ms: 0, decodes: [] }));`);
  const silent = real(`parentPort.on("message", () => {});`);
  const quitter = real(`parentPort.on("message", () => process.exit(0));`);

  console.log("");
  console.log(`${n} 8. a real thread that stops answering is terminated and replaced`);
  {
    const logs: string[] = [];
    const queue = [silent, answering];
    const t = kind.make((l) => logs.push(l), 300, () => (queue.shift() ?? answering)());
    const r1 = await within(t.decode(audio(), 12_000), 3_000);
    check("the window times out", err(r1) === "timeout", r1);
    const r2 = await within(t.decode(audio(), 12_000), 3_000);
    check("a fresh real thread decodes the next one", r2 !== "hung" && r2.error === undefined, r2);
    await tick(100); // the terminated thread's exit event, which must not count
    check("one restart, the real exit from terminate() ignored", logs.filter((l) => l.includes("restarting")).length === 1, logs);
    await t.close();
  }

  console.log("");
  console.log(`${n} 9. a real thread that exits with code 0 mid-window`);
  {
    const queue = [quitter, answering];
    const t = kind.make(() => {}, 5_000, () => (queue.shift() ?? answering)());
    const started = Date.now();
    const r1 = await within(t.decode(audio(), 12_000), 3_000);
    const waited = Date.now() - started;
    check(`the window fails at the exit (${waited} ms), not at the timeout`, waited < 2_000 && (err(r1) ?? "").includes("code 0"), r1);
    const r2 = await within(t.decode(audio(), 12_000), 3_000);
    check("and the next window is decoded by a fresh thread", r2 !== "hung" && r2.error === undefined, r2);
    await t.close();
  }
  console.log("");
}

async function main(): Promise<void> {
  for (const kind of KINDS) await cases(kind);
  finished = true;
  clearInterval(keepAlive);
  if (failures > 0) {
    console.log(`${failures} failed`);
    process.exit(1);
  }
  console.log("all passed");
  process.exit(0);
}

main().catch((e: unknown) => {
  console.log("  FAIL threw:", e);
  finished = true;
  process.exit(1);
});
