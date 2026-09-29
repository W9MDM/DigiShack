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

import { CONNECT_TIMEOUT_MS, FIRST_BACKOFF_MS, nextBackoff } from "@/lib/client/socket-retry";

export interface BridgeSocket {
  connected: boolean;
  /** Failed attempts SINCE the last successful open — reset on connect, not a lifetime tally. */
  attempts: number;
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
  const [attempts, setAttempts] = useState(0);
  const handler = useRef(onMessage);
  handler.current = onMessage;

  useEffect(() => {
    if (!wsUrl) return;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let backoff = FIRST_BACKOFF_MS;
    // Declared HERE, not inside connect(), so the cleanup below can reach it.
    let socket: WebSocket | null = null;
    let connectTimer: ReturnType<typeof setTimeout> | null = null;

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

      // THE SAME CONNECT TIMEOUT the decodes page needed, for the same reason: a browser
      // WebSocket left in CONNECTING fires neither `onopen` nor `onclose`, so the retry
      // below is never scheduled and the page waits for ever. A proxy in front of a dead
      // origin produces exactly that state, and this bridge restarts several times a day.
      if (connectTimer) clearTimeout(connectTimer);
      connectTimer = setTimeout(() => {
        if (ws.readyState === WebSocket.CONNECTING) {
          try {
            ws.close();
          } catch {
            /* already gone */
          }
        }
      }, CONNECT_TIMEOUT_MS);

      ws.onopen = () => {
        if (connectTimer) clearTimeout(connectTimer);
        connectTimer = null;
        setConnected(true);
        setAttempts(0);
        backoff = FIRST_BACKOFF_MS;
      };
      ws.onmessage = (ev) => {
        try {
          handler.current(JSON.parse(ev.data as string) as Record<string, unknown>);
        } catch {
          // A malformed frame is not worth a broken page.
        }
      };
      ws.onclose = () => {
        if (connectTimer) clearTimeout(connectTimer);
        connectTimer = null;
        setConnected(false);
        if (closed) return;
        setAttempts((a) => a + 1);
        retry = setTimeout(connect, backoff);
        backoff = nextBackoff(backoff);
      };
      ws.onerror = () => ws.close();
    };

    connect();

    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      if (connectTimer) clearTimeout(connectTimer);
      socket?.close();
    };
  }, [wsUrl]);

  return { connected, attempts };
}
