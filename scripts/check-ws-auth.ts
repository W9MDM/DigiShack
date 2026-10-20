/* eslint-disable no-console */
// The bridge's WebSocket gate (lib/bridge/ws-auth.ts) — code review R04.
// Run: npx tsx scripts/check-ws-auth.ts
//
// Through a REAL http server on an ephemeral loopback port, with REAL ws clients, because
// the 401/403 is written by the gate itself: asserting on the decision object alone would
// leave the half that touches a socket — the async gap, the refusal bytes, the close of a
// revalidated socket — untested.
//
// No database. A fake Prisma is put on globalThis BEFORE anything that imports
// lib/db/prisma is loaded (lib/db/prisma.ts uses `globalThis.prisma ?? new PrismaClient`),
// which is why every application import below is dynamic.
//
// "Through nginx" is not hand-written headers: the proxy_set_header lines of the /ws
// locations are READ FROM deploy/nginx/digishack.conf and applied the way nginx applies
// them. Remove `Host $host` there and the proxied cases here fail with 403 — exactly what
// every browser would get.

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import net, { type AddressInfo } from "node:net";
import path from "node:path";

import WebSocket, { WebSocketServer } from "ws";

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
let lookups = 0;
let failLookups = false;
let lookupDelayMs = 5;

(globalThis as unknown as { prisma?: unknown }).prisma = {
  session: {
    findUnique: async (args: { where: { tokenHash: string } }) => {
      lookups++;
      // A real query takes time; this is what lets concurrent upgrades overlap.
      await new Promise((r) => setTimeout(r, lookupDelayMs));
      if (failLookups) throw new Error("database unavailable (simulated)");
      return sessions.get(args.where.tokenHash) ?? null;
    },
    update: async () => ({}),
    delete: async () => ({}),
  },
};

// ---------------------------------------------------------------------------
// nginx, as far as the /ws locations go
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, "..");
const CONF = readFileSync(path.join(ROOT, "deploy/nginx/digishack.conf"), "utf8");

function locationBlock(loc: string): string {
  const start = CONF.indexOf(`location ${loc} {`);
  if (start === -1) return "";
  return CONF.slice(start, CONF.indexOf("}", start));
}

/** proxy_set_header lines of a location, in order. */
function proxyHeaders(loc: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const m of locationBlock(loc).matchAll(/^\s*proxy_set_header\s+(\S+)\s+(.+?);\s*$/gm)) {
    out.push([m[1]!, m[2]!.trim().replace(/^"(.*)"$/, "$1")]);
  }
  return out;
}

interface Visitor {
  /** What the browser (or attacker) sent nginx. Lowercase names. */
  headers: Record<string, string>;
  /** The peer nginx sees, after real_ip (CF-Connecting-IP from loopback). */
  remoteAddr: string;
  scheme: "http" | "https";
}

/**
 * The headers nginx would send the bridge for this visitor at `loc`. nginx passes the
 * client's headers through, replaces Host with $proxy_host and Connection with close by
 * default, then applies the location's proxy_set_header lines; an empty value removes the
 * header. Hop-by-hop and ws handshake headers are left to the ws client to generate.
 */
function throughNginx(loc: string, v: Visitor): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v.headers)) out[k.toLowerCase()] = val;
  out.host = "digishack_bridge"; // $proxy_host, the upstream's name
  const vars: Record<string, string> = {
    $host: (v.headers.host ?? "").split(":")[0]!.toLowerCase(),
    $remote_addr: v.remoteAddr,
    $proxy_add_x_forwarded_for: v.headers["x-forwarded-for"]
      ? `${v.headers["x-forwarded-for"]}, ${v.remoteAddr}`
      : v.remoteAddr,
    $scheme: v.scheme,
    $http_upgrade: "websocket",
  };
  for (const [name, value] of proxyHeaders(loc)) {
    const key = name.toLowerCase();
    const resolved = value.replace(/\$[a-z_]+/g, (x) => vars[x] ?? "");
    if (key === "upgrade" || key === "connection") continue; // the ws client's own
    if (resolved === "") delete out[key];
    else out[key] = resolved;
  }
  return out;
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const ws_auth = await import("../lib/bridge/ws-auth");
  const session = await import("../lib/auth/session");
  const { createWsGate, hashSessionToken, PROXY_HEADERS, localBridgeSocket } = ws_auth;

  const BRIDGE_TOKEN = randomBytes(24).toString("hex");
  let bridgeToken: string | null = BRIDGE_TOKEN;
  let clock = Date.now();
  const logs: string[] = [];

  function addSession(role: Role, opts: { expired?: boolean; active?: boolean } = {}): string {
    const token = randomBytes(32).toString("base64url"); // exactly as lib/auth/session.ts mints one
    const tokenHash = hashSessionToken(token);
    sessions.set(tokenHash, {
      id: `s${sessions.size}`,
      tokenHash,
      expiresAt: new Date(clock + (opts.expired ? -60_000 : 86_400_000)),
      lastSeenAt: new Date(clock),
      user: {
        id: `u-${role.toLowerCase()}-${sessions.size}`,
        email: "x@example.com",
        name: "x",
        callsign: null,
        role,
        active: opts.active ?? true,
      },
    });
    return token;
  }
  const cookie = (t: string) => `${session.SESSION_COOKIE}=${t}`;

  // -------------------------------------------------------------------------
  console.log("the bridge and lib/auth/session.ts agree on the cookie and its hash");
  // -------------------------------------------------------------------------
  {
    const t = addSession("VIEWER");
    const auth = await session.getAuth({
      headers: { cookie: `other=1; ${cookie(t)}; b=2` },
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as IncomingMessage);
    ok(auth !== null, "getAuth() finds the session the gate's hash names — same cookie name, same SHA-256");
  }

  // -------------------------------------------------------------------------
  // The server under test: the gate in front of the same routing shape as the bridge.
  // -------------------------------------------------------------------------
  const gate = createWsGate({
    bridgeToken: () => bridgeToken,
    now: () => clock,
    revalidateMs: 0,
    log: (l) => logs.push(l),
  });
  const wss = new WebSocketServer({ noServer: true });
  const server = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  server.on(
    "upgrade",
    gate.guard((req, sock, head) => {
      const { pathname } = new URL(req.url ?? "/", "http://x");
      if (pathname !== "/ws/decodes" && pathname !== "/ws/audio") {
        sock.destroy();
        return;
      }
      wss.handleUpgrade(req, sock, head, (ws) => ws.send(JSON.stringify({ kind: "hello", pathname })));
    }),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  const open: WebSocket[] = [];

  /** 101 when it opened (socket kept in `open`), the HTTP status when refused, -1 otherwise. */
  function attempt(p: string, headers: Record<string, string> = {}): Promise<{ status: number; ws?: WebSocket }> {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${p}`, { headers });
      ws.once("open", () => {
        open.push(ws);
        resolve({ status: 101, ws });
      });
      ws.once("error", (err) => {
        const m = /Unexpected server response: (\d+)/.exec(err.message);
        resolve({ status: m ? Number(m[1]) : -1 });
      });
    });
  }
  const local = { origin: `http://127.0.0.1:3000` }; // the no-proxy development layout
  const PUBLIC = "digishack.example.com";
  const viaNginx = (loc: string, h: Record<string, string>, scheme: "http" | "https" = "https") =>
    throughNginx(loc, {
      headers: { host: PUBLIC, origin: `${scheme}://${PUBLIC}`, ...h },
      remoteAddr: "203.0.113.9",
      scheme,
    });

  // -------------------------------------------------------------------------
  console.log("\nno credentials");
  // -------------------------------------------------------------------------
  eq((await attempt("/ws/decodes")).status, 401, "no cookie, no token, straight to the port → 401");
  eq((await attempt("/ws/audio")).status, 401, "the same on /ws/audio (the operator's old recorder) → 401");
  eq(
    (await attempt("/ws/decodes", viaNginx("/ws/decodes", {}))).status,
    401,
    "a stranger through nginx → 401 (the R04 hole)",
  );
  eq(
    (await attempt("/ws/audio", viaNginx("/ws/audio", {}))).status,
    401,
    "a stranger through nginx to receiver audio → 401",
  );
  eq((await attempt("/ws/nonsense")).status, 401, "an unknown path is authenticated too (fail closed) → 401");

  // -------------------------------------------------------------------------
  console.log("\nsession cookies");
  // -------------------------------------------------------------------------
  const viewer = addSession("VIEWER");
  eq((await attempt("/ws/decodes", { cookie: cookie("not-a-session-token-at-all-xx"), ...local })).status, 401, "unknown cookie → 401");
  eq((await attempt("/ws/decodes", { cookie: cookie(addSession("VIEWER", { expired: true })), ...local })).status, 401, "expired session → 401");
  eq((await attempt("/ws/decodes", { cookie: cookie(addSession("ADMIN", { active: false })), ...local })).status, 401, "disabled account → 401");
  eq((await attempt("/ws/decodes", { cookie: `${session.SESSION_COOKIE}=%E0%A4%A`, ...local })).status, 401, "a cookie that will not percent-decode → 401, no crash");
  eq((await attempt("/ws/decodes", { cookie: cookie(viewer), ...local })).status, 101, "valid VIEWER cookie, same-host Origin (page :3000, socket :port) → accepted");
  eq((await attempt("/ws/audio", { cookie: cookie(viewer) })).status, 101, "valid cookie, no Origin (not a browser) → accepted");
  eq((await attempt("/ws/audio", { cookie: `a=1; ${cookie(viewer)}; b=2`, ...local })).status, 101, "the cookie among others → accepted");
  eq((await attempt("/ws/decodes", { cookie: cookie(addSession("OPERATOR")), ...local })).status, 101, "OPERATOR → accepted");
  eq((await attempt("/ws/decodes", { cookie: cookie(addSession("ADMIN")), ...local })).status, 101, "ADMIN → accepted");
  eq(
    (await attempt("/ws/decodes", viaNginx("/ws/decodes", { cookie: cookie(viewer) }))).status,
    101,
    "valid cookie through nginx over https (headers from digishack.conf) → accepted",
  );
  eq(
    (await attempt("/ws/audio", viaNginx("/ws/audio", { cookie: cookie(viewer) }, "http"))).status,
    101,
    "valid cookie through nginx over plain LAN http → accepted",
  );
  eq((await attempt("/ws/nonsense", { cookie: cookie(viewer), ...local })).status, -1, "unknown path with a valid cookie: admitted, then dropped by the router, not upgraded");

  // -------------------------------------------------------------------------
  console.log("\nOrigin");
  // -------------------------------------------------------------------------
  eq((await attempt("/ws/decodes", { cookie: cookie(viewer), origin: "https://evil.example" })).status, 403, "valid cookie, foreign Origin → 403");
  eq(
    (await attempt("/ws/decodes", viaNginx("/ws/decodes", { cookie: cookie(viewer), origin: "https://other.example.com" }))).status,
    403,
    "valid cookie through nginx from another origin on the same site → 403",
  );
  eq((await attempt("/ws/decodes", { cookie: cookie(viewer), origin: "null" })).status, 403, "Origin: null (sandboxed frame, file://) → 403");
  eq((await attempt("/ws/decodes", { cookie: cookie(viewer), origin: "chrome-extension://abc" })).status, 403, "a non-http(s) Origin → 403");
  eq(
    (await attempt("/ws/decodes", { cookie: cookie(viewer), host: "digishack_bridge", "x-forwarded-host": PUBLIC, origin: `https://${PUBLIC}` })).status,
    101,
    "Origin matching X-Forwarded-Host when a proxy rewrote Host → accepted",
  );
  eq((await attempt("/ws/decodes", { cookie: cookie(viewer), origin: "HTTP://127.0.0.1:3000" })).status, 101, "hostname compared case-insensitively");
  {
    // THE HEADER TRAP: a /ws location without `proxy_set_header Host $host`.
    const h = viaNginx("/ws/decodes", { cookie: cookie(viewer) });
    h.host = "digishack_bridge";
    eq((await attempt("/ws/decodes", h)).status, 403, "an nginx location that does not forward Host → 403 for every browser (why that line is load-bearing)");
  }

  // -------------------------------------------------------------------------
  console.log("\nthe bridge token");
  // -------------------------------------------------------------------------
  eq((await attempt("/ws/audio", { "x-bridge-token": BRIDGE_TOKEN })).status, 101, "loopback, X-Bridge-Token → accepted");
  eq((await attempt(`/ws/audio?token=${BRIDGE_TOKEN}`)).status, 101, "loopback, ?token= → accepted");
  eq((await attempt("/ws/audio", { "x-bridge-token": `${BRIDGE_TOKEN}x` })).status, 401, "loopback, wrong token → 401");
  eq((await attempt("/ws/audio", { "x-bridge-token": BRIDGE_TOKEN, "x-real-ip": "203.0.113.9" })).status, 401, "correct token with a proxy header (loopback anonymous through nginx) → 401");
  eq(
    (await attempt("/ws/audio", viaNginx("/ws/audio", { "x-bridge-token": BRIDGE_TOKEN }))).status,
    401,
    "correct token in a header through nginx → 401 (the conf strips it)",
  );
  eq(
    (await attempt(`/ws/audio?token=${BRIDGE_TOKEN}`, viaNginx("/ws/audio", {}))).status,
    401,
    "correct token in the query through nginx → 401",
  );
  ok(logs.some((l) => l.includes("rotate bridge.token")), "and the log says to rotate it, since it was the real one in a URL");
  bridgeToken = null;
  eq((await attempt("/ws/audio", { "x-bridge-token": BRIDGE_TOKEN })).status, 401, "no bridge.token configured → any token 401");
  bridgeToken = BRIDGE_TOKEN;
  {
    const s = localBridgeSocket("/ws/audio", { port, token: BRIDGE_TOKEN });
    const status = await new Promise<number>((resolve) => {
      s.once("open", () => resolve(101));
      s.once("error", () => resolve(-1));
    });
    open.push(s);
    eq(status, 101, "localBridgeSocket() (what the box's scripts use) → accepted");
    let threw = false;
    try {
      localBridgeSocket(`wss://${PUBLIC}/ws/audio`, { token: BRIDGE_TOKEN });
    } catch {
      threw = true;
    }
    ok(threw, "localBridgeSocket() refuses to send the token to any host but loopback");
  }

  // -------------------------------------------------------------------------
  console.log("\ndecisions that need a peer this machine cannot fake");
  // -------------------------------------------------------------------------
  const fake = (remoteAddress: string, headers: Record<string, string>, url = "/ws/audio") =>
    ({ headers, url, socket: { remoteAddress } }) as unknown as IncomingMessage;
  eq((await gate.authorize(fake("10.20.30.40", { "x-bridge-token": BRIDGE_TOKEN }))).ok, false, "correct token from a LAN peer (bindAddress 0.0.0.0) → refused");
  eq((await gate.authorize(fake("10.20.30.40", { cookie: cookie(viewer) }))).ok, true, "a valid cookie from a LAN peer → admitted");
  eq((await gate.authorize(fake("::1", { "x-bridge-token": BRIDGE_TOKEN }))).ok, true, "token from ::1 → admitted");
  eq((await gate.authorize(fake("::ffff:127.0.0.1", { "x-bridge-token": BRIDGE_TOKEN }))).ok, true, "token from ::ffff:127.0.0.1 → admitted");
  let allMark = true;
  for (const h of PROXY_HEADERS) {
    if ((await gate.authorize(fake("127.0.0.1", { "x-bridge-token": BRIDGE_TOKEN, [h]: "x" }))).ok) allMark = false;
  }
  ok(allMark, `each of the ${PROXY_HEADERS.length} proxy headers alone marks a request as forwarded`);
  eq((await gate.authorize(fake("127.0.0.1", { "x-bridge-token": BRIDGE_TOKEN, "cf-connecting-ip": "203.0.113.9", "cf-ray": "1" }))).ok, false, "cloudflared pointed straight at the bridge → token refused");
  eq((await gate.authorize(fake("::1", { cookie: cookie(viewer), host: "[::1]:3101", origin: "http://[::1]:3000" }))).ok, true, "IPv6 Host and Origin compare by hostname");

  // -------------------------------------------------------------------------
  console.log("\ncaching, and what a reconnect storm costs");
  // -------------------------------------------------------------------------
  {
    const t = addSession("VIEWER");
    lookups = 0;
    eq((await attempt("/ws/decodes", { cookie: cookie(t) })).status, 101, "first connection");
    eq((await attempt("/ws/decodes", { cookie: cookie(t) })).status, 101, "second, within the TTL");
    eq(lookups, 1, "two connections inside the TTL → one query");
    clock += 11_000;
    await attempt("/ws/decodes", { cookie: cookie(t) });
    eq(lookups, 2, "after the TTL → asked again");

    const storm = addSession("VIEWER");
    lookups = 0;
    lookupDelayMs = 50;
    const results = await Promise.all(Array.from({ length: 20 }, () => attempt("/ws/audio", { cookie: cookie(storm) })));
    lookupDelayMs = 5;
    ok(results.every((r) => r.status === 101), "20 simultaneous reconnects of one session → all accepted");
    eq(lookups, 1, "…on ONE query");

    lookups = 0;
    for (let i = 0; i < 5; i++) await attempt("/ws/decodes", { cookie: cookie("a-bad-cookie-repeated-xxxxx") });
    eq(lookups, 1, "a bad cookie retried five times inside the TTL → one query (negative cache)");

    failLookups = true;
    eq((await attempt("/ws/decodes", { cookie: cookie(addSession("VIEWER")) })).status, 503, "database down at upgrade → 503, not admitted");
    failLookups = false;
  }

  // -------------------------------------------------------------------------
  console.log("\nlong-lived sockets are re-checked");
  // -------------------------------------------------------------------------
  {
    const t = addSession("VIEWER");
    const r = await attempt("/ws/decodes", { cookie: cookie(t) });
    const closedP = new Promise<boolean>((resolve) => {
      r.ws?.once("close", () => resolve(true));
      setTimeout(() => resolve(false), 2_000);
    });
    failLookups = true;
    await gate.revalidate();
    failLookups = false;
    eq(r.ws?.readyState, WebSocket.OPEN, "database down during revalidation → the socket is kept");
    const tokenSock = await attempt("/ws/audio", { "x-bridge-token": BRIDGE_TOKEN });
    sessions.delete(hashSessionToken(t)); // signed out
    const res = await gate.revalidate();
    ok(res.closed >= 1, `signed out → revalidation closed its socket (${res.closed})`);
    ok(await closedP, "…and the client saw the close");
    eq(tokenSock.ws?.readyState, WebSocket.OPEN, "a token client is not touched by revalidation");

    const t2 = addSession("OPERATOR");
    const r2 = await attempt("/ws/audio", { cookie: cookie(t2) });
    sessions.get(hashSessionToken(t2))!.user.active = false;
    const closed2 = new Promise<boolean>((resolve) => {
      r2.ws?.once("close", () => resolve(true));
      setTimeout(() => resolve(false), 2_000);
    });
    await gate.revalidate();
    ok(await closed2, "account disabled → closed at the next revalidation");
  }

  // -------------------------------------------------------------------------
  console.log("\na client that vanishes mid-lookup");
  // -------------------------------------------------------------------------
  {
    lookupDelayMs = 100;
    await new Promise<void>((resolve) => {
      const s = net.connect(port, "127.0.0.1", () => {
        s.write(
          "GET /ws/decodes HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
            "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
            `Cookie: ${cookie(addSession("VIEWER"))}\r\n\r\n`,
        );
        setTimeout(() => {
          s.resetAndDestroy();
          resolve();
        }, 20);
      });
      s.on("error", () => {});
    });
    await new Promise((r) => setTimeout(r, 150));
    lookupDelayMs = 5;
    eq((await attempt("/ws/decodes", { cookie: cookie(viewer) })).status, 101, "reset during the lookup → no crash, the next client is served");
  }

  // -------------------------------------------------------------------------
  console.log("\nthe shipped proxy configuration");
  // -------------------------------------------------------------------------
  for (const loc of ["/ws/decodes", "/ws/audio"]) {
    const names = proxyHeaders(loc).map(([n, v]) => `${n.toLowerCase()} ${v}`);
    ok(names.includes("host $host"), `${loc} forwards Host $host (the Origin check needs it)`);
    ok(names.includes("x-real-ip $remote_addr"), `${loc} sets X-Real-IP (marks the request as proxied)`);
    ok(names.includes("x-bridge-token "), `${loc} drops any client-supplied X-Bridge-Token`);
  }
  const lxc = readFileSync(path.join(ROOT, "deploy/proxmox/digishack-lxc.sh"), "utf8");
  ok(/install -m 644 \/opt\/digishack\/deploy\/nginx\/digishack\.conf/.test(lxc), "the Proxmox installer installs that same file");

  for (const w of open) w.terminate();
  gate.stop();
  server.close();
  wss.close();
  console.log("");
  if (failed > 0) {
    console.log(`${failed} FAILED`);
    process.exit(1);
  }
  console.log("all ws-auth assertions passed");
  process.exit(0);
}

setTimeout(() => {
  console.log("TIMED OUT");
  process.exit(1);
}, 30_000).unref();

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
