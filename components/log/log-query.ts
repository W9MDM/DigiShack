// The log page's state as a URL, and the API request built from it.
//
// The filters used to live in React state only, so opening a contact and pressing Back
// landed on an unfiltered page 1 every time. Now the page URL carries them
// (`/qsos?q=W1AW&band=20M&page=3`) and history restores them.
//
// `logApiPath` and `logExportHref` must build byte-for-byte the requests the page sent
// before this module existed — scripts/check-logbook.ts holds them to that.

import { BAND_NAMES } from "@/lib/ham/bands";
import { LOGGABLE_MODES } from "@/lib/ham/modes";

export type LogSortField = "startTime" | "callsign" | "band" | "mode";
export type LogConfirmed = "any" | "yes" | "no";
export type LogSortDir = "asc" | "desc";

export interface LogQuery {
  /** Free text, as typed. Trimmed when sent. */
  q: string;
  band: string;
  mode: string;
  /** Whole UTC day, `YYYY-MM-DD`, or "". */
  from: string;
  to: string;
  confirmed: LogConfirmed;
  sort: LogSortField;
  dir: LogSortDir;
  /** Zero-based. The URL carries it one-based. */
  page: number;
}

export const LOG_PAGE_SIZE = 50;

export const DEFAULT_LOG_QUERY: LogQuery = {
  q: "",
  band: "",
  mode: "",
  from: "",
  to: "",
  confirmed: "any",
  sort: "startTime",
  dir: "desc",
  page: 0,
};

const SORTS: readonly LogSortField[] = ["startTime", "callsign", "band", "mode"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

type RawQuery = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

function validDate(v: string): string {
  return DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? v : "";
}

/** Read the page URL. Anything unrecognised falls back to the default, never throws. */
export function parseLogQuery(raw: RawQuery): LogQuery {
  const band = first(raw.band).toUpperCase();
  const mode = first(raw.mode).toUpperCase();
  const confirmed = first(raw.confirmed);
  const sort = first(raw.sort) as LogSortField;
  const dir = first(raw.dir);
  const page = Number.parseInt(first(raw.page), 10);
  return {
    q: first(raw.q),
    band: BAND_NAMES.includes(band) ? band : "",
    mode: LOGGABLE_MODES.includes(mode) ? mode : "",
    from: validDate(first(raw.from)),
    to: validDate(first(raw.to)),
    confirmed: confirmed === "yes" || confirmed === "no" ? confirmed : "any",
    sort: SORTS.includes(sort) ? sort : "startTime",
    dir: dir === "asc" ? "asc" : "desc",
    page: Number.isFinite(page) && page >= 1 ? page - 1 : 0,
  };
}

/** The page URL's query string, carrying only what differs from the default. */
export function logQuerySearch(s: LogQuery): string {
  const p = new URLSearchParams();
  if (s.q.trim()) p.set("q", s.q.trim());
  if (s.band) p.set("band", s.band);
  if (s.mode) p.set("mode", s.mode);
  if (s.from) p.set("from", s.from);
  if (s.to) p.set("to", s.to);
  if (s.confirmed !== "any") p.set("confirmed", s.confirmed);
  if (s.sort !== "startTime") p.set("sort", s.sort);
  if (s.dir !== "desc") p.set("dir", s.dir);
  if (s.page > 0) p.set("page", String(s.page + 1));
  return p.toString();
}

/**
 * The list request. Dates are whole UTC days, matching the ADIF export: a date without
 * the time boundary silently drops everything logged after midnight on the closing day.
 */
export function logApiPath(s: LogQuery): string {
  const params = new URLSearchParams({
    take: String(LOG_PAGE_SIZE),
    skip: String(s.page * LOG_PAGE_SIZE),
    sort: s.sort,
    dir: s.dir,
    confirmed: s.confirmed,
  });
  if (s.q.trim()) params.set("q", s.q.trim());
  if (s.band) params.set("band", s.band);
  if (s.mode) params.set("mode", s.mode);
  if (s.from) params.set("from", `${s.from}T00:00:00.000Z`);
  if (s.to) params.set("to", `${s.to}T23:59:59.999Z`);
  return `/api/qsos?${params}`;
}

/** Export what is on screen, not the whole log. The ADIF route takes the same filters. */
export function logExportHref(s: LogQuery): string {
  return `/api/adif/export?${new URLSearchParams({
    ...(s.q.trim() ? { q: s.q.trim() } : {}),
    ...(s.band ? { band: s.band } : {}),
    ...(s.mode ? { mode: s.mode } : {}),
    ...(s.from ? { from: `${s.from}T00:00:00.000Z` } : {}),
    ...(s.to ? { to: `${s.to}T23:59:59.999Z` } : {}),
    ...(s.confirmed !== "any" ? { confirmed: s.confirmed } : {}),
  }).toString()}`;
}

/** Filters behind the phone's "Filters" toggle — everything except the search box. */
export function activeFilterCount(s: LogQuery): number {
  return [s.band, s.mode, s.from, s.to, s.confirmed !== "any"].filter(Boolean).length;
}

export function isFiltered(s: LogQuery): boolean {
  return s.q.trim() !== "" || activeFilterCount(s) > 0;
}

/** "51–100 of 38,012". */
export function formatRange(page: number, total: number): string {
  if (total <= 0) return "0";
  const start = page * LOG_PAGE_SIZE + 1;
  const end = Math.min(total, (page + 1) * LOG_PAGE_SIZE);
  return `${start.toLocaleString()}–${end.toLocaleString()} of ${total.toLocaleString()}`;
}

// The last log URL, so "Back to log" on a contact returns to the same filtered page.
const LAST_LOG_KEY = "digishack:last-log-url";

export function rememberLogUrl(url: string): void {
  try {
    sessionStorage.setItem(LAST_LOG_KEY, url);
  } catch {
    /* storage blocked: Back to log falls back to /qsos */
  }
}

export function lastLogUrl(): string {
  try {
    const v = sessionStorage.getItem(LAST_LOG_KEY);
    if (v === "/qsos" || v?.startsWith("/qsos?")) return v;
  } catch {
    /* storage blocked */
  }
  return "/qsos";
}
