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
  user: { id: string; email: string; name: string; callsign: string | null; role: Role; active: boolean };
}
const sessions = new Map<string, FakeSession>();
/** What the next session lookup does instead of answering. */
let lookupFails: (() => Error) | null = null;
let lastSeenFails = false;
let deletes = 0;

(globalThis as unknown as { prisma?: unknown }).prisma = {
  session: {
    findUnique: async (args: { where: { tokenHash: string } }) => {
      if (lookupFails) throw lookupFails();
      return sessions.get(args.where.tokenHash) ?? null;
    },
    update: async () => {
      if (lastSeenFails) throw new Error("lastSeenAt write timed out (simulated)");
      return {};
    },
    delete: async (args: { where: { id: string } }) => {
      deletes++;
      for (const [k, s] of sessions) if (s.id === args.where.id) sessions.delete(k);
      return {};
    },
    deleteMany: async () => ({ count: 0 }),
  },
  user: { count: async () => 1 },
  setting: { findMany: async () => [] },
};

const SESSION_COOKIE = "digishack_session";
function addSession(opts: { expired?: boolean; active?: boolean; role?: Role } = {}): string {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  sessions.set(tokenHash, {
    id: `s${sessions.size}`,
    tokenHash,
    expiresAt: new Date(Date.now() + (opts.expired ? -60_000 : 86_400_000)),
    lastSeenAt: new Date(Date.now() - 60 * 60_000),
    user: {
      id: `u${sessions.size}`,
      email: "op@example.com",
      name: "Op",
      callsign: "W9XYZ",
      role: opts.role ?? "ADMIN",
      active: opts.active ?? true,
    },
  });
  return token;
}

// ---------------------------------------------------------------------------
// Request and response doubles, enough of each for the guards and sendJson
// ---------------------------------------------------------------------------

function fakeReq(token: string | null, method = "GET"): IncomingMessage {
  return {
    method,
    url: "/gridmap",
    headers: token ? { cookie: `other=1; ${SESSION_COOKIE}=${token}` } : {},
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
  async function page(token: string | null) {
    const res = fakeRes();
    const ctx = { req: fakeReq(token), res, resolvedUrl: "/gridmap", query: {} };
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
    lastSeenFails = true;
    const { result } = await page(addSession());
    lastSeenFails = false;
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
