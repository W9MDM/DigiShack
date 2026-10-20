// Supervises one decoder worker thread: posts jobs to it, correlates the answers, and
// replaces it when it stops answering, crashes or exits.
//
// Shared by the three decoder threads - decode-thread.ts (FT8/FT4), wspr-thread.ts and
// js8-thread.ts - because all three had the same flaw (code review R06, fixed for FT8/FT4
// in 1.225.0 and then here for the other two): a job that timed out handed the caller an
// empty window but left the wedged worker installed, so every later job was posted to it
// and timed out in its turn. A deaf decoder that looked alive. An unexpected exit with code
// 0 was ignored outright, leaving a worker that no longer existed as the one jobs went to.
//
// The workers themselves are always plain JavaScript (decode-worker.mjs, and the esbuild
// bundles of wspr-worker.ts / js8-worker.ts): the live box runs Node 20, where a worker
// thread does not inherit tsx and a `.ts` worker dies with "Unknown file extension". This
// file runs on the main thread only, so it may be TypeScript.

/** What every decoder worker posts back for one job. */
export interface SupervisedReply<D> {
  id: number;
  decodes: D[];
  ms: number;
  error?: string;
}

/** What the caller gets for one job. `error` set means the window is treated as empty. */
export interface SupervisedResult<D> {
  decodes: D[];
  /** CPU actually spent decoding, measured inside the worker. */
  ms: number;
  error?: string;
}

/**
 * The parts of a worker thread the supervisor uses.
 *
 * A real `Worker` in production. The recovery checks substitute workers that hang, exit
 * cleanly or crash on cue, since a real decoder cannot be made to do any of those on demand.
 */
export interface SupervisedWorker<R> {
  on(event: "message", listener: (reply: R) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  postMessage(value: unknown, transferList?: readonly ArrayBuffer[]): void;
  ref(): void;
  unref(): void;
  terminate(): Promise<number>;
}

export interface WorkerSupervisorOptions<D> {
  /** Builds a worker. Called lazily, by the first job after start-up or a retirement. */
  spawn: () => SupervisedWorker<SupervisedReply<D>>;
  /** How long one job may take before its worker is presumed wedged. */
  timeoutMs: number;
  onLog?: (line: string) => void;
  /** The line logged when a job times out. */
  timedOutLine: (timeoutMs: number) => string;
  /**
   * The line logged when a worker is retired. It must contain the word "restarting":
   * the checks count it to prove a healthy thread is never replaced.
   */
  restartingLine: (why: string, restarts: number) => string;
}

/**
 * One worker at a time, and a worker that stops answering is replaced rather than waited on.
 *
 * A timeout RETIRES the worker's generation: whatever else it owed is failed at once, it is
 * terminated, and the next job builds a fresh one. Anything a retired worker says afterwards
 * is ignored, so a late answer cannot be taken for a newer job's. The cost is whatever state
 * the worker had learned (the FT8 hash book, the WSPR hash table), which starts empty again -
 * the same cost as a crash.
 */
export class WorkerSupervisor<D> {
  /** The worker in service and the generation it belongs to; null until the next job needs one. */
  private live: { worker: SupervisedWorker<SupervisedReply<D>>; generation: number } | null = null;
  private generation = 0;
  private seq = 0;
  /** Jobs owed by the live worker. Retiring a worker empties this, so it never holds another generation's. */
  private readonly pending = new Map<
    number,
    { resolve: (r: SupervisedResult<D>) => void; timer: NodeJS.Timeout }
  >();
  private closed = false;
  /** Restarts, so a thread dying in a loop is visible rather than silent. */
  private restarts = 0;

  constructor(private readonly opts: WorkerSupervisorOptions<D>) {}

  private ensure(): { worker: SupervisedWorker<SupervisedReply<D>>; generation: number } {
    if (this.live) return this.live;

    const generation = ++this.generation;
    const worker = this.opts.spawn();

    worker.on("message", (m) => {
      // A retired worker's answer belongs to a job that has already been given up on.
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
    // worker that no longer existed installed, with every later job posted into nothing
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
    // `unref` are counted by the pending map in `run()` and the message handler.
    worker.unref();
    this.live = { worker, generation };
    return this.live;
  }

  /**
   * Take one generation's worker out of service, once.
   *
   * Everything it still owed is failed first: those jobs' audio went to it and is gone, and
   * leaving their promises pending would wedge the pipeline behind a thread that is no
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
    // "restarting" is literal enough: the replacement is built by the next job.
    this.opts.onLog?.(this.opts.restartingLine(why, this.restarts));
  }

  /**
   * Post one job, as `{ id, ...payload }`, and wait for its answer.
   *
   * `transfer` is TRANSFERRED, NOT COPIED: the caller must not touch those buffers after
   * this. A buffer that cannot be transferred (a SharedArrayBuffer) throws, and the returned
   * promise rejects - the correct outcome for a caller that has quietly changed how it
   * allocates audio.
   */
  async run(payload: object, transfer: readonly ArrayBuffer[]): Promise<SupervisedResult<D>> {
    if (this.closed) return { decodes: [], ms: 0, error: "decoder closed" };
    let live: { worker: SupervisedWorker<SupervisedReply<D>>; generation: number };
    try {
      live = this.ensure();
    } catch (err) {
      return { decodes: [], ms: 0, error: `could not start the decoder: ${err instanceof Error ? err.message : String(err)}` };
    }
    const { worker: w, generation } = live;
    const id = ++this.seq;
    const timeoutMs = this.opts.timeoutMs;

    return new Promise<SupervisedResult<D>>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        this.opts.onLog?.(this.opts.timedOutLine(timeoutMs));
        resolve({ decodes: [], ms: timeoutMs, error: "timeout" });
        // The worker that swallowed it is presumed wedged, and is replaced rather than fed
        // the next job too. See the class comment.
        this.retire(generation, `timed out after ${timeoutMs}ms`);
      }, timeoutMs);
      timer.unref?.();
      // Holds the process open for as long as this job is owed an answer.
      if (this.pending.size === 0) w.ref();
      this.pending.set(id, { resolve, timer });

      try {
        w.postMessage({ id, ...payload }, transfer);
      } catch (err) {
        // The job never reached the worker, so the worker is not at fault and must not be
        // retired by this job's timer: undo the bookkeeping and reject.
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
