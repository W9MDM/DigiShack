// The main-thread side of the WSPR decoder thread. See lib/radio/wspr-worker.ts for why
// there is a thread at all and why the thread loads a BUNDLE of it (wspr-worker.bundle.mjs,
// plain JavaScript: a worker thread on Node 20 does not inherit tsx), and
// lib/radio/worker-supervisor.ts for the supervision it shares with the FT8/FT4 and JS8
// threads: one job at a time, a timeout that treats a stuck window as empty AND retires the
// wedged worker, a restart on any exit or crash, and `unref` so an idle thread never keeps
// the process alive.

import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";

import type { WsprDecode } from "@/lib/digital/wsprdemod";
import type { WsprJobResult } from "@/lib/radio/wspr-worker";
import { WorkerSupervisor, type SupervisedResult, type SupervisedWorker } from "@/lib/radio/worker-supervisor";

export type WsprThreadResult = SupervisedResult<WsprDecode>;

/** A worker thread as the WSPR thread uses it; a real `Worker` in production. */
export type WsprWorker = SupervisedWorker<WsprJobResult>;

export interface WsprThreadOptions {
  /** How long one window may take before its worker is presumed wedged. */
  timeoutMs?: number;
  /** Builds a worker. For checks only: production always runs wspr-worker.bundle.mjs. */
  spawn?: () => WsprWorker;
}

/** Three seconds is typical; a machine four times slower still fits in the two-minute period. */
const JOB_TIMEOUT_MS = 60_000;

export class WsprThread {
  private readonly supervisor: WorkerSupervisor<WsprDecode>;

  constructor(onLog?: (line: string) => void, opts: WsprThreadOptions = {}) {
    const spawn = (): WsprWorker => {
      // The bundle, never the .ts: see the header. Said once per spawn when it is missing,
      // because the Worker's own error ("Cannot find module") does not say what to run.
      const url = new URL("./wspr-worker.bundle.mjs", import.meta.url);
      if (!existsSync(url)) {
        onLog?.(
          "[wspr] lib/radio/wspr-worker.bundle.mjs is missing - run `npm run build:wspr-worker`; every WSPR window decodes as empty until it exists",
        );
      }
      return new Worker(url);
    };
    this.supervisor = new WorkerSupervisor<WsprDecode>({
      spawn: opts.spawn ?? spawn,
      timeoutMs: opts.timeoutMs ?? JOB_TIMEOUT_MS,
      onLog,
      timedOutLine: (ms) => `[wspr] window timed out after ${ms} ms — treating as empty`,
      restartingLine: (why, n) => `[wspr] decoder thread ${why} — restarting (restart ${n})`,
    });
  }

  /** Transferred, not copied: the pipeline hands over its own buffer and does not read it again. */
  decode(audio: Float32Array, sampleRate: number): Promise<WsprThreadResult> {
    return this.supervisor.run({ audio, sampleRate }, [audio.buffer as ArrayBuffer]);
  }

  close(): Promise<void> {
    return this.supervisor.close();
  }
}
