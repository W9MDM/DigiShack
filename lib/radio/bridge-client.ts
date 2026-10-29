// Talking to the bridge from the web tier, in one place.
//
// The bridge listens on 127.0.0.1 only and every mutating route wants its token, which lives
// in encrypted settings and must never reach a browser or a worker. pages/api/bridge/* have
// done this inline since the beginning; the public radio API needs the same thing, and two
// copies of "read the token, read the port, fetch with a timeout" would be two places for
// the next port change to miss. The browser proxies are left as they are - they work, they
// are asserted by check:flex-wiring - and this is what new callers use.

import { getNumberSetting, getSetting } from "@/lib/settings";

export interface BridgeAnswer {
  /** False when nothing answered on the port at all. */
  reachable: boolean;
  /** The HTTP status when it answered. */
  status: number;
  body: unknown;
}

async function port(): Promise<number> {
  return getNumberSetting("bridge.port", 3101);
}

/** GET /status, or `reachable: false` when the bridge is not running. */
export async function bridgeStatus(): Promise<BridgeAnswer> {
  try {
    const r = await fetch(`http://127.0.0.1:${await port()}/status`, {
      signal: AbortSignal.timeout(3_000),
    });
    return { reachable: true, status: r.status, body: await r.json() };
  } catch {
    return { reachable: false, status: 0, body: null };
  }
}

/**
 * Turn the auto operator off, whatever mode it is in. True when the bridge confirmed it, or
 * answered 503 - no native transmit path, so there is no auto operator to be running. False
 * when the bridge could not be asked; the caller says so rather than claiming it stopped.
 */
export async function stopAutomation(): Promise<boolean> {
  const answer = await bridgeCommand("auto", { mode: "off" });
  return answer.reachable && ((answer.status >= 200 && answer.status < 300) || answer.status === 503);
}

/**
 * POST a control action with the shared token. `tokenMissing` is distinct from unreachable:
 * the bridge provisions its own token on first run, so a missing one means it has never
 * started on this install.
 */
export async function bridgeCommand(
  path: string,
  payload: Record<string, unknown>,
): Promise<BridgeAnswer & { tokenMissing?: boolean }> {
  const token = await getSetting("bridge.token");
  if (!token) return { reachable: false, status: 0, body: null, tokenMissing: true };
  try {
    const r = await fetch(`http://127.0.0.1:${await port()}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Bridge-Token": token },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5_000),
    });
    let body: unknown = null;
    try {
      body = await r.json();
    } catch {
      body = null;
    }
    return { reachable: true, status: r.status, body };
  } catch {
    return { reachable: false, status: 0, body: null };
  }
}
