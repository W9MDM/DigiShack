// The main-thread side of the JS8 decoder thread. See lib/radio/js8-worker.ts for why
// there is a thread at all and why the thread loads a BUNDLE of it (js8-worker.bundle.mjs,
// plain JavaScript: a worker thread on Node 20 does not inherit tsx), and
// lib/radio/worker-supervisor.ts for the supervision it shares with the FT8/FT4 and WSPR
// threads: one job at a time, a timeout that treats a stuck window as empty AND retires the
// wedged worker, a restart on any exit or crash, and `unref` so an idle thread never keeps
// the process alive.

import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";

import type { Js8JobResult, Js8WorkerDecode } from "@/lib/radio/js8-worker";
import { WorkerSupervisor, type SupervisedResult, type SupervisedWorker } from "@/lib/radio/worker-supervisor";

export type Js8ThreadResult = SupervisedResult<Js8WorkerDecode>;

/** A worker thread as the JS8 thread uses it; a real `Worker` in production. */
export type Js8Worker = SupervisedWorker<Js8JobResult>;

export interface Js8ThreadOptions {
  /** How long one window may take before its worker is presumed wedged. */
  timeoutMs?: number;
  /** Builds a worker. For checks only: production always runs js8-worker.bundle.mjs. */
  spawn?: () => Js8Worker;
}

/** Three seconds is typical on the station; a window that takes a minute is stuck, not slow. */
const JOB_TIMEOUT_MS = 60_000;

export class Js8Thread {
  private readonly supervisor: WorkerSupervisor<Js8WorkerDecode>;

  constructor(onLog?: (line: string) => void, opts: Js8ThreadOptions = {}) {
    const spawn = (): Js8Worker => {
      // The bundle, never the .ts: see the header. Said once per spawn when it is missing,
      // because the Worker's own error ("Cannot find module") does not say what to run.
      const url = new URL("./js8-worker.bundle.mjs", import.meta.url);
      if (!existsSync(url)) {
        onLog?.(
          "[js8] lib/radio/js8-worker.bundle.mjs is missing - run `npm run build:js8-worker`; every JS8 window decodes as empty until it exists",
        );
      }
      return new Worker(url);
    };
    this.supervisor = new WorkerSupervisor<Js8WorkerDecode>({
      spawn: opts.spawn ?? spawn,
      timeoutMs: opts.timeoutMs ?? JOB_TIMEOUT_MS,
      onLog,
      timedOutLine: (ms) => `[js8] window timed out after ${ms} ms — treating as empty`,
      restartingLine: (why, n) => `[js8] decoder thread ${why} — restarting (restart ${n})`,
    });
  }

  /** Transferred, not copied: the pipeline hands over its own buffer and does not read it again. */
  decode(audio: Float32Array, sampleRate: number, submode: "A" | "B" | "C" | "E" | "I" = "A"): Promise<Js8ThreadResult> {
    return this.supervisor.run({ audio, sampleRate, submode }, [audio.buffer as ArrayBuffer]);
  }

  close(): Promise<void> {
    return this.supervisor.close();
  }
}
