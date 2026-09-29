// The reconnect policy for the bridge socket, as arithmetic rather than as code buried in
// an effect.
//
// WHY THIS IS SEPARATE. The operator reported a page stuck on "Reconnecting (235)" that
// never came back on its own: "when it goes from this to live the page doesnt auto refresh
// so the reconnecting timer just keeps counting instead." A manual reload fixed it every
// time, which is the signature of a client that has stopped retrying rather than one that
// is retrying and failing.
//
// THE HOLE IT CAME FROM. A browser `WebSocket` has NO CONNECT TIMEOUT. If the TCP
// connection is accepted but the handshake never completes, the socket sits in CONNECTING
// indefinitely — `onopen` never fires and neither does `onclose`, so the retry that lives
// in `onclose` is never scheduled and the page waits for ever. That is exactly what a proxy
// in front of a dead origin does: Cloudflare accepts the connection and then has nothing to
// hand it to. The bridge restarts several times a day here, so the window is wide open.
//
// The fix is a timer the SOCKET cannot suppress: if it has not opened by then, close it and
// count that as a failure. Closing a CONNECTING socket does fire `onclose`, which is what
// puts the existing retry path back in charge.

/** How long a connection attempt may sit unopened before it is abandoned. */
export const CONNECT_TIMEOUT_MS = 10_000;

/** First retry delay, and the ceiling it doubles toward. */
export const FIRST_BACKOFF_MS = 1_000;
export const MAX_BACKOFF_MS = 15_000;

/**
 * The delay before the next attempt.
 *
 * Doubling with a ceiling: the bridge is usually back within thirty seconds, so the early
 * attempts are close together and the later ones stop hammering a radio that may be off for
 * the evening. The ceiling is FIFTEEN seconds rather than the thirty used elsewhere because
 * this page is what an operator stares at while waiting for the station to come back — a
 * half-minute of nothing after the bridge is already up reads as broken.
 */
export function nextBackoff(current: number): number {
  if (!Number.isFinite(current) || current <= 0) return FIRST_BACKOFF_MS;
  return Math.min(current * 2, MAX_BACKOFF_MS);
}

/**
 * What the connection badge should say.
 *
 * PURE, because the bug was in this decision and not in the socket. `attempts` is a LIFETIME
 * counter that nothing ever reset, so a page left open across a few bridge restarts showed a
 * number that looked like a stuck retry loop even while it was connected — and once it
 * really did stick, there was no way to tell the two apart by looking.
 *
 * Connected always wins, and reconnecting reports the attempts SINCE the last successful
 * connection, which is the only number that answers "is it getting anywhere".
 */
export function linkLabel(connected: boolean, attemptsSinceOpen: number): string {
  if (connected) return "Live";
  if (attemptsSinceOpen <= 0) return "Connecting";
  return `Reconnecting (${attemptsSinceOpen})`;
}
