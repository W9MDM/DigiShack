// Cloudlog / Wavelog.
//
// Self-hosted logging software with a genuinely simple API: one JSON POST carrying an
// API key, a station profile id and an ADIF record. No developer registration, no
// per-application key, no rate limit to be polite about — the server belongs to the
// operator.
//
// Wavelog is a fork of Cloudlog and speaks the same endpoint, so one implementation
// covers both. The path differs between deployments depending on whether the install
// uses `index.php` routing, so the URL is normalised below rather than demanding the
// operator get it exactly right.

import { adifRecord, type AdifQsoInput } from "@/lib/adif/write";
import { getSetting } from "@/lib/settings";

export interface CloudlogCredentials {
  /** Base URL of the installation, e.g. https://logging.example.com */
  url: string;
  apiKey: string;
  /** Which station profile the contacts belong to. Cloudlog calls this the id. */
  stationProfileId: string;
}

export async function getCloudlogCredentials(): Promise<CloudlogCredentials | null> {
  const url = (await getSetting("cloudlog.url"))?.trim();
  const apiKey = (await getSetting("cloudlog.apiKey"))?.trim();
  const stationProfileId = (await getSetting("cloudlog.stationProfileId"))?.trim();
  if (!url || !apiKey || !stationProfileId) return null;
  return { url, apiKey, stationProfileId };
}

/**
 * Build the QSO endpoint from whatever the operator pasted.
 *
 * Accepts the bare host, a URL with a trailing slash, one that already includes
 * `index.php`, and one that is already the full API path. Getting this wrong produces
 * a 404 that reads as "the server is down", so it is worth being generous.
 */
export function cloudlogQsoUrl(base: string): string {
  let u = base.trim().replace(/\/+$/, "");
  if (/\/api\/qso$/i.test(u)) return u;
  if (!/\/index\.php$/i.test(u)) u += "/index.php";
  return `${u}/api/qso`;
}

export interface CloudlogResult {
  ok: boolean;
  /** Cloudlog's own reply, which is where it explains a rejection. */
  detail: string;
  sent: number;
  /** Already in the remote log. The state we wanted, so it counts as done. */
  duplicates: number;
  /**
   * Indexes into the input array that are FINISHED — uploaded or already there.
   *
   * Indexes rather than a count, because duplicates are skipped rather than aborting the
   * run, so "the first N succeeded" stopped being true. The caller marks exactly these.
   */
  doneIndexes: number[];
  /** Up to a few rejections, for the log. */
  errors: string[];
}

/**
 * Does this reply mean "already in the log"?
 *
 * MEASURED against Wavelog, which answers a duplicate with HTTP 400 and a body like
 *
 *     {"status":"abort","type":"adif","adif_count":1,"adif_errors":1,
 *      "messages":["","Date/Time: 2017-12-02 01:15:00 Callsign: K9LOT Band: 2m
 *                  Duplicate for K9XYZ<br>"]}
 *
 * The comment this replaces asserted the opposite — that "a duplicate is reported rather
 * than erroring" and arrives with a 200. It does not, so the `!res.ok` branch caught it
 * first and returned a hard failure, and because that branch RETURNED from inside the loop,
 * a single duplicate ended the whole run. With duplicates scattered through a 28,000-contact
 * backlog the sweep would have stopped at the first one every time, uploading nothing after
 * it, forever.
 */
export function isDuplicateReply(body: string): boolean {
  return /duplicate/i.test(body);
}

/**
 * Upload contacts.
 *
 * One request per QSO: the API takes a single ADIF string per call. That is fine for
 * the volumes involved — this is the operator's own server on their own network — and
 * it means one bad record cannot fail a whole batch.
 */
export async function uploadToCloudlog(
  qsos: AdifQsoInput[],
  opts: { timeoutMs?: number } = {},
): Promise<CloudlogResult> {
  const creds = await getCloudlogCredentials();
  const empty = { sent: 0, duplicates: 0, doneIndexes: [] as number[], errors: [] as string[] };
  if (!creds) {
    return {
      ok: false,
      ...empty,
      detail: "Cloudlog URL, API key and station profile id are not all configured",
    };
  }
  if (qsos.length === 0) return { ok: true, ...empty, detail: "Nothing to upload" };

  const url = cloudlogQsoUrl(creds.url);
  let sent = 0;
  let duplicates = 0;
  const doneIndexes: number[] = [];
  const errors: string[] = [];

  for (let i = 0; i < qsos.length; i++) {
    const qso = qsos[i]!;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: creds.apiKey,
          station_profile_id: creds.stationProfileId,
          type: "adif",
          string: adifRecord(qso).trim(),
        }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      });

      const body = (await res.text()).trim();

      // Duplicate is checked BEFORE the status code, because Wavelog reports it with a 400.
      if (isDuplicateReply(body)) {
        duplicates++;
        doneIndexes.push(i);
        continue;
      }

      // A rejected KEY or an unreachable server fails identically for every remaining
      // contact, so there is nothing to learn from proving it 499 more times. Anything else
      // is recorded and the run carries on — one bad record must not strand the rest, which
      // is what the previous version did with every duplicate.
      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          sent,
          duplicates,
          doneIndexes,
          errors,
          detail: `HTTP ${res.status} — the API key was refused: ${body.slice(0, 160)}`,
        };
      }

      if (!res.ok || /"status"\s*:\s*"?(error|failed|abort)/i.test(body)) {
        if (errors.length < 5) {
          errors.push(`${qso.callsign}: HTTP ${res.status} ${body.slice(0, 140)}`);
        }
        continue;
      }

      sent++;
      doneIndexes.push(i);
    } catch (err) {
      const why = err instanceof Error ? err.message : "upload failed";
      // A connection-level failure is about the server, not the record. Stop.
      return { ok: false, sent, duplicates, doneIndexes, errors, detail: why };
    }
  }

  const failed = qsos.length - sent - duplicates;
  return {
    ok: failed === 0,
    sent,
    duplicates,
    doneIndexes,
    errors,
    detail:
      `${sent} uploaded` +
      (duplicates ? `, ${duplicates} already there` : "") +
      (failed ? `, ${failed} refused` : ""),
  };
}

/**
 * Check the configuration without logging anything.
 *
 * Cloudlog has a status endpoint that validates the key, which is a genuinely
 * read-only test — better than the empty-upload probe the other integrations need.
 */
export async function testCloudlog(): Promise<{ ok: boolean; detail: string }> {
  const creds = await getCloudlogCredentials();
  if (!creds) return { ok: false, detail: "Not configured" };

  const base = creds.url.trim().replace(/\/+$/, "");
  const root = /\/index\.php$/i.test(base) ? base : `${base}/index.php`;
  // `/api/auth/<key>` VALIDATES THE KEY. The previous probe called `/api/statistics`, which
  // needs no key at all — so it answered "Reachable" for a wrong key, a revoked key or an
  // empty one, and the settings page reported a working integration that could not upload.
  // A probe that cannot fail is not a test.
  const authUrl = `${root}/api/auth/${encodeURIComponent(creds.apiKey)}`;

  try {
    const res = await fetch(authUrl, {
      method: "GET",
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.text()).trim();
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}: ${body.slice(0, 200)}` };

    // Measured reply: `<auth><status>Valid</status><rights>rw</rights></auth>`.
    const status = /<status>([^<]*)<\/status>/i.exec(body)?.[1]?.trim() ?? "";
    const rights = /<rights>([^<]*)<\/rights>/i.exec(body)?.[1]?.trim() ?? "";
    if (!/^valid$/i.test(status)) {
      return { ok: false, detail: `The API key was refused (${status || body.slice(0, 120)})` };
    }
    // Read-only rights reach here as a SUCCESS with a warning rather than a failure: the key
    // is genuine and the connection works, and reporting it as broken would send the
    // operator looking for the wrong problem.
    if (!/w/i.test(rights)) {
      return {
        ok: true,
        detail: `Key valid but READ-ONLY (rights: ${rights || "none"}) — uploads will be refused.`,
      };
    }
    return { ok: true, detail: `Key valid, read-write.` };
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : "Could not reach Cloudlog",
    };
  }
}
