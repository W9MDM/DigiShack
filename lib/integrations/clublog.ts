import { adifHeader, adifRecord, type AdifQsoInput } from "@/lib/adif/write";
import { getSetting } from "@/lib/settings";
import { classifyClubLogReply } from "@/lib/integrations/clublog-reply";

// Club Log.
//
// Every endpoint requires POST. A GET is refused with a bare nginx 403 that mentions
// nothing about the method, which impersonates an IP-level block convincingly enough
// to mislead.
//
// DOWNLOAD: `getadif.php`, POST, form-encoded, `call` (not `callsign`). Omitting `type`
// returns the whole log; `type=dxqrs` narrows it to OQRS.
//
// UPLOAD NEEDS AN API KEY, and its absence looks nothing like a missing credential.
// Without `api`, both write endpoints answer a bare nginx 403 — refused before PHP, so
// no error text and no mention of authentication. This file previously recorded, as
// settled fact, that Club Log blocks uploads from this installation at its edge and that
// nothing could change it. That was WRONG, and it was wrong for a month. Reads kept
// working from the same address the entire time, which made the false diagnosis fit
// perfectly: "the refusal follows the path, reads pass and writes do not" describes a
// missing form field exactly as well as it describes a firewall rule.
//
// The key is requested from Club Log's HELPDESK rather than generated on the site, so
// there is no way to discover it is required by looking at their settings page.
//
// MEASURED 2026-08-30 from the live station, with the key attached:
//     getadif.php    200   28,001 records
//     putlogs.php    200   "Upload accepted and queued!"
//     realtime.php   200   "OK", and "Dupe" for a record already held
//
// UPLOADS GO ONE CONTACT AT A TIME through `realtime.php` — see `uploadQsoToClubLog`.
//
// `uploadAdifToClubLog` HAS NO CALLER, and that is said plainly because this file has
// been here before: `upload-runner.ts` opens by recording that it and `insertQrzQso` were
// once "written, tested and never called". It is kept for one capability `realtime.php`
// does not have — Club Log's `clear` flag, which replaces a log rather than merging into
// it, and which is the only way to repair a log uploaded wrongly. Deleting it would mean
// writing it again the first time somebody needs that. If a whole-log rebuild is still
// unbuilt a release or two from now, delete it rather than let this comment keep
// excusing it.

const PUT_URL = "https://clublog.org/putlogs.php";
const REALTIME_URL = "https://clublog.org/realtime.php";
const GET_URL = "https://clublog.org/getadif.php";

export interface ClubLogCredentials {
  email: string;
  password: string;

  /** Station callsign the log belongs to. */
  callsign: string;
  /**
   * Club Log's optional `api` field, when the operator has one.
   *
   * Undefined rather than empty when unset, so the request omits the field entirely. An
   * empty `api=` is not the same as no `api` at all, and a service that reads one as an
   * invalid credential would refuse a request that succeeds without it.
   */
  apiKey?: string;
}

export async function getClubLogCredentials(): Promise<ClubLogCredentials | null> {
  const email = await getSetting("clublog.email");
  // Prefer the application password for API use, falling back to the account
  // password. Club Log documents the former for the write endpoints.
  const password =
    (await getSetting("clublog.appPassword")) ?? (await getSetting("clublog.password"));
  if (!email || !password) return null;
  const apiKey = (await getSetting("clublog.apiKey"))?.trim();
  return {
    email,
    password,
    callsign: (await getSetting("clublog.callsign")) ?? "",
    apiKey: apiKey ? apiKey : undefined,
  };
}

export interface ClubLogUploadResult {
  ok: boolean;
  /** Club Log's own reply text, which is where it explains itself. */
  detail: string;
  /** QSOs Club Log took, counting any it already held. */
  sent: number;
  /**
   * Club Log already had this contact, and that counts as delivered.
   *
   * See `ClubLogReplyVerdict.duplicate` for why it is success rather than failure.
   * Reported separately only so a run can tell contacts it put there from contacts that
   * were already there.
   */
  duplicate?: boolean;
}

// `permanent` USED TO LIVE ON THAT TYPE, and its removal is the point rather than tidying.
// It marked the bare nginx 403 as a dead end nobody could act on, and the runner used it
// to report Club Log as SKIPPED instead of FAILED so the daily "uploads are failing" email
// would stop. That is reasonable treatment for a condition that is genuinely hopeless, and
// this one never was: the refusal was a missing API key. A flag whose only purpose is to
// suppress the report of a fixable fault is worse than no flag, so the fault is reported
// again, with the fix named in the message.

/**
 * Upload a batch of QSOs as ADIF.
 *
 * `clear` maps to Club Log's own flag for replacing the log rather than merging.
 * It defaults to false and should stay that way unless the operator explicitly
 * asks: passing it discards whatever Club Log holds, including confirmations that
 * exist nowhere else.
 */
export async function uploadAdifToClubLog(
  qsos: AdifQsoInput[],
  opts: { clear?: boolean; callsign?: string; timeoutMs?: number } = {},
): Promise<ClubLogUploadResult> {
  const creds = await getClubLogCredentials();
  if (!creds) {
    return { ok: false, sent: 0, detail: "Club Log email/password are not configured" };
  }
  if (qsos.length === 0) return { ok: true, sent: 0, detail: "Nothing to upload" };

  const callsign = opts.callsign || creds.callsign || qsos[0]!.station.callsign;
  if (!callsign) {
    return { ok: false, sent: 0, detail: "No station callsign to attribute the upload to" };
  }

  const adif =
    adifHeader({ programVersion: "DigiShack", createdAt: new Date() }) +
    qsos.map((q) => adifRecord(q)).join("");

  const form = new FormData();
  form.set("email", creds.email);
  form.set("password", creds.password);
  form.set("callsign", callsign.toUpperCase());
  // Documented as optional and obtained from Club Log's helpdesk, so it is sent only when
  // present. See clublog.apiKey in the settings registry for why an empty one is worse
  // than none.
  if (creds.apiKey) form.set("api", creds.apiKey);
  if (opts.clear) form.set("clear", "1");
  // Club Log expects a file part, not a plain field.
  form.set("file", new Blob([adif], { type: "text/plain" }), "digishack.adi");

  try {
    const res = await fetch(PUT_URL, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 180_000),
    });
    // Club Log answers 200 with a body describing the outcome and uses non-200 for auth
    // and quota problems, so the reply is read rather than the status. See
    // `clublog-reply.ts` for every case and what it was measured to say.
    const verdict = classifyClubLogReply(res.status, await res.text());
    return {
      ok: verdict.ok,
      sent: verdict.ok ? qsos.length : 0,
      duplicate: verdict.duplicate,
      detail: verdict.detail,
    };
  } catch (err) {
    return {
      ok: false,
      sent: 0,
      detail: err instanceof Error ? err.message : "Club Log upload failed",
    };
  }
}

/**
 * Upload ONE contact through Club Log's real-time endpoint.
 *
 * THIS IS THE PATH DIGISHACK USES for ordinary logging. Club Log documents it for a
 * program uploading as it works, and it answers per contact rather than per file.
 *
 * WHY NOT THE BATCH ENDPOINT HERE. `putlogs.php` takes a whole ADIF and answers ONCE for
 * the lot, so a record it dislikes is indistinguishable in the reply from the twenty-four
 * beside it: the sweep either marks all twenty-five sent — including the one that was
 * dropped — or none of them, and re-sends twenty-four contacts Club Log already holds.
 * That is not hypothetical. A batch of 22 was accepted on 2026-08-30 with one record
 * silently skipped (`Q0UO`, from an imported log, a prefix belonging to no DXCC entity),
 * and nothing in the HTTP reply said so. It arrived hours later as an email.
 *
 * Both differences from the batch endpoint are MEASURED rather than assumed:
 *   - `adif` is a PLAIN FORM FIELD holding a single record, not a file part, and carries
 *     no header — an `<EOH>` here is part of the record as far as Club Log is concerned.
 *   - a contact already held answers 200 "Dupe", which is success. See
 *     `classifyClubLogReply`.
 *
 * THE COST IS REQUEST COUNT, AND THE CALLER OWNS IT. One contact is one request, so a
 * five-thousand backlog is five thousand requests where the batch endpoint needed ten.
 * Club Log documents repeated FAILURES as what earns an address a real block, so a caller
 * looping over rows must stop on consecutive failures rather than run the loop out — see
 * the Club Log branch of `runUploads`.
 */
export async function uploadQsoToClubLog(
  qso: AdifQsoInput,
  opts: { callsign?: string; timeoutMs?: number } = {},
): Promise<ClubLogUploadResult> {
  const creds = await getClubLogCredentials();
  if (!creds) {
    return { ok: false, sent: 0, detail: "Club Log email/password are not configured" };
  }

  const callsign = opts.callsign || creds.callsign || qso.station.callsign;
  if (!callsign) {
    return { ok: false, sent: 0, detail: "No station callsign to attribute the upload to" };
  }

  const form = new FormData();
  form.set("email", creds.email);
  form.set("password", creds.password);
  form.set("callsign", callsign.toUpperCase());
  // One bare record, no header — `realtime.php` reads this field as a single QSO.
  form.set("adif", adifRecord(qso).trim());
  if (creds.apiKey) form.set("api", creds.apiKey);

  try {
    const res = await fetch(REALTIME_URL, {
      method: "POST",
      body: form,
      // Much shorter than the batch timeout. This is one record, and a caller working
      // through a backlog blocks on it before sending the next.
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
    const verdict = classifyClubLogReply(res.status, await res.text());
    return {
      ok: verdict.ok,
      sent: verdict.ok ? 1 : 0,
      duplicate: verdict.duplicate,
      detail: verdict.detail,
    };
  } catch (err) {
    return {
      ok: false,
      sent: 0,
      detail: err instanceof Error ? err.message : "Club Log upload failed",
    };
  }
}

/**
 * Check the credentials by uploading nothing.
 *
 * Club Log offers no read-only endpoint that accepts these credentials, so the
 * cheapest honest check is an upload of an empty ADIF: it exercises
 * authentication without adding a QSO. A rejection here is a credential problem;
 * anything else means the path works.
 */
export async function testClubLog(): Promise<{ ok: boolean; detail: string }> {
  const creds = await getClubLogCredentials();
  if (!creds) return { ok: false, detail: "Club Log credentials are not configured" };


  const form = new FormData();
  form.set("email", creds.email);
  form.set("password", creds.password);
  form.set("callsign", (creds.callsign || "K9XYZ").toUpperCase());
  // Without this the probe fails at the edge exactly as the real uploads did, which is
  // what an operator who had just pasted a valid key would have seen.
  if (creds.apiKey) form.set("api", creds.apiKey);
  form.set("file", new Blob([adifHeader({ programVersion: "DigiShack" })], { type: "text/plain" }), "probe.adi");

  try {
    const res = await fetch(PUT_URL, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    // NOT routed through `classifyClubLogReply`, deliberately. This probe uploads a
    // header and no records, and what Club Log answers to that has never been measured.
    // The shared rules read an empty 200 as a failure, which is right for a real contact
    // and would be wrong here — reporting a working configuration as broken. UNVERIFIED
    // either way; it stays lenient until somebody measures it.
    const body = (await res.text()).trim();
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}: ${body.slice(0, 200)}` };
    if (/invalid|denied|error/i.test(body)) return { ok: false, detail: body.slice(0, 200) };
    return { ok: true, detail: body.slice(0, 200) || "Accepted" };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : "Club Log request failed" };
  }
}


export interface ClubLogDownloadResult {
  ok: boolean;
  adif?: string;
  count?: number;
  error?: string;
}

/**
 * Download the log Club Log holds.
 *
 * POST and form-encoded, both mandatory. Without `type` this is the entire log,
 * which is what a local-vs-remote diff needs — the alternative, trusting
 * server-side dedup and re-uploading everything, moves several megabytes to
 * discover a handful of missing contacts.
 */
export async function downloadClubLogAdif(
  opts: { callsign?: string; type?: "dxqrs"; timeoutMs?: number } = {},
): Promise<ClubLogDownloadResult> {
  const creds = await getClubLogCredentials();
  if (!creds) return { ok: false, error: "Club Log credentials are not configured" };

  const call = opts.callsign || creds.callsign;
  if (!call) return { ok: false, error: "No callsign to download for" };

  const body = new URLSearchParams({
    email: creds.email,
    password: creds.password,
    call: call.toUpperCase(),
  });
  if (opts.type) body.set("type", opts.type);

  try {
    const res = await fetch(GET_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 180_000),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    if (!/<call:/i.test(text)) {
      return { ok: false, error: `Club Log returned no ADIF: ${text.slice(0, 200)}` };
    }
    const { parseAdif } = await import("@/lib/adif/parse");
    return { ok: true, adif: text, count: parseAdif(text).qsos.length };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Club Log download failed" };
  }
}
