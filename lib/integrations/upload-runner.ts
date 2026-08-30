// Uploading contacts to the log-hosting services, automatically.
//
// Nothing in this application had ever uploaded a QSO anywhere. `insertQrzQso` and
// `uploadAdifToClubLog` were both written, tested and never called; `upload-state.ts`
// tracked a thing that never happened. The flags in the database came from ADIF
// imports and from reconciling against remote logs, not from this software sending
// anything.
//
// THE HAZARD, and the reason this is not just a loop over the log:
//
// 26,256 contacts are marked unsent to QRZ, and almost all of them are already there,
// uploaded by whatever logger the operator used before. Sweeping the lot would be
// 26,000 API calls to discover that — rude to QRZ, slow, and for a service that
// charges for a logbook subscription, a good way to get an account looked at.
//
// So automatic upload applies from a CUTOFF: contacts logged at or after the moment
// the operator switched it on. The back catalogue is a separate, explicit action with
// a count shown first. That distinction is the whole design.

import { QSO_INCLUDE, toAdifInput } from "@/lib/adif/from-row";
import { prisma } from "@/lib/db/prisma";
import { uploadQsoToClubLog } from "@/lib/integrations/clublog";
import { uploadToCloudlog } from "@/lib/integrations/cloudlog";
import { N3FJP_DEFAULT_PORT, sendToN3fjp } from "@/lib/integrations/n3fjp";
import { insertQrzQso } from "@/lib/integrations/qrz-logbook";
import {
  SERVICE_LABEL,
  markUploaded,
  type UploadService,
} from "@/lib/integrations/upload-state";
import { getEqslCredentials, uploadEqslQso } from "@/lib/integrations/eqsl";
import {
  type LotwCert,
  LotwCertError,
  loadLotwCert,
  lotwCertInfo,
} from "@/lib/integrations/lotw-cert";
import { buildTq8, type LotwContact, type LotwStation } from "@/lib/integrations/lotw-tq8";
import { tq8Filename, uploadTq8 } from "@/lib/integrations/lotw-upload";
import { getBooleanSetting, getNumberSetting, getSetting } from "@/lib/settings";

/** Services this can actually push to today. */
export const UPLOADABLE = ["qrz", "clublog", "cloudlog", "eqsl", "lotw", "n3fjp"] as const;
export type UploadableService = (typeof UPLOADABLE)[number];

/**
 * Consecutive failures before a service is left alone until the next restart.
 *
 * Club Log currently answers 403 for reasons nobody has diagnosed. Without a breaker
 * that becomes a fixed number of pointless requests every sweep, forever, and the
 * log fills with the same error until it stops being read.
 */
const FAILURE_LIMIT = 3;

/**
 * Failing Club Log requests in a row before the sweep gives up on the rest.
 *
 * Club Log is uploaded ONE CONTACT AT A TIME, which turns a sweep from one request into
 * up to `maxPerRun` of them, and Club Log documents repeated failures as what earns an
 * address a real block. A batch that failed cost one request and could do so for ever
 * harmlessly; twenty-five cannot.
 *
 * Three rather than one, because the fault this has to survive is a single record Club
 * Log will not take — an imported log had exactly one, a callsign whose prefix belongs to
 * no DXCC entity — and stopping the whole sweep on it would let one bad row hold up
 * everything behind it indefinitely.
 *
 * Smaller than `FAILURE_LIMIT`'s job, and not a replacement for it: this bounds ONE
 * sweep, the breaker stands the service down across sweeps.
 */
const CLUBLOG_CONSECUTIVE_FAILURES = 3;

const breaker: Record<string, { failures: number; lastError: string }> = {};

export function resetBreaker(service?: string): void {
  if (service) delete breaker[service];
  else for (const k of Object.keys(breaker)) delete breaker[k];
}

export function breakerState(): Record<string, { failures: number; lastError: string }> {
  return { ...breaker };
}

function tripped(service: string): boolean {
  return (breaker[service]?.failures ?? 0) >= FAILURE_LIMIT;
}

function noteFailure(service: string, error: string): void {
  const b = breaker[service] ?? { failures: 0, lastError: "" };
  b.failures++;
  b.lastError = error;
  breaker[service] = b;
}

export interface UploadPrefs {
  enabled: boolean;
  /** eQSL.cc. Off by default like the rest — it posts cards to other operators. */
  eqsl: boolean;
  /** LoTW. Needs a certificate rather than a password, so it cannot default to on. */
  lotw: boolean;
  qrz: boolean;
  clublog: boolean;
  cloudlog: boolean;
  /**
   * N3FJP Amateur Contact Log, over TCP on the operator's own network.
   *
   * Off by default like every other target: it pushes to a program that may not be
   * running, and an operator who has not asked for it should not have contacts appearing
   * in a second log.
   */
  n3fjp: boolean;
  /** Only contacts at or after this instant are uploaded automatically. */
  since: Date | null;
  maxPerRun: number;
  /**
   * Contacts per LoTW sweep, separate from `maxPerRun`.
   *
   * `maxPerRun` counts REQUESTS as much as contacts, because QRZ and eQSL take one call
   * each — 25 there is 25 round trips to somebody else's server. LoTW takes one POST for
   * the whole signed file, so the same number costs the same either way and 25 turned a
   * 6,500-contact backlog into two days of sweeps.
   */
  lotwBatch: number;
  /**
   * Contacts per Cloudlog/Wavelog sweep.
   *
   * One request per contact there, as with QRZ and eQSL — but the server belongs to the
   * operator. `maxPerRun` is restraint towards OTHER PEOPLE's services and their rate
   * limits, and neither is a consideration on your own network.
   */
  cloudlogBatch: number;
  /**
   * Only create an outgoing eQSL for a contact where they already sent us one.
   *
   * On eQSL the upload IS the card, so there is no log-only mode to fall back on. This makes
   * every send a REPLY rather than an approach, which is both the etiquette and the smaller
   * number: 6,920 reciprocal candidates against 23,728 unsent, at one request each.
   */
  eqslReciprocalOnly: boolean;
}

export async function getUploadPrefs(): Promise<UploadPrefs> {
  const raw = (await getSetting("uploads.since")) ?? "";
  const since = raw ? new Date(raw) : null;
  return {
    enabled: await getBooleanSetting("uploads.enabled", false),
    eqsl: await getBooleanSetting("uploads.eqsl", false),
    lotw: await getBooleanSetting("uploads.lotw", false),
    qrz: await getBooleanSetting("uploads.qrz", true),
    clublog: await getBooleanSetting("uploads.clublog", false),
    cloudlog: await getBooleanSetting("uploads.cloudlog", false),
    n3fjp: await getBooleanSetting("uploads.n3fjp", false),
    since: since && !Number.isNaN(since.getTime()) ? since : null,
    maxPerRun: await getNumberSetting("uploads.maxPerRun", 25),
    lotwBatch: await getNumberSetting("uploads.lotwBatch", 500),
    cloudlogBatch: await getNumberSetting("uploads.cloudlogBatch", 200),
    eqslReciprocalOnly: await getBooleanSetting("uploads.eqslReciprocalOnly", true),
  };
}

const SENT_FIELD: Record<
  UploadableService,
  "qrzSent" | "clublogSent" | "cloudlogSent" | "eqslSent" | "lotwSent" | "n3fjpSent"
> = {
  qrz: "qrzSent",
  clublog: "clublogSent",
  cloudlog: "cloudlogSent",
  eqsl: "eqslSent",
  lotw: "lotwSent",
  n3fjp: "n3fjpSent",
};

/**
 * Everything the ADIF writer needs, in one query shape.
 *
 * Shared with the ADIF and CSV exports rather than declared again here — this mapping used to
 * exist twice and a third copy was about to be written, which is the point at which a field
 * added to the model reaches two of the three and is silently missing from the last.
 */
const QSO_FOR_UPLOAD = QSO_INCLUDE;

type QsoRow = Awaited<ReturnType<typeof loadPending>>[number];

async function loadPending(
  service: UploadableService,
  since: Date | null,
  limit: number,
  ignoreCutoff: boolean,
  reciprocalOnly = false,
  qsoIds?: string[],
) {
  const where = pendingWhere(service, { since, ignoreCutoff, reciprocalOnly, qsoIds });
  return prisma.qso.findMany({
    where,
    orderBy: { startTime: "asc" },
    take: limit,
    include: QSO_FOR_UPLOAD,
  });
}

/**
 * Which contacts a run should pick up — the whole selection rule, as data.
 *
 * Pulled out of `loadPending` so it can be asserted without a database. The rule it
 * encodes is not obvious and getting it wrong is silent: a query that finds nothing
 * reports a clean run of zero, which reads as success.
 *
 * NAMED CONTACTS IGNORE EVERY FILTER, INCLUDING THE SENT FLAG. That is the reprocess
 * path, and the contact it is asked to send is usually one already MARKED sent — an
 * upload the operator does not believe happened, a service that was down, a logging
 * program that was closed. Filtering on `sent = false` there would find nothing and
 * report success, which is the exact failure the button exists to escape.
 *
 * The cutoff and the eQSL reciprocal rule go with it. Both are restraint about what to
 * send UNASKED, and somebody has just asked.
 */
export function pendingWhere(
  service: UploadableService,
  opts: {
    since?: Date | null;
    ignoreCutoff?: boolean;
    reciprocalOnly?: boolean;
    qsoIds?: string[];
  },
): Record<string, unknown> {
  if (opts.qsoIds) return { id: { in: opts.qsoIds } };
  return {
    [SENT_FIELD[service]]: false,
    ...(opts.ignoreCutoff || !opts.since ? {} : { startTime: { gte: opts.since } }),
    // eQSL only, and only when asked for: send a card back to whoever sent us one.
    ...(opts.reciprocalOnly && service === "eqsl" ? { eqslRcvd: true } : {}),
  };
}

/**
 * Which services a run touches.
 *
 * An explicit list wins over `only`, and both win over the preferences — a reprocess names
 * its destinations and a service being switched off for automatic sweeps says nothing
 * about whether the operator may send one contact there by hand.
 */
export function resolveServices(
  opts: { only?: UploadableService; services?: UploadableService[] },
  prefs: Pick<UploadPrefs, UploadableService>,
): UploadableService[] {
  if (opts.services) return opts.services;
  if (opts.only) return [opts.only];
  return UPLOADABLE.filter((s) => prefs[s]);
}


/**
 * Everything the LoTW uploader needs about this station, from settings plus the certificate.
 *
 * The DXCC comes from the CERTIFICATE rather than from a setting or a prefix lookup: it is
 * what LoTW issued, and a mismatch between the station record and the certificate is refused.
 */
async function lotwStationFor(cert: LotwCert): Promise<LotwStation | null> {
  const station = await prisma.station.findFirst({ select: { callsign: true, grid: true } });
  if (!station?.callsign) return null;
  return {
    callsign: station.callsign,
    dxcc: cert.dxcc,
    grid: station.grid || null,
    state: (await getSetting("lotw.station.state")) || null,
    county: (await getSetting("lotw.station.county")) || null,
    cqZone: await getOptionalNumber("lotw.station.cqZone"),
    ituZone: await getOptionalNumber("lotw.station.ituZone"),
    iota: (await getSetting("lotw.station.iota")) || null,
    canadian: await getBooleanSetting("lotw.station.canadian", false),
  };
}

/**
 * A number setting where "not set" and "zero" are different answers.
 *
 * `getNumberSetting` takes a default and cannot express absence, and absence matters here:
 * an omitted CQ zone leaves the field out of both the station record and the signed bytes,
 * while a zero would put `0` in both and be refused.
 */
async function getOptionalNumber(key: string): Promise<number | null> {
  const raw = (await getSetting(key)) ?? "";
  if (!raw.trim()) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function toLotwContact(q: QsoRow): LotwContact {
  return {
    callsign: q.callsign,
    band: q.band,
    bandRx: null,
    mode: q.mode,
    freqHz: q.freqHz === null ? null : Number(q.freqHz),
    freqRxHz: null,
    propMode: null,
    satName: null,
    startTime: q.startTime,
  };
}

export interface ServiceResult {
  service: UploadableService;
  attempted: number;
  uploaded: number;
  duplicates: number;
  failed: number;
  skipped: string | null;
  errors: string[];
  /**
   * What the service said on SUCCESS, when it said anything worth keeping.
   *
   * Kept because the runner was discarding it and leaving the log to assert a number the
   * remote end had not confirmed. For LoTW the honest reading of that number is narrow:
   * MEASURED against the live service, an accepted upload answers
   *
   *     File k9xyz-2026-08-23-13-57-11-digishack.tq8 queued for processing.
   *
   * so `uploaded` means TAKEN FOR PROCESSING, not stored. LoTW validates the records
   * afterwards and reports the outcome by email. An earlier version of this comment claimed
   * the reply carried an "N out of M records added" count; it does not, and that was eQSL's
   * behaviour conflated with this one.
   *
   * The consequence is that marking a batch sent on acceptance is OPTIMISTIC. Confirming it
   * properly means asking LoTW what it actually holds — `lotwreport.adi` with
   * `qso_query=1&qso_qsl=no&qso_qsorxsince=<date>` returns our own uploaded contacts — which
   * is how the first 26 through this code were verified by hand. Doing it automatically is
   * not yet built.
   */
  detail?: string;
}

export interface UploadRunResult {
  ran: boolean;
  reason: string | null;
  services: ServiceResult[];
}

/**
 * Upload whatever is pending, up to the per-run cap.
 *
 * `ignoreCutoff` is the back-catalogue path and must only ever be reached from an
 * explicit operator action with the count shown first.
 */
export async function runUploads(
  opts: {
    ignoreCutoff?: boolean;
    limit?: number;
    only?: UploadableService;
    /**
     * Send THESE contacts, whatever their upload state — the reprocess path.
     *
     * Named contacts bypass the sent flag, the cutoff and the eQSL reciprocal rule; see
     * `loadPending`. Pair it with `services`, because the point of naming a contact is
     * usually to send it somewhere it did not reach.
     */
    qsoIds?: string[];
    /** Exactly these services, whatever the preferences say. */
    services?: UploadableService[];
  } = {},
): Promise<UploadRunResult> {
  const prefs = await getUploadPrefs();
  // A reprocess works with automatic uploading OFF, and that is not an oversight: an
  // operator who has just been told a contact never reached QRZ should not have to switch
  // on a sweep of everything else to send that one contact.
  if (!prefs.enabled && !opts.ignoreCutoff && !opts.qsoIds) {
    return { ran: false, reason: "Automatic uploading is off", services: [] };
  }

  const limit = opts.limit ?? prefs.maxPerRun;
  const wanted = resolveServices(opts, prefs);

  const services: ServiceResult[] = [];

  for (const service of wanted) {
    const r: ServiceResult = {
      service,
      attempted: 0,
      uploaded: 0,
      duplicates: 0,
      failed: 0,
      skipped: null,
      errors: [],
    };

    // The breaker exists to stop a SWEEP hammering a service that is down. It has no
    // business refusing a person who has clicked reprocess on one contact — they may well
    // be clicking it because they have just fixed whatever tripped it.
    if (tripped(service) && !opts.qsoIds) {
      r.skipped = `${FAILURE_LIMIT} consecutive failures — last: ${breaker[service]?.lastError ?? "?"}`;
      services.push(r);
      continue;
    }

    // LoTW gets its own size. An explicit `opts.limit` still wins, so a caller asking for
    // one contact — which is how the signature was first tested against the live service —
    // gets one contact.
    const take =
      opts.qsoIds
        ? opts.qsoIds.length
        : opts.limit !== undefined
        ? limit
        : service === "lotw"
          ? prefs.lotwBatch
          : service === "cloudlog"
            ? prefs.cloudlogBatch
            : limit;
    const rows = await loadPending(
      service,
      prefs.since,
      take,
      opts.ignoreCutoff ?? false,
      prefs.eqslReciprocalOnly,
      opts.qsoIds,
    );
    if (rows.length === 0) {
      services.push(r);
      continue;
    }
    r.attempted = rows.length;

    if (service === "qrz") {
      // One at a time: QRZ's API takes a single record per call.
      const done: string[] = [];
      for (const q of rows) {
        const res = await insertQrzQso(toAdifInput(q));
        if (res.ok) {
          r.uploaded++;
          done.push(q.id);
        } else if (res.duplicate) {
          // Already on QRZ — which is the state we wanted. Marking it means we stop
          // asking, and that is the whole point of tracking upload state.
          r.duplicates++;
          done.push(q.id);
        } else {
          r.failed++;
          if (r.errors.length < 5) r.errors.push(`${q.callsign}: ${res.error ?? "failed"}`);
          noteFailure(service, res.error ?? "failed");
          if (tripped(service)) break;
        }
      }
      if (done.length > 0) await markUploaded(service as UploadService, done);
      if (r.uploaded > 0 || r.duplicates > 0) resetBreaker(service);
    } else if (service === "eqsl") {
      // One GET per contact — eQSL's API takes a single record in the query string and
      // has no batch form, so this is its shape rather than a choice.
      const creds = await getEqslCredentials();
      if (!creds) {
        r.skipped = "eQSL username and password are not configured";
        services.push(r);
        continue;
      }
      const done: string[] = [];
      for (const q of rows) {
        const out = await uploadEqslQso(
          {
            callsign: q.callsign,
            band: q.band,
            mode: q.mode,
            startTime: q.startTime,
            rstSent: q.rstSent,
          },
          creds,
        );
        if (out.status === "sent") {
          r.uploaded++;
          done.push(q.id);
        } else if (out.status === "duplicate") {
          // Already on eQSL, which is the state we wanted. Marking it is what stops us
          // asking again — the same reasoning as QRZ's duplicate handling above.
          r.duplicates++;
          done.push(q.id);
        } else {
          r.failed++;
          if (r.errors.length < 5) r.errors.push(`${q.callsign}: ${out.detail}`);
          noteFailure(service, out.detail);
          // Bad credentials will fail for every remaining contact in exactly the same
          // way, so stop rather than spend the run proving it 24 more times.
          if (out.status === "bad-credentials" || tripped(service)) break;
        }
      }
      if (done.length > 0) await markUploaded(service as UploadService, done);
      if (r.uploaded > 0 || r.duplicates > 0) resetBreaker(service);
    } else if (service === "lotw") {
      // ONE SIGNED FILE FOR THE WHOLE BATCH, which is LoTW's shape rather than a choice:
      // the certificate signs each contact, the contacts travel together in a .tq8, and the
      // service answers once for the file. It follows that the batch is all-or-nothing —
      // there is no per-contact result to read — so nothing is marked sent unless LoTW says
      // it took the file.
      let cert: LotwCert | null;
      try {
        cert = await loadLotwCert();
      } catch (err) {
        r.skipped = err instanceof LotwCertError ? err.message : "the LoTW certificate is unreadable";
        services.push(r);
        continue;
      }
      if (!cert) {
        r.skipped = "no LoTW callsign certificate has been uploaded";
        services.push(r);
        continue;
      }
      if (cert.validTo.getTime() < Date.now()) {
        // Signing with an expired certificate produces a file LoTW refuses in full. Said
        // here rather than discovered from a rejection, because the rejection text does not
        // mention expiry.
        r.skipped = `the ${cert.callsign} certificate expired on ${cert.validTo.toISOString().slice(0, 10)} — renew it in TQSL and upload it again`;
        services.push(r);
        continue;
      }

      const st = await lotwStationFor(cert);
      if (!st) {
        r.skipped = "no station callsign is set";
        services.push(r);
        continue;
      }

      const built = buildTq8(cert, st, rows.map(toLotwContact));
      for (const ex of built.excluded) {
        // Excluded, not failed: these are outside the certificate's QSO window and no
        // number of retries changes that. Counting them as failures would trip the breaker
        // and stop the contacts that CAN go.
        if (r.errors.length < 5) {
          r.errors.push(`${ex.callsign} on ${ex.startTime.toISOString().slice(0, 10)}: ${ex.reason}`);
        }
      }
      if (built.included === 0) {
        r.skipped =
          built.excluded.length > 0
            ? `all ${built.excluded.length} contacts fall outside the certificate's QSO date window`
            : "nothing to send";
        services.push(r);
        continue;
      }

      const out = await uploadTq8(built.gz, tq8Filename(st.callsign));
      if (out.ok) {
        r.detail = out.detail;
        const sent = rows
          .filter((q) => !built.excluded.some((e) => e.callsign === q.callsign && e.startTime.getTime() === q.startTime.getTime()))
          .map((q) => q.id);
        r.uploaded = sent.length;
        await markUploaded(service as UploadService, sent);
        resetBreaker(service);
      } else {
        r.failed = built.included;
        r.errors.push(out.detail);
        noteFailure(service, out.detail);
      }
    } else if (service === "cloudlog") {
      // One request per contact — the API takes a single record, and this is the
      // operator's own server, so the round trips cost nothing worth optimising.
      const res = await uploadToCloudlog(rows.map(toAdifInput));
      r.uploaded = res.sent;
      r.duplicates = res.duplicates;
      // BY INDEX, not `rows.slice(0, sent)`. That slice assumed the first N in order had
      // succeeded, which stopped being true once duplicates were skipped instead of ending
      // the run — it would have marked the wrong contacts as uploaded.
      if (res.doneIndexes.length > 0) {
        await markUploaded(
          service as UploadService,
          res.doneIndexes.map((i) => rows[i]!.id),
        );
      }
      r.failed = rows.length - res.sent - res.duplicates;
      for (const e of res.errors.slice(0, 5)) r.errors.push(e);
      if (!res.ok && res.sent === 0 && res.duplicates === 0) {
        r.errors.push(res.detail);
        noteFailure(service, res.detail);
      } else {
        // Progress was made, so the breaker resets even if some records were refused.
        // Otherwise a handful of permanently-bad records would eventually stop a service
        // that is working for everything else.
        resetBreaker(service);
      }
    } else if (service === "n3fjp") {
      // One connection for the whole batch — this is a program on a desk on the same
      // network, not somebody else's API, so there is no rate limit to respect and no
      // reason to reconnect per contact.
      const res = await sendToN3fjp(rows.map(toAdifInput), {
        host: (await getSetting("n3fjp.host")) ?? "",
        port: await getNumberSetting("n3fjp.port", N3FJP_DEFAULT_PORT),
      });
      r.uploaded = res.sent;
      r.detail = res.detail;
      // BY INDEX, like Cloudlog above: a connection that dies halfway through has
      // genuinely written the records before it, and marking `rows.slice(0, sent)` would
      // be assuming an ordering that the partial-failure path does not guarantee.
      if (res.doneIndexes.length > 0) {
        await markUploaded(
          service as UploadService,
          res.doneIndexes.map((i) => rows[i]!.id),
        );
      }
      r.failed = rows.length - res.sent;
      for (const e of res.errors.slice(0, 5)) r.errors.push(e);
      if (res.ok) {
        resetBreaker(service);
      } else {
        r.errors.push(res.detail);
        // A closed logging program is the ordinary case rather than a fault, but it still
        // trips the breaker: three sweeps of ECONNREFUSED is enough, and the contacts are
        // still flagged unsent so they go out whenever the program next comes up.
        noteFailure(service, res.detail);
      }
    } else {
      // CLUB LOG GOES ONE CONTACT AT A TIME, through `realtime.php`.
      //
      // The batch endpoint answers ONCE for a whole file, so a record it drops is
      // invisible to the caller: the sweep marks all twenty-five sent including the one
      // that was skipped, or fails all twenty-five and re-sends the twenty-four Club Log
      // already holds. Neither is recoverable from the reply, because the reply does not
      // say which record was at fault. Sent per contact, each row's fate is known.
      //
      // THE COST IS REQUEST COUNT, AND IT NEEDS A BRAKE — see
      // CLUBLOG_CONSECUTIVE_FAILURES. Twenty-five doomed requests a sweep at a service
      // that blocks addresses for repeated failures is a materially different thing from
      // the one doomed request the batch path made.
      let consecutive = 0;
      for (const row of rows) {
        const res = await uploadQsoToClubLog(toAdifInput(row));
        if (res.ok) {
          consecutive = 0;
          r.uploaded++;
          if (res.duplicate) r.duplicates++;
          // Marked per contact rather than once at the end. A sweep interrupted after
          // nineteen — a restart, a deploy, a timeout on the twentieth — must not come
          // back and send those nineteen a second time.
          await markUploaded(service as UploadService, [row.id]);
        } else {
          consecutive++;
          r.failed++;
          if (r.errors.length < 5) r.errors.push(`${row.callsign}: ${res.detail}`);
          if (consecutive >= CLUBLOG_CONSECUTIVE_FAILURES) break;
        }
      }
      // `attempted` was set to the whole batch before the branch, which is true for every
      // service that tries all of its rows. This one can stop early, and reporting 25
      // attempted when 5 were tried would make the brake invisible in the run report —
      // the failure rate would read as 3-in-25 rather than 3-in-5.
      r.attempted = r.uploaded + r.failed;

      // ANY success resets the breaker, and that is deliberate. The breaker is for a
      // service that is down or refusing everything. A single record Club Log will not
      // take is a fact about that record, and letting it count towards standing the
      // service down would let one bad row in an imported log stop uploads for the whole
      // log — which is exactly the shape of fault this sweep now exists to isolate.
      if (r.uploaded > 0) {
        resetBreaker(service);
      } else if (r.failed > 0) {
        noteFailure(service, r.errors[r.errors.length - 1] ?? "failed");
      }
    }

    services.push(r);
  }

  return { ran: true, reason: null, services };
}

/**
 * Which column records that this service has the contact.
 *
 * Exported because the baseline endpoint counts against the same column it is about to
 * write, and a second copy of this mapping is exactly how a service ends up counted
 * against one field and marked on another.
 */
export function SENT_FIELD_FOR(service: UploadableService): string {
  return SENT_FIELD[service];
}

/**
 * Has this service been given what it needs to accept an upload?
 *
 * Each answers differently, and a chain of ternaries had already let one fall through to
 * Club Log's answer. Kept as a switch so that adding a service without saying what
 * "configured" means for it is a type error rather than a wrong badge.
 */
export async function isConfigured(service: UploadableService): Promise<boolean> {
  switch (service) {
    case "qrz":
      return Boolean(await getSetting("qrz.logbookApiKey"));
    case "cloudlog":
      return (
        Boolean(await getSetting("cloudlog.url")) && Boolean(await getSetting("cloudlog.apiKey"))
      );
    case "eqsl":
      return (
        Boolean(await getSetting("eqsl.username")) && Boolean(await getSetting("eqsl.password"))
      );
    case "lotw":
      // A certificate, not a credential. The LoTW username and password are for
      // downloading confirmations and cannot upload anything.
      return (await lotwCertInfo()) !== null;
    case "clublog":
      return Boolean(await getSetting("clublog.email"));
    case "n3fjp":
      // A host is the whole configuration — the port has a documented default and the API
      // has no credential at all, which is why it must only ever be pointed at a machine
      // on the operator's own network.
      return Boolean(await getSetting("n3fjp.host"));
  }
}

/**
 * Where ONE contact stands with every service — the reprocess panel's whole content.
 *
 * Written because the log page could not answer the question an operator actually asks of
 * a contact: "did this go anywhere?" The flags are on the row and were never rendered, so
 * a QSO that reached nothing looked exactly like one that reached everything.
 *
 * Returns null when there is no such contact.
 */
export async function qsoDestinations(qsoId: string): Promise<QsoDestination[] | null> {
  const q = await prisma.qso.findUnique({
    where: { id: qsoId },
    select: {
      qrzSent: true,
      clublogSent: true,
      cloudlogSent: true,
      eqslSent: true,
      lotwSent: true,
      lotwSentAt: true,
      n3fjpSent: true,
    },
  });
  if (!q) return null;

  const prefs = await getUploadPrefs();
  const out: QsoDestination[] = [];
  for (const service of UPLOADABLE) {
    out.push({
      service,
      label: SERVICE_LABEL[service],
      sent: q[SENT_FIELD[service]],
      // LoTW is the only one that records WHEN, because its acceptance is a queue
      // acknowledgement that has to be checkable later. See markUploaded.
      sentAt: service === "lotw" ? (q.lotwSentAt?.toISOString() ?? null) : null,
      configured: await isConfigured(service),
      enabled: prefs[service],
    });
  }
  return out;
}

export interface QsoDestination {
  service: UploadableService;
  label: string;
  /** The flag on the contact — what we BELIEVE, which is the thing being doubted. */
  sent: boolean;
  /** LoTW only; null everywhere else. */
  sentAt: string | null;
  /** Enough settings to attempt an upload at all. */
  configured: boolean;
  /** Switched on for automatic sweeps. A reprocess does not require it. */
  enabled: boolean;
}

export interface PendingCounts {
  service: UploadableService;
  /** Awaiting upload and newer than the cutoff — what automatic mode will send. */
  pending: number;
  /** Everything unsent, cutoff ignored — the back catalogue. */
  backlog: number;
  configured: boolean;
}

/** What is waiting, for the UI to show before anything is sent. */
export async function uploadCounts(): Promise<PendingCounts[]> {
  const prefs = await getUploadPrefs();
  const out: PendingCounts[] = [];
  for (const service of UPLOADABLE) {
    const field = SENT_FIELD[service];
    const backlog = await prisma.qso.count({ where: { [field]: false } });
    const pending = prefs.since
      ? await prisma.qso.count({ where: { [field]: false, startTime: { gte: prefs.since } } })
      : backlog;
    out.push({ service, pending, backlog, configured: await isConfigured(service) });
  }
  return out;
}

/**
 * Treat everything up to now as already uploaded, without sending any of it.
 *
 * The honest way to adopt this feature on a log that predates it. An operator whose
 * 26,000 contacts are already on QRZ from a previous program wants the flags to say
 * so, not 26,000 API calls that each come back "duplicate".
 */
export async function baselineAsUploaded(
  service: UploadableService,
  before: Date,
): Promise<number> {
  const { count } = await prisma.qso.updateMany({
    where: { [SENT_FIELD[service]]: false, startTime: { lt: before } },
    data: { [SENT_FIELD[service]]: true },
  });
  return count;
}
