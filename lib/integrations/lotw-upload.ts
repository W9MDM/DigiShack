// POSTing a signed .tq8 to Logbook of the World.
//
// There is no API key. THE CERTIFICATE IS THE AUTHENTICATION -- the signature inside the
// file is what identifies the operator -- which is why the endpoint takes an anonymous
// multipart POST and why a signature over the wrong bytes is indistinguishable, from here,
// from a network problem.

const URL = "https://lotw.arrl.org/lotw/upload";
const FIELD = "upfile";

/**
 * The marker LoTW puts in the page when it took the file.
 *
 * An HTML comment, because the endpoint answers with a page meant for a browser rather than
 * a status code -- it returns 200 for a rejected upload as readily as an accepted one, so
 * `res.ok` says nothing. Cloudlog looks for the same string.
 */
const ACCEPTED = "<!-- .UPL. accepted -->";
const REJECTED = "<!-- .UPL. rejected -->";

export interface LotwUploadResult {
  ok: boolean;
  /** Something worth putting in a log line or showing the operator. */
  detail: string;
  /** The reply, trimmed, for when `detail` is not enough to work out what happened. */
  body: string;
}

/** Strip tags and squeeze whitespace, to get a sentence out of an HTML reply. */
function readable(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The one sentence in LoTW's reply page that says what happened.
 *
 * The page is a full web page — navigation, sponsor logo, the upload form again — so the
 * first 300 characters of its text are a menu bar. What matters is a single sentence, and
 * MEASURED against the live service it reads:
 *
 *     File k9xyz-2026-08-23-13-57-11-digishack.tq8 queued for processing.
 *
 * QUEUED, not added. Acceptance here is an acknowledgement that the file passed initial
 * validation and was taken; the records are processed afterwards, asynchronously. So this
 * reply cannot report how many contacts LoTW kept, and any code that treats it as a per
 * -record result is wrong — see the note on `uploaded` in upload-runner.ts.
 */
function gist(text: string): string {
  // Named shapes rather than sentence-splitting. Splitting on full stops looked reasonable
  // and picked up "--> Search Help: Search Yaesu | LoTW Principal Sponsor ... queued for
  // processing." as one sentence, because the page has a stray full stop after "Log On" and
  // none between the menu and the answer. The filename also carries a dot, which any
  // sentence rule has to survive.
  const shapes = [
    /File\s+\S+\s+queued for processing\./i,
    /\d+\s+out of\s+\d+[^.]{0,80}\./i,
    /queued for processing\./i,
  ];
  for (const re of shapes) {
    const m = re.exec(text);
    if (m) return m[0].trim().slice(0, 200);
  }
  return text.trim().slice(0, 200);
}

/**
 * Read LoTW's answer.
 *
 * Separated from the request so it can be tested against captured replies -- the failure
 * that matters is a 200 whose body says the file was refused, and that cannot be reproduced
 * by mocking a status code.
 */
export function readLotwReply(status: number, body: string): LotwUploadResult {
  const text = readable(body);

  if (body.includes(ACCEPTED)) {
    return { ok: true, detail: gist(text) || "accepted", body: body.trim() };
  }
  if (body.includes(REJECTED)) {
    return {
      ok: false,
      detail: `LoTW rejected the file: ${text.slice(0, 300) || "no reason given"}`,
      body: body.trim(),
    };
  }
  if (status < 200 || status >= 300) {
    return { ok: false, detail: `LoTW answered ${status}: ${text.slice(0, 200)}`, body: body.trim() };
  }
  // 200 with neither marker. Historically this is LoTW being down for maintenance and
  // serving a notice page, which must NOT be read as success -- marking the batch sent
  // would lose those contacts silently.
  return {
    ok: false,
    detail: `LoTW answered ${status} but said neither accepted nor rejected: ${text.slice(0, 200) || "empty reply"}`,
    body: body.trim(),
  };
}

/** `<call>-<timestamp>-digishack.tq8`, which is the shape TQSL and Cloudlog both use. */
export function tq8Filename(callsign: string, now = new Date()): string {
  const call = callsign.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const ts = now.toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `${call}-${ts}-digishack.tq8`;
}

export async function uploadTq8(
  gz: Buffer,
  filename: string,
  timeoutMs = 120_000,
): Promise<LotwUploadResult> {
  const form = new FormData();
  form.append(FIELD, new Blob([new Uint8Array(gz)], { type: "application/octet-stream" }), filename);

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(URL, { method: "POST", body: form, signal: ctl.signal });
    return readLotwReply(res.status, await res.text());
  } catch (err) {
    // A timeout here is genuinely ambiguous: LoTW may have taken the file and been slow to
    // say so. Reported as a failure, which leaves the batch unmarked and re-sent next run --
    // LoTW discards duplicates, so re-sending is safe and losing the contacts is not.
    const why = err instanceof Error ? err.message : "unknown";
    return {
      ok: false,
      detail: ctl.signal.aborted
        ? `LoTW did not answer within ${Math.round(timeoutMs / 1000)}s. The file may or may not have been accepted; it will be re-sent, and LoTW discards duplicates.`
        : `Could not reach LoTW: ${why}`,
      body: "",
    };
  } finally {
    clearTimeout(timer);
  }
}
