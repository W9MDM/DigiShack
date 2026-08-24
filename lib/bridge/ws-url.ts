// Where a browser should connect to the bridge's WebSocket.
//
// Extracted because a second page now needs it, and the rule is subtle enough that a copy
// would drift: the bridge listens on its own port, which is fine in development and wrong
// on a deployed install, where NGINX proxies the socket onto the app's own origin. An
// explicit setting wins; the fallback guesses the bridge port on this host.
//
// Server-side only — it reads settings.

import type { IncomingHttpHeaders } from "node:http";

import { getNumberSetting, getSetting } from "@/lib/settings";

export async function bridgeWsUrl(headers: IncomingHttpHeaders): Promise<{
  wsUrl: string;
  bridgePort: number;
}> {
  const bridgePort = await getNumberSetting("bridge.port", 3101);
  const configured = await getSetting("bridge.wsUrl");

  if (configured) return { wsUrl: configured, bridgePort };

  // Behind any reverse proxy, the socket is SAME-ORIGIN with no port. The bridge
  // binds 127.0.0.1 only, so its port is unreachable from anywhere but the box
  // itself — the proxy (nginx, a Cloudflare Tunnel) is what exposes /ws/decodes on
  // the app's own origin, and deploy/nginx does exactly that. Guessing host:3101
  // here left the decode page saying "connecting" forever on every proxied install.
  //
  // "Behind a proxy" is read from the headers the shipped nginx config always sets
  // (X-Real-IP / X-Forwarded-Proto); a bare `next dev` or `next start` sets neither
  // and falls through to the direct-port guess, which is correct there — the
  // browser and the bridge share a loopback.
  const forwardedProto = (headers["x-forwarded-proto"] as string | undefined)
    ?.split(",")[0]
    ?.trim();
  if (forwardedProto || headers["x-real-ip"]) {
    const host = headers.host ?? "localhost";
    // wss when the page is https — a ws:// socket there is blocked as mixed content.
    const scheme = forwardedProto === "https" ? "wss" : "ws";
    return { wsUrl: `${scheme}://${host}/ws/decodes`, bridgePort };
  }

  // No proxy in sight: talk to the bridge's port directly, on this same machine.
  const host = (headers.host ?? "localhost:3000").split(":")[0];
  return { wsUrl: `ws://${host}:${bridgePort}/ws/decodes`, bridgePort };
}
