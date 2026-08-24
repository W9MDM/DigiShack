import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { Role } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { getNumberSetting } from "@/lib/settings";

export const SESSION_COOKIE = "digishack_session";

/**
 * Session lifetime, from the /settings UI (falling back to SESSION_TTL_DAYS and
 * then 30). Read per session creation rather than cached at module load so
 * changing it in the UI takes effect without a restart.
 */
async function ttlDays(): Promise<number> {
  const n = await getNumberSetting("app.sessionTtlDays", 30);
  return n > 0 ? n : 30;
}

/** Skip the lastSeenAt write unless it's this stale — one UPDATE per request is wasteful. */
const LAST_SEEN_THROTTLE_MS = 5 * 60 * 1000;

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

function appendSetCookie(res: ServerResponse, cookie: string): void {
  const existing = res.getHeader("Set-Cookie");
  if (existing === undefined) {
    res.setHeader("Set-Cookie", cookie);
  } else if (Array.isArray(existing)) {
    res.setHeader("Set-Cookie", [...existing, cookie]);
  } else {
    res.setHeader("Set-Cookie", [String(existing), cookie]);
  }
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
  const days = await ttlDays();
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

  await prisma.session.create({
    data: {
      tokenHash: hashToken(token),
      userId,
      expiresAt,
      userAgent: (req.headers["user-agent"] ?? "").slice(0, 255) || null,
      ip: clientIp(req),
    },
  });

  appendSetCookie(
    res,
    serializeCookie(SESSION_COOKIE, token, {
      expires: expiresAt,
      maxAge: days * 24 * 60 * 60,
      secure: isSecureRequest(req),
    }),
  );
}

export function clearSessionCookie(res: ServerResponse): void {
  appendSetCookie(
    res,
    serializeCookie(SESSION_COOKIE, "", { expires: new Date(0), maxAge: 0 }),
  );
}

/**
 * Resolve the current user, or null. Rejects expired sessions and deactivated
 * users — an admin disabling an account takes effect on the next request rather
 * than whenever a token happens to expire.
 */
export async function getAuth(req: IncomingMessage): Promise<AuthContext | null> {
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

  if (Date.now() - session.lastSeenAt.getTime() > LAST_SEEN_THROTTLE_MS) {
    await prisma.session
      .update({ where: { id: session.id }, data: { lastSeenAt: new Date() } })
      .catch(() => {});
  }

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

function clientIp(req: IncomingMessage): string | null {
  // Behind NGINX the socket address is always 127.0.0.1, so a forwarded header is
  // the only way to see the real client. X-Real-IP, NOT X-Forwarded-For: the
  // shipped config sets `$proxy_add_x_forwarded_for`, which APPENDS the real
  // address to whatever the client sent, making element 0 attacker-controlled. This
  // value is recorded on Session rows, so trusting it meant an attacker could write
  // whatever origin they liked into the audit trail.
  const real = req.headers["x-real-ip"];
  const fromProxy = (Array.isArray(real) ? real[0] : real)?.trim();
  return (fromProxy || req.socket.remoteAddress || "").slice(0, 64) || null;
}

/** Timing-safe string compare, for anything token-shaped outside sessions. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
