import { adifHeader, adifRecord, type AdifQsoInput } from "@/lib/adif/write";
import { getSetting } from "@/lib/settings";

// Club Log.
//
// Every endpoint requires POST. A GET is refused with a bare nginx 403 that mentions
// nothing about the method, which impersonates an IP-level block convincingly enough
// to mislead.
//
// DOWNLOAD works: `getadif.php`, POST, form-encoded, `call` (not `callsign`).
// Omitting `type` returns the whole log; `type=dxqrs` narrows it to OQRS.
//
// UPLOAD is refused from this installation with a bare nginx 403 — before PHP, so it
// is not an authentication result. Ruled out by measurement: the credential type,
// an IP block (`getadif.php` returned 28,001 records from the same address in the
// same minute), the HTTP method and encoding, and anything specific to multipart.
// The refusal follows the path: reads pass, writes do not.
//
// Do not probe it further. Repeated failures against these endpoints are what Club
// Log documents as triggering a real IP block, and this installation does not have
// one. An operator who wants their contacts on Club Log can point Club Log at LoTW,
// which needs nothing from here.

const PUT_URL = "https://clublog.org/putlogs.php";
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
  /** QSOs in the batch that was sent. */
  sent: number;
  /**
   * This installation will NEVER be able to upload, so retrying is waste.
   *
   * Distinguished from an ordinary failure because the two deserve opposite treatment. A
   * timeout or a bad password is worth another sweep and worth an email; a bare nginx 403
   * on `putlogs.php` is a refusal at the edge, before PHP, that has been ruled out as
   * credentials, method, encoding and IP block — see the note at the top of this file. It
   * will answer the same way for ever, and retrying it every ten minutes produced a daily
   * "clublog uploads are failing" email about a condition nobody can act on.
   */
  permanent?: boolean;
}

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
    const body = (await res.text()).trim();

    // Club Log answers 200 with a body describing the outcome, and uses non-200
    // for auth and quota problems. Both need reporting verbatim — its messages
    // are specific and guessing at them helps nobody.
    if (!res.ok) {
      // A 403 whose body is an nginx error page rather than anything Club Log wrote is
      // the documented dead end: the request never reached the application, so no
      // credential or payload change can affect it. Club Log's OWN 403 would carry its
      // own words, and that one IS worth retrying — hence matching on the body, not just
      // the status.
      const edgeRefusal =
        res.status === 403 && /<html|nginx/i.test(body) && !/clublog/i.test(body);
      return {
        ok: false,
        sent: 0,
        permanent: edgeRefusal,
        detail: edgeRefusal
          ? "Club Log refuses uploads from this installation at its edge (a bare nginx 403, " +
            "before the application). Ruled out by measurement: credentials, IP block, HTTP " +
            "method and encoding — downloads from the same address work. Nothing here can " +
            "change it; point Club Log at LoTW instead, which needs nothing from DigiShack."
          : `HTTP ${res.status}: ${body.slice(0, 300)}`,
      };
    }
    const failed = /error|invalid|denied|fail/i.test(body);
    return {
      ok: !failed,
      sent: failed ? 0 : qsos.length,
      detail: body.slice(0, 300) || "(empty reply)",
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
  form.set("file", new Blob([adifHeader({ programVersion: "DigiShack" })], { type: "text/plain" }), "probe.adi");

  try {
    const res = await fetch(PUT_URL, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
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
