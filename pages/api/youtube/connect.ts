import crypto from "node:crypto";

import type { NextApiRequest, NextApiResponse } from "next";

import { sendError, sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import { getSetting } from "@/lib/settings";
import { consentUrl, redirectUri } from "@/lib/integrations/youtube-api";

// Start the one-time YouTube consent.
//
// Returns a URL for the operator to visit. Google sends them back to /api/youtube/callback
// with a code, which that route exchanges for a refresh token.
//
// ADMIN, not OPERATOR. Connecting an account is not an operating decision — it grants a
// standing right to act as the channel — so it sits with the role that owns credentials.

/**
 * A one-use value tying the callback to this request.
 *
 * Without it, anyone who can reach the callback URL could hand it a code from a DIFFERENT
 * Google account and have this station store a refresh token for a channel its operator
 * does not own. Held in memory rather than the database: it is valid for one handshake and
 * a restart mid-consent is a re-click, not a fault.
 */
const pending = new Map<string, number>();
const STATE_TTL_MS = 10 * 60_000;

export function issueState(now = Date.now()): string {
  for (const [k, at] of pending) if (now - at > STATE_TTL_MS) pending.delete(k);
  const state = crypto.randomBytes(24).toString("base64url");
  pending.set(state, now);
  return state;
}

/** True exactly once per state, and never after it has expired. */
export function consumeState(state: string, now = Date.now()): boolean {
  const at = pending.get(state);
  if (at === undefined) return false;
  pending.delete(state);
  return now - at <= STATE_TTL_MS;
}

/**
 * Where Google should return to.
 *
 * From the REQUEST rather than a setting, so an install reached on a different hostname
 * does not need one more thing configured — and behind Cloudflare the forwarded proto is
 * the only honest source of the scheme, since the origin itself is plain HTTP.
 */
export function baseUrlFrom(req: NextApiRequest): string {
  const host = (req.headers["x-forwarded-host"] as string) ?? req.headers.host ?? "localhost:3000";
  const proto = (req.headers["x-forwarded-proto"] as string) ?? "https";
  return `${proto.split(",")[0]!.trim()}://${host.split(",")[0]!.trim()}`;
}

async function get(req: NextApiRequest, res: NextApiResponse) {
  const clientId = (await getSetting("youtube.clientId"))?.trim();
  if (!clientId) {
    sendError(
      res,
      400,
      "Set the YouTube OAuth client ID first, in Settings → YouTube Live.",
    );
    return;
  }
  const base = baseUrlFrom(req);
  sendJson(res, 200, {
    url: consentUrl(clientId, base, issueState()),
    // Echoed so the operator can paste it into Google Cloud Console, which compares this
    // string exactly and fails with `redirect_uri_mismatch` when it differs by a character.
    redirectUri: redirectUri(base),
  });
}

export default authedRoute({ GET: { role: "ADMIN", handler: get } });
