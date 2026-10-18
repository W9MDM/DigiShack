// DigiShack's adapter to the pinned Pat engine (v1.0.0) over its LOOPBACK HTTP API.
//
// This is the only place that speaks Pat's wire format. It bounds every response, times
// out, classifies failures (so callers can tell "engine not running" from "bad reply"),
// redacts the stored Winlink secret, and offers domain-normalized shapes so the rest of
// DigiShack never has to touch Pat's field names. Stage 1 uses the read surface + the
// Internet-CMS connect alias; it never transmits and never reaches the VARA TCP modem.
//
// A stub-engine test (scripts/check-winlink-adapter.ts) exercises this against the
// captured fixtures with an injected fetch, so none of it needs a live Pat to verify.

import type {
  PatBandwidths,
  PatConfig,
  PatConnectAliases,
  PatFormCatalog,
  PatMailbox,
  PatMessage,
  PatRmsNode,
  PatStatus,
} from "@/lib/winlink/types";

/** How a Pat call failed, so callers can show the right state instead of a raw error. */
export type PatErrorKind = "unavailable" | "timeout" | "http" | "parse" | "too-large";

export class PatError extends Error {
  constructor(
    readonly kind: PatErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "PatError";
  }
}

export interface PatEngineOptions {
  /** Pat's loopback web/JSON API, e.g. http://127.0.0.1:8049. */
  baseUrl?: string;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
  /** Cap on a single response body, bytes. */
  maxBytes?: number;
  /** Injected fetch, for the stub-engine test. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE = "http://127.0.0.1:8049";
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_BYTES = 8 << 20; // 8 MiB — a mailbox body/attachment list, not a bulk dump

export class PatEngine {
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly doFetch: typeof fetch;

  constructor(opts: PatEngineOptions = {}) {
    this.base = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.doFetch = opts.fetchImpl ?? fetch;
  }

  private async getJson<T>(path: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.doFetch(`${this.base}${path}`, {
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new PatError("timeout", `Pat timed out after ${this.timeoutMs} ms on ${path}`);
      }
      throw new PatError(
        "unavailable",
        `Pat engine unreachable at ${this.base}: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new PatError("http", `Pat returned HTTP ${res.status} on ${path}`, res.status);
    const text = await res.text();
    if (text.length > this.maxBytes) {
      throw new PatError("too-large", `Pat response on ${path} exceeded ${this.maxBytes} bytes`);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new PatError("parse", `Pat returned a non-JSON body on ${path}`);
    }
  }

  /** Connection/engine state. */
  status(): Promise<PatStatus> {
    return this.getJson<PatStatus>("/api/status");
  }

  /** Full config with the Winlink secret redacted — never return it raw past the adapter. */
  async config(): Promise<PatConfig> {
    return redactConfig(await this.getJson<PatConfig>("/api/config"));
  }

  /** Alias name -> transport URL template. The "telnet" alias is the Internet-CMS path. */
  connectAliases(): Promise<PatConnectAliases> {
    return this.getJson<PatConnectAliases>("/api/connect_aliases");
  }

  /** A mailbox folder's messages (summaries: Body/BodyHTML are empty here). */
  mailbox(box: PatMailbox): Promise<PatMessage[]> {
    return this.getJson<PatMessage[]>(`/api/mailbox/${box}`);
  }

  /** One message with its body populated. */
  message(box: PatMailbox, mid: string): Promise<PatMessage> {
    return this.getJson<PatMessage>(`/api/mailbox/${box}/${encodeURIComponent(mid)}`);
  }

  /** The cached RMS gateway directory, scored from the station locator. */
  gateways(): Promise<PatRmsNode[]> {
    return this.getJson<PatRmsNode[]>("/api/rmslist");
  }

  formCatalog(): Promise<PatFormCatalog> {
    return this.getJson<PatFormCatalog>("/api/formcatalog");
  }

  bandwidths(mode: string): Promise<PatBandwidths> {
    return this.getJson<PatBandwidths>(`/api/bandwidths?mode=${encodeURIComponent(mode)}`);
  }
}

/** Never let the engine's stored Winlink password past the adapter boundary. */
export function redactConfig(c: PatConfig): PatConfig {
  return { ...c, secure_login_password: c.secure_login_password ? "***" : "" };
}

// --------------------------------------------------------------------------- //
// Domain normalization: the shapes the rest of DigiShack consumes, so no UI or
// API route ever reads Pat's PascalCase wire fields directly.

export interface WinlinkMessageSummary {
  mid: string;
  /** RFC3339 with offset, as Pat reports it. */
  date: string;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  unread: boolean;
  p2pOnly: boolean;
  attachmentCount: number;
}

export function toMessageSummary(m: PatMessage): WinlinkMessageSummary {
  return {
    mid: m.MID,
    date: m.Date,
    from: m.From.Addr,
    to: m.To.map((a) => a.Addr),
    cc: (m.Cc ?? []).map((a) => a.Addr),
    subject: m.Subject,
    unread: m.Unread,
    p2pOnly: m.P2POnly,
    attachmentCount: m.Files.length,
  };
}

export interface WinlinkGateway {
  callsign: string;
  grid: string;
  distanceKm: number;
  bearingDeg: number;
  modes: string;
  dialKHz: number;
  centerKHz: number;
  url: string;
}

export function toGateway(n: PatRmsNode): WinlinkGateway {
  return {
    callsign: n.callsign,
    grid: n.gridsquare,
    distanceKm: n.distance,
    bearingDeg: n.azimuth,
    modes: n.modes,
    dialKHz: n.dial.khz,
    centerKHz: n.freq.khz,
    url: n.url,
  };
}
