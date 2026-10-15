// The JS8 decoder, on its own thread.
//
// A fifteen-second JS8 window costs about a second of CPU on this machine to decode
// (lib/digital/js8demod.ts) and three on the station, and the bridge's main thread cannot
// be away that long: DAX audio keeps arriving. FT8 and WSPR decode on their own threads
// for the same reason, and this follows the WSPR one exactly - including that the thread
// loads lib/radio/js8-worker.bundle.mjs, plain JavaScript esbuild builds from this file
// and what it imports (`npm run build:js8-worker`), because a worker thread on the
// station's Node 20 does not inherit tsx. The dictionary (js8-jsc-words.json) is read by
// this thread on its first dictionary frame, from the directory the bridge runs in.
//
// What a job returns is more than a decode: every frame is also read by the message layer
// here, so the main thread gets the printed form, the kind, the parties and the text, and
// only has to join frames into messages.

import { parentPort } from "node:worker_threads";

import { js8DecodeAudio } from "@/lib/digital/js8demod";
import { js8JscDecompress } from "@/lib/digital/js8-jsc";
import { js8ParseFrame, type Js8ParsedFrame } from "@/lib/digital/js8-message";

export interface Js8Job {
  id: number;
  audio: Float32Array;
  sampleRate: number;
  /** The speed to decode: A Normal, B Fast, C Turbo, E Slow. */
  submode?: "A" | "B" | "C" | "E" | "I";
}

export interface Js8WorkerDecode {
  freqHz: number;
  dtS: number;
  snrDb: number;
  /** The twelve payload characters, as they came. */
  frame: string;
  /** The 3-bit transmission type: first / last / data flags. */
  txType: number;
  sync: number;
  hardErrors: number;
  parsed: Js8ParsedFrame;
}

export interface Js8JobResult {
  id: number;
  ms: number;
  decodes: Js8WorkerDecode[];
  error?: string;
}

parentPort?.on("message", (job: Js8Job) => {
  const started = Date.now();
  try {
    const decodes = js8DecodeAudio(job.audio, { sampleRate: job.sampleRate, submode: job.submode ?? "A" }).map((d) => ({
      freqHz: d.freqHz,
      dtS: d.dtS,
      snrDb: d.snrDb,
      frame: d.text,
      txType: d.frameType,
      sync: d.sync,
      hardErrors: d.hardErrors,
      parsed: js8ParseFrame(d.text, d.frameType, js8JscDecompress),
    }));
    const result: Js8JobResult = { id: job.id, ms: Date.now() - started, decodes };
    parentPort?.postMessage(result);
  } catch (err) {
    const result: Js8JobResult = {
      id: job.id,
      ms: Date.now() - started,
      decodes: [],
      error: err instanceof Error ? err.message : String(err),
    };
    parentPort?.postMessage(result);
  }
});
