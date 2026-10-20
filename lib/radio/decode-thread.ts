// Owns the decode worker, and is the only thing that talks to it.
//
// See lib/radio/decode-worker.mjs for why the decoder runs on a thread at all. This side
// exists so the pipeline can `await decode(...)` and never think about threads, restarts or
// message correlation.

import { Worker } from "node:worker_threads";

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
export interface DecodeWorker {
  on(event: "message", listener: (reply: DecodeWorkerReply) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  postMessage(value: unknown, transferList?: readonly ArrayBuffer[]): void;
  ref(): void;
  unref(): void;
  terminate(): Promise<number>;
}

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
 */
export class DecodeThread {
  /** The worker in service and the generation it belongs to; null until the next job needs one. */
  private live: { worker: DecodeWorker; generation: number } | null = null;
  private generation = 0;
  private seq = 0;
  /** Jobs owed by the live worker. Retiring a worker empties this, so it never holds another generation's. */
  private readonly pending = new Map<
    number,
    { resolve: (r: DecodeResult) => void; timer: NodeJS.Timeout }
  >();
  private closed = false;
  /** Restarts, so a thread dying in a loop is visible rather than silent. */
  private restarts = 0;
  private readonly timeoutMs: number;
  private readonly spawn: () => DecodeWorker;

  constructor(
    private readonly onLog?: (line: string) => void,
    opts: DecodeThreadOptions = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? JOB_TIMEOUT_MS;
    this.spawn = opts.spawn ?? spawnDecodeWorker;
  }

  private ensure(): { worker: DecodeWorker; generation: number } {
    if (this.live) return this.live;

    const generation = ++this.generation;
    const worker = this.spawn();

    worker.on("message", (m) => {
      // A retired worker's answer belongs to a window that has already been given up on.
      if (this.live?.generation !== generation) return;
      const job = this.pending.get(m.id);
      if (!job) return;
      clearTimeout(job.timer);
      this.pending.delete(m.id);
      if (this.pending.size === 0) worker.unref();
      job.resolve({ decodes: m.decodes, ms: m.ms, error: m.error });
    });

    // A DEAD THREAD IS A DEAF STATION, so it is rebuilt rather than mourned. ANY exit of the
    // live worker is unexpected - including code 0, which used to be ignored and left a
    // worker that no longer existed installed, with every later window posted into nothing
    // until it timed out. Our own terminate() is not counted: retire() has already moved
    // the generation on by the time its exit arrives.
    worker.on("error", (err) => this.retire(generation, `failed: ${err.message}`));
    worker.on("exit", (code) => this.retire(generation, `exited with code ${code}`));

    // REF'D WHILE WORKING, UNREF'D WHILE IDLE — and both halves were learned the hard way.
    //
    // Always unref'd was the first attempt: the process then does not wait for a decode in
    // flight, so a window is abandoned the instant nothing else has work pending. A window
    // silently not decoded is the exact fault this change exists to remove.
    //
    // Never unref'd was the second: an idle thread then holds the process open for ever, so
    // anything that creates a pipeline without stopping it can never exit. That wedged the
    // check suite, which builds a pipeline per case.
    //
    // So the thread holds the process open exactly while it owes an answer. `ref` and
    // `unref` are counted by the pending map in `decode()` and the message handler.
    worker.unref();
    this.live = { worker, generation };
    return this.live;
  }

  /**
   * Take one generation's worker out of service, once.
   *
   * Everything it still owed is failed first: those windows' audio went to it and is gone,
   * and leaving their promises pending would wedge the pipeline behind a thread that is no
   * longer there. Then it is terminated — a no-op for one that already exited, and the only
   * way out for one stuck inside a decode.
   */
  private retire(generation: number, why: string): void {
    const live = this.live;
    if (!live || live.generation !== generation) return;
    this.live = null;
    for (const [id, job] of this.pending) {
      clearTimeout(job.timer);
      this.pending.delete(id);
      job.resolve({ decodes: [], ms: 0, error: why });
    }
    live.worker.terminate().catch(() => {
      /* already gone */
    });
    if (this.closed) return;
    this.restarts++;
    // "restarting" is literal enough: the replacement is built by the next window, and
    // check-decode-worker counts this word to prove a healthy thread is never replaced.
    this.onLog?.(`[decode] worker ${why} — restarting (restart ${this.restarts})`);
  }

  async decode(job: DecodeJob): Promise<DecodeResult> {
    if (this.closed) return { decodes: [], ms: 0, error: "decoder closed" };
    let live: { worker: DecodeWorker; generation: number };
    try {
      live = this.ensure();
    } catch (err) {
      return { decodes: [], ms: 0, error: `could not start the decoder: ${err instanceof Error ? err.message : String(err)}` };
    }
    const { worker: w, generation } = live;
    const id = ++this.seq;

    return new Promise<DecodeResult>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        this.onLog?.(`[decode] window timed out after ${this.timeoutMs}ms — treating as empty`);
        resolve({ decodes: [], ms: this.timeoutMs, error: "timeout" });
        // The worker that swallowed it is presumed wedged, and is replaced rather than fed
        // the next window too. See the class comment.
        this.retire(generation, `timed out after ${this.timeoutMs}ms`);
      }, this.timeoutMs);
      timer.unref?.();
      // Holds the process open for as long as this window is owed an answer.
      if (this.pending.size === 0) w.ref();
      this.pending.set(id, { resolve, timer });

      // TRANSFERRED, NOT COPIED. The audio is ~330 kB a window and the caller has no use
      // for it afterwards, so the buffer is handed over rather than cloned. The caller must
      // not touch `job.audio` after this — every caller in the pipeline builds it fresh for
      // exactly one decode.
      // Cast because a Float32Array MAY be backed by a SharedArrayBuffer, which is not
      // transferable — but every caller here builds a plain one. Narrowed rather than
      // silenced: a shared buffer would throw at runtime, and that is the correct outcome
      // for a caller that has quietly changed how it allocates audio.
      try {
        w.postMessage({ id, ...job }, [job.audio.buffer as ArrayBuffer]);
      } catch (err) {
        // The job never reached the worker, so the worker is not at fault and must not be
        // retired by this job's timer: undo the bookkeeping and reject, as it always did.
        clearTimeout(timer);
        this.pending.delete(id);
        if (this.pending.size === 0) w.unref();
        throw err;
      }
    });
  }

  /** Stop accepting work and tear the thread down. */
  async close(): Promise<void> {
    this.closed = true;
    const live = this.live;
    this.live = null;
    for (const [id, job] of this.pending) {
      clearTimeout(job.timer);
      this.pending.delete(id);
      job.resolve({ decodes: [], ms: 0, error: "decoder closed" });
    }
    if (live) await live.worker.terminate().catch(() => 0);
  }
}
