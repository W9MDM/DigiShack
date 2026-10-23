/* eslint-disable no-console */
// Assertions on the API rate limits: the per-user / per-key limiter in authedRoute, the
// tighter budgets on the whole-logbook routes, the per-address cap on the QSL unsubscribe
// link, and the nginx zones in front of all of it.
// Run: npm run check:rate-limit
//
// WHY THIS EXISTS. A security audit asked for rate limiting after another club site took
// eight million requests with nothing in front of it. A limiter is the kind of code that
// is easy to get subtly wrong in the direction nobody notices until the day it matters —
// or in the other direction, where the operator's own Digital page starts answering 429
// on a busy band. Both directions are asserted here:
//
//   * it REFUSES: over the limit is a 429 with a Retry-After that is the real window end;
//   * it does NOT refuse normal use: the limits are checked against the polling the
//     client code actually does, so lowering one below that fails here, not in the shack;
//   * it is BOUNDED: a flood of distinct keys cannot grow the process without limit.
//
// No database. A fake Prisma is put on globalThis BEFORE anything that imports
// lib/db/prisma is loaded, which is why the application imports below are dynamic.
// Every group uses its own users and keys: the limiters are process-wide Maps.

import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

let failed = 0;
function ok(cond: boolean, what: string, extra?: unknown): void {
  if (cond) console.log(`  ok    ${what}`);
  else {
    failed++;
    console.log(`  FAIL  ${what}`, extra ?? "");
  }
}
function eq(a: unknown, b: unknown, what: string): void {
  ok(Object.is(a, b), what, `expected ${String(b)}, got ${String(a)}`);
}

// ---------------------------------------------------------------------------
// The fake database: sessions and API keys, nothing else
// ---------------------------------------------------------------------------

type Role = "VIEWER" | "OPERATOR" | "ADMIN";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const sessions = new Map<string, unknown>();
const apiKeys = new Map<string, unknown>();
let nextId = 0;

(globalThis as unknown as { prisma?: unknown }).prisma = {
  session: {
    findUnique: async (args: { where: { tokenHash: string } }) => sessions.get(args.where.tokenHash) ?? null,
    update: async () => ({}),
    delete: async () => ({}),
  },
  apiKey: {
    findUnique: async (args: { where: { keyHash: string } }) => apiKeys.get(args.where.keyHash) ?? null,
    update: async () => ({}),
  },
  user: { count: async () => 1 },
  setting: { findMany: async () => [] },
  // Anything else a real handler reaches for is a failure, which authedRoute turns into a
  // 500. That is enough: the budget is spent before the handler runs, so a route's tier is
  // visible from where the 500s turn into 429s.
};

/** A signed-in user (or another session of an existing one); returns the cookie token. */
function addUser(role: Role = "OPERATOR", existing?: string): { token: string; userId: string } {
  const token = randomBytes(24).toString("base64url");
  const userId = existing ?? `u${nextId++}`;
  sessions.set(sha256(token), {
    id: `s${nextId++}`,
    tokenHash: sha256(token),
    expiresAt: new Date(Date.now() + 86_400_000),
    lastSeenAt: new Date(), // inside the five-minute window: no session write
    user: { id: userId, email: `${userId}@example.test`, name: userId, callsign: null, role, active: true },
  });
  return { token, userId };
}

/** An API key; returns the bearer token. */
function addKey(role: Role = "OPERATOR"): string {
  const token = `dsk_${randomBytes(24).toString("base64url")}`;
  apiKeys.set(sha256(token), {
    id: `k${nextId++}`,
    name: "desk dial",
    role,
    active: true,
    expiresAt: null,
    lastUsedAt: new Date(),
  });
  return token;
}

// ---------------------------------------------------------------------------
// Request and response doubles
// ---------------------------------------------------------------------------

interface Caller {
  cookie?: string;
  bearer?: string;
  ip?: string;
}

function fakeReq(c: Caller, method = "GET", url = "/api/x"): IncomingMessage {
  const headers: Record<string, string> = {};
  if (c.cookie) headers.cookie = `digishack_session=${c.cookie}`;
  if (c.bearer) headers.authorization = `Bearer ${c.bearer}`;
  if (c.ip) headers["cf-connecting-ip"] = c.ip;
  return {
    method,
    url,
    query: {},
    body: {},
    headers,
    cookies: c.cookie ? { digishack_session: c.cookie } : {},
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as IncomingMessage;
}

interface FakeRes {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: string;
  headersSent: boolean;
}
function fakeRes(): FakeRes & ServerResponse {
  const r = {
    statusCode: 200,
    headers: {} as Record<string, string | string[]>,
    body: "",
    headersSent: false,
    setHeader(k: string, v: string | string[]) {
      r.headers[k.toLowerCase()] = v;
      return r;
    },
    getHeader(k: string) {
      return r.headers[k.toLowerCase()];
    },
    status(code: number) {
      r.statusCode = code;
      return r;
    },
    send(b: string) {
      r.body = b;
      r.headersSent = true;
    },
    write(b: string) {
      r.body += b;
      r.headersSent = true;
      return true;
    },
    end(b?: string) {
      r.body += b ?? "";
      r.headersSent = true;
    },
  };
  return r as unknown as FakeRes & ServerResponse;
}

type Handler = (req: never, res: never) => Promise<void> | void;
async function call(h: Handler, c: Caller, method = "GET"): Promise<FakeRes> {
  const res = fakeRes();
  await h(fakeReq(c, method) as never, res as never);
  return res;
}

/** Calls whose handlers fail on the fake database log loudly; that noise is expected. */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const orig = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = orig;
  }
}

/** How many calls get through before the first 429, up to `max`. */
async function budgetOf(h: Handler, c: Caller, max: number, method = "GET"): Promise<number> {
  return quietly(async () => {
    for (let i = 0; i < max; i++) {
      const r = await call(h, c, method);
      if (r.statusCode === 429) return i;
    }
    return max;
  });
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const throttle = await import("../lib/auth/throttle");
  const { RateLimiter, API_GENERAL_LIMIT, API_HEAVY_LIMIT, API_MAP_LIMIT, UNSUBSCRIBE_LIMIT } = throttle;
  const { authedRoute } = await import("../lib/auth/guard");

  // -------------------------------------------------------------------------
  console.log("the limiter: under the limit passes, over it is refused, the window resets");
  // -------------------------------------------------------------------------
  {
    const L = new RateLimiter({ name: "t", limit: 5, windowMs: 60_000 });
    const t0 = 1_000_000;
    for (let i = 1; i <= 5; i++) {
      const d = L.hit("a", t0 + i);
      ok(d.allowed, `request ${i} of 5 is allowed`);
      eq(d.remaining, 5 - i, `and reports ${5 - i} left`);
    }
    const over = L.hit("a", t0 + 10_000);
    ok(!over.allowed, "request 6 is refused");
    // Window opened at t0+1, closes at t0+60_001; asked at t0+10_000 → 50.001 s → 51.
    eq(over.retryAfterSeconds, 51, "Retry-After is the window's end, rounded UP");
    const later = L.hit("a", t0 + 59_500);
    eq(later.retryAfterSeconds, 1, "and counts down: half a second left is 1, never 0");
    // Refused requests did not extend anything: the window still closes where it did.
    ok(L.hit("a", t0 + 60_001).allowed, "exactly at the window's end it is let in again");
    eq(L.hit("a", t0 + 60_002).remaining, 3, "with a fresh budget (two spent)");
    ok(L.hit("b", t0 + 10_000).allowed, "a different key was never affected");

    // A client that honours Retry-After exactly is admitted on that try.
    const R = new RateLimiter({ name: "r", limit: 1, windowMs: 60_000 });
    R.hit("c", 0);
    const wait = R.hit("c", 12_345).retryAfterSeconds;
    ok(R.hit("c", 12_345 + wait * 1000).allowed, `waiting the advertised ${wait} s is enough`);
  }

  // -------------------------------------------------------------------------
  console.log("the limiter's memory is bounded");
  // -------------------------------------------------------------------------
  {
    const L = new RateLimiter({ name: "e", limit: 3, windowMs: 60_000, maxKeys: 1000 });
    for (let i = 0; i < 50_000; i++) L.hit(`flood|${i}`, 5_000 + i);
    ok(L.size <= 1000, `50,000 live keys against a cap of 1,000 left ${L.size} tracked`);
    // Expired windows are what is swept first: a key from long ago cannot pin a slot.
    const M = new RateLimiter({ name: "e2", limit: 3, windowMs: 1_000, maxKeys: 100 });
    for (let i = 0; i < 100; i++) M.hit(`old|${i}`, 0);
    M.hit("new", 10_000);
    eq(M.size, 1, "a full map of expired windows is swept to just the newcomer");
    // And it still limits after a flood rather than having swept itself useless.
    for (let i = 0; i < 3; i++) L.hit("after", 100_000);
    ok(!L.hit("after", 100_001).allowed, "and still refuses a key over its limit afterwards");

    // The real limiters, at their real cap, under a flood of addresses.
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 40_000; i++) UNSUBSCRIBE_LIMIT.hit(`198.18.${i >> 8}.${i & 255}`);
    const grew = (process.memoryUsage().heapUsed - before) / 1024 / 1024;
    ok(UNSUBSCRIBE_LIMIT.size <= UNSUBSCRIBE_LIMIT.maxKeys, `40,000 addresses: ${UNSUBSCRIBE_LIMIT.size} tracked, cap ${UNSUBSCRIBE_LIMIT.maxKeys}`);
    ok(grew < 64, `and the heap did not grow without bound (${grew.toFixed(1)} MB)`);
  }

  // -------------------------------------------------------------------------
  console.log("the limits leave headroom over what the client actually polls");
  // -------------------------------------------------------------------------
  {
    // Per visible tab, per minute, from the timers in the client code (lib/auth/throttle.ts
    // has the same table). If a poll is added or tightened, add it here.
    const digital = {
      "/api/bridge/gate (4 s)": 15,
      "/api/digital/worth (per cycle, FT2 worst)": 16,
      "/api/digital/broadcast (30 s)": 2,
      "/api/contest/ft8battle (20 s)": 3,
      "HeardBy + SstvPanel (60 s)": 2,
      "/api/stats/bands (120 s)": 0.5,
      "/api/stats/today (per logged QSO)": 4,
      "control presses": 10,
    };
    const rig = {
      "/api/bridge/gate (4 s)": 15,
      "/api/bridge/status (2 s)": 30,
      "/api/pota/spots (60 s)": 1,
      "/api/cluster/spots (60 s)": 1,
      "control presses, POST + reload": 20,
    };
    const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
    const perMinute = sum(digital) + sum(rig);
    const general = (API_GENERAL_LIMIT.limit * 60_000) / API_GENERAL_LIMIT.windowMs;
    ok(
      general >= 8 * perMinute,
      `general ${general}/min is >= 8x Digital + Rig together (${perMinute}/min)`,
    );
    // The documented dial contract: "a few times a second" on /api/v1/radio/state, on its key.
    ok(general >= 5 * 60 * 2, `general ${general}/min holds a dial polling 5/s with 2x to spare`);
    // The grid map fetches /api/qso-map twice per filter change; ten bands clicked through.
    ok(API_MAP_LIMIT.limit >= 20, `the map budget (${API_MAP_LIMIT.limit}) holds clicking through ten bands`);
    ok(API_MAP_LIMIT.limit < API_GENERAL_LIMIT.limit / 10, "and is far tighter than the general one");
    ok(
      API_HEAVY_LIMIT.limit >= 5 && API_HEAVY_LIMIT.limit <= 15,
      `the heavy budget is a few a minute (${API_HEAVY_LIMIT.limit}), above a fast FT4 run's ADIF pushes`,
    );
  }

  // -------------------------------------------------------------------------
  console.log("authedRoute: over the general limit is a 429 with Retry-After and a JSON body");
  // -------------------------------------------------------------------------
  {
    let ran = 0;
    const h = authedRoute({
      GET: { role: "VIEWER", handler: (_q, res) => { ran++; res.status(200).end("ok"); } },
    });
    const me = addUser();
    const first = await call(h, { cookie: me.token });
    eq(first.statusCode, 200, "a signed-in request is served");
    const n = await budgetOf(h, { cookie: me.token }, API_GENERAL_LIMIT.limit + 5);
    eq(n, API_GENERAL_LIMIT.limit - 1, `the rest of the budget (${API_GENERAL_LIMIT.limit - 1}) is served, then refused`);
    eq(ran, API_GENERAL_LIMIT.limit, "the handler ran exactly `limit` times");
    const r = await call(h, { cookie: me.token });
    eq(r.statusCode, 429, "429");
    const ra = Number(r.headers["retry-after"]);
    ok(Number.isInteger(ra) && ra >= 1 && ra <= 60, "Retry-After is whole seconds within the window", r.headers["retry-after"]);
    eq(r.headers["cache-control"], "no-store", "and the refusal is not cacheable");
    const body = JSON.parse(r.body) as { error?: unknown; retryAfterSeconds?: unknown };
    ok(typeof body.error === "string" && body.error.length > 0, "body.error says what happened", body);
    eq(body.retryAfterSeconds, ra, "body.retryAfterSeconds matches the header");
    eq(ran, API_GENERAL_LIMIT.limit, "and the handler did not run for the refused request");

    // Unauthenticated requests are not charged to anyone, and are still a 401.
    const anon = await call(h, {});
    eq(anon.statusCode, 401, "no credentials is still a 401, not a 429");
  }

  // -------------------------------------------------------------------------
  console.log("per user and per key: one exhausting its budget does not touch another");
  // -------------------------------------------------------------------------
  {
    const tight = new RateLimiter({ name: "iso", limit: 3, windowMs: 60_000 });
    const h = authedRoute({
      GET: { role: "VIEWER", allowApiKey: true, rateLimit: tight, handler: (_q, res) => void res.status(200).end("ok") },
    });
    const alice = addUser();
    const bob = addUser();
    const key = addKey();
    const key2 = addKey();
    eq(await budgetOf(h, { cookie: alice.token }, 10), 3, "alice gets 3");
    eq((await call(h, { cookie: alice.token })).statusCode, 429, "and then 429");
    eq(await budgetOf(h, { cookie: bob.token }, 10), 3, "bob, same route, still gets all 3");
    eq(await budgetOf(h, { bearer: key }, 10), 3, "an API key gets its own 3");
    eq(await budgetOf(h, { bearer: key2 }, 10), 3, "and a second key its own");
    // Two sessions of one user share the user's budget: per USER, not per browser, or
    // signing in again would be a way round it.
    const alicePhone = addUser("OPERATOR", alice.userId);
    eq((await call(h, { cookie: alicePhone.token })).statusCode, 429, "alice's second session shares her spent budget");
    // A browser that also carries a key is charged as the session, as authedRoute prefers it.
    const carol = addUser();
    const carolKey = addKey();
    for (let i = 0; i < 3; i++) await call(h, { cookie: carol.token, bearer: carolKey });
    eq(await budgetOf(h, { bearer: carolKey }, 10), 3, "a key sent alongside a session was not charged");
  }

  // -------------------------------------------------------------------------
  console.log("the whole-logbook routes are on their tighter budgets");
  // -------------------------------------------------------------------------
  {
    // The REAL route modules, so a tier dropped from one of them fails here. Their handlers
    // fail against the fake database (500), which does not matter: the budget is spent
    // before the handler runs, and the 429 arrives on schedule or it does not.
    const routes: Array<[string, Handler, number, "cookie" | "key", string]> = [
      ["/api/adif/export", (await import("../pages/api/adif/export")).default as Handler, API_HEAVY_LIMIT.limit, "cookie", "GET"],
      ["/api/adif/csv", (await import("../pages/api/adif/csv")).default as Handler, API_HEAVY_LIMIT.limit, "cookie", "GET"],
      ["/api/qso-map", (await import("../pages/api/qso-map")).default as Handler, API_MAP_LIMIT.limit, "cookie", "GET"],
      ["/api/v1/awards", (await import("../pages/api/v1/awards")).default as Handler, API_HEAVY_LIMIT.limit, "key", "GET"],
      ["/api/v1/adif", (await import("../pages/api/v1/adif")).default as Handler, API_HEAVY_LIMIT.limit, "key", "POST"],
    ];
    for (const [name, h, want, kind, method] of routes) {
      // A fresh caller per route; the heavy routes share one budget, which is intended.
      const c: Caller = kind === "cookie" ? { cookie: addUser().token } : { bearer: addKey() };
      eq(await budgetOf(h, c, want + 5, method), want, `${name}: ${want} a minute, then 429`);
    }

    // And the radio surface is NOT: a dial polls state several times a second on its own
    // key, and turns the knob through commands. Read from source rather than called, since
    // calling it would reach for a real bridge on this machine.
    for (const f of ["state", "commands", "capabilities"]) {
      const src = readFileSync(path.resolve(__dirname, `../pages/api/v1/radio/${f}.ts`), "utf8");
      ok(!/rateLimits*:/.test(src), `/api/v1/radio/${f} stays on the general budget`);
    }
  }

  // -------------------------------------------------------------------------
  console.log("the unsubscribe link is capped per address");
  // -------------------------------------------------------------------------
  {
    const unsub = (await import("../pages/api/qsl/unsubscribe")).default as Handler;
    const N = UNSUBSCRIBE_LIMIT.limit;
    // Invalid tokens, so nothing is written; the budget is spent before the token is read.
    let served = 0;
    for (let i = 0; i < N; i++) {
      const r = await call(unsub, { ip: "203.0.113.50" });
      if (r.statusCode === 400) served++;
    }
    eq(served, N, `the first ${N} from one address are answered (400: bad token)`);
    const r = await call(unsub, { ip: "203.0.113.50" });
    eq(r.statusCode, 429, "the next one is 429");
    ok(Number(r.headers["retry-after"]) >= 1, "with a Retry-After", r.headers["retry-after"]);
    ok(/Too many requests/.test(r.body), "and a page a stranger can read, not a code");
    eq((await call(unsub, { ip: "203.0.113.50" }, "POST")).statusCode, 429, "POST (One-Click) shares the same budget");
    eq((await call(unsub, { ip: "198.51.100.7" })).statusCode, 400, "a different address is unaffected");
    // One address in two spellings is one address (lib/auth/client-ip.ts normalises).
    eq((await call(unsub, { ip: "::ffff:203.0.113.50" })).statusCode, 429, "the IPv4-mapped spelling is the same address");
    // Through the tunnel the socket is loopback: keyed on CF-Connecting-IP, not on that.
    for (let i = 0; i < N; i++) await call(unsub, { ip: "192.0.2.1" });
    eq((await call(unsub, { ip: "192.0.2.2" })).statusCode, 400, "two visitors behind the same tunnel do not share a bucket");
  }

  // -------------------------------------------------------------------------
  console.log("nginx: zones in http context, 429s, and the sockets and static assets untouched");
  // -------------------------------------------------------------------------
  {
    const conf = readFileSync(path.resolve(__dirname, "../deploy/nginx/digishack.conf"), "utf8")
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
    const firstServer = conf.indexOf("server {");
    const zoneAt = (re: RegExp) => conf.search(re);
    for (const z of ["digishack_api", "digishack_heavy", "digishack_pages"]) {
      const at = zoneAt(new RegExp(`limit_req_zone\\s+\\$binary_remote_addr\\s+zone=${z}:`));
      ok(at !== -1 && at < firstServer, `${z} is defined on $binary_remote_addr, outside server{}`);
    }
    const conn = zoneAt(/limit_conn_zone\s+\$binary_remote_addr\s+zone=digishack_conn:/);
    ok(conn !== -1 && conn < firstServer, "digishack_conn likewise");
    ok(/real_ip_header\s+CF-Connecting-IP;/.test(conf), "the key is the real visitor (real_ip from CF-Connecting-IP)");
    ok(/limit_req_status\s+429;/.test(conf) && /limit_conn_status\s+429;/.test(conf), "refusals are 429, not 503");

    function block(loc: string): string {
      const start = conf.indexOf(`location ${loc} {`);
      if (start === -1) return "";
      return conf.slice(start, conf.indexOf("}", start));
    }
    for (const loc of ["/ws/decodes", "/ws/audio", "/_next/static/"]) {
      const b = block(loc);
      ok(b !== "" && !/limit_req|limit_conn/.test(b), `${loc} is not rate limited`);
    }
    ok(/limit_req\s+zone=digishack_api\b/.test(block("/api/")), "/api/ is on the general zone");
    ok(/limit_req\s+zone=digishack_api\b/.test(block("/api/integrations/")), "/api/integrations/ too");
    ok(/limit_req\s+zone=digishack_pages\b/.test(block("/")), "pages are on their own zone");

    const heavy = /location ~ (\S+) \{([^}]*)\}/.exec(conf);
    ok(heavy !== null && /zone=digishack_heavy\b/.test(heavy[2]!), "a regex location carries the heavy zone");
    const re = new RegExp(heavy?.[1] ?? "^$");
    for (const p of ["/api/adif/export", "/api/adif/csv", "/api/qso-map", "/api/v1/adif", "/api/v1/awards"]) {
      ok(re.test(p), `${p} matches it`);
    }
    for (const p of ["/api/v1/radio/state", "/api/v1/radio/commands", "/api/v1/qsos", "/api/bridge/status", "/api/adif/import"]) {
      ok(!re.test(p), `${p} does not`);
    }

    // nginx's general rate must sit above the app's, or the app's precise 429 (with its
    // JSON and Retry-After) is never what a client sees.
    const rate = /zone=digishack_api:\S+\s+rate=(\d+)r\/s/.exec(conf);
    const perMin = Number(rate?.[1] ?? 0) * 60;
    ok(perMin >= (API_GENERAL_LIMIT.limit * 60_000) / API_GENERAL_LIMIT.windowMs, `nginx /api/ (${perMin}/min) >= the app's per-user limit`);
    const hv = /zone=digishack_heavy:\S+\s+rate=(\d+)r\/m/.exec(conf);
    ok(Number(hv?.[1] ?? 0) >= API_MAP_LIMIT.limit, "nginx's heavy zone is no tighter than the app's map budget");
  }

  console.log("");
  if (failed > 0) {
    console.log(`${failed} FAILED`);
    process.exit(1);
  }
  console.log("all rate-limit assertions passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
