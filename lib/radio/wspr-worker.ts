// The WSPR decoder, on its own thread.
//
// A two-minute WSPR window takes about three seconds of CPU to decode (lib/digital/wsprdemod
// .ts), and the bridge's main thread cannot be away for three seconds: DAX audio arrives
// over UDP the whole time, and a stall longer than the socket buffer loses the first
// seconds of the NEXT window - which is where every WSPR transmission starts. FT8 and FT4
// decode on lib/radio/decode-worker.mjs for the same reason; FT2 stays on the main thread
// because it takes 170 ms.
//
// PLAIN JAVASCRIPT ON THE THREAD. This file is TypeScript, but the thread loads
// lib/radio/wspr-worker.bundle.mjs, which esbuild builds from it and what it imports
// (`npm run build:wspr-worker`; `npm run check:wspr-worker` fails while the bundle is
// stale). The first release spawned this .ts file directly, on the measurement that a
// worker inherits the parent's tsx loader flags - true on the Node 24 it was measured on,
// false on the Node 20 the station runs, where every window died in the thread with
// "Unknown file extension .ts". The FT8 worker is a plain .mjs for the same reason; this
// one is too, by way of a build step, because the decoder it runs is TypeScript.
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
