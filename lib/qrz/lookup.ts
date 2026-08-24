import { getSetting } from "@/lib/settings";

// QRZ.com XML callsign lookup.
//
// Two steps, both against xmldata.qrz.com:
//
//   1. Log in with username/password -> a session key
//   2. Look up a callsign with that key
//
// The session key lasts about 24 hours, so it is cached in memory and renewed on
// the specific error QRZ returns for an expired one. Logging in per lookup would
// be both slow and rude to a service that asks you not to.
//
// The email address is only present for accounts with an XML subscription, and
// only for hams who have chosen to publish it. A missing email is therefore a
// normal outcome, not an error — the caller must handle it.

const XML_URL = "https://xmldata.qrz.com/xml/current/";

export interface QrzCallsignInfo {
  callsign: string;
  name: string | null;
  email: string | null;
  grid: string | null;
  country: string | null;
  state: string | null;
  county: string | null;
  /** Their preferred QSL route, free text, as QRZ stores it. */
  qslVia: string | null;
  /** True when the record says they accept eQSL / LoTW. */
  eqsl: boolean | null;
  lotw: boolean | null;
}

export type QrzLookupResult =
  | { status: "found"; info: QrzCallsignInfo }
  | { status: "not-found" }
  | { status: "no-credentials" }
  | { status: "error"; reason: string };

/** Cached session key. QRZ keys are good for roughly a day. */
let sessionKey: string | null = null;
let sessionAt = 0;
const SESSION_TTL_MS = 20 * 60 * 60_000;

/** Pull one tag's text out of QRZ's XML. Their responses are small and flat. */
function tag(xml: string, name: string): string | null {
  const m = new RegExp(`<${name}>([^<]*)</${name}>`, "i").exec(xml);
  const v = m?.[1]?.trim();
  return v ? v : null;
}

async function login(): Promise<{ key: string } | { error: string }> {
  const username = await getSetting("qrz.username");
  const password = await getSetting("qrz.password");
  if (!username || !password) return { error: "no-credentials" };

  const url = `${XML_URL}?username=${encodeURIComponent(username)};password=${encodeURIComponent(password)};agent=DigiShack`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return { error: `QRZ login returned HTTP ${res.status}` };

  const xml = await res.text();
  const key = tag(xml, "Key");
  if (key) {
    sessionKey = key;
    sessionAt = Date.now();
    return { key };
  }
  // QRZ reports login problems in <Error>, not via HTTP status.
  return { error: tag(xml, "Error") ?? "QRZ login failed for an unstated reason" };
}

async function sessionFor(force = false): Promise<{ key: string } | { error: string }> {
  if (!force && sessionKey && Date.now() - sessionAt < SESSION_TTL_MS) {
    return { key: sessionKey };
  }
  return login();
}

/** Clear the cached session — used when credentials change. */
export function resetQrzSession(): void {
  sessionKey = null;
  sessionAt = 0;
}

/**
 * Look up one callsign.
 *
 * Retries exactly once on an expired session: QRZ signals that in the body
 * rather than with a status code, and a stale key is the common case for a
 * long-running process.
 */
export async function lookupCallsign(callsign: string): Promise<QrzLookupResult> {
  const call = callsign.trim().toUpperCase();
  if (!call) return { status: "not-found" };

  for (let attempt = 0; attempt < 2; attempt++) {
    const session = await sessionFor(attempt > 0);
    if ("error" in session) {
      return session.error === "no-credentials"
        ? { status: "no-credentials" }
        : { status: "error", reason: session.error };
    }

    let xml: string;
    try {
      const res = await fetch(
        `${XML_URL}?s=${encodeURIComponent(session.key)};callsign=${encodeURIComponent(call)}`,
        { signal: AbortSignal.timeout(15_000) },
      );
      if (!res.ok) return { status: "error", reason: `QRZ returned HTTP ${res.status}` };
      xml = await res.text();
    } catch (err) {
      return {
        status: "error",
        reason: err instanceof Error ? err.message : "QRZ request failed",
      };
    }

    const error = tag(xml, "Error");
    if (error) {
      // "Session Timeout" / "Invalid session key" — log in again and retry once.
      if (/session/i.test(error) && attempt === 0) {
        resetQrzSession();
        continue;
      }
      if (/not found/i.test(error)) return { status: "not-found" };
      return { status: "error", reason: error };
    }

    const found = tag(xml, "call");
    if (!found) return { status: "not-found" };

    const fname = tag(xml, "fname");
    const lname = tag(xml, "name");
    return {
      status: "found",
      info: {
        callsign: found.toUpperCase(),
        name: [fname, lname].filter(Boolean).join(" ") || null,
        email: tag(xml, "email"),
        grid: tag(xml, "grid"),
        country: tag(xml, "country"),
        state: tag(xml, "state"),
        county: tag(xml, "county"),
        qslVia: tag(xml, "qslmgr"),
        // QRZ sends "1"/"0" for these; absent means unknown, not false.
        eqsl: tag(xml, "eqsl") === null ? null : tag(xml, "eqsl") === "1",
        lotw: tag(xml, "lotw") === null ? null : tag(xml, "lotw") === "1",
      },
    };
  }

  return { status: "error", reason: "QRZ session could not be established" };
}
