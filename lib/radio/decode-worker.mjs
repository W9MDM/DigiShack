// The FT8/FT4 decoder, on a thread of its own.
//
// WHY THIS EXISTS. `decodeFT8` is synchronous and takes 2.1-2.8 s on this machine. Run on
// the main thread it holds Node's event loop for that whole time, which is why the pipeline
// used to DEFER the full-band pass whenever a transmission was pending: decoding and keying
// on time could not both happen, so one had to wait. The operator saw the cost as decodes
// arriving 30 s after their window instead of 16.
//
// WSJT-X does not have this problem because `jt9` is a separate process. This is the same
// answer with a thread instead: the decode cannot delay a key, so nothing has to be
// deferred, and every window is decoded.
//
// WHY .mjs AND NOT .ts, IN A REPOSITORY THAT IS OTHERWISE ALL TYPESCRIPT. tsx does not
// carry its loader into `worker_threads` - a `.ts` worker fails with "Unknown file
// extension", with or without `--import tsx` in execArgv, and both were tried on the live
// machine. Plain JavaScript costs almost nothing here: this file receives numbers, calls
// one library function and posts numbers back. Its contract is asserted from the TypeScript
// side in scripts/check-decode-worker.ts.
//
// FT8 AND FT4 ONLY. FT2 is decoded by our own port in lib/digital, which is TypeScript and
// therefore not importable here, and it keeps running on the main thread. That is a smaller
// problem than it sounds: FT2's transmission is 1,947 ms against FT8's 12,640, so it is a
// much shorter decode, and it is the experimental mode rather than the one this station
// operates in.

import { parentPort } from "node:worker_threads";
import { decodeFT4, decodeFT8, HashCallBook } from "@e04/ft8ts";

/**
 * ONE book for the life of the thread, shared by every pass.
 *
 * `HashCallBook` remembers the full callsigns behind hashes like `<3D2USU>`, learned when a
 * station sends its call in full. That state is the whole reason the library asks for an
 * instance rather than making one per call, and it is why the decoder had to move here
 * WHOLE rather than being called per-window from the main thread: shipping the book across
 * a thread boundary on every window would cost more than the decode it was trying to speed
 * up, and a book that reset each window would leave every compound message unresolved.
 *
 * It also means the slice pass and the full pass must run on the SAME thread, which they do.
 */
const book = new HashCallBook();

parentPort.on("message", (job) => {
  const started = Date.now();
  try {
    const opts = {
      sampleRate: job.sampleRate,
      depth: job.depth,
      hashCallBook: book,
      ...(job.freqLow === undefined ? {} : { freqLow: job.freqLow }),
      ...(job.freqHigh === undefined ? {} : { freqHigh: job.freqHigh }),
    };

    const out = job.mode === "FT4" ? decodeFT4(job.audio, opts) : decodeFT8(job.audio, opts);

    parentPort.postMessage({
      id: job.id,
      ms: Date.now() - started,
      // Mapped here rather than on the main thread so what crosses the boundary is the
      // smallest useful shape, and so the main thread never touches a library object.
      decodes: (out ?? []).map((d) => ({
        freq: Math.round(d.freq),
        snr: Math.round(d.snr),
        dt: d.dt,
        msg: String(d.msg).trim(),
      })),
    });
  } catch (err) {
    // NEVER THROW OUT OF THE WORKER. An uncaught error here terminates the thread, and a
    // terminated decoder is a deaf station. The pipeline treats a failed job as an empty
    // window - the same thing it already did when a decode threw on the main thread.
    parentPort.postMessage({
      id: job.id,
      ms: Date.now() - started,
      decodes: [],
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
