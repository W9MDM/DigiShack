/* eslint-disable no-console */
// The page and API session guards (lib/auth/guard.ts) under a database that fails.
// Run: npm run check:page-auth
//
// WHY THIS EXISTS. withPageAuth answered a failed session lookup with a redirect to
// /login?error=database. To the operator that is a sign-out: one slow query (a pool
// timeout, MariaDB restarting) and every page they open is the sign-in form, although
// their session row and cookie are both fine. The rule this checks is the other half of
// "never weaken authentication": a lookup that FAILED must refuse without saying "signed
// out", and a lookup that ANSWERED no — no cookie, unknown token, expired, disabled — must
// still go to /login exactly as before.
//
// SLIDING EXPIRY is checked here too, because it lives in the same lookup: a session that
// is used is pushed out to a full TTL from now and its cookie re-issued to match, at most
// once an hour and only alongside the five-minute lastSeenAt write; and none of that may
// revive an expired or revoked session, or turn a failed write into a sign-out.
//
// No database. A fake Prisma is put on globalThis BEFORE anything that imports
// lib/db/prisma is loaded, which is why the application imports below are dynamic.

import { randomBytes, createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { Prisma } from "@prisma/client";

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
// The fake database
// ---------------------------------------------------------------------------

type Role = "VIEWER" | "OPERATOR" | "ADMIN";
interface FakeSession {
  id: string;
  tokenHash: string;
  expiresAt: Date;
  lastSeenAt: Date;
  user: { id: string; email: string; name: string; callsign: string | null; role: Role; qslManager?: boolean; active: boolean };
}
const sessions = new Map<string, FakeSession>();
/** What the next session lookup does instead of answering. */
let lookupFails: (() => Error) | null = null;
/** Every session write (lastSeenAt, the sliding extension) fails. */
let updateFails = false;
/** Runs just before a session write lands: a revocation racing the request. */
let beforeUpdate: (() => void) | null = null;
let settingsFail = false;
let deletes = 0;
const updates: Array<{ id: string; data: { lastSeenAt?: Date; expiresAt?: Date } }> = [];

let nextId = 0;
(globalThis as unknown as { prisma?: unknown }).prisma = {
  session: {
    findUnique: async (args: { where: { tokenHash: string } }) => {
      if (lookupFails) throw lookupFails();
      const s = sessions.get(args.where.tokenHash);
      // A copy, as a real query returns: the row can change after it was read.
      return s ? { ...s, user: { ...s.user } } : null;
    },
    update: async (args: {
      where: { id: string; expiresAt?: { gt: Date } };
      data: { lastSeenAt?: Date; expiresAt?: Date };
    }) => {
      beforeUpdate?.();
      if (updateFails) throw new Error("session write timed out (simulated)");
      const s = [...sessions.values()].find((x) => x.id === args.where.id);
      const gt = args.where.expiresAt?.gt;
      if (!s || (gt && s.expiresAt.getTime() <= gt.getTime())) {
        throw new Prisma.PrismaClientKnownRequestError("Record to update not found.", {
          code: "P2025",
          clientVersion: "test",
        });
      }
      Object.assign(s, args.data);
      updates.push({ id: s.id, data: args.data });
      return {};
    },
    create: async (args: { data: { tokenHash: string; expiresAt: Date; userId: string } }) => {
      sessions.set(args.data.tokenHash, {
        id: `s${nextId++}`,
        tokenHash: args.data.tokenHash,
        expiresAt: args.data.expiresAt,
        lastSeenAt: new Date(),
        user: { id: args.data.userId, email: "op@example.com", name: "Op", callsign: null, role: "ADMIN", active: true },
      });
      return {};
    },
    delete: async (args: { where: { id: string } }) => {
      deletes++;
      for (const [k, s] of sessions) if (s.id === args.where.id) sessions.delete(k);
      return {};
    },
    deleteMany: async (args: { where: { userId?: string } }) => {
      let count = 0;
      for (const [k, s] of sessions) {
        if (args.where.userId !== undefined && s.user.id === args.where.userId) {
          sessions.delete(k);
          count++;
        }
      }
      return { count };
    },
  },
  user: { count: async () => 1 },
  setting: {
    findMany: async () => {
      if (settingsFail) throw new Error("settings read timed out (simulated)");
      return [];
    },
  },
};

// The TTL is read from settings, which fall back to this. Not the default 30, so a cookie
// or expiry that came out right only by coincidence with the default would show.
process.env.SESSION_TTL_DAYS = "7";
const TTL_MS = 7 * 86_400_000;

const SESSION_COOKIE = "digishack_session";
function addSession(
  opts: { expired?: boolean; active?: boolean; role?: Role; qslManager?: boolean; expiresInMs?: number; lastSeenAgoMs?: number } = {},
): string {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  sessions.set(tokenHash, {
    id: `s${nextId++}`,
    tokenHash,
    expiresAt: new Date(Date.now() + (opts.expired ? -60_000 : (opts.expiresInMs ?? 86_400_000))),
    lastSeenAt: new Date(Date.now() - (opts.lastSeenAgoMs ?? 60 * 60_000)),
    user: {
      id: `u${sessions.size}`,
      email: "op@example.com",
      name: "Op",
      callsign: "W9XYZ",
      role: opts.role ?? "ADMIN",
      qslManager: opts.qslManager ?? false,
      active: opts.active ?? true,
    },
  });
  return token;
}

// ---------------------------------------------------------------------------
// Request and response doubles, enough of each for the guards and sendJson
// ---------------------------------------------------------------------------

function fakeReq(token: string | null, method = "GET", extra: Record<string, string> = {}): IncomingMessage {
  return {
    method,
    url: "/gridmap",
    headers: { ...(token ? { cookie: `other=1; ${SESSION_COOKIE}=${token}` } : {}), ...extra },
    cookies: token ? { [SESSION_COOKIE]: token } : {},
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as IncomingMessage;
}

interface FakeRes {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: string;
  ended: boolean;
  headersSent: boolean;
}
function fakeRes(): FakeRes & ServerResponse {
  const r = {
    statusCode: 200,
    headers: {} as Record<string, string | string[]>,
    body: "",
    ended: false,
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
      r.ended = true;
      r.headersSent = true;
    },
    end(b?: string) {
      r.body = b ?? "";
      r.ended = true;
      r.headersSent = true;
    },
  };
  return r as unknown as FakeRes & ServerResponse;
}

const TIMEOUT = () =>
  new Prisma.PrismaClientKnownRequestError("Timed out fetching a new connection from the connection pool.", {
    code: "P2024",
    clientVersion: "test",
  });
const UNREACHABLE = () =>
  new Prisma.PrismaClientKnownRequestError("Can't reach database server at `127.0.0.1:3306`", {
    code: "P1001",
    clientVersion: "test",
  });

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { withPageAuth, authedRoute } = await import("../lib/auth/guard");

  const gssp = withPageAuth();
  async function page(token: string | null, extra: Record<string, string> = {}) {
    const res = fakeRes();
    const ctx = { req: fakeReq(token, "GET", extra), res, resolvedUrl: "/gridmap", query: {} };
    const result = (await gssp(ctx as never)) as Record<string, unknown>;
    return { result, res };
  }
  const redirectOf = (r: Record<string, unknown>) =>
    (r.redirect as { destination?: string } | undefined)?.destination ?? null;

  // -------------------------------------------------------------------------
  console.log("a page whose session lookup FAILS is refused in place, not sent to sign in");
  // -------------------------------------------------------------------------
  for (const [label, make] of [
    ["pool timeout (P2024)", TIMEOUT],
    ["server unreachable (P1001)", UNREACHABLE],
    ["plain error", () => new Error("socket hang up")],
  ] as const) {
    const token = addSession();
    const rows = sessions.size;
    lookupFails = make;
    const { result, res } = await page(token);
    lookupFails = null;
    eq(redirectOf(result), null, `${label}: no redirect (it used to be /login?error=database)`);
    ok(!("user" in ((result.props as object) ?? {})), `${label}: no user handed to the page`);
    eq(res.statusCode, 503, `${label}: 503`);
    eq(res.headers["retry-after"], "5", `${label}: Retry-After`);
    eq(res.headers["cache-control"], "no-store", `${label}: not cacheable`);
    ok(res.ended, `${label}: the response is finished, so Next renders nothing of the page`);
    ok(/http-equiv="refresh"/.test(res.body), `${label}: the page retries itself`);
    eq(res.headers["set-cookie"], undefined, `${label}: the session cookie is left alone`);
    eq(sessions.size, rows, `${label}: no session row removed`);
    // And once the database answers again, the same cookie is still a signed-in visitor.
    const again = await page(token);
    ok(
      (again.result.props as { user?: { id: string } } | undefined)?.user !== undefined,
      `${label}: the same cookie is signed in once the database is back`,
    );
  }

  // -------------------------------------------------------------------------
  console.log("a page whose session lookup ANSWERS no still goes to /login");
  // -------------------------------------------------------------------------
  {
    const none = await page(null);
    eq(redirectOf(none.result), "/login?next=%2Fgridmap", "no cookie");

    const unknown = await page(randomBytes(32).toString("base64url"));
    eq(redirectOf(unknown.result), "/login?next=%2Fgridmap", "a token with no session row (signed out, revoked)");

    const before = deletes;
    const expired = await page(addSession({ expired: true }));
    eq(redirectOf(expired.result), "/login?next=%2Fgridmap", "an expired session");
    eq(deletes, before + 1, "the expired row is cleaned up");

    const disabled = await page(addSession({ active: false }));
    eq(redirectOf(disabled.result), "/login?next=%2Fgridmap", "a disabled account");

    for (const r of [none, unknown, expired, disabled]) {
      if (r.res.statusCode !== 200 || r.res.ended) {
        ok(false, "a refusal that the database answered is a plain redirect", r.res.statusCode);
      }
    }
  }

  // -------------------------------------------------------------------------
  console.log("a valid session is signed in, even when the lastSeenAt write fails");
  // -------------------------------------------------------------------------
  {
    updateFails = true;
    const { result } = await page(addSession());
    updateFails = false;
    ok((result.props as { user?: unknown } | undefined)?.user !== undefined, "props carry the user");
    eq(redirectOf(result), null, "no redirect");
  }

  // -------------------------------------------------------------------------
  console.log("an API route: a failed lookup is a retryable 503, never a 401");
  // -------------------------------------------------------------------------
  {
    let ran = 0;
    const handler = authedRoute({
      GET: {
        role: "VIEWER",
        handler: (_req, res) => {
          ran++;
          res.status(200).send("{}");
        },
      },
    });
    async function call(token: string | null) {
      const res = fakeRes();
      await handler(fakeReq(token) as never, res as never);
      return res;
    }

    const token = addSession();
    lookupFails = TIMEOUT;
    const down = await call(token);
    lookupFails = null;
    eq(down.statusCode, 503, "pool timeout: 503");
    eq(down.headers["retry-after"], "5", "pool timeout: Retry-After");
    eq(ran, 0, "pool timeout: the handler did not run");
    eq(down.headers["set-cookie"], undefined, "pool timeout: no cookie touched");
    ok(/"retryable":true/.test(down.body), "pool timeout: the body says to retry");

    const up = await call(token);
    eq(up.statusCode, 200, "the same cookie works once the database is back");
    eq(ran, 1, "and the handler ran");

    const anon = await call(null);
    eq(anon.statusCode, 401, "no cookie is still a 401");
    const bogus = await call(randomBytes(32).toString("base64url"));
    eq(bogus.statusCode, 401, "an unknown token is still a 401");
    eq(ran, 1, "the handler ran for neither");
  }

  // -------------------------------------------------------------------------
  // Sliding expiry
  // -------------------------------------------------------------------------
  const { getAuth, createSession } = await import("../lib/auth/session");
  const { invalidateSettingsCache } = await import("../lib/settings");
  const rowOf = (token: string) => sessions.get(createHash("sha256").update(token).digest("hex"));
  const sessionCookies = (res: FakeRes) => {
    const raw = res.headers["set-cookie"];
    const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
    return list.filter((c) => c.startsWith(`${SESSION_COOKIE}=`));
  };
  const near = (a: number, b: number, slackMs = 5_000) => Math.abs(a - b) <= slackMs;
  const signedIn = (r: Record<string, unknown>) =>
    (r.props as { user?: unknown } | undefined)?.user !== undefined;
  const apiHandler = authedRoute({
    GET: { role: "VIEWER", handler: (_req, res) => void res.status(200).send("{}") },
  });
  async function api(token: string | null) {
    const res = fakeRes();
    await apiHandler(fakeReq(token) as never, res as never);
    return res;
  }

  console.log("the QSL manager: QSL routes and pages whatever the role, nothing else");
  {
    const ok200 = (_req: unknown, res: { status: (n: number) => { send: (b: string) => void } }) => void res.status(200).send("{}");
    const qslRoute = authedRoute({ POST: { role: "ADMIN", qsl: true, handler: ok200 as never } });
    const adminRoute = authedRoute({ POST: { role: "ADMIN", handler: ok200 as never } });
    const hit = async (h: typeof qslRoute, token: string) => {
      const res = fakeRes();
      await h(fakeReq(token, "POST") as never, res as never);
      return res.statusCode;
    };
    const viewer = addSession({ role: "VIEWER" });
    const manager = addSession({ role: "VIEWER", qslManager: true });
    eq(`${await hit(qslRoute, viewer)} ${await hit(qslRoute, manager)}`, "403 200", "a QSL route: refused to a viewer, open to the viewer who is the QSL manager");
    eq(await hit(adminRoute, manager), 403, "an admin route without qsl stays closed to them");
    const redirectOf = (r: unknown) => (r as { redirect?: { destination: string } }).redirect?.destination ?? null;
    const qslPage = withPageAuth({ role: "OPERATOR", qsl: true });
    const at = async (g: typeof qslPage, token: string) =>
      redirectOf(await g({ req: fakeReq(token), res: fakeRes(), resolvedUrl: "/qsl", query: {} } as never));
    eq(`${await at(qslPage, viewer)} ${await at(qslPage, manager)}`, "/ null", "a QSL page: the viewer is sent home, the QSL manager is let in");
    eq(await at(withPageAuth({ role: "OPERATOR" }), manager), "/", "a page that is not QSL still sends them home");
  }

  console.log("a session that is used is extended to a full TTL, and its cookie re-issued");
  {
    // Signed in six days ago on a seven-day TTL: one day left.
    const token = addSession({ expiresInMs: 86_400_000 });
    const writes = updates.length;
    const { result, res } = await page(token);
    ok(signedIn(result), "page: signed in");
    const row = rowOf(token);
    ok(row !== undefined && near(row.expiresAt.getTime(), Date.now() + TTL_MS), "page: the row now expires a full TTL from now", row?.expiresAt);
    eq(updates.length, writes + 1, "page: one UPDATE, carrying both expiresAt and lastSeenAt");
    const last = updates[updates.length - 1];
    ok(last?.data.expiresAt !== undefined && last.data.lastSeenAt !== undefined, "page: the UPDATE has both fields");
    const cookies = sessionCookies(res);
    eq(cookies.length, 1, "page: exactly one session cookie on the response");
    const c = cookies[0] ?? "";
    ok(c.startsWith(`${SESSION_COOKIE}=${token};`), "page: it is the SAME token, re-issued", c);
    ok(c.includes(`Max-Age=${TTL_MS / 1000}`), "page: Max-Age is the TTL", c);
    const expires = /Expires=([^;]+)/.exec(c)?.[1];
    ok(
      expires !== undefined && row !== undefined && Math.abs(Date.parse(expires) - row.expiresAt.getTime()) < 1_000,
      "page: Expires matches the row",
      expires,
    );
    ok(/HttpOnly/.test(c) && /SameSite=Lax/.test(c) && /Path=\//.test(c), "page: same attributes as at sign-in", c);
    ok(!/Secure/.test(c), "page: no Secure over plain HTTP", c);
    eq(redirectOf(result), null, "page: no redirect");
    eq(res.statusCode, 200, "page: not a 503");
    eq(res.headers["cache-control"], undefined, "page: the guard sets no Cache-Control of its own (Next's stands)");

    const viaTls = await page(addSession({ expiresInMs: 86_400_000 }), { "x-forwarded-proto": "https" });
    ok(/Secure/.test(sessionCookies(viaTls.res)[0] ?? ""), "page: Secure when the request came over TLS");

    const apiToken = addSession({ expiresInMs: 86_400_000 });
    const r = await api(apiToken);
    eq(r.statusCode, 200, "api: the handler answered");
    const apiRow = rowOf(apiToken);
    ok(apiRow !== undefined && near(apiRow.expiresAt.getTime(), Date.now() + TTL_MS), "api: the row was extended");
    ok((sessionCookies(r)[0] ?? "").startsWith(`${SESSION_COOKIE}=${apiToken};`), "api: the cookie rides on the API response");
  }

  console.log("the extension is throttled: a session used again within the hour is not rewritten");
  {
    const token = addSession({ expiresInMs: 86_400_000 });
    await page(token);
    const writes = updates.length;
    const before = rowOf(token)?.expiresAt.getTime();
    const second = await page(token);
    ok(signedIn(second.result), "the second request is signed in");
    eq(updates.length, writes, "no second UPDATE");
    eq(sessionCookies(second.res).length, 0, "no second cookie");
    eq(rowOf(token)?.expiresAt.getTime(), before, "expiry unchanged");

    // Fifty minutes into the hour, with lastSeenAt stale: lastSeenAt is written, expiry is not.
    const t2 = addSession({ expiresInMs: TTL_MS - 50 * 60_000, lastSeenAgoMs: 10 * 60_000 });
    const was = rowOf(t2)?.expiresAt.getTime();
    const w2 = updates.length;
    const r2 = await page(t2);
    eq(updates.length, w2 + 1, "a stale lastSeenAt is still written");
    eq(updates[updates.length - 1]?.data.expiresAt, undefined, "but without extending");
    eq(rowOf(t2)?.expiresAt.getTime(), was, "expiry unchanged");
    eq(sessionCookies(r2.res).length, 0, "and no cookie");

    // Seventy minutes short of a full TTL: due.
    const t3 = addSession({ expiresInMs: TTL_MS - 70 * 60_000, lastSeenAgoMs: 10 * 60_000 });
    const r3 = await page(t3);
    eq(sessionCookies(r3.res).length, 1, "over an hour short of a full TTL: extended");

    // Seen two minutes ago: inside the lastSeenAt window nothing is considered, even with a
    // day left. It is picked up on the first request after the window.
    const t5 = addSession({ expiresInMs: 86_400_000, lastSeenAgoMs: 2 * 60_000 });
    const w5 = updates.length;
    const r5 = await page(t5);
    eq(updates.length, w5, "seen two minutes ago: no write");
    eq(sessionCookies(r5.res).length, 0, "seen two minutes ago: no cookie yet");

    // A TTL lowered since sign-in never shortens a session.
    const t4 = addSession({ expiresInMs: 30 * 86_400_000, lastSeenAgoMs: 10 * 60_000 });
    const long = rowOf(t4)?.expiresAt.getTime();
    const r4 = await page(t4);
    eq(rowOf(t4)?.expiresAt.getTime(), long, "a session longer than the TTL is not cut short");
    eq(sessionCookies(r4.res).length, 0, "nor re-issued");
  }

  console.log("an expired session is not revived, and a revoked one is still refused");
  {
    const writes = updates.length;
    const expiredToken = addSession({ expired: true });
    const expired = await page(expiredToken);
    eq(redirectOf(expired.result), "/login?next=%2Fgridmap", "expired: to /login");
    eq(rowOf(expiredToken), undefined, "expired: the row is gone, not extended");
    eq(sessionCookies(expired.res).length, 0, "expired: no cookie re-issued");
    const expiredApi = await api(addSession({ expired: true }));
    eq(expiredApi.statusCode, 401, "expired: the API says 401");
    eq(sessionCookies(expiredApi).length, 0, "expired: no cookie on the 401");

    const revoked = addSession({ expiresInMs: 86_400_000 });
    sessions.delete(createHash("sha256").update(revoked).digest("hex"));
    const gone = await page(revoked);
    eq(redirectOf(gone.result), "/login?next=%2Fgridmap", "revoked: to /login");
    eq(sessionCookies(gone.res).length, 0, "revoked: no cookie");

    const disabled = await page(addSession({ active: false, expiresInMs: 86_400_000 }));
    eq(redirectOf(disabled.result), "/login?next=%2Fgridmap", "disabled account: to /login");
    eq(sessionCookies(disabled.res).length, 0, "disabled account: no cookie");
    eq(updates.length, writes, "none of them wrote to a session row");

    // Revoked WHILE the request was in flight: read as valid, gone by the time of the write.
    const racing = addSession({ expiresInMs: 86_400_000 });
    const hash = createHash("sha256").update(racing).digest("hex");
    beforeUpdate = () => sessions.delete(hash);
    const raced = await page(racing);
    beforeUpdate = null;
    eq(sessions.has(hash), false, "revoked mid-request: the row stays gone");
    eq(sessionCookies(raced.res).length, 0, "revoked mid-request: no cookie re-issued");

    // Expired between the read and the write: the conditional UPDATE matches nothing.
    const edge = addSession({ expiresInMs: 86_400_000 });
    beforeUpdate = () => {
      const s = sessions.get(createHash("sha256").update(edge).digest("hex"));
      if (s) s.expiresAt = new Date(Date.now() - 1);
    };
    const late = await page(edge);
    beforeUpdate = null;
    ok((rowOf(edge)?.expiresAt.getTime() ?? 0) < Date.now(), "expired mid-request: not pushed back out");
    eq(sessionCookies(late.res).length, 0, "expired mid-request: no cookie re-issued");
  }

  console.log("a failed extension skips the extension and nothing else");
  {
    const token = addSession({ expiresInMs: 86_400_000 });
    const was = rowOf(token)?.expiresAt.getTime();
    updateFails = true;
    const p = await page(token);
    const a = await api(token);
    updateFails = false;
    ok(signedIn(p.result), "write fails: the page is still signed in");
    eq(p.res.statusCode, 200, "write fails: not a 503");
    eq(sessionCookies(p.res).length, 0, "write fails: no cookie (it would promise what the row does not have)");
    eq(a.statusCode, 200, "write fails: the API still answers");
    eq(sessionCookies(a).length, 0, "write fails: no cookie on the API either");
    eq(rowOf(token)?.expiresAt.getTime(), was, "write fails: the expiry it had");
    const after = await page(token);
    eq(sessionCookies(after.res).length, 1, "write fails: the next use extends it");

    const t2 = addSession({ expiresInMs: 86_400_000 });
    settingsFail = true;
    invalidateSettingsCache();
    const s = await page(t2);
    settingsFail = false;
    invalidateSettingsCache();
    ok(signedIn(s.result), "settings unreadable: still signed in");
    eq(s.res.statusCode, 200, "settings unreadable: not a 503");
    eq(sessionCookies(s.res).length, 0, "settings unreadable: no extension this time");
  }

  console.log("getAuth without a response extends nothing, and one response carries one session cookie");
  {
    const token = addSession({ expiresInMs: 86_400_000 });
    const was = rowOf(token)?.expiresAt.getTime();
    ok((await getAuth(fakeReq(token))) !== null, "no res: signed in");
    eq(rowOf(token)?.expiresAt.getTime(), was, "no res: not extended (a row longer than its cookie would be a lie)");

    // The password change: the guard re-issues the old cookie, then the handler replaces it.
    const pw = authedRoute({
      POST: {
        role: "VIEWER",
        handler: async (req, res, auth) => {
          for (const [k, s] of sessions) if (s.user.id === auth.user.id) sessions.delete(k);
          await createSession(auth.user.id, req, res);
          res.status(200).send("{}");
        },
      },
    });
    const old = addSession({ expiresInMs: 86_400_000 });
    const res = fakeRes();
    await pw(fakeReq(old, "POST") as never, res as never);
    const cookies = sessionCookies(res);
    eq(cookies.length, 1, "password change: one session cookie, not the extended old one as well");
    ok(!(cookies[0] ?? "").startsWith(`${SESSION_COOKIE}=${old};`), "password change: and it is the new one");
  }

  console.log("");
  if (failed > 0) {
    console.log(`${failed} FAILED`);
    process.exit(1);
  }
  console.log("all page-auth assertions passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
