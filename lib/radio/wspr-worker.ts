// The WSPR decoder, on its own thread.
//
// A two-minute WSPR window takes about three seconds of CPU to decode (lib/digital/wsprdemod
// .ts), and the bridge's main thread cannot be away for three seconds: DAX audio arrives
// over UDP the whole time, and a stall longer than the socket buffer loses the first
// seconds of the NEXT window - which is where every WSPR transmission starts. FT8 and FT4
// decode on lib/radio/decode-worker.mjs for the same reason; FT2 stays on the main thread
// because it takes 170 ms.
//
// A TypeScript worker, not a .mjs one, because the decoder is TypeScript. This works under
// tsx, which is how the bridge runs (`npm run bridge` and PM2 both launch
// node_modules/tsx/dist/cli.mjs): a worker inherits the parent's execArgv, and tsx's loader
// flags are in it - measured, not assumed, before this file was written. Under plain node
// the worker would fail to load, and lib/radio/wspr-thread.ts reports that as a decode
// error rather than hanging.
//
// One hash table for the life of the thread, as the FT8 worker keeps one hash-call book:
// a type 3 message resolves only if its station's type 2 was heard earlier, and that
// memory has to outlive a window.

import { parentPort } from "node:worker_threads";

import { WsprHashTable } from "@/lib/digital/wspr";
import { wsprDecodeAudio, type WsprDecode } from "@/lib/digital/wsprdemod";

export interface WsprJob {
  id: number;
  audio: Float32Array;
  sampleRate: number;
}

export interface WsprJobResult {
  id: number;
  ms: number;
  decodes: WsprDecode[];
  error?: string;
}

const hashes = new WsprHashTable();

parentPort?.on("message", (job: WsprJob) => {
  const started = Date.now();
  try {
    const decodes = wsprDecodeAudio(job.audio, { sampleRate: job.sampleRate, hashes });
    const result: WsprJobResult = { id: job.id, ms: Date.now() - started, decodes };
    parentPort?.postMessage(result);
  } catch (err) {
    const result: WsprJobResult = {
      id: job.id,
      ms: Date.now() - started,
      decodes: [],
      error: err instanceof Error ? err.message : String(err),
    };
    parentPort?.postMessage(result);
  }
});
