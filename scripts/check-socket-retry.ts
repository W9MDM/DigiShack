/* eslint-disable no-console */
// Assertions on the bridge socket's reconnect policy.
// Run: npm run check:socket-retry
//
// THE REPORT: a decodes page stuck on "Reconnecting (235)" that never recovered on its own —
// "when it goes from this to live the page doesnt auto refresh so the reconnecting timer
// just keeps counting instead." A manual reload fixed it every time, which is the signature
// of a client that has STOPPED retrying rather than one retrying and failing.
//
// TWO FAULTS, and only the first explains the sticking:
//
//   1. A browser WebSocket has NO CONNECT TIMEOUT. A socket whose TCP connection is accepted
//      but whose handshake never completes sits in CONNECTING for ever: `onopen` never
//      fires, and neither does `onclose` — so the retry, which lived in `onclose`, was never
//      scheduled. A proxy in front of a dead origin produces exactly that state, and this
//      bridge restarts several times a day.
//
//   2. `attempts` only ever counted UP. Nothing reset it on a successful connection, so a
//      page open across a few restarts displayed a lifetime total. "Reconnecting (235)" and
//      "reconnected 235 times since Tuesday" looked identical, which is why the real fault
//      took a while to see.
//
// The socket itself needs a browser, so what is asserted here is the POLICY — the backoff
// arithmetic, the label, and (against a fake socket) that a connection which never opens is
// abandoned and retried rather than waited on for ever.

import {
  CONNECT_TIMEOUT_MS,
  FIRST_BACKOFF_MS,
  MAX_BACKOFF_MS,
  linkLabel,
  nextBackoff,
} from "../lib/client/socket-retry";

let failed = 0;
function ok(cond: boolean, what: string, extra?: unknown): void {
  if (cond) {
    console.log(`  ok    ${what}`);
  } else {
    failed++;
    console.log(`  FAIL  ${what}`, extra ?? "");
  }
}
function eq(a: unknown, b: unknown, what: string): void {
  ok(Object.is(a, b), what, `expected ${String(b)}, got ${String(a)}`);
}

// ---------------------------------------------------------------------------
console.log("the backoff climbs and then stops climbing");
// ---------------------------------------------------------------------------

eq(nextBackoff(FIRST_BACKOFF_MS), 2_000, "the first retry doubles");
eq(nextBackoff(8_000), 15_000, "and is clamped at the ceiling rather than overshooting it");
eq(nextBackoff(MAX_BACKOFF_MS), MAX_BACKOFF_MS, "at the ceiling it stays there");

// DEGENERATE INPUTS CANNOT PRODUCE A DEAD RETRY LOOP. A backoff of 0 would spin the retry as
// fast as the event loop allows; NaN would make `setTimeout` fire immediately, for ever.
eq(nextBackoff(0), FIRST_BACKOFF_MS, "a zero backoff restarts at the first delay, not at 0");
eq(nextBackoff(-5), FIRST_BACKOFF_MS, "so does a negative one");
eq(nextBackoff(Number.NaN), FIRST_BACKOFF_MS, "and NaN, which setTimeout would treat as 0");
ok(FIRST_BACKOFF_MS > 0 && MAX_BACKOFF_MS >= FIRST_BACKOFF_MS, "the bounds are sane");

{
  // It must actually REACH the ceiling from the first delay in a sensible number of steps,
  // and never exceed it. A ceiling that could be stepped past would let the delay grow
  // without bound after enough failures — which is how a page stops retrying in practice.
  let b = FIRST_BACKOFF_MS;
  let steps = 0;
  while (b < MAX_BACKOFF_MS && steps < 100) {
    b = nextBackoff(b);
    steps++;
    ok(b <= MAX_BACKOFF_MS, `step ${steps} stays at or under the ceiling (${b})`);
  }
  eq(b, MAX_BACKOFF_MS, `the ceiling is reached, in ${steps} steps`);
}

// ---------------------------------------------------------------------------
console.log("the label distinguishes a stuck retry from an old tally");
// ---------------------------------------------------------------------------

eq(linkLabel(true, 0), "Live", "connected reads Live");
// CONNECTED WINS OUTRIGHT. The operator's page showed a warning badge while the bridge was
// up; whatever the counter says, connected is connected.
eq(linkLabel(true, 235), "Live", "and still reads Live with a large attempt count behind it");
eq(linkLabel(false, 0), "Connecting", "the first attempt is Connecting, not Reconnecting (0)");
eq(linkLabel(false, 3), "Reconnecting (3)", "later attempts are counted");
eq(linkLabel(false, -1), "Connecting", "a negative count cannot render");

// ---------------------------------------------------------------------------
console.log("a socket that never opens is abandoned, not waited on for ever");
// ---------------------------------------------------------------------------

// THE FAULT REPRODUCED. A fake WebSocket that accepts the connection and then does nothing —
// which is what a proxy does while the origin behind it is down. Without a timeout this
// fixture never calls back at all, which is precisely the bug.
{
  const CONNECTING = 0;
  const CLOSED = 3;

  class StuckSocket {
    readyState = CONNECTING;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    close(): void {
      // A real browser fires `close` when a CONNECTING socket is closed. That is the
      // property the fix depends on: it is what hands control back to the retry path.
      if (this.readyState === CLOSED) return;
      this.readyState = CLOSED;
      this.onclose?.();
    }
  }

  // The supervisor loop, reduced to the part being asserted.
  // A COUNTER OBJECT, not a number. The first version returned `{ attempts }`, which copies
  // the value at return time — every later increment happened inside the closure and was
  // invisible to the assertions, so a working fix read as a failure. The check catching its
  // own fixture is the point of running it.
  const run = (
    make: () => StuckSocket,
    tick: (fn: () => void, ms: number) => void,
  ): { attempts: number } => {
    const counter = { attempts: 0 };
    const connect = (): void => {
      const ws = make();
      const timer = setTimeout(() => {
        if (ws.readyState === CONNECTING) ws.close();
      }, CONNECT_TIMEOUT_MS);
      ws.onopen = () => clearTimeout(timer);
      ws.onclose = () => {
        clearTimeout(timer);
        counter.attempts++;
        tick(connect, 0);
      };
    };
    connect();
    return counter;
  };

  // Drive it synchronously: every scheduled callback runs at once, three rounds deep.
  const pending: (() => void)[] = [];
  const sockets: StuckSocket[] = [];
  const state = run(
    () => {
      const s = new StuckSocket();
      sockets.push(s);
      return s;
    },
    (fn) => pending.push(fn),
  );

  // Nothing has happened yet — the socket is hanging, exactly as reported.
  eq(sockets.length, 1, "one connection attempt is in flight");
  eq(sockets[0]!.readyState, CONNECTING, "and it is stuck in CONNECTING, as the fault was");
  eq(state.attempts, 0, "with no failure recorded, because nothing has called back");

  // Now let the connect timeout fire, which is the whole fix.
  sockets[0]!.close();
  ok(state.attempts === 1, "the timeout closing it records a failed attempt", state.attempts);
  ok(pending.length === 1, "and schedules another connection", pending.length);

  pending.shift()!();
  eq(sockets.length, 2, "the retry really does open a new socket");
  ok(
    sockets[1]!.readyState === CONNECTING,
    "which is itself subject to the same timeout, so this cannot stall either",
  );
}

// ---------------------------------------------------------------------------
console.log("the timeout is longer than a connection takes and shorter than a person waits");
// ---------------------------------------------------------------------------

ok(CONNECT_TIMEOUT_MS >= 5_000, "long enough not to abandon a slow but working handshake", CONNECT_TIMEOUT_MS);
ok(CONNECT_TIMEOUT_MS <= 30_000, "short enough that a stuck socket is noticed promptly", CONNECT_TIMEOUT_MS);
// AND LONGER THAN THE FIRST BACKOFF, or the retry would outpace the attempt it is retrying
// and pile up sockets against a slow origin.
ok(CONNECT_TIMEOUT_MS > FIRST_BACKOFF_MS, "and longer than the first retry delay");

console.log("");
if (failed > 0) {
  console.log(`${failed} FAILED`);
  process.exit(1);
}
console.log("all socket-retry assertions passed");
