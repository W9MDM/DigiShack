// A bridge WebSocket subscription that actually closes when the component goes away.
//
// The reason this is a hook rather than a few lines in each page: the digital page once
// declared its socket inside the connect() closure, out of reach of the cleanup, which
// therefore set a flag and cleared a timer and never closed anything. Every re-run of the
// effect left the previous socket open and still delivering — and React's development
// double-mount guarantees a re-run. Three live sockets meant every decode arrived three
// times, appended three times, exact triplicates in every column, and because the row list
// is capped it cut the number of DISTINCT stations on screen to a third.
//
// One place to get that right is better than one place per page.

import { useEffect, useRef, useState } from "react";

export interface BridgeSocket {
  connected: boolean;
}

/**
 * Subscribe to the bridge, handing every parsed message to `onMessage`.
 *
 * `onMessage` is held in a ref, so a caller may pass an inline arrow function without
 * tearing the socket down and rebuilding it on every render — which would reconnect
 * several times a second and look, from the bridge, like a client flapping.
 */
export function useBridgeSocket(
  wsUrl: string | null,
  onMessage: (msg: Record<string, unknown>) => void,
): BridgeSocket {
  const [connected, setConnected] = useState(false);
  const handler = useRef(onMessage);
  handler.current = onMessage;

  useEffect(() => {
    if (!wsUrl) return;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let backoff = 1_000;
    // Declared HERE, not inside connect(), so the cleanup below can reach it.
    let socket: WebSocket | null = null;

    const connect = () => {
      if (closed) return;
      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl);
      } catch {
        retry = setTimeout(connect, backoff);
        return;
      }
      socket = ws;

      ws.onopen = () => {
        setConnected(true);
        backoff = 1_000;
      };
      ws.onmessage = (ev) => {
        try {
          handler.current(JSON.parse(ev.data as string) as Record<string, unknown>);
        } catch {
          // A malformed frame is not worth a broken page.
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (closed) return;
        retry = setTimeout(connect, backoff);
        // Backing off to half a minute: the bridge restarts in seconds, but a radio at the
        // end of a VPN can be gone for a while and a page left open must not hammer it.
        backoff = Math.min(30_000, backoff * 2);
      };
      ws.onerror = () => ws.close();
    };

    connect();

    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      socket?.close();
    };
  }, [wsUrl]);

  return { connected };
}
