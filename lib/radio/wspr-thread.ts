// The main-thread side of the WSPR decoder thread. See lib/radio/wspr-worker.ts for why
// there is a thread at all and why the thread loads a BUNDLE of it (wspr-worker.bundle.mjs,
// plain JavaScript: a worker thread on Node 20 does not inherit tsx), and
// lib/radio/decode-thread.ts for the FT8/FT4 one this mirrors: one job at a time, a timeout
// that treats a stuck window as empty, a restart on a crash, and `unref` so an idle thread
// never keeps the process alive.

import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";

import type { WsprDecode } from "@/lib/digital/wsprdemod";
import type { WsprJobResult } from "@/lib/radio/wspr-worker";

export interface WsprThreadResult {
  decodes: WsprDecode[];
  ms: number;
  error?: string;
}

/** Three seconds is typical; a machine four times slower still fits in the two-minute period. */
const JOB_TIMEOUT_MS = 60_000;

export class WsprThread {
  private worker: Worker | null = null;
  private seq = 0;
  private readonly pending = new Map<number, { resolve: (r: WsprThreadResult) => void; timer: NodeJS.Timeout }>();
  private closed = false;
  private restarts = 0;

  constructor(private readonly onLog?: (line: string) => void) {}

  private ensure(): Worker {
    if (this.worker) return this.worker;
    // The bundle, never the .ts: see the header. Said once per spawn when it is missing,
    // because the Worker's own error ("Cannot find module") does not say what to run.
    const url = new URL("./wspr-worker.bundle.mjs", import.meta.url);
    if (!existsSync(url)) {
      this.onLog?.(
        "[wspr] lib/radio/wspr-worker.bundle.mjs is missing - run `npm run build:wspr-worker`; every WSPR window decodes as empty until it exists",
      );
    }
    const w = new Worker(url);
    w.on("message", (m: WsprJobResult) => {
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
      this.onLog?.(`[wspr] decoder thread ${why} — restarting (restart ${this.restarts})`);
    };
    w.on("error", (err) => down(`failed: ${err.message}`));
    w.on("exit", (code) => code !== 0 && down(`exited with code ${code}`));
    w.unref();
    this.worker = w;
    return w;
  }

  async decode(audio: Float32Array, sampleRate: number): Promise<WsprThreadResult> {
    if (this.closed) return { decodes: [], ms: 0, error: "decoder closed" };
    const w = this.ensure();
    const id = ++this.seq;
    return new Promise<WsprThreadResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (this.pending.size === 0) this.worker?.unref();
        this.onLog?.(`[wspr] window timed out after ${JOB_TIMEOUT_MS} ms — treating as empty`);
        resolve({ decodes: [], ms: JOB_TIMEOUT_MS, error: "timeout" });
      }, JOB_TIMEOUT_MS);
      this.pending.set(id, { resolve, timer });
      w.ref();
      // Transferred, not copied: the pipeline hands over its own buffer and does not read
      // it again.
      w.postMessage({ id, audio, sampleRate }, [audio.buffer as ArrayBuffer]);
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
