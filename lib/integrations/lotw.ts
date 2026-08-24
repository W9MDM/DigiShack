import { parseAdif, dupeKey } from "@/lib/adif/parse";
import { prisma } from "@/lib/db/prisma";
import { getSetting } from "@/lib/settings";

// Logbook of the World.
//
// Query service: https://lotw.arrl.org/lotwuser/lotwreport.adi
// Docs: https://lotw.arrl.org/lotw-help/developer-query-qsos-qsls/
//
// DOWNLOAD ONLY. Uploading to LoTW requires the QSO to be signed by TQSL with the
// operator's certificate — there is no username/password upload path — so
// `lotw.tqslPath` exists for a later step and is not used here.
//
// Downloading is read-only against ARRL, which is what makes it safe to run
// against a real account without risking anything in the operator's LoTW record.

const REPORT_URL = "https://lotw.arrl.org/lotwuser/lotwreport.adi";

/** Written after a successful sync, for incremental fetches. */
const KEY_LAST_QSL = "lotw.lastQslSince";

/**
 * When a sync last ran and what happened.
 *
 * State, not configuration — written directly and never shown on the Settings page.
 * Exists so the operator can see the integration is alive without reading the bridge
 * log, which is the question they actually have: a page that only offers a button
 * cannot tell you whether the last hour worked.
 */
const KEY_LAST_RUN = "lotw.lastRunAt";
const KEY_LAST_RESULT = "lotw.lastResult";

export interface LotwLastRun {
  at: string | null;
  result: string | null;
  /** The incremental marker: everything confirmed after this has been fetched. */
  marker: string | null;
}

export async function getLotwLastRun(): Promise<LotwLastRun> {
  const rows = await prisma.setting.findMany({
    where: { key: { in: [KEY_LAST_RUN, KEY_LAST_RESULT, KEY_LAST_QSL] } },
    select: { key: true, value: true },
  });
  const get = (k: string) => rows.find((r) => r.key === k)?.value || null;
  return { at: get(KEY_LAST_RUN), result: get(KEY_LAST_RESULT), marker: get(KEY_LAST_QSL) };
}

async function recordRun(result: string): Promise<void> {
  const put = async (key: string, value: string) =>
    prisma.setting.upsert({
      where: { key },
      create: { key, value, encrypted: false },
      update: { value },
    });
  try {
    await put(KEY_LAST_RUN, new Date().toISOString());
    await put(KEY_LAST_RESULT, result.slice(0, 300));
  } catch {
    /* a status note must never be able to fail a sync */
  }
}

/**
 * Explicit "from the beginning" date.
 *
 * Required because leaving `qso_qslsince` off makes LoTW use its own per-account
 * record of your last download, which is not the same as no filter at all.
 * Earlier than any LoTW data can be.
 */
const FULL_HISTORY_SINCE = "1945-01-01";

/**
 * How far back the FIRST automatic sync reaches when there is no marker yet.
 *
 * Not the whole history, and that is the point. Falling back to 1945 made the first
 * run ask LoTW for eighty years of QSLs, which takes minutes to generate and comes
 * back 503 — and because the marker is only written after a success, the next run
 * asked for eighty years again. Observed on this station: no marker ever written and
 * a 503 every time, so the sync could not start no matter how often it ran.
 *
 * Chunking the bootstrap by year does not fix it either: a dozen windows that must
 * ALL succeed against a service that rate-limits is a run that rarely completes, and
 * a partial history must not advance the marker or the missing years are skipped
 * forever.
 *
 * Thirty days is one small request that succeeds, sets the marker, and has the sync
 * running incrementally from then on. An operator who genuinely needs the back
 * catalogue presses Full sync, which still walks year by year — that is a deliberate
 * act with someone watching it, which is the right shape for a request this heavy.
 */
const BOOTSTRAP_DAYS = 30;

function bootstrapSince(): string {
  const d = new Date(Date.now() - BOOTSTRAP_DAYS * 86_400_000);
  return d.toISOString().slice(0, 10);
}

export interface LotwCredentials {
  username: string;
  password: string;
}

export async function getLotwCredentials(): Promise<LotwCredentials | null> {
  const username = await getSetting("lotw.username");
  const password = await getSetting("lotw.password");
  if (!username || !password) return null;
  return { username, password };
}

export interface LotwFetchResult {
  ok: boolean;
  /** Raw ADIF, when the request succeeded. */
  adif?: string;
  error?: string;
  /**
   * True when LoTW refused because a request for this account was already running.
   *
   * Distinct from an ordinary failure: it means "wait", not "something is wrong",
   * and it must never be retried — retrying is what causes it.
   */
  concurrent?: boolean;
  /** APP_LoTW_LASTQSL from the report header, for the next incremental fetch. */
  lastQsl?: string;
  recordCount?: number;
}

export interface LotwFetchOptions {
  /** Only QSLs matched/updated on or after this date (YYYY-MM-DD). */
  qslSince?: string;
  /** Restrict to one of your own callsigns. */
  ownCall?: string;
  /** Restrict by QSO date (not QSL date) — used to chunk a full history. */
  qsoStartDate?: string;
  qsoEndDate?: string;
  /**
   * `no` asks for OUR OWN uploaded contacts rather than only the confirmed ones.
   *
   * The same report endpoint answers both questions, and the difference is this one
   * parameter. Defaults to `yes` because every existing caller wants confirmations.
   */
  qsl?: "yes" | "no";
  /**
   * `qso_qsorxsince` — contacts LoTW RECEIVED since this date, which is not the same as
   * when they happened. It is the only way to ask "what did you take from me lately", and
   * therefore the only way to check that an upload was actually kept.
   */
  rxSince?: string;
  timeoutMs?: number;
}

/**
 * Download confirmations.
 *
 * LoTW signals failure with an HTML page rather than an HTTP error status, and
 * the documented way to detect that is the absence of the ADIF end-of-header
 * tag — so a 200 response is not evidence of success here.
 */
/**
 * One LoTW report request at a time, process-wide.
 *
 * LoTW's limit is on CONCURRENT requests per account, and it belongs to the endpoint rather
 * than to any one caller — which is where the existing guard was wrong. `syncLotwConfirmations`
 * had its own in-flight promise, so two calls to IT were serialised; the moment a second kind
 * of request existed (reconciliation asks the same endpoint a different question) the two could
 * overlap and each would 503 the other, reproducing exactly the failure that guard documents.
 *
 * A chained promise rather than a boolean or a rejection: a second caller waits and then runs,
 * which from the outside is a request that took longer. Turning it away would push the retry
 * decision onto every caller, and the comment below explains why retrying this particular
 * refusal is the wrong move.
 */
let reportChain: Promise<unknown> = Promise.resolve();

function serialised<T>(run: () => Promise<T>): Promise<T> {
  const next = reportChain.then(run, run);
  // Swallowed on the CHAIN only, so one failed request does not reject the next caller's
  // turn. The real result still propagates to whoever asked.
  reportChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

export async function fetchLotwQsls(
  creds: LotwCredentials,
  opts: LotwFetchOptions = {},
): Promise<LotwFetchResult> {
  return serialised(() => fetchLotwQslsUnserialised(creds, opts));
}

async function fetchLotwQslsUnserialised(
  creds: LotwCredentials,
  opts: LotwFetchOptions = {},
): Promise<LotwFetchResult> {
  const params = new URLSearchParams({
    login: creds.username,
    password: creds.password,
    qso_query: "1",
    qso_qsl: opts.qsl ?? "yes",
  });

  // The detail parameters are for CONFIRMATIONS ONLY.
  //
  // They ask LoTW to include the QSLing station's details and our own callsign per record, so
  // a multi-callsign log can be attributed correctly — and they make the report substantially
  // more expensive to generate. Sent alongside `qso_qsl=no`, which asks for our whole uploaded
  // log rather than the confirmed subset, the request took long enough that the timeout here
  // aborted it while LoTW carried on generating — so the account's single request slot stayed
  // busy and the NEXT attempt was refused with "only one page request per user at a time".
  //
  // Which is the exact trap the retry note below describes, reached from a different
  // direction: three reconciliation attempts in a row failed that way, each one prolonging the
  // condition it was failing on. A hand-run query without these parameters answered promptly.
  if ((opts.qsl ?? "yes") === "yes") {
    params.set("qso_qsldetail", "yes");
    params.set("qso_withown", "yes");
  }

  if (opts.qslSince) params.set("qso_qslsince", opts.qslSince);
  if (opts.rxSince) params.set("qso_qsorxsince", opts.rxSince);
  if (opts.ownCall) params.set("qso_owncall", opts.ownCall);
  if (opts.qsoStartDate) params.set("qso_startdate", opts.qsoStartDate);
  if (opts.qsoEndDate) params.set("qso_enddate", opts.qsoEndDate);

  // LoTW allows ONE REQUEST PER ACCOUNT AT A TIME, and says so in the body of the
  // 503 it returns otherwise:
  //
  //   Page Request Limit! Only one page request per user at a time is allowed.
  //   Please allow sufficient time for the previous page(s) to finish loading
  //   before submitting any further requests.
  //
  // That is a concurrency limit, not a rate limit, and the difference is the whole
  // bug. The retry loop here was CAUSING the error it was trying to survive: the
  // first request was still being generated server-side — a large report takes
  // minutes — so every retry arrived while it was in flight and was refused, three
  // times, and the run failed. The diagnosis shown to the operator ("rate-limits
  // heavy use, wait a few minutes") then sent them off looking for the wrong thing.
  //
  // So: retries only for transport failures and genuine server errors, never for
  // this one. If a request is already running, the answer is to wait for it, not to
  // ask again.
  const attempts = 3;
  let text = "";
  let lastError = "";

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(`${REPORT_URL}?${params}`, {
        headers: { "User-Agent": "DigiShack/0.9 (amateur radio logbook)" },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
      });

      if (res.ok) {
        text = await res.text();
        break;
      }

      // Read the body: LoTW puts the real reason there, and the status alone
      // cannot tell "one at a time" from "we are broken".
      const body = await res.text().catch(() => "");
      if (/Page Request Limit/i.test(body)) {
        return {
          ok: false,
          error:
            "LoTW allows only one request per account at a time, and one is already " +
            "running. A large report takes several minutes to generate — wait for it " +
            "to finish before syncing again.",
          concurrent: true,
        };
      }

      lastError =
        res.status === 503
          ? "LoTW is temporarily unavailable (HTTP 503)."
          : `LoTW returned HTTP ${res.status}`;

      // Only 5xx is worth retrying; a 4xx will not change on its own.
      if (res.status < 500 || attempt === attempts) {
        return { ok: false, error: lastError };
      }
    } catch (err) {
      lastError =
        err instanceof Error
          ? `Could not reach LoTW: ${err.message}`
          : "Could not reach LoTW";
      if (attempt === attempts) return { ok: false, error: lastError };
    }

    // 5s, then 15s. Deliberately unhurried.
    await new Promise((r) => setTimeout(r, attempt * 10_000 - 5_000));
  }

  if (!text) return { ok: false, error: lastError || "LoTW returned nothing" };

  // Documented failure detection: no <eoh> means this is an HTML explanation,
  // not a report.
  if (!/<eoh>/i.test(text)) {
    const hint = /password|login|invalid|incorrect/i.test(text)
      ? "LoTW rejected the credentials — check lotw.username and lotw.password in Settings."
      : "LoTW returned a page rather than an ADIF report.";
    return { ok: false, error: hint };
  }

  const lastQsl = /<APP_LoTW_LASTQSL:\d+>([^<]+)/i.exec(text)?.[1]?.trim();

  return {
    ok: true,
    adif: text,
    lastQsl,
    recordCount: (text.match(/<eor>/gi) ?? []).length,
  };
}

export interface LotwSyncReport {
  dryRun: boolean;
  fetched: number;
  parsed: number;
  matched: number;
  updated: number;
  alreadyMarked: number;
  /** Award fields (state, county, zones, grid, IOTA) filled in from LoTW's detail. */
  enriched: number;
  unmatched: number;
  /** Confirmations with no corresponding QSO in the log. */
  unmatchedSamples: {
    callsign: string;
    band: string;
    mode: string;
    startTime: string;
  }[];
  lastQsl: string | null;
  incrementalFrom: string | null;
}

/**
 * Download confirmations and mark matching QSOs `lotwRcvd`.
 *
 * Matching is the same callsign+band+mode+minute key the ADIF importer uses for
 * duplicate detection — LoTW records times to the minute, so comparing seconds
 * would match nothing.
 *
 * Only ever sets `lotwRcvd` to true. It never clears the flag: a confirmation
 * absent from an incremental window is not evidence that it was withdrawn.
 */
/**
 * Only one LoTW sync in this process at a time.
 *
 * LoTW refuses a second concurrent request per account, so two of our own runs
 * overlapping is a guaranteed failure for both. That became reachable the moment an
 * hourly schedule existed: an operator pressing Sync while the timer fired would take
 * out the run that was already working, and both would report a confusing 503.
 *
 * A promise rather than a boolean, so a second caller WAITS for the first and
 * receives its result rather than being turned away — from the outside that is simply
 * a sync that took a little longer.
 */
let inFlight: Promise<
  { ok: false; error: string } | { ok: true; report: LotwSyncReport }
> | null = null;

export function lotwSyncInFlight(): boolean {
  return inFlight !== null;
}

export async function syncLotwConfirmations(opts: {
  dryRun: boolean;
  full: boolean;
  ownCall?: string;
}): Promise<{ ok: false; error: string } | { ok: true; report: LotwSyncReport }> {
  if (inFlight) return inFlight;
  inFlight = runLotwSync(opts)
    .then(async (r) => {
      // Only a REAL run is worth recording. A dry run answers a question; it does
      // not change when the integration last did its job.
      if (!opts.dryRun) {
        await recordRun(
          r.ok
            ? `${r.report.matched} matched, ${r.report.updated} newly confirmed`
            : `failed: ${r.error}`,
        );
      }
      return r;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

async function runLotwSync(opts: {
  dryRun: boolean;
  full: boolean;
  ownCall?: string;
}): Promise<{ ok: false; error: string } | { ok: true; report: LotwSyncReport }> {
  const creds = await getLotwCredentials();
  if (!creds) {
    return {
      ok: false,
      error: "LoTW credentials are not configured (Settings → Logbook of the World).",
    };
  }

  // Incremental unless asked for everything: LoTW asks clients not to re-download
  // their whole QSL history on every run.
  //
  // `full` must pass an explicit early date. OMITTING qso_qslsince does NOT mean
  // "everything" — LoTW tracks each account's previous download server-side and
  // returns only QSLs received since then, so a "full" sync that left the
  // parameter off quietly returned a handful of recent records and looked like a
  // complete history.
  const marker = (await prisma.setting.findUnique({ where: { key: KEY_LAST_QSL } }))?.value;

  /**
   * Are we asking for the whole history rather than a small increment?
   *
   * True when explicitly asked, AND true when there is no marker yet — which is the
   * case that made this unable to start at all. `since` already fell back to 1945
   * without a marker, but the year-chunking below keyed off `opts.full`, so a first
   * run asked LoTW for eighty years of QSLs in a SINGLE request. That takes minutes
   * to generate, comes back 503, and the marker is only written after a success — so
   * the next run asked for eighty years again. Observed on this station: no marker
   * ever written, 503 after 142 seconds, every time.
   */
  const wholeHistory = opts.full;
  const since = wholeHistory
    ? FULL_HISTORY_SINCE
    : (marker ?? bootstrapSince());

  // A full history for a large log is too big for one request — LoTW takes
  // minutes to generate it and the transfer times out. Chunk by QSO year
  // instead: each response is small, a slow year doesn't sink the whole run, and
  // it stays inside NGINX's proxy_read_timeout.
  //
  // Incremental syncs are a single request; they are small by definition.
  const windows: { start?: string; end?: string }[] = [];

  if (wholeHistory) {
    const earliest = await prisma.qso.findFirst({
      orderBy: { startTime: "asc" },
      select: { startTime: true },
    });
    const firstYear = earliest ? earliest.startTime.getUTCFullYear() : new Date().getUTCFullYear();
    const thisYear = new Date().getUTCFullYear();
    for (let y = firstYear; y <= thisYear; y++) {
      windows.push({ start: `${y}-01-01`, end: `${y}-12-31` });
    }
  } else {
    windows.push({});
  }

  const collected: string[] = [];
  let fetchedCount = 0;
  let lastQsl: string | undefined;

  for (const [index, w] of windows.entries()) {
    // Space out a multi-year run. LoTW rate-limits, and a burst of a dozen
    // report requests is exactly what trips it.
    // 15 s, not 3. LoTW allows one request per account AT A TIME and a report can
    // take minutes to generate; a three-second gap all but guarantees the next
    // window arrives while the previous one is still being built.
    if (index > 0) await new Promise((r) => setTimeout(r, 15_000));

    const page = await fetchLotwQsls(creds, {
      qslSince: since,
      ownCall: opts.ownCall,
      qsoStartDate: w.start,
      qsoEndDate: w.end,
      timeoutMs: 120_000,
    });

    if (!page.ok || !page.adif) {
      return {
        ok: false,
        error: w.start
          ? `LoTW download failed for ${w.start.slice(0, 4)}: ${page.error ?? "unknown"}`
          : (page.error ?? "LoTW download failed"),
      };
    }

    collected.push(page.adif);
    fetchedCount += page.recordCount ?? 0;
    // Keep the newest marker across all windows.
    if (page.lastQsl && (!lastQsl || page.lastQsl > lastQsl)) lastQsl = page.lastQsl;
  }

  const fetched = {
    recordCount: fetchedCount,
    lastQsl,
  };

  const qsos = collected.flatMap((doc) => parseAdif(doc).qsos);

  let matched = 0;
  let updated = 0;
  let alreadyMarked = 0;
  // Individual FIELDS filled from LoTW's detail, not contacts — one contact can
  // contribute several, and the useful figure is how much the log actually gained.
  let enriched = 0;
  const unmatchedSamples: LotwSyncReport["unmatchedSamples"] = [];

  for (const confirmation of qsos) {
    // Narrow by the indexed columns, then match on the minute-precision key.
    const candidates = await prisma.qso.findMany({
      where: {
        callsign: confirmation.callsign,
        band: confirmation.band,
        mode: confirmation.mode,
      },
      select: {
        id: true,
        callsign: true,
        band: true,
        mode: true,
        startTime: true,
        lotwRcvd: true,
        // Needed to decide what is missing. The request already asks LoTW for
        // `qso_qsldetail`, and every one of these was being parsed and thrown away.
        gridSquare: true,
        dxcc: true,
        state: true,
        county: true,
        cqZone: true,
        ituZone: true,
        iota: true,
        continent: true,
        qslRcvdAt: true,
      },
    });

    const want = dupeKey(confirmation);
    const hit = candidates.find((c) => dupeKey(c) === want);

    if (!hit) {
      if (unmatchedSamples.length < 25) {
        unmatchedSamples.push({
          callsign: confirmation.callsign,
          band: confirmation.band,
          mode: confirmation.mode,
          startTime: confirmation.startTime.toISOString(),
        });
      }
      continue;
    }

    matched++;

    // What LoTW knows that we might not.
    //
    // The request asks for `qso_qsldetail`, so each confirmation carries the other
    // station's location as LoTW holds it — and for WAS, WAZ, IOTA and WAC that is a
    // better source than anything else available: it comes from their signed record
    // rather than from a callsign lookup or from what got typed in at the time.
    //
    // Only ever fills a field that is EMPTY. LoTW is a better source than a guess and
    // a worse one than the operator, who may have corrected something deliberately,
    // and silently overwriting that is not a trade worth making for an award count.
    const fill: Record<string, unknown> = {};
    const takeIfEmpty = <K extends keyof typeof hit>(key: K, incoming: unknown) => {
      if (hit[key] === null && incoming !== null && incoming !== undefined && incoming !== "") {
        fill[key as string] = incoming;
      }
    };
    takeIfEmpty("gridSquare", confirmation.gridSquare);
    takeIfEmpty("dxcc", confirmation.dxcc);
    takeIfEmpty("state", confirmation.state);
    takeIfEmpty("county", confirmation.county);
    takeIfEmpty("cqZone", confirmation.cqZone);
    takeIfEmpty("ituZone", confirmation.ituZone);
    takeIfEmpty("iota", confirmation.iota);
    takeIfEmpty("continent", confirmation.continent);
    // When LoTW confirmed it, which is not the same as when we noticed.
    takeIfEmpty("qslRcvdAt", confirmation.qslRcvdAt);

    const enrichedCount = Object.keys(fill).length;
    if (enrichedCount > 0) enriched += enrichedCount;

    if (hit.lotwRcvd && enrichedCount === 0) {
      alreadyMarked++;
      continue;
    }

    if (!opts.dryRun) {
      await prisma.qso.update({
        where: { id: hit.id },
        data: { lotwRcvd: true, lotwSent: true, ...fill },
      });
    }
    // A contact already marked, whose detail we have now taken, is not a new
    // confirmation — counting it as one would overstate what the sync achieved.
    if (hit.lotwRcvd) alreadyMarked++;
    else updated++;
  }

  // Advance the incremental marker only on a real run that succeeded.
  if (!opts.dryRun && fetched.lastQsl) {
    await prisma.setting.upsert({
      where: { key: KEY_LAST_QSL },
      create: { key: KEY_LAST_QSL, value: fetched.lastQsl, encrypted: false },
      update: { value: fetched.lastQsl },
    });
  }

  return {
    ok: true,
    report: {
      dryRun: opts.dryRun,
      fetched: fetched.recordCount ?? 0,
      parsed: qsos.length,
      matched,
      updated,
      alreadyMarked,
      enriched,
      unmatched: qsos.length - matched,
      unmatchedSamples,
      lastQsl: fetched.lastQsl ?? null,
      incrementalFrom: since ?? null,
    },
  };
}

/** Read-only credential check: the smallest possible query. */
export async function testLotw(): Promise<{ ok: boolean; detail: string }> {
  const creds = await getLotwCredentials();
  if (!creds) return { ok: false, detail: "Not configured" };

  // A date far in the future returns an empty but valid report — enough to prove
  // the credentials without transferring a whole QSL history. Note this relies on
  // qso_qslsince being honoured; omitting it would instead return whatever LoTW
  // considers new since the last download.
  const res = await fetchLotwQsls(creds, { qslSince: "2099-01-01" });

  return res.ok
    ? { ok: true, detail: "Credentials accepted" }
    : { ok: false, detail: res.error ?? "Failed" };
}
