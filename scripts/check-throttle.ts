/* eslint-disable no-console */
// Assertions on the login/reset throttle.
// Run: npm run check:throttle
//
// WHY THIS EXISTS, and it is not a hypothetical. The throttle gates two endpoints that
// matter — failed logins and "forgot password" — and until now nothing asserted any of it.
// The gap surfaced as an afternoon of misdiagnosis:
//
//   "ive entered my email address of k9xyz@example.com twice today"
//
// against a server log whose most recent reset line was a MONTH old. A locked throttle and
// a request that never arrived are indistinguishable from the outside, because the endpoint
// answers with the same neutral sentence either way — by design, so it cannot be used to
// discover which addresses have accounts. The lock branch is now logged server-side, and
// the behaviour it depends on is asserted here.
//
// MAX_FAILURES, LOCK_MS and DECAY_MS are deliberately NOT imported: they are not exported,
// and hardcoding copies of them here would assert this file against itself. The budget is
// DERIVED from what a fresh key reports instead, so these assertions follow the real
// configuration wherever it is set.
//
// Every group uses a unique key. The module holds one process-wide Map, so assertions that
// share a key silently depend on each other's order.

import { checkThrottle, recordFailure, recordSuccess } from "../lib/auth/throttle";

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
console.log("a key nobody has touched is free");
// ---------------------------------------------------------------------------

const BUDGET = checkThrottle("probe|budget").remaining;
{
  const fresh = checkThrottle("fresh|key|one");
  ok(!fresh.locked, "an unknown key is not locked");
  eq(fresh.retryAfterSeconds, 0, "and has nothing to wait for");
  ok(BUDGET > 0, `the budget is a positive number of attempts (${BUDGET})`);
  // A budget of 1 would lock a user out on their first attempt, which for a reset endpoint
  // reachable from a login page is a self-inflicted outage.
  ok(BUDGET >= 3, "and is large enough that one mistake is not a lockout", BUDGET);
}

// ---------------------------------------------------------------------------
console.log("the budget is spent one attempt at a time, then locks");
// ---------------------------------------------------------------------------
{
  const k = "spend|budget|one";
  // Every attempt up to the bar must stay OPEN. This is the property that made the
  // misdiagnosis possible to rule out by reasoning: if attempts 1..n-1 were silently
  // locked, the absence of log lines would prove nothing.
  for (let i = 1; i < BUDGET; i++) {
    const st = recordFailure(k);
    ok(!st.locked, `attempt ${i} of ${BUDGET} is still allowed through`);
    eq(st.remaining, BUDGET - i, `and reports ${BUDGET - i} left`);
  }
  const last = recordFailure(k);
  ok(last.locked, `attempt ${BUDGET} locks the key`);
  eq(last.remaining, 0, "and reports nothing remaining");
  ok(last.retryAfterSeconds > 0, "with a positive wait", last.retryAfterSeconds);
  // A lock long enough to matter, short enough to be a lock rather than a ban.
  ok(
    last.retryAfterSeconds <= 60 * 60,
    "that is under an hour, so a locked-out operator is not stranded for the day",
    last.retryAfterSeconds,
  );

  // IDEMPOTENT WHILE LOCKED. `checkThrottle` must not extend the lock, or an operator
  // refreshing the page would never be let back in.
  const a = checkThrottle(k).retryAfterSeconds;
  const b = checkThrottle(k).retryAfterSeconds;
  ok(b <= a, "checking a locked key does not extend the lock", { a, b });
}

// ---------------------------------------------------------------------------
console.log("locks are per key, which is what stops one address locking another");
// ---------------------------------------------------------------------------
{
  // The forgot endpoint keys on `forgot|<ip>|<email>`, so this is the property that decides
  // whether one address being hammered can lock out a different one from the same house.
  const mine = "forgot|203.0.113.9|k9xyz@example.test";
  const theirs = "forgot|203.0.113.9|someone-else@example.test";
  for (let i = 0; i < BUDGET; i++) recordFailure(mine);
  ok(checkThrottle(mine).locked, "the hammered key is locked");
  ok(!checkThrottle(theirs).locked, "a different address from the SAME ip is unaffected");

  const elsewhere = "forgot|198.51.100.4|k9xyz@example.test";
  ok(!checkThrottle(elsewhere).locked, "and the same address from a different ip is unaffected");
}

// ---------------------------------------------------------------------------
console.log("a success clears the record");
// ---------------------------------------------------------------------------
{
  const k = "success|clears|one";
  for (let i = 0; i < BUDGET - 1; i++) recordFailure(k);
  ok(checkThrottle(k).remaining < BUDGET, "the key has spent some budget");
  recordSuccess(k);
  eq(checkThrottle(k).remaining, BUDGET, "a success restores the full budget");
  ok(!checkThrottle(k).locked, "and leaves it unlocked");

  // AND IT CLEARS A LOCK TOO. `recordSuccess` deletes the entry outright, so an operator
  // who gets in by another route is not still locked out of this one.
  const locked = "success|clears|locked";
  for (let i = 0; i < BUDGET; i++) recordFailure(locked);
  ok(checkThrottle(locked).locked, "a locked key");
  recordSuccess(locked);
  ok(!checkThrottle(locked).locked, "is unlocked by a success");
}

// ---------------------------------------------------------------------------
console.log("recordFailure reports the same state checkThrottle would");
// ---------------------------------------------------------------------------
{
  // The forgot handler acts on what `checkThrottle` returns and spends with
  // `recordFailure`. If the two disagreed, the branch taken and the budget spent would be
  // describing different things.
  const k = "agree|states|one";
  for (let i = 0; i < BUDGET - 1; i++) {
    const returned = recordFailure(k);
    const checked = checkThrottle(k);
    eq(returned.locked, checked.locked, `locked agrees at attempt ${i + 1}`);
    eq(returned.remaining, checked.remaining, `remaining agrees at attempt ${i + 1}`);
  }
}

// ---------------------------------------------------------------------------
console.log("the tracking map cannot grow without bound");
// ---------------------------------------------------------------------------
{
  // An unauthenticated endpoint takes the key from caller-supplied input — the email — so
  // the map's size is attacker-chosen. Unbounded, that is a memory exhaustion bug in the
  // web tier of a station that is also transmitting.
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 20_000; i++) recordFailure(`flood|${i}|x@example.test`);
  const grew = (process.memoryUsage().heapUsed - before) / 1024 / 1024;
  // 20,000 distinct keys against a cap that sweeps. The figure is generous — the point is
  // that it is BOUNDED, not that it is small.
  ok(grew < 64, `20,000 distinct keys did not grow the heap without bound (${grew.toFixed(1)} MB)`);
  // And the throttle still works afterwards, rather than having swept itself into a state
  // where nothing is tracked at all.
  const k = "after|flood|one";
  for (let i = 0; i < BUDGET; i++) recordFailure(k);
  ok(checkThrottle(k).locked, "and it still locks a key after a flood");
}

console.log("");
if (failed > 0) {
  console.log(`${failed} FAILED`);
  process.exit(1);
}
console.log("all throttle assertions passed");
