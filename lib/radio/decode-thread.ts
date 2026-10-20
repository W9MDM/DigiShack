// Owns the decode worker, and is the only thing that talks to it.
//
// See lib/radio/decode-worker.mjs for why the decoder runs on a thread at all. This side
// exists so the pipeline can `await decode(...)` and never think about threads, restarts or
// message correlation.

import { Worker } from "node:worker_threads";

import { WorkerSupervisor, type SupervisedWorker } from "@/lib/radio/worker-supervisor";

/** One decode result, in the shape the pipeline already expects from the library. */
export interface ThreadDecode {
  freq: number;
  snr: number;
  dt: number;
  msg: string;
}

export interface DecodeJob {
  audio: Float32Array;
  mode: "FT8" | "FT4";
  sampleRate: number;
  depth: number;
  freqLow?: number;
  freqHigh?: number;
}

export interface DecodeResult {
  decodes: ThreadDecode[];
  /** CPU actually spent decoding, measured inside the worker. */
  ms: number;
  /** Set when the worker caught something. The window is treated as empty. */
  error?: string;
}

/** What decode-worker.mjs posts back for one job. */
export interface DecodeWorkerReply {
  id: number;
  decodes: ThreadDecode[];
  ms: number;
  error?: string;
}

/**
 * The parts of a worker thread this class uses.
 *
 * A real `Worker` running decode-worker.mjs in production — always plain JavaScript, because
 * the live box runs Node 20, where a worker thread does not inherit tsx and a `.ts` worker
 * dies with "Unknown file extension". The recovery check substitutes workers that hang, exit
 * cleanly or crash on cue, since the real decoder cannot be made to do any of those on demand.
 */
export type DecodeWorker = SupervisedWorker<DecodeWorkerReply>;

export interface DecodeThreadOptions {
  /** How long one window may take before its worker is presumed wedged. */
  timeoutMs?: number;
  /** Builds a worker. For checks only: production always runs decode-worker.mjs. */
  spawn?: () => DecodeWorker;
}

/**
 * How long to wait for one window before giving up on it.
 *
 * Generous against a measured 2.1-2.8 s: this is not a performance target, it is the line
 * past which the thread is assumed wedged rather than slow. A window abandoned here is a
 * window nobody decoded, which is the same outcome as the old main-thread decode throwing.
 */
const JOB_TIMEOUT_MS = 20_000;

/** `new URL` against this module, so it resolves the same from the project root, PM2's cwd or scripts/. */
const spawnDecodeWorker = (): DecodeWorker => new Worker(new URL("./decode-worker.mjs", import.meta.url));

/**
 * The decoder thread.
 *
 * ONE THREAD, NOT A POOL, and that is deliberate. The `HashCallBook` inside it is stateful -
 * it learns the full callsigns behind hashes - and two threads would each learn half of
 * them, so a compound message resolved on one would be unresolved on the other. A pool
 * would also decode two windows at once, which is not a thing this station needs: windows
 * arrive every 7.5-15 s and a pass takes under 3.
 *
 * ONE THREAD AT A TIME, TOO, and a thread that stops answering is replaced rather than
 * waited on. The timeout used to hand the caller an empty window and leave the same wedged
 * worker installed, so every later window was posted to it and timed out in turn - a deaf
 * station that looked alive, because the window watchdog is fed before a decode finishes
 * and never noticed. Now a timeout RETIRES the worker's generation: whatever else it owed is
 * failed at once, it is terminated, and the next window builds a fresh one. Anything a
 * retired worker says afterwards is ignored, so a late answer cannot be taken for a newer
 * window's. The cost is the hash book, which starts empty again - the same cost as a crash.
 * That supervision lives in worker-supervisor.ts, shared with the WSPR and JS8 threads.
 */
export class DecodeThread {
  private readonly supervisor: WorkerSupervisor<ThreadDecode>;

  constructor(onLog?: (line: string) => void, opts: DecodeThreadOptions = {}) {
    this.supervisor = new WorkerSupervisor<ThreadDecode>({
      spawn: opts.spawn ?? spawnDecodeWorker,
      timeoutMs: opts.timeoutMs ?? JOB_TIMEOUT_MS,
      onLog,
      timedOutLine: (ms) => `[decode] window timed out after ${ms}ms — treating as empty`,
      // check-decode-worker counts "restarting" to prove a healthy thread is never replaced.
      restartingLine: (why, n) => `[decode] worker ${why} — restarting (restart ${n})`,
    });
  }

  /**
   * Decode one window.
   *
   * TRANSFERRED, NOT COPIED. The audio is ~330 kB a window and the caller has no use for it
   * afterwards, so the buffer is handed over rather than cloned. The caller must not touch
   * `job.audio` after this — every caller in the pipeline builds it fresh for exactly one
   * decode. Cast because a Float32Array MAY be backed by a SharedArrayBuffer, which is not
   * transferable — but every caller here builds a plain one. Narrowed rather than silenced:
   * a shared buffer would throw at runtime, and that is the correct outcome for a caller that
   * has quietly changed how it allocates audio.
   */
  decode(job: DecodeJob): Promise<DecodeResult> {
    return this.supervisor.run(job, [job.audio.buffer as ArrayBuffer]);
  }

  /** Stop accepting work and tear the thread down. */
  close(): Promise<void> {
    return this.supervisor.close();
  }
}
