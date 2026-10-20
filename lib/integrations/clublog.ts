import { adifRecord, type AdifQsoInput } from "@/lib/adif/write";
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
// ONLY THE REAL-TIME UPLOAD REMAINS. A batch `putlogs.php` uploader (the one carrier of
// Club Log's `clear` flag, which replaces a log rather than merging into it), a
// credential probe and a `getadif.php` downloader sat here for many releases with no
// caller and were deleted, as this comment had promised they would be. Git history has
// them if a whole-log rebuild is ever built.

const REALTIME_URL = "https://clublog.org/realtime.php";

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

