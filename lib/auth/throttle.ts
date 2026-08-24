// In-memory login throttle.
//
// Per-process, which is correct for the current deployment: the web tier runs at
// `instances: 1` under PM2 (see ecosystem.config.js). If the web tier is ever
// clustered or scaled out, this must move to Redis alongside the realtime
// pub/sub — otherwise each worker keeps its own counter and the effective limit
// multiplies by the worker count.
//
// This is a speed bump against credential stuffing, not a complete defence.
// Fronting DigiShack with fail2ban or NGINX `limit_req` is still worthwhile.

interface Attempt {
  failures: number;
  /** Epoch ms until which further attempts are refused outright. */
  lockedUntil: number;
  lastFailureAt: number;
}

const attempts = new Map<string, Attempt>();

const MAX_FAILURES = 8;
const LOCK_MS = 15 * 60 * 1000;
/** Failures older than this stop counting, so an honest typo doesn't accumulate forever. */
const DECAY_MS = 30 * 60 * 1000;
/** Bound the map so a distributed attack can't grow it without limit. */
const MAX_TRACKED_KEYS = 10_000;

export interface ThrottleState {
  locked: boolean;
  retryAfterSeconds: number;
  remaining: number;
}

export function checkThrottle(key: string): ThrottleState {
  const now = Date.now();
  const entry = attempts.get(key);

  if (!entry) return { locked: false, retryAfterSeconds: 0, remaining: MAX_FAILURES };

  if (entry.lockedUntil > now) {
    return {
      locked: true,
      retryAfterSeconds: Math.ceil((entry.lockedUntil - now) / 1000),
      remaining: 0,
    };
  }

  if (now - entry.lastFailureAt > DECAY_MS) {
    attempts.delete(key);
    return { locked: false, retryAfterSeconds: 0, remaining: MAX_FAILURES };
  }

  return {
    locked: false,
    retryAfterSeconds: 0,
    remaining: Math.max(0, MAX_FAILURES - entry.failures),
  };
}

export function recordFailure(key: string): ThrottleState {
  const now = Date.now();

  if (attempts.size >= MAX_TRACKED_KEYS) sweep(now);

  const entry = attempts.get(key) ?? {
    failures: 0,
    lockedUntil: 0,
    lastFailureAt: now,
  };

  // A decayed entry starts over rather than resuming its old count.
  if (now - entry.lastFailureAt > DECAY_MS) entry.failures = 0;

  entry.failures += 1;
  entry.lastFailureAt = now;

  if (entry.failures >= MAX_FAILURES) {
    entry.lockedUntil = now + LOCK_MS;
    entry.failures = 0; // the lock replaces the counter
  }

  attempts.set(key, entry);
  return checkThrottle(key);
}

export function recordSuccess(key: string): void {
  attempts.delete(key);
}

function sweep(now: number): void {
  for (const [key, entry] of attempts) {
    if (entry.lockedUntil <= now && now - entry.lastFailureAt > DECAY_MS) {
      attempts.delete(key);
    }
  }
  // Still full of live locks — drop the oldest rather than grow without bound.
  if (attempts.size >= MAX_TRACKED_KEYS) {
    const oldest = [...attempts.entries()]
      .sort((a, b) => a[1].lastFailureAt - b[1].lastFailureAt)
      .slice(0, Math.floor(MAX_TRACKED_KEYS / 4));
    for (const [key] of oldest) attempts.delete(key);
  }
}
