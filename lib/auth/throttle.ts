// In-memory login throttle.
//
// Per-process, which is correct for the current deployment: the web tier runs at
// `instances: 1` under PM2 (see ecosystem.config.js). If the web tier is ever
// clustered or scaled out, this must move to Redis alongside the realtime
// pub/sub — otherwise each worker keeps its own counter and the effective limit
// multiplies by the worker count.
//
// This is a speed bump against credential stuffing, not a complete defence. The
// shipped nginx config (deploy/nginx/digishack.conf) now adds per-address
// `limit_req` / `limit_conn` in front of it; fail2ban on top is still worthwhile.
//
// TWO LIMITERS LIVE HERE, and they answer different questions:
//
//   * the LOGIN THROTTLE below counts FAILURES and locks a key out — the right shape for
//     a password form, where success is the normal case and only mistakes should cost;
//   * RateLimiter, further down, counts EVERY request in a fixed window — the right shape
//     for an API, where the question is "how often", not "how wrong". authedRoute
//     (lib/auth/guard.ts) charges each signed-in user or API key to one, and the
//     unauthenticated QSL unsubscribe link charges each address to another.
//
// Both are per-process and bounded, for the same reasons.

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

// ---------------------------------------------------------------------------
// Request rate limiting
// ---------------------------------------------------------------------------
//
// A FIXED WINDOW per key: the first request opens a window of `windowMs`, every request in
// it counts, and the (limit+1)th is refused until the window closes. Chosen over a token
// bucket for one property: the answer to "when can I try again" is exact — the window's
// end — so the Retry-After a client is given is the moment it will actually be let in, not
// an estimate. The cost is that a client can spend up to twice the limit across a window
// boundary, which against limits set at many times normal use does not matter.
//
// BOUNDED. A key is a user id, an API key id or an address. The first two are few; the
// third is chosen by whoever is sending traffic, so the map is capped and swept exactly as
// the login throttle's is. Under a flood of live keys the OLDEST windows are dropped, which
// lets those keys start over early — bounded memory is worth more than a perfect count.

export interface RateLimitOptions {
  /** Short name, for logs and the 429 message. */
  name: string;
  /** Requests allowed per window. */
  limit: number;
  windowMs: number;
  /** Most keys tracked at once. */
  maxKeys?: number;
}

export interface RateDecision {
  allowed: boolean;
  limit: number;
  /** Requests left in the current window, after this one. */
  remaining: number;
  /** Zero when allowed; otherwise whole seconds until the window closes, at least 1. */
  retryAfterSeconds: number;
}

interface RateWindow {
  start: number;
  count: number;
}

export class RateLimiter {
  readonly name: string;
  readonly limit: number;
  readonly windowMs: number;
  readonly maxKeys: number;
  private readonly windows = new Map<string, RateWindow>();

  constructor(opts: RateLimitOptions) {
    this.name = opts.name;
    this.limit = opts.limit;
    this.windowMs = opts.windowMs;
    this.maxKeys = opts.maxKeys ?? MAX_TRACKED_KEYS;
  }

  /** Count one request against `key` and say whether it may proceed. */
  hit(key: string, now: number = Date.now()): RateDecision {
    let w = this.windows.get(key);

    if (!w || now - w.start >= this.windowMs) {
      // A new window goes to the END of the map, so iteration order is oldest-window
      // first and eviction below can drop from the front without sorting.
      if (w) this.windows.delete(key);
      else if (this.windows.size >= this.maxKeys) this.evict(now);
      w = { start: now, count: 0 };
      this.windows.set(key, w);
    }

    // Refused requests are not counted: a client hammering a closed window must not push
    // its own reopening further away, or Retry-After would be a lie.
    if (w.count >= this.limit) {
      return {
        allowed: false,
        limit: this.limit,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((w.start + this.windowMs - now) / 1000)),
      };
    }

    w.count += 1;
    return { allowed: true, limit: this.limit, remaining: this.limit - w.count, retryAfterSeconds: 0 };
  }

  /** Keys currently tracked. For the checks, and for anyone wondering about memory. */
  get size(): number {
    return this.windows.size;
  }

  /**
   * Make room. Oldest window first (see hit), so the expired ones are a PREFIX of the map
   * and the walk stops at the first live one; then live windows go, oldest first, down to
   * three quarters full. Always that far down, or a map that is full of windows expiring
   * one at a time would make every new key pay for a walk of the whole map.
   */
  private evict(now: number): void {
    const target = Math.floor((this.maxKeys * 3) / 4);
    for (const [key, w] of this.windows) {
      const expired = now - w.start >= this.windowMs;
      if (!expired && this.windows.size <= target) break;
      this.windows.delete(key);
    }
  }
}

// THE LIMITS, and the arithmetic behind them. Measured from the client code, not guessed:
// every timer on the two pages an operator leaves open all day, per visible tab, per minute.
//
//   Digital (/decodes)                       Rig (/rig)
//     /api/bridge/gate     every 4 s   15      /api/bridge/gate     every 4 s   15
//     /api/digital/worth   per cycle  <=16      /api/bridge/status   every 2 s   30
//     /api/digital/broadcast   30 s     2      /api/pota/spots          60 s    1
//     /api/contest/ft8battle   20 s     3      /api/cluster/spots       60 s    1
//     HeardBy, SstvPanel       60 s     2      each control press: the POST and a reload, 2
//     /api/stats/bands        120 s   0.5
//     /api/stats/today   per logged QSO  ~4
//
// (worth is per new decode cycle: 4 a minute on FT8, 8 on FT4, 16 on FT2.) Both pages open
// is about 110 a minute plus whatever the operator clicks. The general limit is 2,400 a
// minute per user — twenty times that. Generous on purpose: a club running Field Day from
// one shared account on a dozen devices is normal use, and must not be what this refuses.
// It still caps a stolen session or a runaway script at 40 a second.
//
// API keys are their own key, so a desk dial polling /api/v1/radio/state "a few times a
// second" (docs/radio-api.md: the documented contract) spends its own 2,400, not the
// operator's browser budget.

const MINUTE = 60_000;

/** Every authenticated API route, per user or per API key. */
export const API_GENERAL_LIMIT = new RateLimiter({ name: "api", limit: 2400, windowMs: MINUTE });

/**
 * Whole-logbook work: ADIF and CSV export, awards over the full log, ADIF import. Each is
 * seconds of database time on a big log and none is something a person does more than a
 * few times a minute; a logger pushing one ADIF record per contact stays under it too
 * (a fast FT4 run is about five a minute).
 */
export const API_HEAVY_LIMIT = new RateLimiter({ name: "heavy", limit: 10, windowMs: MINUTE });

/**
 * /api/qso-map. Heavy like the exports, but the map pages refetch it on every filter
 * change — the grid map asks twice per change, slim and full — so an operator clicking
 * through the bands makes twenty in a minute. A few a minute would 429 normal use.
 */
export const API_MAP_LIMIT = new RateLimiter({ name: "map", limit: 30, windowMs: MINUTE });

/**
 * The QSL unsubscribe link, per address. Unauthenticated, so this is the only budget it
 * has. Generous enough for a mail provider's One-Click POSTs, which arrive from the
 * provider's servers rather than from the person, several people sharing one of them.
 */
export const UNSUBSCRIBE_LIMIT = new RateLimiter({ name: "unsubscribe", limit: 10, windowMs: MINUTE });
