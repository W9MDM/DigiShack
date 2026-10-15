// The main-thread side of the JS8 decoder thread. See lib/radio/js8-worker.ts for why
// there is a thread at all and why the thread loads a BUNDLE of it (js8-worker.bundle.mjs,
// plain JavaScript: a worker thread on Node 20 does not inherit tsx), and
// lib/radio/decode-thread.ts for the FT8/FT4 one this mirrors: one job at a time, a timeout
// that treats a stuck window as empty, a restart on a crash, and `unref` so an idle thread
// never keeps the process alive.

import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";

import type { Js8JobResult, Js8WorkerDecode } from "@/lib/radio/js8-worker";

export interface Js8ThreadResult {
  decodes: Js8WorkerDecode[];
  ms: number;
  error?: string;
}

/** Three seconds is typical on the station; a window that takes a minute is stuck, not slow. */
const JOB_TIMEOUT_MS = 60_000;

export class Js8Thread {
  private worker: Worker | null = null;
  private seq = 0;
  private readonly pending = new Map<number, { resolve: (r: Js8ThreadResult) => void; timer: NodeJS.Timeout }>();
  private closed = false;
  private restarts = 0;

  constructor(private readonly onLog?: (line: string) => void) {}

  private ensure(): Worker {
    if (this.worker) return this.worker;
    // The bundle, never the .ts: see the header. Said once per spawn when it is missing,
    // because the Worker's own error ("Cannot find module") does not say what to run.
    const url = new URL("./js8-worker.bundle.mjs", import.meta.url);
    if (!existsSync(url)) {
      this.onLog?.(
        "[js8] lib/radio/js8-worker.bundle.mjs is missing - run `npm run build:js8-worker`; every JS8 window decodes as empty until it exists",
      );
    }
    const w = new Worker(url);
    w.on("message", (m: Js8JobResult) => {
      const job = this.pending.get(m.id);
      if (!job) return;
      clearTimeout(job.timer);
      this.pending.delete(m.id);
      if (this.pending.size === 0) w.unref();
      job.resolve({ decodes: m.decodes, ms: m.ms, error: m.error });
    });
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
      this.onLog?.(`[js8] decoder thread ${why} — restarting (restart ${this.restarts})`);
    };
    w.on("error", (err) => down(`failed: ${err.message}`));
    w.on("exit", (code) => code !== 0 && down(`exited with code ${code}`));
    w.unref();
    this.worker = w;
    return w;
  }

  async decode(audio: Float32Array, sampleRate: number, submode: "A" | "B" | "C" | "E" | "I" = "A"): Promise<Js8ThreadResult> {
    if (this.closed) return { decodes: [], ms: 0, error: "decoder closed" };
    const w = this.ensure();
    const id = ++this.seq;
    return new Promise<Js8ThreadResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (this.pending.size === 0) this.worker?.unref();
        this.onLog?.(`[js8] window timed out after ${JOB_TIMEOUT_MS} ms — treating as empty`);
        resolve({ decodes: [], ms: JOB_TIMEOUT_MS, error: "timeout" });
      }, JOB_TIMEOUT_MS);
      this.pending.set(id, { resolve, timer });
      w.ref();
      // Transferred, not copied: the pipeline hands over its own buffer and does not read
      // it again.
      w.postMessage({ id, audio, sampleRate, submode }, [audio.buffer as ArrayBuffer]);
    });
  }

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
