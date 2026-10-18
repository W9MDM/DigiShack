/* eslint-disable no-console */
// Pat supervisor check (offline, no real Pat, no real timers). Drives the lifecycle state
// machine with a fake child process and injected health-probe/sleep: loopback enforcement,
// readiness waiting, ready-timeout, clean stop, and bounded auto-restart on crash.

import {
  assertLoopback,
  PatSupervisor,
  type PatSupervisorConfig,
  type SpawnedProcess,
  type SpawnFn,
} from "@/services/winlink/pat-supervisor";

let pass = 0;
let fail = 0;
function ok(label: string, cond: boolean): void {
  if (cond) {
    pass++;
    console.log(`  ok    ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}`);
  }
}
const safe = (fn: () => void): boolean => {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
};
const throwsErr = (fn: () => void): boolean => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};
async function expectThrow(fn: () => Promise<unknown>, label: string): Promise<void> {
  try {
    await fn();
    ok(`${label} (did not throw)`, false);
  } catch {
    ok(label, true);
  }
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

class FakeProc implements SpawnedProcess {
  killed = false;
  killSignal: string | null = null;
  private exitListener: ((code: number | null) => void) | null = null;
  constructor(readonly pid: number) {}
  on(event: "exit", listener: (code: number | null) => void): void {
    if (event === "exit") this.exitListener = listener;
  }
  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
    this.killSignal = signal ?? "SIGTERM";
    return true;
  }
  emitExit(code: number | null): void {
    this.exitListener?.(code);
  }
}

function recordingSpawn(): { procs: FakeProc[]; spawnImpl: SpawnFn; last: () => FakeProc } {
  const procs: FakeProc[] = [];
  let n = 0;
  const spawnImpl: SpawnFn = () => {
    const p = new FakeProc(1000 + ++n);
    procs.push(p);
    return p;
  };
  return { procs, spawnImpl, last: () => procs[procs.length - 1]! };
}

const probeAlwaysTrue = async (): Promise<boolean> => true;
const probeAlwaysFalse = async (): Promise<boolean> => false;
function probeReadyOnCall(target: number): () => Promise<boolean> {
  let c = 0;
  return async () => (++c >= target);
}
const noSleep = async (): Promise<void> => {};

const cfg: PatSupervisorConfig = {
  binary: "/opt/winlink/engine/pat-1.0.0/pat",
  configPath: "/opt/winlink/data/config.json",
  mbox: "/opt/winlink/data/mailbox",
  httpAddr: "127.0.0.1:8049",
  mycall: "K9XYZ",
};

async function main(): Promise<void> {
  console.log("\nloopback guard");
  ok("accepts 127.0.0.1:8049", safe(() => assertLoopback("127.0.0.1:8049")));
  ok("accepts localhost:8049", safe(() => assertLoopback("localhost:8049")));
  ok("accepts [::1]:8049", safe(() => assertLoopback("[::1]:8049")));
  ok("rejects 0.0.0.0:8049", throwsErr(() => assertLoopback("0.0.0.0:8049")));
  ok("rejects 192.0.2.1:8049", throwsErr(() => assertLoopback("192.0.2.1:8049")));
  ok("constructor rejects non-loopback", throwsErr(() => new PatSupervisor({ ...cfg, httpAddr: "0.0.0.0:8049" })));

  console.log("\nbuildArgs");
  const argSup = new PatSupervisor(cfg, { spawnImpl: recordingSpawn().spawnImpl, healthProbe: probeAlwaysTrue, sleepImpl: noSleep });
  const args = argSup.buildArgs();
  ok("has --config <path>", args[args.indexOf("--config") + 1] === cfg.configPath);
  ok("has --mbox <path>", args[args.indexOf("--mbox") + 1] === cfg.mbox);
  ok("binds http to loopback addr", args.includes("http") && args[args.indexOf("--addr") + 1] === cfg.httpAddr);

  console.log("\nstart -> ready");
  const r1 = recordingSpawn();
  const s1 = new PatSupervisor(cfg, { spawnImpl: r1.spawnImpl, healthProbe: probeReadyOnCall(3), sleepImpl: noSleep, readyTimeoutMs: 5000, pollIntervalMs: 100 });
  await s1.start();
  ok("running after start", s1.getState().running);
  ok("ready after probe succeeds", s1.getState().ready);
  ok("pid reflects spawned child", s1.getState().pid === r1.procs[0]!.pid);
  ok("spawned exactly once", r1.procs.length === 1);

  console.log("\nready timeout");
  const s2 = new PatSupervisor(cfg, { spawnImpl: recordingSpawn().spawnImpl, healthProbe: probeAlwaysFalse, sleepImpl: noSleep, readyTimeoutMs: 300, pollIntervalMs: 100 });
  await expectThrow(() => s2.start(), "start throws when never ready");

  console.log("\nexit without auto-restart");
  const r3 = recordingSpawn();
  const s3 = new PatSupervisor(cfg, { spawnImpl: r3.spawnImpl, healthProbe: probeAlwaysTrue, sleepImpl: noSleep, autoRestart: false });
  await s3.start();
  r3.last().emitExit(1);
  ok("running false after exit", !s3.getState().running);
  ok("lastExitCode recorded", s3.getState().lastExitCode === 1);
  ok("no respawn", r3.procs.length === 1);

  console.log("\nauto-restart on crash");
  const r4 = recordingSpawn();
  const s4 = new PatSupervisor(cfg, { spawnImpl: r4.spawnImpl, healthProbe: probeAlwaysTrue, sleepImpl: noSleep, autoRestart: true, restartDelayMs: 1, maxRestarts: 3 });
  await s4.start();
  r4.last().emitExit(1);
  await tick();
  ok("respawned after crash", r4.procs.length === 2);
  ok("restart counter incremented", s4.getState().restarts === 1);
  ok("running again", s4.getState().running);
  ok("ready again", s4.getState().ready);

  console.log("\nstop is final");
  const r5 = recordingSpawn();
  const s5 = new PatSupervisor(cfg, { spawnImpl: r5.spawnImpl, healthProbe: probeAlwaysTrue, sleepImpl: noSleep, autoRestart: true, restartDelayMs: 1 });
  await s5.start();
  await s5.stop();
  ok("child killed on stop", r5.procs[0]!.killed);
  ok("running false after stop", !s5.getState().running);
  r5.procs[0]!.emitExit(0);
  await tick();
  ok("no restart after an intentional stop", r5.procs.length === 1);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

void main();
