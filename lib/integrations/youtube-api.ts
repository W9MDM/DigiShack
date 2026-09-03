// Talking to YouTube as the channel owner.
//
// WHY AN API KEY IS NOT ENOUGH, since that is what an operator reaches for first. An API
// key reads public data. Both of the things this station wants — renaming the day's
// broadcast, and reading the live chat so a viewer can post a callsign to be worked — act
// AS the channel, and Google only permits that against an OAuth token. The key is not used
// anywhere in this file.
//
// THE SCOPE IS ONE STRING and it covers both: `youtube.force-ssl`. `youtube.readonly`
// cannot write a title, and the narrower chat scopes do not exist.
//
// WHAT IS STORED. The client ID is not a secret. The client SECRET and the REFRESH TOKEN
// are, and both are held encrypted like the Club Log key — the refresh token especially,
// because it is a standing grant to act as the channel until it is revoked. Neither is ever
// returned to a browser, and neither appears in a log line.
//
// THE SEVEN-DAY TRAP. Google expires refresh tokens issued by an app still in "Testing"
// after one week. An operator who does not publish their consent screen would find the
// title stopped updating every Monday with no error anywhere, because the failure looks
// like an ordinary auth rejection. `describeAuthFailure` names it, since nothing else will.

import { getSetting, writeSettings } from "@/lib/settings";

/** The one scope that covers reading live chat and updating a broadcast. */
export const YOUTUBE_SCOPE = "https://www.googleapis.com/auth/youtube.force-ssl";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API_BASE = "https://www.googleapis.com/youtube/v3";

/**
 * Where Google sends the operator back to after consent.
 *
 * Must match a URI registered on the OAuth client EXACTLY, including scheme and any
 * trailing path — Google compares strings, not hosts, and a mismatch fails with
 * `redirect_uri_mismatch` rather than anything that names the cause.
 */
export function redirectUri(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/api/youtube/callback`;
}

/**
 * The consent URL the operator visits once.
 *
 * `access_type=offline` is what asks for a REFRESH token rather than only an hour of
 * access, and `prompt=consent` forces Google to issue a new one even if this account has
 * approved the app before — without it, a second attempt returns an access token and no
 * refresh token, and the connection silently stops working an hour later.
 */
export function consentUrl(clientId: string, baseUrl: string, state: string): string {
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(baseUrl),
    response_type: "code",
    scope: YOUTUBE_SCOPE,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `${AUTH_URL}?${p.toString()}`;
}

export interface TokenSet {
  accessToken: string;
  /** Absolute epoch ms. */
  expiresAt: number;
  /** Only present on the first exchange, which is why it must be stored then. */
  refreshToken?: string;
}

/**
 * Turn Google's `expires_in` into an absolute expiry, with a margin.
 *
 * SIXTY SECONDS EARLY, deliberately. A token that expires between the check and the request
 * fails the request, and the request in question might be the one carrying a title change
 * at the start of a broadcast. The margin costs one extra refresh an hour.
 */
export function expiryFrom(expiresInSeconds: number, now = Date.now()): number {
  return now + Math.max(0, expiresInSeconds - 60) * 1000;
}

/** Is this token still usable? */
export function tokenUsable(t: TokenSet | null, now = Date.now()): boolean {
  return t !== null && t.accessToken !== "" && t.expiresAt > now;
}

/**
 * Explain an auth failure in terms an operator can act on.
 *
 * Google's own messages are accurate and useless here: `invalid_grant` covers a revoked
 * token, a token from a different client, and — overwhelmingly the likely one — a refresh
 * token that expired because the consent screen is still in Testing. Naming the seven-day
 * rule is the difference between a fix and a shrug.
 */
export function describeAuthFailure(status: number, body: string): string {
  if (body.includes("invalid_grant")) {
    return (
      "YouTube rejected the stored refresh token (invalid_grant). The usual cause is an " +
      "OAuth consent screen still in Testing, which expires refresh tokens after 7 days — " +
      "publish the app in Google Cloud Console and reconnect. It also happens if access " +
      "was revoked, or the client ID changed."
    );
  }
  if (body.includes("invalid_client")) {
    return "YouTube rejected the client ID or secret (invalid_client). Check both in Settings.";
  }
  if (status === 403 && body.includes("quota")) {
    return (
      "The YouTube Data API daily quota is exhausted. Chat polling is the usual cause — " +
      "lengthen the interval or request more quota in Google Cloud Console."
    );
  }
  if (status === 403) {
    return `YouTube refused the request (403). ${body.slice(0, 200)}`;
  }
  return `YouTube returned HTTP ${status}. ${body.slice(0, 200)}`;
}

/** Exchange the one-time code from the consent redirect for a refresh token. */
export async function exchangeCode(
  code: string,
  clientId: string,
  clientSecret: string,
  baseUrl: string,
): Promise<TokenSet> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri(baseUrl),
      grant_type: "authorization_code",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(describeAuthFailure(res.status, text));
  const j = JSON.parse(text) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!j.refresh_token) {
    // The one failure worth its own sentence: without a refresh token the connection works
    // for an hour and then stops, which is the hardest kind of fault to attribute later.
    throw new Error(
      "Google returned no refresh token. That happens when the account has already " +
        "approved this app — reconnect, and if it recurs remove the app's access at " +
        "myaccount.google.com/permissions and try again.",
    );
  }
  return {
    accessToken: j.access_token ?? "",
    expiresAt: expiryFrom(j.expires_in ?? 3600),
    refreshToken: j.refresh_token,
  };
}

/** One access token, cached in the process until it is nearly expired. */
let cached: TokenSet | null = null;

/** Forget the cached access token — used after a failure, so the next call re-authorises. */
export function clearTokenCache(): void {
  cached = null;
}

/**
 * A usable access token, refreshed if necessary.
 *
 * Cached per process. The bridge and the web tier each keep their own, which is the same
 * accepted duplication the settings cache has — two refreshes an hour is not worth a shared
 * store, and a shared one would need invalidation both ways.
 */
export async function accessToken(): Promise<string> {
  if (tokenUsable(cached)) return cached!.accessToken;

  const clientId = (await getSetting("youtube.clientId"))?.trim();
  const clientSecret = (await getSetting("youtube.clientSecret"))?.trim();
  const refresh = (await getSetting("youtube.refreshToken"))?.trim();
  if (!clientId || !clientSecret || !refresh) {
    throw new Error(
      "YouTube is not connected. Settings → YouTube Live → Connect to YouTube.",
    );
  }

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refresh,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) {
    cached = null;
    throw new Error(describeAuthFailure(res.status, text));
  }
  const j = JSON.parse(text) as { access_token?: string; expires_in?: number };
  cached = {
    accessToken: j.access_token ?? "",
    expiresAt: expiryFrom(j.expires_in ?? 3600),
  };
  return cached.accessToken;
}

/** Store the refresh token from a completed consent. */
export async function storeRefreshToken(token: string, userId: string): Promise<void> {
  await writeSettings([{ key: "youtube.refreshToken", value: token }], userId);
  clearTokenCache();
}

/** Is YouTube connected at all? Cheap enough for a status payload. */
export async function youtubeConnected(): Promise<boolean> {
  const [id, secret, refresh] = await Promise.all([
    getSetting("youtube.clientId"),
    getSetting("youtube.clientSecret"),
    getSetting("youtube.refreshToken"),
  ]);
  return Boolean(id?.trim() && secret?.trim() && refresh?.trim());
}

/**
 * One authorised call to the Data API.
 *
 * Retries ONCE after clearing the token cache, because the single most common transient
 * failure is an access token that expired a moment sooner than its stated lifetime. Any
 * second failure is reported rather than retried — a loop against a quota error would
 * exhaust what is left of the day's allowance.
 */
export async function youtubeApi<T>(
  path: string,
  init: { method?: string; query?: Record<string, string>; body?: unknown } = {},
): Promise<T> {
  const call = async (): Promise<Response> => {
    const token = await accessToken();
    const q = init.query ? `?${new URLSearchParams(init.query).toString()}` : "";
    return fetch(`${API_BASE}${path}${q}`, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  };

  let res = await call();
  if (res.status === 401) {
    clearTokenCache();
    res = await call();
  }
  const text = await res.text();
  if (!res.ok) throw new Error(describeAuthFailure(res.status, text));
  return (text ? JSON.parse(text) : {}) as T;
}

// ---------------------------------------------------------------------------
// The day's broadcast
// ---------------------------------------------------------------------------

/** What a title or description template can refer to. */
export interface BroadcastFacts {
  callsign: string;
  grid: string;
  band: string | null;
  mode: string | null;
  qsos: number;
  /** UTC date, so a title set at 23:50 local names the day the log will file it under. */
  date: Date;
}

/** YouTube truncates past this; it does not refuse. */
export const TITLE_MAX = 100;

/**
 * Fill a title or description template.
 *
 * UNKNOWN PLACEHOLDERS ARE LEFT ALONE rather than blanked. An operator who writes {callsgin}
 * should see their typo in the title, not a hole — a silently emptied placeholder reads as
 * the station having no callsign, and there is nothing to trace it back to.
 *
 * A band or mode the radio has not reported yet renders as "--" rather than an empty gap,
 * for the same reason the overlay does it: absent and empty look different on a screen.
 */
export function renderTemplate(template: string, f: BroadcastFacts): string {
  const values: Record<string, string> = {
    date: f.date.toISOString().slice(0, 10),
    callsign: f.callsign || "--",
    grid: f.grid || "--",
    band: f.band ?? "--",
    mode: f.mode ?? "--",
    qsos: String(f.qsos),
  };
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key]! : whole,
  );
}

/** A title that YouTube will accept whole. */
export function renderTitle(template: string, f: BroadcastFacts): string {
  const t = renderTemplate(template, f).trim();
  // TRIMMED HERE rather than left to YouTube, which cuts mid-word without saying so. A
  // title ending in an ellipsis at least reads as deliberate.
  return t.length <= TITLE_MAX ? t : t.slice(0, TITLE_MAX - 1).trimEnd() + "…";
}
