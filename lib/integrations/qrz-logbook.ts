import { adifRecord, type AdifQsoInput } from "@/lib/adif/write";
import { getSetting } from "@/lib/settings";

// QRZ.com Logbook API.
//
// Endpoint: https://logbook.qrz.com/api (POST, url-encoded)
// Docs: https://www.qrz.com/docs/logbook/QRZLogbookAPI.html
//
// Responses are `&`-separated KEY=VALUE pairs, not JSON. RESULT is OK / FAIL /
// AUTH / PARTIAL, with REASON on failure.
//
// QRZ explicitly asks for an identifiable User-Agent and rate-limits generic
// ones, so it is set on every request.

const API_URL = "https://logbook.qrz.com/api";
const USER_AGENT = "DigiShack/0.9 (amateur radio logbook)";

export type QrzResult = Record<string, string>;

/** `&lt;` etc. — QRZ HTML-escapes the ADIF payload. */
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/gi, "'")
    // Last, so an escaped ampersand can't be re-interpreted as another entity.
    .replace(/&amp;/gi, "&");
}

/**
 * Parse QRZ's `&`-separated KEY=VALUE response.
 *
 * The ADIF value cannot be split on `&`: QRZ returns it HTML-escaped, so every
 * single field delimiter arrives as `&lt;…&gt;`, and a naive split shreds the
 * records into fragments — the response parses "successfully" and yields zero
 * QSOs. Everything from `ADIF=` to the end of the body is therefore taken
 * verbatim and then unescaped.
 */
export function parseQrzResponse(body: string): QrzResult {
  const out: QrzResult = {};

  const adifMatch = /(^|&)ADIF=/i.exec(body);
  const head = adifMatch ? body.slice(0, adifMatch.index) : body;

  if (adifMatch) {
    out.ADIF = decodeHtmlEntities(
      body.slice(adifMatch.index + adifMatch[0].length),
    );
  }

  for (const pair of head.split("&")) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim().toUpperCase();
    if (!key || key === "ADIF") continue;
    out[key] = decodeURIComponent(pair.slice(idx + 1).replace(/\+/g, " ")).trim();
  }

  return out;
}

async function call(
  key: string,
  action: string,
  extra: Record<string, string> = {},
): Promise<{ ok: boolean; data: QrzResult; error?: string }> {
  const body = new URLSearchParams({ KEY: key, ACTION: action, ...extra });

  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
      },
      body,
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      return { ok: false, data: {}, error: `QRZ returned HTTP ${res.status}` };
    }

    const data = parseQrzResponse(await res.text());
    const result = data.RESULT ?? "";

    if (result === "OK" || result === "PARTIAL") return { ok: true, data };

    if (result === "AUTH") {
      return {
        ok: false,
        data,
        error:
          "QRZ rejected the logbook API key. Check qrz.logbookApiKey in Settings — it is per-logbook and different from your QRZ XML login.",
      };
    }

    return {
      ok: false,
      data,
      // REASON is where QRZ puts the actual explanation.
      error: data.REASON || `QRZ returned RESULT=${result || "(none)"}`,
    };
  } catch (err) {
    return {
      ok: false,
      data: {},
      error:
        err instanceof Error ? `Could not reach QRZ: ${err.message}` : "Could not reach QRZ",
    };
  }
}

export async function getQrzLogbookKey(): Promise<string | null> {
  return getSetting("qrz.logbookApiKey");
}

/**
 * Read-only status call. Safe to run against a live logbook — it reads metadata
 * and writes nothing, which makes it the right way to verify credentials.
 */
export async function testQrzLogbook(): Promise<{
  ok: boolean;
  detail: string;
  data?: QrzResult;
}> {
  const key = await getQrzLogbookKey();
  if (!key) return { ok: false, detail: "Not configured" };

  const res = await call(key, "STATUS");
  if (!res.ok) return { ok: false, detail: res.error ?? "Failed" };

  // DATA holds an &-separated list of its own; surface the useful parts.
  const inner = res.data.DATA ? parseQrzResponse(res.data.DATA) : {};
  const merged = { ...inner, ...res.data };

  const bits = [
    merged.CALLSIGN ? `callsign ${merged.CALLSIGN}` : null,
    merged.COUNT ? `${merged.COUNT} QSOs` : null,
    merged.CONFIRMED ? `${merged.CONFIRMED} confirmed` : null,
    merged.DXCC_COUNT ? `${merged.DXCC_COUNT} DXCC` : null,
  ].filter(Boolean);

  return {
    ok: true,
    detail: bits.length > 0 ? bits.join(", ") : "Credentials accepted",
    data: merged,
  };
}

// ---------------------------------------------------------------------------
// Fetch / import
// ---------------------------------------------------------------------------

/**
 * Records per FETCH. QRZ accepts MAX:5000, which turns a 26,000-QSO logbook into
 * six requests rather than a hundred.
 */
export const FETCH_PAGE = 5000;

export interface QrzPage {
  ok: boolean;
  adif?: string;
  /** Highest APP_QRZLOG_LOGID in this page, for the next request. */
  lastLogId?: number;
  count: number;
  error?: string;
}

/** APP_QRZLOG_LOGID values, in the order they appear. */
export function qrzLogIds(adif: string): number[] {
  return [...adif.matchAll(/<app_qrzlog_logid:\d+>(\d+)/gi)].map((m) =>
    Number(m[1]),
  );
}

/**
 * One page of the logbook.
 *
 * Paging uses `AFTERLOGID`, which — determined empirically against the live API,
 * as it isn't documented — returns records in ASCENDING logid order and is
 * INCLUSIVE of the id given. Callers must therefore drop the boundary record, or
 * page one and page two overlap by exactly one QSO forever.
 */
export async function fetchQrzPage(
  afterLogId: number,
  max = FETCH_PAGE,
): Promise<QrzPage> {
  const key = await getQrzLogbookKey();
  if (!key) return { ok: false, count: 0, error: "QRZ logbook API key is not configured" };

  const res = await call(key, "FETCH", { OPTION: `AFTERLOGID:${afterLogId},MAX:${max}` });
  if (!res.ok) return { ok: false, count: 0, error: res.error };

  const adif = res.data.ADIF ?? "";
  const ids = qrzLogIds(adif);

  return {
    ok: true,
    adif,
    lastLogId: ids.length > 0 ? Math.max(...ids) : undefined,
    count: Number(res.data.COUNT ?? ids.length) || ids.length,
  };
}

export interface QrzInsertResult {
  ok: boolean;
  logId?: string;
  error?: string;
  /** True when QRZ rejected it because the QSO is already there. */
  duplicate?: boolean;
}

/**
 * Upload one QSO.
 *
 * WRITES TO A LIVE LOGBOOK. Callers must have an explicit user action behind
 * this — never a background sweep over the whole log.
 *
 * `replace` maps to QRZ's OPTION=REPLACE, which overwrites an existing duplicate
 * rather than failing.
 */
export async function insertQrzQso(
  qso: AdifQsoInput,
  { replace = false }: { replace?: boolean } = {},
): Promise<QrzInsertResult> {
  const key = await getQrzLogbookKey();
  if (!key) return { ok: false, error: "QRZ logbook API key is not configured" };

  // QRZ takes a single ADIF record. adifRecord() appends a newline, which is
  // harmless, and emits <EOR> which QRZ expects.
  const adif = adifRecord(qso).trim();

  const res = await call(key, "INSERT", {
    ADIF: adif,
    ...(replace ? { OPTION: "REPLACE" } : {}),
  });

  if (res.ok) {
    return { ok: true, logId: res.data.LOGID };
  }

  const duplicate = /duplicate/i.test(res.error ?? "");
  return { ok: false, error: res.error, duplicate };
}
