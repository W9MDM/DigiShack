/* eslint-disable no-console */
// Checks for who gets a broadcast frame, and who is past helping.
// Run: npm run check:broadcast
//
// THE FAULT THESE GUARD. `broadcast()` fed every connected client unconditionally, and
// spectrum plus panadapter frames go through it at four a second, each a base64 string
// built from a fresh Buffer. A client that stops draining — a backgrounded tab, a sleeping
// phone, a connection dropped without a close event — has every one of those frames queued
// inside `ws`, and that queue is ArrayBuffer memory.
//
// MEASURED on the live station: `arrayBuffers` 2 MB -> 24 MB in five minutes while
// `heapUsed` moved 2 MB, and the bridge at 653 MB after 3.6 hours. That starved a deploy:
// the Next build was OOM-killed on a 2 GB box AFTER deleting the previous output.
//
// The audio path guarded this from the start and its comment predicted the outcome — "a
// backlog on a slow socket would grow without bound and eventually take the bridge's memory
// with it". The guard was on one channel of two.
//
// These call the real `broadcastAction`, not a copy. check-dxcc.ts spent a long time
// asserting a rule only its own local reimplementation followed.

import {
  broadcastAction,
  DROPPABLE_KINDS,
  HOPELESS_CLIENT_BYTES,
  SLOW_CLIENT_BYTES,
} from "../lib/radio/broadcast-policy";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}`, extra ?? "");
  }
}

const healthy = (kind: string | undefined) =>
  broadcastAction({ kind, bufferedAmount: 0, isOpen: true });

console.log("1. a healthy client gets everything");
{
  for (const kind of ["status", "qso", "spectrum", "panadapter", "telemetry", undefined]) {
    check(`${kind ?? "(no kind)"} is sent`, healthy(kind) === "send");
  }
}

console.log("");
console.log("2. a socket that is not OPEN is never written to");
{
  // CONNECTING and CLOSING both still ACCEPT `send()` and queue the result, and a
  // half-closed connection can sit in CLOSING for as long as the peer ignores it. This is
  // what stops frames piling into a socket nobody will ever read.
  for (const kind of ["status", "spectrum"]) {
    check(
      `${kind}: not sent while closing`,
      broadcastAction({ kind, bufferedAmount: 0, isOpen: false }) === "skip",
    );
  }
  check(
    "and that holds even for a hopeless backlog — skip, not terminate",
    broadcastAction({ kind: "status", bufferedAmount: 99e6, isOpen: false }) === "skip",
  );
}

console.log("");
console.log("3. THE LEAK: a slow client stops receiving cheap frames");
{
  const slow = SLOW_CLIENT_BYTES + 1;
  for (const kind of [...DROPPABLE_KINDS]) {
    check(
      `${kind} is dropped once the socket is behind`,
      broadcastAction({ kind, bufferedAmount: slow, isOpen: true }) === "skip",
    );
  }
  // The point of the whole change: at four frames a second, this is the difference between
  // a bounded socket and one that grows until the process dies.
  check(
    "spectrum at 4/sec cannot accumulate on a stalled socket",
    broadcastAction({ kind: "spectrum", bufferedAmount: slow, isOpen: true }) === "skip",
  );
}

console.log("");
console.log("4. but a state message is still delivered to a slow client");
{
  const slow = SLOW_CLIENT_BYTES + 1;
  // A `status` a client misses leaves it showing the wrong thing until some unrelated
  // change happens to arrive. Unlike a waterfall row, there is no "next one in 250 ms".
  for (const kind of ["status", "qso", "qso-tx", "decodes", "clock", undefined]) {
    check(
      `${kind ?? "(no kind)"} is queued rather than dropped`,
      broadcastAction({ kind, bufferedAmount: slow, isOpen: true }) === "send",
    );
  }
  check(
    "an unknown kind is treated as meaningful, not droppable",
    broadcastAction({ kind: "something-new", bufferedAmount: slow, isOpen: true }) === "send",
  );
}

console.log("");
console.log("5. hopeless clients are TERMINATED, not merely forgotten");
{
  const hopeless = HOPELESS_CLIENT_BYTES + 1;
  // Forgetting the socket would leave its queue attached to a live connection and reclaim
  // nothing — which is the fault itself, not a fix for it.
  for (const kind of ["status", "spectrum", undefined]) {
    check(
      `${kind ?? "(no kind)"}: terminated past the hopeless mark`,
      broadcastAction({ kind, bufferedAmount: hopeless, isOpen: true }) === "terminate",
    );
  }
  check(
    "termination outranks droppability — a stuck socket goes whatever it was fed",
    broadcastAction({ kind: "spectrum", bufferedAmount: hopeless, isOpen: true }) === "terminate",
  );
}

console.log("");
console.log("6. the thresholds are ordered, and a brief stall is not fatal");
{
  check("slow is below hopeless", SLOW_CLIENT_BYTES < HOPELESS_CLIENT_BYTES);
  // Far enough apart that a momentary stall on a good connection never reaches the
  // hopeless mark, close enough that one stuck client cannot hold tens of megabytes.
  check(
    "with an order of magnitude between them",
    HOPELESS_CLIENT_BYTES >= SLOW_CLIENT_BYTES * 8,
    `${SLOW_CLIENT_BYTES} vs ${HOPELESS_CLIENT_BYTES}`,
  );
  check(
    "exactly at the slow mark is still fine — the test is >, not >=",
    broadcastAction({ kind: "spectrum", bufferedAmount: SLOW_CLIENT_BYTES, isOpen: true }) === "send",
  );
  check(
    "exactly at the hopeless mark is not yet terminated",
    broadcastAction({ kind: "status", bufferedAmount: HOPELESS_CLIENT_BYTES, isOpen: true }) === "send",
  );
}

console.log("");
console.log("7. audio is NOT on this channel, and must not be added to it");
{
  // `sendAudio` has its own guard and its own client set, with a hard drop at 400 kB — it
  // is PCM, not JSON, and it must never queue. Listing it as droppable here would imply it
  // travels this way.
  check("audio is not a broadcast kind", !DROPPABLE_KINDS.has("audio"));
}

console.log("");
if (failures > 0) {
  console.log(`${failures} failed`);
  process.exit(1);
}
console.log("all passed");
