import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { clientIp } from "@/lib/auth/client-ip";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { Role } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { getNumberSetting } from "@/lib/settings";

export const SESSION_COOKIE = "digishack_session";

/**
 * Session lifetime, from the /settings UI (falling back to SESSION_TTL_DAYS and
 * then 30). Read per use rather than cached at module load so changing it in the
 * UI takes effect without a restart. It is a window of INACTIVITY: every use of a
 * session pushes its expiry out to this far from now (see getAuth).
 */
async function ttlDays(): Promise<number> {
  const n = await getNumberSetting("app.sessionTtlDays", 30);
  return n > 0 ? n : 30;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Skip the lastSeenAt write unless it's this stale — one UPDATE per request is wasteful. */
const LAST_SEEN_THROTTLE_MS = 5 * 60 * 1000;

/**
 * Extend a session only once it has lost this much of its lifetime. Without it every
 * request would send a fresh cookie; with it a session in constant use gets one Set-Cookie
 * an hour, adds no UPDATE of its own (it rides on the lastSeenAt write), and is never
 * much more than an hour short of a full TTL.
 */
export const EXTEND_THROTTLE_MS = 60 * 60 * 1000;

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  callsign: string | null;
  role: Role;
}

export interface AuthContext {
  user: AuthUser;
  sessionId: string;
}

// ---------------------------------------------------------------------------
// Token handling
// ---------------------------------------------------------------------------

/**
 * Only the SHA-256 of the token is stored. A plain hash (not a slow KDF) is
 * correct here: the token is 256 bits of CSPRNG output, so there is no
 * dictionary to attack — the reason to hash it at all is that a database leak
 * shouldn't hand over live sessions.
 */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

// ---------------------------------------------------------------------------
// Cookie serialization (hand-rolled to avoid depending on Next's transitive
// `cookie` package, which is not part of its public API)
// ---------------------------------------------------------------------------

function serializeCookie(
  name: string,
  value: string,
  opts: { expires?: Date; maxAge?: number; secure?: boolean },
): string {
  const parts = [`${name}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax"];

  // Secure only when the connection that logged in actually was. This used to key
  // off NODE_ENV=production, which conflates "a real build" with "TLS exists" — and
  // every shack install is a real build on plain LAN HTTP. Browsers refuse Secure
  // cookies over http:// EXCEPT on localhost, so the symptom was precise and
  // misleading: login worked at http://localhost:3000 and silently looped back to
  // the login page from http://<the-machine's-ip>:3000, on every fresh install.
  if (opts.secure) parts.push("Secure");

  if (opts.expires) parts.push(`Expires=${opts.expires.toUTCString()}`);
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(opts.maxAge)}`);

  return parts.join("; ");
}

/**
 * Was this request carried over TLS?
 *
 * Directly (`socket.encrypted` — Next serving HTTPS itself) or via a proxy that says
 * so (deploy/nginx sets X-Forwarded-Proto). A station behind that proxy gets Secure
 * session cookies; one on bare LAN HTTP gets cookies its browser will actually keep.
 */
function isSecureRequest(req: IncomingMessage): boolean {
  const forwarded = String(req.headers["x-forwarded-proto"] ?? "")
    .split(",")[0]
    ?.trim();
  if (forwarded) return forwarded === "https";
  return Boolean((req.socket as { encrypted?: boolean }).encrypted);
}

/**
 * Add a session cookie to the response, replacing any session cookie already on it.
 *
 * One response can now carry two: the guard re-issues the old cookie when it extends the
 * session, and then a handler such as the password change revokes every session and
 * creates a new one. Browsers apply duplicates in order so appending alone would work,
 * but dropping the earlier one means the response never offers a cookie that is already
 * dead. Other cookies on the response are kept.
 */
function setSessionCookie(res: ServerResponse, cookie: string): void {
  const existing = res.getHeader("Set-Cookie");
  const kept = (existing === undefined ? [] : Array.isArray(existing) ? existing : [String(existing)])
    .map(String)
    .filter((c) => !c.startsWith(`${SESSION_COOKIE}=`));
  res.setHeader("Set-Cookie", kept.length === 0 ? cookie : [...kept, cookie]);
}

/** Read the session cookie. Works for both API requests and getServerSideProps. */
function readTokenFromRequest(req: IncomingMessage): string | null {
  // Next populates req.cookies on API routes and in getServerSideProps.
  const parsed = (req as IncomingMessage & { cookies?: Partial<Record<string, string>> })
    .cookies;
  if (parsed && typeof parsed[SESSION_COOKIE] === "string") {
    return parsed[SESSION_COOKIE];
  }

  const header = req.headers.cookie;
  if (!header) return null;
  for (const pair of header.split(";")) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    if (pair.slice(0, idx).trim() === SESSION_COOKIE) {
      return decodeURIComponent(pair.slice(idx + 1).trim());
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export async function createSession(
  userId: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const token = newToken();
  const ttlMs = (await ttlDays()) * DAY_MS;
  const expiresAt = new Date(Date.now() + ttlMs);

  await prisma.session.create({
    data: {
      tokenHash: hashToken(token),
      userId,
      expiresAt,
      userAgent: (req.headers["user-agent"] ?? "").slice(0, 255) || null,
      ip: sessionIp(req),
    },
  });

  issueSessionCookie(req, res, token, expiresAt, ttlMs);
}

/** The cookie for a live session, kept by the browser exactly as long as the row lasts. */
function issueSessionCookie(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  expiresAt: Date,
  ttlMs: number,
): void {
  setSessionCookie(
    res,
    serializeCookie(SESSION_COOKIE, token, {
      expires: expiresAt,
      maxAge: ttlMs / 1000,
      secure: isSecureRequest(req),
    }),
  );
}

export function clearSessionCookie(res: ServerResponse): void {
  setSessionCookie(
    res,
    serializeCookie(SESSION_COOKIE, "", { expires: new Date(0), maxAge: 0 }),
  );
}

/**
 * Resolve the current user, or null. Rejects expired sessions and deactivated
 * users — an admin disabling an account takes effect on the next request rather
 * than whenever a token happens to expire.
 *
 * SLIDING EXPIRY. A session that passes is extended to a full TTL from now, so it ends
 * after TTL days of not being used rather than TTL days after sign-in, however often it
 * was used in between. That needs `res`: the browser keeps the cookie only as long as
 * its own Max-Age says, so the row and the cookie are extended together or not at all.
 * Without `res` (the login page's "already signed in?" probe) nothing is extended.
 *
 * The extension is housekeeping, like lastSeenAt. If it fails — the settings read or the
 * UPDATE — the request is still signed in on the expiry the session already had, and the
 * next use tries again. It never revives anything: a session past its expiry is refused
 * above and deleted, a revoked one has no row to find, and the UPDATE itself only matches
 * a row that is still unexpired, so a revocation racing this request is not undone.
 */
export async function getAuth(
  req: IncomingMessage,
  res?: ServerResponse,
): Promise<AuthContext | null> {
  const token = readTokenFromRequest(req);
  if (!token) return null;

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          name: true,
          callsign: true,
          role: true,
          active: true,
        },
      },
    },
  });

  if (!session) return null;

  if (session.expiresAt.getTime() <= Date.now()) {
    // Clean up as we go; there's no cron sweeping these.
    await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }

  if (!session.user.active) return null;

  await touchSession(req, res, token, session);

  return {
    sessionId: session.id,
    user: {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
      callsign: session.user.callsign,
      role: session.user.role,
    },
  };
}

/**
 * The once-in-a-while write for a session that was just accepted: lastSeenAt when it is
 * stale, and the sliding extension when it is due. Both go in one UPDATE. Never throws.
 *
 * The extension is only considered when lastSeenAt is due anyway, and an extension sets
 * lastSeenAt too. So a request inside the five-minute window costs nothing at all, not even
 * the settings read the TTL needs, and the extension is at most five minutes late.
 */
async function touchSession(
  req: IncomingMessage,
  res: ServerResponse | undefined,
  token: string,
  session: { id: string; expiresAt: Date; lastSeenAt: Date },
): Promise<void> {
  const now = Date.now();
  if (now - session.lastSeenAt.getTime() <= LAST_SEEN_THROTTLE_MS) return;
  const data: { lastSeenAt: Date; expiresAt?: Date } = { lastSeenAt: new Date(now) };

  let ttlMs: number | null = null;
  if (res && !res.headersSent) {
    try {
      ttlMs = (await ttlDays()) * DAY_MS;
    } catch {
      // Settings unreadable: no extension this time, and the request goes on.
    }
  }
  // Only ever later: a TTL lowered in Settings leaves a longer-lived session alone until
  // its remaining time falls under the new TTL, as "lowering it does not revoke" promises.
  const extendTo =
    ttlMs !== null && now + ttlMs - session.expiresAt.getTime() > EXTEND_THROTTLE_MS
      ? new Date(now + ttlMs)
      : null;
  if (extendTo) data.expiresAt = extendTo;

  let wrote = false;
  try {
    // The expiresAt condition is what keeps this from reviving a session that ran out (or
    // was cut short) since it was read: no unexpired row, nothing updated, and it throws.
    await prisma.session.update({
      where: { id: session.id, expiresAt: { gt: new Date(now) } },
      data,
    });
    wrote = true;
  } catch {
    // Like the lastSeenAt write always was: skipped, not fatal.
  }

  if (wrote && extendTo && ttlMs !== null && res && !res.headersSent) {
    issueSessionCookie(req, res, token, extendTo, ttlMs);
  }
}

export async function destroyCurrentSession(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const token = readTokenFromRequest(req);
  if (token) {
    await prisma.session
      .deleteMany({ where: { tokenHash: hashToken(token) } })
      .catch(() => {});
  }
  clearSessionCookie(res);
}

/** Used when a password changes or an account is disabled. */
export async function destroyAllSessions(userId: string): Promise<number> {
  const { count } = await prisma.session.deleteMany({ where: { userId } });
  return count;
}

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

const RANK: Record<Role, number> = { VIEWER: 0, OPERATOR: 1, ADMIN: 2 };

export function hasRole(user: AuthUser, required: Role): boolean {
  return RANK[user.role] >= RANK[required];
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

/**
 * True when no accounts exist, which is the only state in which /setup will
 * create one. Once the first admin exists this returns false forever and setup
 * is closed.
 */
export async function needsSetup(): Promise<boolean> {
  return (await prisma.user.count()) === 0;
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/**
 * The address recorded on Session rows.
 *
 * MOVED to lib/auth/client-ip.ts, which carries the reasoning this comment used to hold —
 * including why X-Forwarded-For is not consulted, which was worked out here first and is
 * the more important half. What was ADDED there is `cf-connecting-ip`: this read only
 * `x-real-ip`, cloudflared does not set it, and so every session ever recorded stored the
 * tunnel's own loopback address rather than the visitor's.
 */
function sessionIp(req: IncomingMessage): string | null {
  const ip = clientIp({ headers: req.headers, socketAddress: req.socket.remoteAddress });
  return ip ? ip.slice(0, 64) : null;
}

/** Timing-safe string compare, for anything token-shaped outside sessions. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
