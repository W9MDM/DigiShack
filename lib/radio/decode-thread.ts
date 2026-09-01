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

/**
 * How long to wait for one window before giving up on it.
 *
 * Generous against a measured 2.1-2.8 s: this is not a performance target, it is the line
 * past which the thread is assumed wedged rather than slow. A window abandoned here is a
 * window nobody decoded, which is the same outcome as the old main-thread decode throwing.
 */
const JOB_TIMEOUT_MS = 20_000;

/**
 * The decoder thread.
 *
 * ONE THREAD, NOT A POOL, and that is deliberate. The `HashCallBook` inside it is stateful -
 * it learns the full callsigns behind hashes - and two threads would each learn half of
 * them, so a compound message resolved on one would be unresolved on the other. A pool
 * would also decode two windows at once, which is not a thing this station needs: windows
 * arrive every 7.5-15 s and a pass takes under 3.
 */
export class DecodeThread {
  private worker: Worker | null = null;
  private seq = 0;
  private readonly pending = new Map<
    number,
    { resolve: (r: DecodeResult) => void; timer: NodeJS.Timeout }
  >();
  private closed = false;
  /** Restarts, so a thread dying in a loop is visible rather than silent. */
  private restarts = 0;

  constructor(private readonly onLog?: (line: string) => void) {}

  private ensure(): Worker {
    if (this.worker) return this.worker;

    // `new URL` against this module, so it resolves the same whether the bridge is started
    // from the project root, from PM2's cwd, or by a check script in scripts/.
    const w = new Worker(new URL("./decode-worker.mjs", import.meta.url));

    w.on("message", (m: { id: number; decodes: ThreadDecode[]; ms: number; error?: string }) => {
      const job = this.pending.get(m.id);
      if (!job) return; // timed out already, and its window is long gone
      clearTimeout(job.timer);
      this.pending.delete(m.id);
      if (this.pending.size === 0) w.unref();
      job.resolve({ decodes: m.decodes, ms: m.ms, error: m.error });
    });

    // A DEAD THREAD IS A DEAF STATION, so it is rebuilt rather than mourned. Everything
    // waiting is failed first: those windows are gone, and leaving their promises pending
    // would wedge the pipeline behind a thread that no longer exists.
    const down = (why: string) => {
      if (this.worker !== w) return;
      this.worker = null;
      for (const [id, job] of this.pending) {
        clearTimeout(job.timer);
        this.pending.delete(id);
        job.resolve({ decodes: [], ms: 0, error: why });
      }
      if (this.closed) return;
      this.restarts++;
      this.onLog?.(`[decode] worker ${why} — restarting (restart ${this.restarts})`);
    };

    w.on("error", (err) => down(`failed: ${err.message}`));
    w.on("exit", (code) => code !== 0 && down(`exited with code ${code}`));

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
    w.unref();
    this.worker = w;
    return w;
  }

  async decode(job: DecodeJob): Promise<DecodeResult> {
    if (this.closed) return { decodes: [], ms: 0, error: "decoder closed" };
    const w = this.ensure();
    const id = ++this.seq;

    return new Promise<DecodeResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (this.pending.size === 0) this.worker?.unref();
        this.onLog?.(`[decode] window timed out after ${JOB_TIMEOUT_MS}ms — treating as empty`);
        resolve({ decodes: [], ms: JOB_TIMEOUT_MS, error: "timeout" });
      }, JOB_TIMEOUT_MS);
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
      w.postMessage({ id, ...job }, [job.audio.buffer as ArrayBuffer]);
    });
  }

  /** Stop accepting work and tear the thread down. */
  async close(): Promise<void> {
    this.closed = true;
    const w = this.worker;
    this.worker = null;
    for (const [id, job] of this.pending) {
      clearTimeout(job.timer);
      this.pending.delete(id);
      job.resolve({ decodes: [], ms: 0, error: "decoder closed" });
    }
    if (w) await w.terminate();
  }
}
