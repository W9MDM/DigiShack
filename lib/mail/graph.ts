// Microsoft Graph, for a mailbox in Microsoft 365, through an app registration.
//
// ONE client for both directions — sending QSL email and alerts (Mail.Send) and reading
// received cards (Mail.Read) — so there is one set of credentials, one token cache and one
// place that turns Microsoft's refusals into sentences.
//
// Client-credentials flow: the app signs in as itself with a client secret, not as a user,
// so nothing here involves a browser and nothing expires the way a user's refresh token
// does. The mailbox is named on every request (`/users/{mailbox}/...`), and what the app
// may touch is whatever the tenant granted it — usually narrowed to this one mailbox by an
// Exchange application access policy, which is why a 403 below is explained as one.
//
// READING IS READ-ONLY. Nothing in this file issues PATCH, DELETE or a move, and the
// receiving side only ever GETs. A message stays unread, in its folder, exactly as it was;
// Mail.Read could not do otherwise, and the code should not even try.
//
// `fetch` is injected so scripts/check-qsl-inbound.ts can drive paging, refusals and
// throttling without a network or a tenant.

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface GraphConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** The mailbox both sent from and read: k9xyz@example.com. */
  mailbox: string;
}

export const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";

/** A refusal from Microsoft, with a sentence an operator can act on. */
export class GraphError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GraphError";
  }
}

// Tenant IDs are a GUID or a domain; client IDs a GUID. Checked because both are put into a
// URL, and a value with a slash or a query string in it would aim the request somewhere else.
const TENANT_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
const CLIENT_RE = /^[A-Za-z0-9-]{8,64}$/;
const MAILBOX_RE = /^[^\s@/\\?#]+@[^\s@/\\?#]+\.[^\s@/\\?#]+$/;

/** What is wrong with the configuration, or null when it is usable. Never echoes the secret. */
export function graphConfigProblem(c: Partial<GraphConfig>): string | null {
  if (!c.tenantId) return "The Microsoft 365 tenant ID is not set (Settings → QSL → Microsoft 365 mail app).";
  if (!TENANT_RE.test(c.tenantId)) return "The tenant ID should be a GUID or a domain such as example.onmicrosoft.com.";
  if (!c.clientId) return "The Microsoft 365 application (client) ID is not set.";
  if (!CLIENT_RE.test(c.clientId)) return "The application (client) ID should be the GUID from the app registration.";
  if (!c.clientSecret) return "The Microsoft 365 client secret is not set.";
  if (!c.mailbox) return "The Microsoft 365 mailbox address is not set.";
  if (!MAILBOX_RE.test(c.mailbox)) return `"${c.mailbox}" is not a mailbox address.`;
  return null;
}

/** Longest a Retry-After is honoured for. Graph asks for seconds; a minute is a ceiling. */
const MAX_RETRY_WAIT_MS = 60_000;
const MAX_RETRIES = 3;

/**
 * Microsoft's error body, when there is one, reduced to its message.
 *
 * Token errors carry `error_description` with an AADSTS code; Graph errors carry
 * `error.message`. Either is far more useful than the status line.
 */
async function errorDetail(res: Response): Promise<string> {
  try {
    const text = (await res.text()).slice(0, 2000);
    try {
      const j = JSON.parse(text) as {
        error?: { code?: string; message?: string } | string;
        error_description?: string;
      };
      if (typeof j.error_description === "string") return j.error_description.split("\r\n")[0] ?? "";
      if (j.error && typeof j.error === "object") {
        return [j.error.code, j.error.message].filter(Boolean).join(": ");
      }
      if (typeof j.error === "string") return j.error;
    } catch {
      /* not JSON */
    }
    return text.trim().slice(0, 300);
  } catch {
    return "";
  }
}

export interface GraphClientOptions {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class GraphClient {
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    readonly config: GraphConfig,
    opts: GraphClientOptions = {},
  ) {
    const problem = graphConfigProblem(config);
    if (problem) throw new GraphError(0, problem);
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? (() => Date.now());
  }

  /** The mailbox path segment, encoded once. */
  get userPath(): string {
    return `${GRAPH_ROOT}/users/${encodeURIComponent(this.config.mailbox)}`;
  }

  /** An access token, from cache while it has more than a minute to run. */
  async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt - 60_000 > this.now()) return this.token.value;
    const url = `https://login.microsoftonline.com/${encodeURIComponent(this.config.tenantId)}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    });
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new GraphError(0, `Could not reach Microsoft sign-in: ${err instanceof Error ? err.message : "network error"}`);
    }
    if (!res.ok) {
      const detail = await errorDetail(res);
      // AADSTS7000215 is a wrong secret, 700016 an unknown client id, 90002 an unknown
      // tenant. The description names which; it never contains the secret itself.
      throw new GraphError(
        res.status,
        `Microsoft refused the app's sign-in (${res.status}). Check the tenant ID, client ID and ` +
          `client secret — and that the secret has not expired.${detail ? ` Microsoft said: ${detail}` : ""}`,
      );
    }
    const j = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!j.access_token) throw new GraphError(res.status, "Microsoft sign-in answered without a token.");
    this.token = { value: j.access_token, expiresAt: this.now() + (j.expires_in ?? 3600) * 1000 };
    return j.access_token;
  }

  /**
   * One Graph request, with the token, throttling handled and refusals explained.
   *
   * `url` must be on graph.microsoft.com — enforced, because paging follows `@odata.nextLink`
   * from a response body, and a token sent wherever a response pointed would be a token
   * handed to anyone who could shape that response.
   */
  async request(
    url: string,
    init: { method?: "GET" | "POST"; headers?: Record<string, string>; body?: string } = {},
  ): Promise<Response> {
    if (!url.startsWith(`${GRAPH_ROOT}/`)) {
      throw new GraphError(0, "Refusing to send the Microsoft token outside graph.microsoft.com.");
    }
    for (let attempt = 0; ; attempt++) {
      const token = await this.accessToken();
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: init.method ?? "GET",
          headers: { Authorization: `Bearer ${token}`, ...init.headers },
          body: init.body,
          signal: AbortSignal.timeout(60_000),
        });
      } catch (err) {
        throw new GraphError(0, `Could not reach Microsoft Graph: ${err instanceof Error ? err.message : "network error"}`);
      }
      if (res.ok) return res;

      // Throttled, or briefly unavailable: wait as asked, a few times, then give up and let
      // the next scheduled run pick up from where this one stopped.
      if ((res.status === 429 || res.status === 503) && attempt < MAX_RETRIES) {
        const after = Number(res.headers.get("Retry-After"));
        const wait = Number.isFinite(after) && after > 0 ? Math.min(after * 1000, MAX_RETRY_WAIT_MS) : 5_000 * (attempt + 1);
        await res.body?.cancel().catch(() => undefined);
        await this.sleep(wait);
        continue;
      }
      // A token that went stale between the cache check and the call: one fresh try.
      if (res.status === 401 && attempt === 0) {
        this.token = null;
        await res.body?.cancel().catch(() => undefined);
        continue;
      }
      const detail = await errorDetail(res);
      throw new GraphError(res.status, explainStatus(res.status, this.config.mailbox, detail));
    }
  }

  async json<T>(url: string): Promise<T> {
    const res = await this.request(url);
    return (await res.json()) as T;
  }

  /**
   * Send one message, given as complete MIME.
   *
   * MIME rather than Graph's JSON message on purpose. The JSON form accepts custom headers
   * only when their names begin with "X-", so List-Unsubscribe — the header behind the
   * unsubscribe button Gmail and Outlook draw, which the SMTP path has always set — could
   * not be sent that way. As MIME, the message is byte-for-byte what nodemailer would have
   * handed the SMTP server, card attachment and Content-ID included.
   *
   * Graph caps a sendMail request at 4 MB, and MIME is base64 again on the way in, so the
   * cap is checked here and refused in a sentence rather than by Microsoft in a 413.
   */
  async sendMime(mime: Buffer): Promise<void> {
    const payload = mime.toString("base64");
    if (payload.length > GRAPH_SENDMAIL_MAX_BYTES) {
      throw new GraphError(
        413,
        `This message is ${(payload.length / 1024 / 1024).toFixed(1)} MB once encoded for Microsoft 365, ` +
          `over the ${GRAPH_SENDMAIL_MAX_BYTES / 1024 / 1024} MB a single send allows. Lower the card size ` +
          "or quality (Settings → QSL card), or send through SMTP.",
      );
    }
    await this.request(`${this.userPath}/sendMail`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: payload,
    });
  }
}

/** Graph's sendMail request ceiling, with a little room for the request itself. */
export const GRAPH_SENDMAIL_MAX_BYTES = 3_900_000;

/** A refusal, as a sentence that says what to change. */
export function explainStatus(status: number, mailbox: string, detail: string): string {
  const said = detail ? ` Microsoft said: ${detail}` : "";
  if (status === 401) {
    return `Microsoft Graph did not accept the app's token (401). The secret may have expired or been replaced.${said}`;
  }
  if (status === 403) {
    // The usual cause, by a distance: the permission is granted, but an Exchange application
    // access policy limits the app to a group this mailbox is not in. The second most usual:
    // the permission was added and admin consent never given.
    return (
      `Access to ${mailbox} was refused (403). Most likely an Exchange application access policy ` +
      `does not include this mailbox, or the app's Mail.Read / Mail.Send permission has not had ` +
      `admin consent.${said}`
    );
  }
  if (status === 404) {
    return `Microsoft 365 has no mailbox ${mailbox} that this app can see (404).${said}`;
  }
  if (status === 429) return `Microsoft Graph is throttling this app (429) and kept asking it to wait.${said}`;
  return `Microsoft Graph answered ${status}.${said}`;
}
