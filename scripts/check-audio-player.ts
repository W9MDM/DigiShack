/* eslint-disable no-console */
// The browser player's start and stop leave nothing behind, and a new format restarts the stream.
// Run: npx tsx scripts/check-audio-player.ts
//
// THE FAULT (code review R16). start() built its AudioContext in a local and published it only
// after resume, worklet load and node construction had all succeeded. A failure at any of those
// escaped with the context still open — and stop() could not close it, because it had never
// been assigned. Browsers cap how many contexts a page may hold. A stop() during the worklet
// load did not stop the start either: it published its nodes afterwards, playing to nobody.
//
// Also (R08, the player's half): a hello mid-stream — the bridge switching radios — must
// rebuild the resampler at the new rate and drop the old radio's queued audio.
//
// No browser: the AudioContext and AudioWorkletNode are fakes installed as globals.

import { AudioStartCancelled, ReceiverAudio } from "../lib/client/audio-player";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}`, extra ?? "");
  }
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (e: Error) => void;
}
function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** What the next fake context does, and what every context did. */
interface Plan {
  suspended?: boolean;
  resume?: () => Promise<void>;
  addModule?: () => Promise<void>;
  noWorklet?: boolean;
  nodeThrows?: boolean;
  closeRejects?: boolean;
}
let plan: Plan = {};
const contexts: FakeContext[] = [];
const nodes: FakeNode[] = [];

class FakeContext {
  state: string;
  sampleRate = 48_000;
  closes = 0;
  destination = {};
  audioWorklet: { addModule: () => Promise<void> } | undefined;
  readonly plan = plan;
  constructor() {
    this.state = this.plan.suspended ? "suspended" : "running";
    this.audioWorklet = this.plan.noWorklet
      ? undefined
      : { addModule: this.plan.addModule ?? (async () => {}) };
    contexts.push(this);
  }
  async resume(): Promise<void> {
    await (this.plan.resume ?? (async () => {}))();
    this.state = "running";
  }
  async close(): Promise<void> {
    this.closes++;
    if (this.plan.closeRejects) throw new Error("synthetic close failure");
    this.state = "closed";
  }
  createGain() {
    return { gain: { value: 0 }, connected: 0, connect() { this.connected++; }, disconnect() {} };
  }
}

class FakeNode {
  readonly posted: unknown[] = [];
  connected = 0;
  disconnected = 0;
  port = {
    onmessage: null as unknown,
    postMessage: (m: unknown) => {
      this.posted.push(m);
    },
  };
  constructor() {
    if (plan.nodeThrows) throw new Error("synthetic node failure");
    nodes.push(this);
  }
  connect(): void {
    this.connected++;
  }
  disconnect(): void {
    this.disconnected++;
  }
}

const g = globalThis as Record<string, unknown>;
g.window = { AudioContext: FakeContext };
g.AudioWorkletNode = FakeNode;

function fresh(p: Plan): void {
  plan = p;
  contexts.length = 0;
  nodes.length = 0;
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
    return null;
  } catch (err) {
    return err;
  }
}

/** One packet of 16-bit PCM, `n` samples of a ramp. */
function pcm(n: number): ArrayBuffer {
  const b = new ArrayBuffer(n * 2);
  const v = new DataView(b);
  for (let i = 0; i < n; i++) v.setInt16(i * 2, (i * 100) % 30_000, true);
  return b;
}

async function main(): Promise<void> {
  console.log("1. a worklet that fails to load: the context is closed, the reason kept");
  {
    fresh({ addModule: async () => { throw new Error("synthetic module load failure"); } });
    const p = new ReceiverAudio();
    const err = await rejection(p.start());
    check("start rejects with the ORIGINAL error", err instanceof Error && err.message === "synthetic module load failure", err);
    check("the context it created is closed", contexts[0]?.closes === 1, contexts[0]?.closes);
    check("and the player is not playing", !p.state.playing && p.state.contextState === "closed", p.state);
    await p.stop();
    check("a stop afterwards does not close it a second time", contexts[0]?.closes === 1, contexts[0]?.closes);
  }

  console.log("");
  console.log("2. every other startup step fails just as cleanly");
  for (const [label, p0] of [
    ["resume refused", { suspended: true, resume: async () => { throw new Error("synthetic resume refusal"); } }],
    ["node construction throws", { nodeThrows: true }],
    ["no AudioWorklet (an insecure page)", { noWorklet: true }],
    ["and a close that itself fails", { addModule: async () => { throw new Error("synthetic module load failure"); }, closeRejects: true }],
  ] as const) {
    fresh(p0 as Plan);
    const p = new ReceiverAudio();
    const err = await rejection(p.start());
    const message = err instanceof Error ? err.message : String(err);
    check(`${label}: closed once, with the startup's own reason (${message})`,
      contexts[0]?.closes === 1 && err instanceof Error && !message.includes("close failure") && !(err instanceof AudioStartCancelled),
      { closes: contexts[0]?.closes, err });
  }

  console.log("");
  console.log("3. stop() during a slow worklet load wins");
  {
    const gate = deferred();
    fresh({ addModule: () => gate.promise });
    const p = new ReceiverAudio();
    const starting = rejection(p.start());
    await Promise.resolve();
    await p.stop();
    check("the context is closed at the stop, not when the load settles", contexts[0]?.closes === 1, contexts[0]?.closes);
    gate.resolve();
    const err = await starting;
    check("start rejects as cancelled", err instanceof AudioStartCancelled, err);
    check("no node was built to play to nobody", nodes.length === 0, nodes.length);
    check("nothing is published", !p.state.playing, p.state);
    check("and the context was closed once, not twice", contexts[0]?.closes === 1, contexts[0]?.closes);
  }

  console.log("");
  console.log("4. stop, then start again before the old start settles: a fresh start");
  {
    const gate = deferred();
    fresh({ addModule: () => gate.promise });
    const p = new ReceiverAudio();
    const first = rejection(p.start());
    await p.stop();
    plan = {};
    const second = p.start();
    gate.resolve();
    check("the old start is cancelled", (await first) instanceof AudioStartCancelled);
    await second;
    check("the new one plays, on a second context", p.state.playing && contexts.length === 2, { playing: p.state.playing, contexts: contexts.length });
    await p.stop();
  }

  console.log("");
  console.log("5. the gesture, and a double call");
  {
    fresh({});
    const p = new ReceiverAudio();
    const a = p.start();
    check("the AudioContext exists before start() returns (inside the click)", contexts.length === 1, contexts.length);
    const b = p.start();
    await Promise.all([a, b]);
    check("a second call joins the first: one context", contexts.length === 1, contexts.length);
    check("and it plays", p.state.playing && nodes[0]?.connected === 1, p.state);
    await p.stop();
    check("stop closes it", contexts[0]?.closes === 1 && nodes[0]?.disconnected === 1);
  }

  console.log("");
  console.log("6. R08: a new hello mid-stream restarts the format");
  {
    fresh({});
    const p = new ReceiverAudio();
    await p.start();
    const node = nodes[0]!;
    p.setSampleRate(24_000);
    for (let i = 0; i < 10; i++) p.push(pcm(128));
    const at24 = node.posted.filter((m) => m instanceof Float32Array).reduce((n, m) => n + (m as Float32Array).length, 0);
    check(`24 kHz to a 48 kHz context doubles (${at24} from 1280)`, Math.abs(at24 - 2_560) <= 2, at24);
    const before = node.posted.length;
    p.setSampleRate(48_000);
    const flushed = node.posted.slice(before).some((m) => (m as { type?: string }).type === "flush");
    check("the worklet is told to drop the old radio's queue", flushed, node.posted.slice(before));
    const mark = node.posted.length;
    for (let i = 0; i < 10; i++) p.push(pcm(128));
    const at48 = node.posted.slice(mark).filter((m) => m instanceof Float32Array).reduce((n, m) => n + (m as Float32Array).length, 0);
    check(`and 48 kHz now passes through 1:1 (${at48} from 1280)`, Math.abs(at48 - 1_280) <= 2, at48);
    check("the state reports the new rate", p.state.sampleRate === 48_000, p.state.sampleRate);
    await p.stop();
  }

  console.log("");
  if (failures > 0) {
    console.log(`${failures} failed`);
    process.exit(1);
  }
  console.log("all passed");
  process.exit(0);
}

main().catch((err: unknown) => {
  console.log("  FAIL threw:", err);
  process.exit(1);
});
