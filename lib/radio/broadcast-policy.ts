// Who gets a broadcast frame, and who is past helping.
//
// THE FAULT. `broadcast()` in services/radio/index.ts fed every connected client
// unconditionally, and spectrum plus panadapter frames go through it at four a second —
// each a base64 string built from a fresh Buffer. A tab that backgrounds, a phone that
// sleeps, or a connection dropped without a close event stops draining, and `ws` queues
// every frame it is handed. That queue is ArrayBuffer memory.
//
// MEASURED on the live station: `arrayBuffers` went 2 MB -> 24 MB in five minutes while
// `heapUsed` moved 2 MB, and the bridge reached 653 MB over 3.6 hours — enough that a
// deploy was OOM-killed on a 2 GB box *after* it had deleted the previous build, leaving
// the web tier serving from memory with nothing on disk to restart into.
//
// The audio path has guarded exactly this since it was written, and its comment predicted
// the outcome: "a backlog on a slow socket would grow without bound and eventually take the
// bridge's memory with it." It was right. The guard was simply on one channel of two.
//
// Extracted here rather than left inline so it can be asserted without importing the bridge,
// which starts a radio.

/**
 * Message kinds a slow client may simply miss.
 *
 * A waterfall row has no value once it is late — the panadapter's own comment says it "has
 * no value once it has scrolled off the screen" — and the next one is 250 ms away. A
 * `status` or a `qso` is a STATE TRANSITION: a client that misses one shows the wrong thing
 * until some unrelated change happens to arrive. So the cheap frames are dropped and the
 * meaningful ones are queued, which is the whole distinction.
 */
export const DROPPABLE_KINDS: ReadonlySet<string> = new Set([
  "spectrum",
  "panadapter",
  "smeter",
  "telemetry",
]);

/**
 * Bytes already queued on a socket past which it is not keeping up.
 *
 * WAS 400,000, COPIED FROM THE AUDIO GUARD, AND THAT WAS WRONG BY MEASUREMENT. The decode
 * socket carries ~423 kbps (measured 2026-08-30 on the live station: 3,095 KB/min, 93% of
 * it panadapter frames at ~8.7/s and ~5.5 KB each). At that rate 400 KB of backlog is 7.5
 * SECONDS of queue a viewer is allowed to build before a single frame is dropped — and
 * below the mark everything queues IN ORDER, so decodes sat in line behind megabytes of
 * waterfall. Observed from the operator's chair as "the decode list is behind" and
 * "decodes only on the exact minute" on a link the tunnel had squeezed. 400 KB suits the
 * audio guard it was copied from because audio is the payload there; here it let the
 * decor delay the data.
 *
 * 64 KB is ~1.2 s of panadapter at the measured rate. A LAN client drains to zero between
 * frames and never touches it; a squeezed client loses waterfall rows — each worthless
 * 120 ms later anyway — and keeps decodes near-live, which is the entire point of
 * having droppable kinds at all.
 */
export const SLOW_CLIENT_BYTES = 64_000;

/**
 * Hopelessly behind.
 *
 * A client this far back will never catch up, and every frame still queued for it is memory
 * this process cannot reclaim while the socket lives. Ten times the slow mark: far enough
 * that a brief stall on a good connection never reaches it, close enough that one stuck
 * client cannot hold tens of megabytes.
 */
export const HOPELESS_CLIENT_BYTES = 4_000_000;

export type BroadcastAction = "send" | "skip" | "terminate";

/**
 * What to do with one client for one frame.
 *
 * `terminate` rather than merely forgetting the socket, and the difference is the entire
 * bug: dropping the reference leaves the queue attached to a live connection and reclaims
 * nothing.
 */
export function broadcastAction(opts: {
  kind: string | undefined;
  bufferedAmount: number;
  isOpen: boolean;
}): BroadcastAction {
  // NOT OPEN MEANS NOT A RECIPIENT. A socket that is CONNECTING or CLOSING still accepts
  // `send()` and queues the result, and a half-closed connection can sit in CLOSING for as
  // long as the peer ignores it.
  if (!opts.isOpen) return "skip";

  if (opts.bufferedAmount > HOPELESS_CLIENT_BYTES) return "terminate";

  if (opts.bufferedAmount > SLOW_CLIENT_BYTES) {
    // Droppable: the next one is along shortly and a late one is worthless.
    if (opts.kind !== undefined && DROPPABLE_KINDS.has(opts.kind)) return "skip";
    // Meaningful: queue it. It is bounded by the hopeless check above.
    return "send";
  }

  return "send";
}
