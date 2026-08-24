import { parseAdif } from "@/lib/adif/parse";
import { prisma } from "@/lib/db/prisma";
import { getSetting } from "@/lib/settings";

// eQSL.cc.
//
// Two different things are called "downloading QSL cards", and only one of them
// is useful to a logbook:
//
//   1. The INBOX — an ADIF file of the confirmations other operators have sent
//      you. This is the data that matters: it drives `eqslRcvd` and therefore
//      award credit. That is what this module fetches.
//   2. The card IMAGES — the decorative graphics. eQSL serves these one at a
//      time from a different endpoint and they carry no information the ADIF
//      does not already have. `eqslCardImageUrl` builds a link for display, but
//      nothing here bulk-downloads them: hundreds of image requests to a
//      volunteer-funded service to obtain pictures of data you already hold is
//      not a reasonable thing to do.
//
// The inbox flow is two steps, which is unusual and worth stating: the first
// request does not return ADIF, it returns an HTML page containing a link to a
// generated .adi file. Fetching that link gets the data.

const BASE = "https://www.eQSL.cc";

export interface EqslCredentials {
  username: string;
  password: string;
  /**
   * QTH nickname, required when the account has more than one.
   *
   * eQSL lets one login own several QTHs (a home station, a portable setup, a
   * club location). With more than one it refuses every request with
   * "Username/Password found more than 1 account" until told which to use, and
   * that error arrives with HTTP 200 in the page body.
   */
  qthNickname?: string | null;
}

export async function getEqslCredentials(): Promise<EqslCredentials | null> {
  const username = await getSetting("eqsl.username");
  const password = await getSetting("eqsl.password");
  if (!username || !password) return null;
  return {
    username,
    password,
    qthNickname: await getSetting("eqsl.qthNickname"),
  };
}

/** Build the query shared by every eQSL call. */
function eqslParams(creds: EqslCredentials): URLSearchParams {
  const p = new URLSearchParams({
    UserName: creds.username,
    Password: creds.password,
  });
  if (creds.qthNickname) p.set("QTHNickname", creds.qthNickname);
  return p;
}

/**
 * Turn one of eQSL's page errors into something that points at the real cause.
 *
 * MEASURED: a WRONG QTH nickname is reported as
 *
 *     Error: No such Username/Password found — This could mean the wrong callsign or the
 *     wrong password, or the user does not exist.
 *
 * The credentials are fine. eQSL is saying it cannot find that user AT that QTH, and its own
 * wording names every cause except the one that applies — so an operator reading it rotates a
 * password that was never the problem. Worth intercepting: this is the error somebody gets
 * after moving and forgetting to change the QTH on their eQSL account, which is exactly how
 * this one was found.
 *
 * eQSL does not enumerate the valid nicknames, checked: a wrong one gets the message above and
 * an empty one gets "found more than 1 account", so the list can only come from My Profile on
 * the site.
 */
export function explainEqslError(raw: string, qthNickname: string | null | undefined): string {
  const msg = raw.trim();
  if (qthNickname && /no such username\/password/i.test(msg)) {
    return (
      `eQSL says "No such Username/Password found", but it is being asked for the QTH ` +
      `"${qthNickname}" — and a nickname that does not exist produces exactly this message. ` +
      `Check the nickname against My Profile on eqsl.cc before changing your password; if you ` +
      `have moved, the QTH may have been renamed or replaced.`
    );
  }
  if (/more than 1 account/i.test(msg)) {
    return (
      "eQSL says this login owns more than one QTH and will not act until told which — set " +
      "the QTH nickname under Settings → eQSL.cc. Find it under My Profile on eqsl.cc."
    );
  }
  return msg;
}


/**
 * Pull eQSL's real message out of a response.
 *
 * The pages carry several kilobytes of JavaScript before any content, and that
 * boilerplate mentions "password" — matching on the whole body produces false
 * failures, which is exactly what happened here. Only the markup after the last
 * script block is the actual page.
 */
export function eqslPageMessage(body: string): string | null {
  const tail = body.slice(body.lastIndexOf("</script>") + 9);
  const text = tail.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  const m = /Error:[^.]*(?:\.|$)/i.exec(text);
  if (m) return m[0].trim();
  return text ? text.slice(0, 200) : null;
}

export interface EqslInboxResult {
  ok: boolean;
  /** Raw ADIF, when the download succeeded. */
  adif?: string;
  /** Confirmations found in it. */
  count?: number;
  error?: string;
}

/**
 * Download the eQSL inbox as ADIF.
 *
 * `since` limits the request — eQSL generates the file on demand, so asking for
 * everything every time is wasteful once the log is established.
 */
export async function downloadEqslInbox(
  opts: { since?: Date; timeoutMs?: number } = {},
): Promise<EqslInboxResult> {
  const creds = await getEqslCredentials();
  if (!creds) return { ok: false, error: "eQSL username/password are not configured" };

  const params = eqslParams(creds);
  if (opts.since) {
    // eQSL wants YYYYMMDD.
    params.set("RcvdSince", opts.since.toISOString().slice(0, 10).replace(/-/g, ""));
  }

  const signal = AbortSignal.timeout(opts.timeoutMs ?? 60_000);

  let page: string;
  try {
    const res = await fetch(`${BASE}/qslcard/DownloadInBox.cfm?${params}`, { signal });
    if (!res.ok) return { ok: false, error: `eQSL returned HTTP ${res.status}` };
    page = await res.text();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "eQSL request failed" };
  }

  // eQSL reports problems in the page body with a 200 status.
  if (!/\.adi/i.test(page)) {
    const msg = eqslPageMessage(page);
    if (msg && /Error:/i.test(msg)) {
      return {
        ok: false,
        error: `${explainEqslError(msg, creds.qthNickname)} (reported in the page body, not the HTTP status)`,
      };
    }
  }

  // The page contains a link to the generated file, e.g.
  //   <A HREF="downloadedfiles/xxxxx.adi">
  const m = /(?:HREF|href)="([^"]*\.adi)"/.exec(page);
  if (!m) {
    return {
      ok: false,
      error: "eQSL did not return a download link — the inbox may be empty, or the page format changed",
    };
  }

  const path = m[1]!.replace(/^\/+/, "");
  let adif: string;
  try {
    const res = await fetch(`${BASE}/qslcard/${path}`, { signal });
    if (!res.ok) return { ok: false, error: `eQSL file download returned HTTP ${res.status}` };
    adif = await res.text();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "eQSL file download failed" };
  }

  const parsed = parseAdif(adif);
  return { ok: true, adif, count: parsed.qsos.length };
}

export interface EqslSyncResult {
  ok: boolean;
  error?: string;
  /** Confirmations in the file. */
  found: number;
  /** Local QSOs newly marked confirmed. */
  matched: number;
  /** Confirmations with no matching local QSO. */
  unmatched: number;
  /** Already marked, so nothing to do. */
  alreadyKnown: number;
  unmatchedSamples: string[];
}

// THE INBOX CARRIES NO STATION OR QTH FIELD. Measured, against a real account:
//
//   <CALL:6>KB3HHA<QSO_DATE:8:D>20251109<TIME_ON:4>0307<BAND:3>40M<MODE:3>FT8
//   <RST_SENT:3> 03<RST_RCVD:0><QSL_SENT:1>Y<QSL_SENT_VIA:1>E<APP_EQSL_AG:1>Y
//   <GRIDSQUARE:4>FM19<EQSL_QSL_RCVD:1>Y<EQSL_QSLRDATE:8>20251109
//
// No STATION_CALLSIGN, no APP_EQSL_QTH_NICKNAME, nothing naming which of the operator's
// profiles a confirmation belongs to. `QTHNickname` is required on the REQUEST when a login
// owns several QTHs — without it eQSL refuses outright — but it does not mark the records.
//
// So on a multi-QTH account, UNMATCHED CONFIRMATIONS ARE EXPECTED and are not a fault. On this
// station 1,799 of 9,427 match nothing, and they are not old contacts from an unimported era:
// they fall in 2025 and 2026, the years this log covers completely. They are the other
// profile's contacts, made over the same period, and nothing in the data distinguishes them.
//
// One consequence worth stating rather than discovering: a confirmation for another profile can
// in principle match a contact in this log by coincidence — same station, same band, within the
// matching window — and would then credit a QSO the confirmation was not for. Narrowing the
// window does not fix it and breaks the 52%-rejection case below. It is bounded by how often two
// stations on one account work the same operator on the same band within half an hour.
//
// WHY THE UNMATCHED ARE NOT WORTH CHASING, decided by the operator and recorded so nobody
// investigates it a second time. The 1,799 were classified against the log:
//
//     band differs:      11   (same station, inside the window, a different band)
//     time differs:   1,000   (same station in the log, but DAYS away, not minutes)
//     callsign absent:  384   (never worked at all)
//
// The thousand are not a window that is too tight — `KF5NIX` confirmed for 2025-11-09 against a
// contact on 2025-10-26 is a fortnight out. They are wrong data at the far end: contacts
// uploaded with bad times by WSJT-X, other operators filing incorrect QSO details on eQSL, and
// a previous logger that duplicated records. Widening the window to catch them would start
// crediting unrelated QSOs with the same station, and on the digital bands the same stations
// recur for years — one of them appears in this log 35 times.
//
// So the rule is the operator's: "if they aren't in my log they don't belong." The log is the
// authority, an unmatched confirmation is discarded, and the count is reported neutrally rather
// than as a fault to be fixed.

/**
 * Apply the eQSL inbox to the log.
 *
 * Matches on callsign+band within a ±30 minute window, nearest first, preferring
 * the same mode. Unmatched confirmations are counted and sampled rather than
 * silently dropped — they usually mean a QSO that was never logged locally, which
 * is worth knowing about.
 */
export async function syncEqslInbox(
  opts: { since?: Date; dryRun?: boolean } = {},
): Promise<EqslSyncResult> {
  const base: EqslSyncResult = {
    ok: false,
    found: 0,
    matched: 0,
    unmatched: 0,
    alreadyKnown: 0,
    unmatchedSamples: [],
  };

  const inbox = await downloadEqslInbox({ since: opts.since });
  if (!inbox.ok || !inbox.adif) return { ...base, error: inbox.error };

  const { qsos } = parseAdif(inbox.adif);
  base.found = qsos.length;
  base.ok = true;
  if (qsos.length === 0) return base;

  // Index the local log by callsign+band, then match within a time window.
  //
  // Minute-exact matching is correct for ADIF dedup but wrong here: a
  // confirmation records the OTHER station's logged time, and clocks and logging
  // habits differ. Matching exactly rejected 52% of a real 2,391-confirmation
  // inbox, including contacts demonstrably present in the log. ±30 minutes is the
  // tolerance LoTW and the QSL bureaux use, so it is the defensible choice.
  const WINDOW_MS = 30 * 60_000;

  const local = await prisma.qso.findMany({
    select: { id: true, callsign: true, band: true, mode: true, startTime: true, eqslRcvd: true },
  });
  const byCallBand = new Map<string, { id: string; mode: string; t: number; eqslRcvd: boolean }[]>();
  for (const q of local) {
    const k = `${q.callsign.toUpperCase()}|${q.band.toUpperCase()}`;
    const list = byCallBand.get(k);
    const entry = { id: q.id, mode: q.mode.toUpperCase(), t: q.startTime.getTime(), eqslRcvd: q.eqslRcvd };
    if (list) list.push(entry);
    else byCallBand.set(k, [entry]);
  }

  const toMark: string[] = [];
  const claimed = new Set<string>();
  for (const c of qsos) {
    const k = `${c.callsign.toUpperCase()}|${c.band.toUpperCase()}`;
    const candidates = byCallBand.get(k) ?? [];
    const want = c.startTime.getTime();
    // Nearest in time wins, preferring the same mode. Each local QSO can only be
    // claimed once, so two confirmations cannot both land on one contact.
    let best: { id: string; eqslRcvd: boolean } | null = null;
    let bestScore = Infinity;
    for (const cand of candidates) {
      if (claimed.has(cand.id)) continue;
      const dt = Math.abs(cand.t - want);
      if (dt > WINDOW_MS) continue;
      // A mode mismatch is tolerated but ranked worse — SSB/USB and MFSK/FT4
      // disagreements are common in third-party logs.
      const score = dt + (cand.mode === c.mode.toUpperCase() ? 0 : WINDOW_MS);
      if (score < bestScore) {
        bestScore = score;
        best = { id: cand.id, eqslRcvd: cand.eqslRcvd };
      }
    }
    if (!best) {
      base.unmatched++;
      if (base.unmatchedSamples.length < 10) {
        base.unmatchedSamples.push(
          `${c.callsign} ${c.band} ${c.mode} ${c.startTime.toISOString().slice(0, 16)}`,
        );
      }
      continue;
    }
    claimed.add(best.id);
    if (best.eqslRcvd) {
      base.alreadyKnown++;
      continue;
    }
    toMark.push(best.id);
  }

  if (!opts.dryRun && toMark.length > 0) {
    for (let i = 0; i < toMark.length; i += 500) {
      await prisma.qso.updateMany({
        where: { id: { in: toMark.slice(i, i + 500) } },
        // ONLY eqslRcvd.
        //
        // This used to also write `qslRcvd: "CONFIRMED", qslRcvdVia: "ELECTRONIC"`,
        // which destroyed information: a contact already confirmed by a paper card
        // had its route rewritten to ELECTRONIC with no record that a card had ever
        // arrived, and `qslRcvd` is the field the ADIF export turns into QSL_RCVD:Y.
        // An eQSL confirmation is not a card and is not accepted for DXCC, so it
        // has its own flag and stays in it. Nothing is lost — `eqslRcvd` is what
        // the eQSL column on the log and the eQSL award view read.
        data: { eqslRcvd: true },
      });
    }
  }
  base.matched = toMark.length;
  return base;
}

/**
 * URL of one eQSL card image, for display.
 *
 * Requires the operator's own credentials, so it must never be rendered into a
 * page a browser fetches directly — the password would be in the markup. Fetch
 * it server-side and proxy the bytes if a card is to be shown.
 */
export function eqslCardImageUrl(
  creds: EqslCredentials,
  qso: { callsign: string; band: string; mode: string; startTime: Date },
): string {
  const p = eqslParams(creds);
  const fields: Record<string, string> = {
    CallsignFrom: qso.callsign.toUpperCase(),
    QSOBand: qso.band,
    QSOMode: qso.mode,
    QSOYear: String(qso.startTime.getUTCFullYear()),
    QSOMonth: String(qso.startTime.getUTCMonth() + 1).padStart(2, "0"),
    QSODay: String(qso.startTime.getUTCDate()).padStart(2, "0"),
    QSOHour: String(qso.startTime.getUTCHours()).padStart(2, "0"),
    QSOMinute: String(qso.startTime.getUTCMinutes()).padStart(2, "0"),
  };
  for (const [k, v] of Object.entries(fields)) p.set(k, v);
  return `${BASE}/qslcard/GetCard.cfm?${p}`;
}

/** Read-only credential check: asks eQSL for our own record count. */
export async function testEqsl(): Promise<{ ok: boolean; detail: string }> {
  const creds = await getEqslCredentials();
  if (!creds) return { ok: false, detail: "eQSL username/password are not configured" };

  try {
    const res = await fetch(`${BASE}/qslcard/DownloadInBox.cfm?${eqslParams(creds)}`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return { ok: false, detail: `eQSL returned HTTP ${res.status}` };
    const body = await res.text();
    if (/\.adi/i.test(body)) {
      // The QTH is named in the success message, because it is used on UPLOADS too — a card
      // sent under the wrong QTH carries the wrong location to the recipient, and the
      // operator has no other place in this application that shows which one is in force.
      return {
        ok: true,
        detail: creds.qthNickname
          ? `Credentials accepted for QTH "${creds.qthNickname}"; inbox available`
          : "Credentials accepted; inbox available",
      };
    }
    const msg = eqslPageMessage(body);
    if (msg && /Error:/i.test(msg)) {
      return { ok: false, detail: explainEqslError(msg, creds.qthNickname) };
    }
    return { ok: true, detail: "Credentials accepted; inbox appears empty" };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : "eQSL request failed" };
  }
}

// ---------------------------------------------------------------------------
// UPLOAD
// ---------------------------------------------------------------------------
//
// eQSL takes one contact per request as a URL-encoded ADIF fragment on a GET, which is
// unusual enough to be worth stating plainly: there is no file upload and no signing. The
// credentials travel in the ADIF header as EQSL_USER and EQSL_PSWD, which means they travel
// in the query string — eQSL's design, not a choice available here.
//
// Field set and response strings verified against Cloudlog's implementation
// (application/controllers/Eqsl.php), which has been uploading successfully for years, and
// against eQSL's own spec at https://eqsl.cc/qslcard/ADIFContentSpecs.cfm.

/** One ADIF field, in eQSL's `<NAME:len>value` form. Empty values are omitted entirely. */
function adifField(name: string, value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  const v = String(value).trim();
  if (!v) return "";
  return `<${name}:${v.length}>${v} `;
}

export interface EqslUploadRecord {
  callsign: string;
  band: string;
  mode: string;
  submode?: string | null;
  startTime: Date;
  rstSent?: string | null;
  propMode?: string | null;
  satName?: string | null;
  /** Free text printed on the card. */
  message?: string | null;
}

/**
 * The ADIF fragment for one contact, unencoded.
 *
 * Built as plain text and encoded once at the end rather than assembled from percent
 * escapes, which is how Cloudlog does it — that version is unreadable and had to be
 * cross-checked character by character to be sure `%5F` was an underscore.
 *
 * QSO_DATE is YYYYMMDD and TIME_ON is HHMM, both UTC. eQSL rejects seconds in TIME_ON.
 */
export function eqslAdifFragment(
  rec: EqslUploadRecord,
  creds: { username: string; password: string; qthNickname?: string | null },
): string {
  const d = rec.startTime;
  const p2 = (n: number) => String(n).padStart(2, "0");
  const date =
    `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}`;
  const time = `${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}`;

  const header =
    adifField("ADIF_VER", "3.1.0") +
    adifField("EQSL_USER", creds.username) +
    adifField("EQSL_PSWD", creds.password) +
    // The QTH nickname selects WHICH of the operator's eQSL profiles the card comes from.
    // Omitted when unset, because sending an empty one makes eQSL pick its default rather
    // than error, and a card from the wrong location is worse than a refusal.
    adifField("APP_EQSL_QTH_NICKNAME", creds.qthNickname ?? null) +
    "<EOH> ";

  const record =
    adifField("QSO_DATE", date) +
    adifField("TIME_ON", time) +
    adifField("CALL", rec.callsign.toUpperCase()) +
    adifField("BAND", rec.band.toUpperCase()) +
    adifField("MODE", rec.mode.toUpperCase()) +
    adifField("SUBMODE", rec.submode?.toUpperCase() ?? null) +
    adifField("RST_SENT", rec.rstSent ?? null) +
    adifField("PROP_MODE", rec.propMode?.toUpperCase() ?? null) +
    adifField("SAT_NAME", rec.satName?.toUpperCase() ?? null) +
    adifField("QSLMSG", rec.message ?? null) +
    "<EOR>";

  return header + record;
}

/** What eQSL said about one contact. */
export type EqslUploadOutcome =
  | { status: "sent" }
  | { status: "duplicate" }
  | { status: "bad-credentials"; detail: string }
  | { status: "rejected"; detail: string }
  | { status: "error"; detail: string };

/**
 * Read eQSL's reply.
 *
 * It answers in prose, with a 200 whatever happened, so the body IS the status code. The
 * strings below are eQSL's, quoted from its own responses:
 *
 *   Result: 1 out of 1 records added          success
 *   Result: 0 out of 1 records added          a duplicate, almost always
 *   Result: 0 out of 0 records added          eQSL could not parse the record at all
 *   Error: No match on eQSL_User/eQSL_Pswd    wrong credentials
 *   Warning: ... Bad record: Duplicate        also a duplicate, differently worded
 *
 * A duplicate is treated as SUCCESS by the caller, and that is deliberate: it means the
 * card is already on eQSL, which is the state we were trying to reach. Retrying it forever
 * would be the alternative.
 *
 * "0 out of 0" is kept distinct from a duplicate because it means the FORMAT was wrong —
 * a bug here rather than a contact already sent — and silently counting it as done would
 * mark contacts uploaded that eQSL never saw.
 */
export function readEqslReply(body: string): EqslUploadOutcome {
  const t = body.replace(/\s+/g, " ").trim();
  if (/No match on eQSL_User/i.test(t)) {
    return { status: "bad-credentials", detail: "eQSL rejected the username or password" };
  }
  if (/Result:\s*1 out of 1 records added/i.test(t)) return { status: "sent" };
  if (/Bad record:\s*Duplicate/i.test(t)) return { status: "duplicate" };
  if (/Result:\s*0 out of 1 records added/i.test(t)) return { status: "duplicate" };
  if (/Result:\s*0 out of 0 records added/i.test(t)) {
    return {
      status: "rejected",
      detail: "eQSL could not parse the record — a formatting fault on our side",
    };
  }
  // Something unrecognised. Reported with a slice of the body, because the next person to
  // see this needs eQSL's own words rather than "upload failed".
  return { status: "error", detail: t.slice(0, 200) || "eQSL returned an empty response" };
}

/** Upload one contact. Returns eQSL's verdict; the caller decides what to mark. */
export async function uploadEqslQso(
  rec: EqslUploadRecord,
  creds: { username: string; password: string; qthNickname?: string | null },
): Promise<EqslUploadOutcome> {
  const fragment = eqslAdifFragment(rec, creds);
  const url =
    "https://www.eqsl.cc/qslcard/importADIF.cfm?ADIFData=" +
    encodeURIComponent(fragment);
  try {
    const res = await fetch(url, {
      // 30 s: eQSL is occasionally slow and a contact half-uploaded is worse than one that
      // waited. The sweep's per-run cap bounds the total time, not this.
      signal: AbortSignal.timeout(30_000),
      headers: { Accept: "text/html,text/plain" },
    });
    const body = await res.text();
    if (!res.ok) {
      return { status: "error", detail: `eQSL returned HTTP ${res.status}` };
    }
    return readEqslReply(body);
  } catch (err) {
    return {
      status: "error",
      detail: err instanceof Error ? err.message : "the request failed",
    };
  }
}
