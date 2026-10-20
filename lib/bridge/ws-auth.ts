// Who may open the bridge's WebSockets — decided before anything is upgraded.
//
// THE FINDING (code review R04). `/ws/decodes` and `/ws/audio` upgraded anyone who could
// reach them. deploy/nginx proxies both onto the app's own origin, and this station is
// published through a Cloudflare tunnel, so a stranger who knew the hostname got the
// station's status, the active QSO and auto state, every decode, the spectrum and the
// receiver's audio without signing in. Every PAGE that opens them is behind the login; the
// sockets themselves were not. A protected page does not protect the URLs it talks to.
//
// THE SCHEME. An upgrade is admitted on exactly one of two credentials:
//
//   1. THE SIGNED-IN SESSION. A browser sends its cookies with a same-origin WebSocket
//      handshake, so the `digishack_session` cookie lib/auth/session.ts sets at login is
//      already on every upgrade a page makes — no page had to change. It is judged the way
//      getAuth() judges it: SHA-256 of the token against Session.tokenHash, not expired,
//      the user still active, role at least VIEWER. Good through the proxy and directly.
//
//   2. THE BRIDGE TOKEN, FROM THIS MACHINE ONLY. `bridge.token` — the secret the control
//      API checks — in an `X-Bridge-Token` header, or `?token=` for a client that cannot
//      set headers. Accepted only on a DIRECT loopback connection: the socket's peer is
//      127.0.0.1 or ::1 AND the request carries none of the headers a proxy adds. Through
//      nginx it is refused even when correct: there it would be a transmit-capable secret
//      in a URL in an access log, and a credential the whole internet could try.
//
//   Nothing else. In particular NOT "anonymous from loopback": nginx and cloudflared ARE
//   loopback, so a rule that trusted the peer address alone would trust every visitor they
//   forward, which is the hole restated. Scripts on the box use localBridgeSocket() below.
//
// ORIGIN is checked first, whatever the credential. A browser always sends Origin on a
// WebSocket handshake, and it must name the host the request was made to (Host, or
// X-Forwarded-Host where a proxy sets one). That is the cross-site WebSocket hijacking
// guard: SameSite=Lax keeps the cookie off a cross-SITE handshake, but not off one from
// another origin on the same site (another subdomain, another port). Ports are not
// compared: nginx's `$host` drops the port, and the no-proxy development layout serves the
// page on :3000 and the socket on :3101 of the same host. No Origin at all means a
// non-browser client, and the credential decides.
//
// "THROUGH A PROXY", reliably. deploy/nginx/digishack.conf sets X-Real-IP and
// X-Forwarded-For on both /ws locations, and the Proxmox installer installs that file
// verbatim. cloudflared adds CF-Connecting-IP, CF-Ray and X-Forwarded-For even when it is
// pointed straight at this port. Any one of PROXY_HEADERS marks a request as forwarded. A
// local process COULD send one, and then simply fails the token path — the safe direction
// for that mistake. A proxy that added none at all would make its traffic look local; then
// a visitor who HELD the bridge token could listen, but an anonymous one still could not,
// because nothing here admits an anonymous request.
//
// SESSION LOOKUPS are cached for CACHE_TTL_MS, positive and negative, and concurrent
// lookups of one cookie share one query — a bridge restart reconnects every open page at
// once, and that should cost one query per session, not one per socket. Open sockets are
// re-checked against the database every REVALIDATE_MS and closed if their session has
// ended: signed out, expired, password changed, account disabled.

import { createHash, timingSafeEqual } from "node:crypto";
import { STATUS_CODES, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import type { Role } from "@prisma/client";
import WebSocket from "ws";

import { clientIp } from "@/lib/auth/client-ip";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { getSetting } from "@/lib/settings";

/** The header the control API already reads (Node lowercases incoming header names). */
export const BRIDGE_TOKEN_HEADER = "x-bridge-token";
/** The same token as a query parameter, for a local client that cannot set a header. */
export const BRIDGE_TOKEN_PARAM = "token";

/** How long one session lookup is trusted, found or not found. */
export const CACHE_TTL_MS = 10_000;
/** How often an open socket's session is asked about again. */
export const REVALIDATE_MS = 2 * 60_000;
/** Distinct cookies being looked up at once before more are turned away with 503. */
const MAX_CONCURRENT_LOOKUPS = 32;
/** Cached lookups kept, oldest dropped first. Bounded because the keys are caller-chosen. */
const MAX_CACHE_ENTRIES = 2_000;
/** One refusal of a kind is logged per this interval, with a count of the rest. */
const LOG_EVERY_MS = 30_000;

/**
 * Headers only a forwarding proxy adds. ANY of them marks a request as not-direct.
 *
 * Deliberately broader than what deploy/nginx sets today: the cost of a false positive is a
 * local client that has to present a session instead of the bridge token, and the cost of a
 * false negative is the bridge token being honoured from the internet.
 */
export const PROXY_HEADERS = [
  "x-real-ip",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "x-forwarded-server",
  "forwarded",
  "via",
  "cf-connecting-ip",
  "cf-ray",
  "cdn-loop",
  "true-client-ip",
] as const;

/** Same ladder as lib/auth/session.ts. A Role added there fails to compile here until ranked. */
const RANK: Record<Role, number> = { VIEWER: 0, OPERATOR: 1, ADMIN: 2 };
const MIN_ROLE: Role = "VIEWER";

/** The paths this gate stands in front of; anything else is logged as "other". */
const KNOWN_PATHS = new Set(["/ws/decodes", "/ws/audio"]);

export interface SessionRow {
  expiresAt: Date;
  user: { id: string; active: boolean; role: Role };
}

/** Session.tokenHash → the row, or null. Throws when the database does. */
export type SessionLookup = (tokenHash: string) => Promise<SessionRow | null>;

/** The shape of an http.Server "upgrade" listener. */
export type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => void;

export type RefusalCode =
  | "origin"
  | "anonymous"
  | "session"
  | "role"
  | "token-proxied"
  | "token-remote"
  | "token-unset"
  | "token-wrong"
  | "lookup-failed"
  | "busy";

export type WsDecision =
  | { ok: true; via: "session"; userId: string; tokenHash: string }
  | { ok: true; via: "bridge-token" }
  | {
      ok: false;
      status: 401 | 403 | 503;
      code: RefusalCode;
      reason: string;
      /** Logged every time, never throttled: the real bridge token went out in a URL. */
      leaked?: true;
    };

// ---------------------------------------------------------------------------
// Pieces, exported for check:ws-auth
// ---------------------------------------------------------------------------

/**
 * SHA-256 hex: what lib/auth/session.ts stores in Session.tokenHash. That function is private
 * there, so this is a copy; check:ws-auth drives getAuth() with the same cookie to prove the
 * two still agree.
 */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function first(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  const t = s?.trim();
  return t ? t : undefined;
}

/**
 * The session token from a Cookie header: the FIRST `digishack_session`, which is the one
 * Next's cookie parser and lib/auth/session.ts both take. A value that will not
 * percent-decode is kept raw (as the `cookie` package does) and simply matches no session.
 */
export function readSessionToken(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const pair of cookieHeader.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1 || pair.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    let value = pair.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    try {
      value = decodeURIComponent(value);
    } catch {
      /* keep it raw */
    }
    // A real token is 43 characters. Something enormous is not one, and is not worth a query.
    return value && value.length <= 512 ? value : null;
  }
  return null;
}

/** 127.0.0.0/8 or ::1, in any of the spellings Node reports. */
export function isLoopbackAddress(addr: string | null | undefined): boolean {
  if (!addr) return false;
  const a = addr.trim().toLowerCase();
  return (
    a === "::1" ||
    a === "0:0:0:0:0:0:0:1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a) ||
    /^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a)
  );
}

/** The first proxy-added header present, or null for a request that came straight to the port. */
export function proxyEvidence(headers: IncomingHttpHeaders): string | null {
  for (const name of PROXY_HEADERS) {
    if (headers[name] !== undefined) return name;
  }
  return null;
}

/** A direct connection from this machine: loopback peer, and no proxy in between. */
export function isDirectLoopback(req: IncomingMessage): boolean {
  return isLoopbackAddress(req.socket?.remoteAddress) && proxyEvidence(req.headers) === null;
}

/** A Host-style value reduced to a hostname: lowercased, port and IPv6 brackets removed. */
function hostnameOf(hostish: string | undefined): string | null {
  const h = hostish?.trim().toLowerCase();
  if (!h) return null;
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end > 1 ? h.slice(1, end) : null;
  }
  const colon = h.indexOf(":");
  if (colon === -1) return h;
  // One colon is host:port. More than one is an unbracketed IPv6 address with no port.
  return h.indexOf(":", colon + 1) === -1 ? h.slice(0, colon) : h;
}

export type OriginVerdict = { ok: true } | { ok: false; origin: string; hosts: string[] };

/**
 * Does the browser's Origin name the host this request was made to?
 *
 * Absent Origin passes (not a browser). "null", a non-http(s) scheme, or a different
 * hostname fails. Ports are ignored on purpose — see the header comment.
 */
export function checkOrigin(headers: IncomingHttpHeaders): OriginVerdict {
  const origin = first(headers.origin);
  if (origin === undefined) return { ok: true };
  const hosts = [first(headers.host), first(headers["x-forwarded-host"])?.split(",")[0]]
    .map(hostnameOf)
    .filter((h): h is string => h !== null);
  let originHost: string | null = null;
  try {
    const u = new URL(origin);
    if (u.protocol === "http:" || u.protocol === "https:") originHost = hostnameOf(u.host);
  } catch {
    /* "null", or not a URL at all */
  }
  if (originHost !== null && hosts.includes(originHost)) return { ok: true };
  return { ok: false, origin, hosts };
}

/** Where a token was presented, if anywhere. The header wins over the query string. */
function presentedToken(req: IncomingMessage): { value: string; via: "header" | "query" } | null {
  const header = first(req.headers[BRIDGE_TOKEN_HEADER]);
  if (header) return { value: header, via: "header" };
  try {
    const q = new URL(req.url ?? "/", "http://bridge.invalid").searchParams.get(BRIDGE_TOKEN_PARAM);
    return q ? { value: q, via: "query" } : null;
  } catch {
    return null;
  }
}

/**
 * Constant-time AND length-independent: compares digests, not the strings. Both digests
 * are 32 bytes, so timingSafeEqual never sees a length mismatch, and a wrong length is
 * just a different digest. Shared with the bridge's HTTP token check (services/radio).
 */
export function tokensEqual(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );
}

function judge(
  row: SessionRow | null,
  now: number,
): { ok: true } | { ok: false; status: 401 | 403; reason: string } {
  if (!row) return { ok: false, status: 401, reason: "no such session (signed out, or a stale cookie)" };
  if (row.expiresAt.getTime() <= now) return { ok: false, status: 401, reason: "session expired" };
  if (!row.user.active) return { ok: false, status: 401, reason: "account disabled" };
  const rank = (RANK as Partial<Record<string, number>>)[row.user.role];
  if (rank === undefined || rank < RANK[MIN_ROLE]) {
    return { ok: false, status: 403, reason: `role ${String(row.user.role)} may not listen` };
  }
  return { ok: true };
}

function pathOf(req: IncomingMessage): string {
  try {
    const p = new URL(req.url ?? "/", "http://bridge.invalid").pathname;
    return KNOWN_PATHS.has(p) ? p : "other";
  } catch {
    return "other";
  }
}

/** Attacker-supplied text on its way into a log line: printable, and short. */
function printable(s: string, max = 80): string {
  const t = s.replace(/[^\x20-\x7e]/g, "?");
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

class BusyError extends Error {}

/**
 * Answer the upgrade with a plain HTTP status and close — before any WebSocket exists.
 * The same shape ws's own abortHandshake writes: end(), then destroy once flushed.
 */
function refuse(socket: Duplex, status: number, body?: string): void {
  const phrase = STATUS_CODES[status] ?? "Refused";
  const text = body ?? phrase;
  socket.once("finish", () => socket.destroy());
  socket.end(
    `HTTP/1.1 ${status} ${phrase}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      "Cache-Control: no-store\r\n" +
      `Content-Length: ${Buffer.byteLength(text)}\r\n` +
      "\r\n" +
      text,
  );
}

/** The default lookup: the selected fields of one Session row by its unique hash. */
export async function lookupSessionInDb(tokenHash: string): Promise<SessionRow | null> {
  return prisma.session.findUnique({
    where: { tokenHash },
    select: { expiresAt: true, user: { select: { id: true, active: true, role: true } } },
  });
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export interface WsGateOptions {
  /** The control API's secret, read at each use: it may be self-provisioned after start. */
  bridgeToken: () => string | null | undefined;
  lookupSession?: SessionLookup;
  now?: () => number;
  cacheTtlMs?: number;
  /** 0 disables the timer; check:ws-auth calls revalidate() itself. */
  revalidateMs?: number;
  maxConcurrentLookups?: number;
  log?: (line: string) => void;
}

export interface WsGate {
  /** The decision alone, with no socket I/O. */
  authorize(req: IncomingMessage): Promise<WsDecision>;
  /** Wrap an upgrade listener: refused requests are answered here; `next` sees only admitted ones. */
  guard(next: UpgradeHandler): UpgradeHandler;
  /** Re-check every open session socket now, closing those whose session has ended. */
  revalidate(): Promise<{ sessions: number; closed: number }>;
  /** Session-admitted sockets currently open. Token clients are not tracked. */
  readonly tracked: number;
  stop(): void;
}

export function createWsGate(opts: WsGateOptions): WsGate {
  const lookup = opts.lookupSession ?? lookupSessionInDb;
  const now = opts.now ?? Date.now;
  const ttl = opts.cacheTtlMs ?? CACHE_TTL_MS;
  const maxInflight = opts.maxConcurrentLookups ?? MAX_CONCURRENT_LOOKUPS;
  const log = opts.log ?? ((line: string) => console.log(line));

  const cache = new Map<string, { row: SessionRow | null; at: number }>();
  const inflight = new Map<string, Promise<SessionRow | null>>();
  const tracked = new Map<Duplex, { tokenHash: string; userId: string; path: string }>();
  const lastLogged = new Map<string, { at: number; suppressed: number }>();

  /** One query per cookie per TTL however many sockets ask, and none for a repeat inside it. */
  function sessionFor(tokenHash: string, fresh = false): Promise<SessionRow | null> {
    if (!fresh) {
      const hit = cache.get(tokenHash);
      if (hit && now() - hit.at < ttl) return Promise.resolve(hit.row);
    }
    const pending = inflight.get(tokenHash);
    if (pending) return pending;
    if (inflight.size >= maxInflight) return Promise.reject(new BusyError("lookups saturated"));
    const p = lookup(tokenHash)
      .then((row) => {
        // Delete then set: re-inserting moves the key to the end, and Map order is the
        // eviction order. A failed lookup is NOT cached — the next attempt asks again.
        cache.delete(tokenHash);
        cache.set(tokenHash, { row, at: now() });
        while (cache.size > MAX_CACHE_ENTRIES) {
          const oldest = cache.keys().next().value;
          if (oldest === undefined) break;
          cache.delete(oldest);
        }
        return row;
      })
      .finally(() => inflight.delete(tokenHash));
    inflight.set(tokenHash, p);
    return p;
  }

  async function authorize(req: IncomingMessage): Promise<WsDecision> {
    const origin = checkOrigin(req.headers);
    if (!origin.ok) {
      return {
        ok: false,
        status: 403,
        code: "origin",
        reason:
          `Origin ${printable(origin.origin)} is not ${origin.hosts.map((h) => printable(h)).join(" or ") || "this host"}` +
          " (if bridge.wsUrl is set, it must name the host the page is opened on — or be blank)",
      };
    }

    let sessionRefusal: string | null = null;
    const sessionToken = readSessionToken(first(req.headers.cookie));
    if (sessionToken) {
      const tokenHash = hashSessionToken(sessionToken);
      let row: SessionRow | null;
      try {
        row = await sessionFor(tokenHash);
      } catch (err) {
        return err instanceof BusyError
          ? { ok: false, status: 503, code: "busy", reason: "too many session lookups in flight" }
          : { ok: false, status: 503, code: "lookup-failed", reason: `session lookup failed: ${errText(err)}` };
      }
      const verdict = judge(row, now());
      if (verdict.ok && row) return { ok: true, via: "session", userId: row.user.id, tokenHash };
      if (!verdict.ok && verdict.status === 403) {
        return { ok: false, status: 403, code: "role", reason: verdict.reason };
      }
      sessionRefusal = verdict.ok ? null : verdict.reason;
    }

    const presented = presentedToken(req);
    if (presented) {
      const expected = opts.bridgeToken() || null;
      const correct = expected !== null && tokensEqual(presented.value, expected);
      const proxy = proxyEvidence(req.headers);
      if (proxy) {
        const leaked = correct && presented.via === "query";
        return {
          ok: false,
          status: 401,
          code: "token-proxied",
          ...(leaked ? { leaked: true as const } : {}),
          reason:
            `bridge token (${presented.via}) arrived through a proxy (${proxy}); it is accepted only from this machine` +
            (leaked
              ? ". It was the REAL token, in a URL — anything on the way that logs URLs (nginx's access log does) has it now: rotate bridge.token"
              : ""),
        };
      }
      if (!isLoopbackAddress(req.socket?.remoteAddress)) {
        return {
          ok: false,
          status: 401,
          code: "token-remote",
          reason: `bridge token from ${printable(req.socket?.remoteAddress ?? "an unknown peer")}: accepted only from this machine (loopback)`,
        };
      }
      if (!expected) return { ok: false, status: 401, code: "token-unset", reason: "bridge.token is not configured" };
      if (!correct) return { ok: false, status: 401, code: "token-wrong", reason: "wrong bridge token" };
      return { ok: true, via: "bridge-token" };
    }

    if (sessionRefusal) return { ok: false, status: 401, code: "session", reason: sessionRefusal };
    return {
      ok: false,
      status: 401,
      code: "anonymous",
      reason: isDirectLoopback(req)
        ? "no session and no bridge token. A script on this machine must send X-Bridge-Token " +
          "(or ?token=) — the bridge.token setting; localBridgeSocket() in lib/bridge/ws-auth.ts does it"
        : "not signed in",
    };
  }

  /** Log a line of a kind at most once per LOG_EVERY_MS, counting what was held back. */
  function note(kind: string, line: string): void {
    const t = now();
    const prev = lastLogged.get(kind);
    if (prev && t - prev.at < LOG_EVERY_MS) {
      prev.suppressed++;
      return;
    }
    const held = prev?.suppressed ? ` (+${prev.suppressed} like it since the last)` : "";
    lastLogged.set(kind, { at: t, suppressed: 0 });
    log(line + held);
  }

  function guard(next: UpgradeHandler): UpgradeHandler {
    return (req, socket, head) => {
      // Node removes its own error listener from an upgraded socket, and ws adds one only
      // inside handleUpgrade. In between is the session lookup — and an 'error' event with
      // no listener (a client resetting mid-lookup) is an uncaught exception that would end
      // the process that owns the radio.
      const onEarlyError = (): void => {
        socket.destroy();
      };
      socket.on("error", onEarlyError);
      const path = pathOf(req);

      authorize(req)
        .then((decision) => {
          if (socket.destroyed) return; // gone while we looked
          if (!decision.ok) {
            // A remote client is told only the status. A script on this box gets the reason.
            const body = isDirectLoopback(req)
              ? `${STATUS_CODES[decision.status] ?? "Refused"}: ${decision.reason}\n`
              : undefined;
            refuse(socket, decision.status, body);
            const who = printable(
              clientIp({ headers: req.headers, socketAddress: req.socket?.remoteAddress }) ?? "?",
              45,
            );
            const line = `[ws-auth] ${decision.status} ${path} from ${who}: ${decision.reason}`;
            // Only the real token can produce a leak warning, so it cannot be used to flood.
            if (decision.leaked) log(line);
            else note(`${decision.code}:${path}`, line);
            return;
          }
          socket.removeListener("error", onEarlyError);
          if (decision.via === "session") {
            tracked.set(socket, { tokenHash: decision.tokenHash, userId: decision.userId, path });
            socket.once("close", () => tracked.delete(socket));
          } else {
            note(`admit-token:${path}`, `[ws-auth] ${path}: local client admitted on the bridge token`);
          }
          next(req, socket, head);
        })
        .catch((err: unknown) => {
          // authorize() turns every expected failure into a decision, so this is a bug in the
          // gate or in `next` — and either way the answer is a refusal, never an admission.
          log(`[ws-auth] ${path}: refused on an internal error: ${errText(err)}`);
          tracked.delete(socket);
          if (!socket.destroyed) socket.destroy();
        });
    };
  }

  async function revalidate(): Promise<{ sessions: number; closed: number }> {
    const byHash = new Map<string, Duplex[]>();
    for (const [socket, t] of tracked) {
      if (socket.destroyed) {
        tracked.delete(socket);
        continue;
      }
      const list = byHash.get(t.tokenHash);
      if (list) list.push(socket);
      else byHash.set(t.tokenHash, [socket]);
    }

    let closed = 0;
    for (const [tokenHash, sockets] of byHash) {
      let row: SessionRow | null;
      try {
        row = await sessionFor(tokenHash, true);
      } catch {
        // The database not answering is not evidence that anyone signed out. Closing every
        // listener because MySQL blinked would be an outage of our own making; ask next round.
        continue;
      }
      const verdict = judge(row, now());
      if (verdict.ok) continue;
      const info = tracked.get(sockets[0]!);
      for (const socket of sockets) {
        tracked.delete(socket);
        socket.destroy();
        closed++;
      }
      log(
        `[ws-auth] closed ${sockets.length} socket(s) of user ${info?.userId ?? "?"}: ${verdict.reason}`,
      );
    }
    return { sessions: byHash.size, closed };
  }

  const every = opts.revalidateMs ?? REVALIDATE_MS;
  const timer =
    every > 0
      ? setInterval(() => {
          revalidate().catch((err: unknown) => log(`[ws-auth] revalidation failed: ${errText(err)}`));
        }, every)
      : null;
  // Never the reason the process stays up.
  timer?.unref();

  return {
    authorize,
    guard,
    revalidate,
    get tracked() {
      return tracked.size;
    },
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}

// ---------------------------------------------------------------------------
// The other side: a local script connecting to this bridge
// ---------------------------------------------------------------------------

/**
 * A WebSocket to THIS machine's bridge, carrying the bridge token, for scripts that run on
 * the box — recorders, probes, measurements. The token is the only way a local client gets
 * past the gate above.
 *
 *     import { localBridgeSocket } from "@/lib/bridge/ws-auth";
 *     const ws = localBridgeSocket("/ws/audio"); // was: new WebSocket("ws://127.0.0.1:3101/ws/audio")
 *
 * Synchronous, like the constructor it replaces: the token is read from settings while the
 * request waits (ws's `finishRequest`), so handlers attached on the next line miss nothing.
 * Run it from inside the project tree, as tsx scripts there are, for `@/` and the settings
 * key. The port is BRIDGE_PORT or 3101; pass `port` if bridge.port lives only in settings.
 *
 * REFUSES any host but loopback: the bridge only honours the token from this machine, so
 * sending it anywhere else could not work and would hand the transmit secret to whoever is
 * listening there.
 */
export function localBridgeSocket(
  pathOrUrl: string,
  options: { port?: number; token?: string | null } = {},
): WebSocket {
  const port = options.port ?? (Number(process.env.BRIDGE_PORT) || 3101);
  const url = /^wss?:\/\//i.test(pathOrUrl) ? pathOrUrl : `ws://127.0.0.1:${port}${pathOrUrl}`;
  const host = hostnameOf(new URL(url).host);
  if (host !== "localhost" && !isLoopbackAddress(host)) {
    throw new Error(
      `localBridgeSocket: ${url} is not this machine. The bridge token is accepted only over loopback, ` +
        "and is not sent anywhere else.",
    );
  }
  return new WebSocket(url, {
    finishRequest: (request) => {
      const token =
        options.token !== undefined
          ? Promise.resolve(options.token)
          : getSetting("bridge.token").catch(() => null);
      void token.then((value) => {
        try {
          if (value) request.setHeader("X-Bridge-Token", value);
          request.end();
        } catch {
          /* the socket was abandoned while the token was being read */
        }
      });
    },
  });
}
