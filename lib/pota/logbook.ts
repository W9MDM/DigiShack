// The POTA hunter and activator logbook.
//
// POTA's public endpoints stop at 25 recent contacts. The full log lives behind
// `/user/logbook`, which needs the session token from a browser logged in to
// pota.app — there is no API key scheme, and no unauthenticated route to it. The
// endpoint was found by reading pota.app's own bundle; it is not documented, which
// is a real constraint on how much this should be relied on and is why the importer
// treats every field defensively and never overwrites without being asked.
//
// The token is an Auth0 JWT and it expires. That makes this a tool for the one-time
// backfill it is meant for — pull the history once, and let DigiShack record
// references itself from then on — rather than a live integration.

/** POTA's page size cap. Larger values are silently reduced. */
const PAGE_SIZE = 100;

/** Enough pages for any realistic log; a guard against an endless-paging bug. */
const MAX_PAGES = 200;

const BASE = "https://api.pota.app/user/logbook";

/**
 * One logbook row.
 *
 * Field names are POTA's. Which callsign is the activator depends on which side of
 * the contact you asked for, so nothing here is renamed to "activator" — that
 * decision belongs to the caller, which knows our own callsign.
 */
export interface PotaLogEntry {
  qsoDateTime: string | null;
  stationCallsign: string | null;
  operatorCallsign: string | null;
  workedCallsign: string | null;
  band: string | null;
  mode: string | null;
  reference: string | null;
  locationDesc: string | null;
  /** Park-to-park: both ends were in a park. */
  p2p: boolean;
}

export interface PotaLogbookPage {
  /** Total rows POTA says exist, from the first page. */
  count: number;
  entries: PotaLogEntry[];
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export function parseLogEntry(raw: unknown): PotaLogEntry {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    qsoDateTime: str(r.qsoDateTime),
    stationCallsign: str(r.station_callsign)?.toUpperCase() ?? null,
    operatorCallsign: str(r.operator_callsign)?.toUpperCase() ?? null,
    workedCallsign: str(r.worked_callsign)?.toUpperCase() ?? null,
    band: str(r.band)?.toUpperCase() ?? null,
    mode: str(r.mode)?.toUpperCase() ?? null,
    reference: str(r.reference)?.toUpperCase() ?? null,
    locationDesc: str(r.locationDesc),
    p2p: Boolean(r.p2p),
  };
}

export interface FetchLogbookOptions {
  token: string;
  /** "hunter" — parks you chased. "activator" — contacts made from a park. */
  kind: "hunter" | "activator";
  /** Called after each page, for progress on a long pull. */
  onPage?: (soFar: number, total: number) => void;
  timeoutMs?: number;
}

/**
 * Pull the whole logbook, page by page.
 *
 * Throws on an authentication failure rather than returning an empty log: "your
 * token expired" and "you have no park contacts" must not look the same, or a
 * backfill would silently do nothing and report success.
 */
export async function fetchPotaLogbook(opts: FetchLogbookOptions): Promise<PotaLogbookPage> {
  const entries: PotaLogEntry[] = [];
  let count = 0;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const q = new URLSearchParams({
      [opts.kind === "hunter" ? "hunterOnly" : "activatorOnly"]: "1",
      page: String(page),
      size: String(PAGE_SIZE),
    });

    const res = await fetch(`${BASE}?${q.toString()}`, {
      headers: {
        // POTA sends the raw token, with no "Bearer " prefix. Adding one gets a 401
        // that reads exactly like an expired token.
        Authorization: opts.token,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });

    if (res.status === 401 || res.status === 403) {
      throw new Error(
        "POTA rejected the token. It is a browser session token and expires — copy a fresh one from pota.app.",
      );
    }
    if (!res.ok) throw new Error(`POTA logbook returned HTTP ${res.status}`);

    const body = (await res.json()) as { count?: unknown; entries?: unknown };
    if (page === 1) count = Number(body.count) || 0;

    const rows = Array.isArray(body.entries) ? body.entries : [];
    if (rows.length === 0) break;
    entries.push(...rows.map(parseLogEntry));
    opts.onPage?.(entries.length, count);

    // A short page is the last page. Trusting `count` alone would loop forever if
    // POTA's total disagreed with what it actually returns.
    if (rows.length < PAGE_SIZE) break;
  }

  return { count: count || entries.length, entries };
}
