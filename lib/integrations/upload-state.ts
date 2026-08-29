// Per-QSO upload state for the log-hosting services.
//
// LoTW and eQSL confirm QSOs, so they get a Sent and an Rcvd flag. QRZ, Club Log
// and HRDLOG only accept them — there is nothing to receive back — so they have a
// Sent flag alone.
//
// Before these columns existed, "what have I not uploaded yet?" could only be
// answered by downloading the whole remote log and diffing it. That works, and it
// is how 3,174 Club Log duplicates were found, but it moves megabytes to discover
// a handful of missing contacts and cannot answer the question offline at all.
// Worse, nothing recorded that a batch HAD been uploaded, so a second run would
// cheerfully send everything again.

import { prisma } from "@/lib/db/prisma";

/** Services that accept uploads and never confirm. */
export type UploadService =
  | "qrz"
  | "clublog"
  | "cloudlog"
  | "hrdlog"
  | "eqsl"
  | "lotw"
  | "n3fjp";

const SENT_FIELD = {
  qrz: "qrzSent",
  clublog: "clublogSent",
  cloudlog: "cloudlogSent",
  hrdlog: "hrdlogSent",
  n3fjp: "n3fjpSent",
  eqsl: "eqslSent",
  lotw: "lotwSent",
} as const satisfies Record<UploadService, string>;

/** Human label, for reports. */
export const SERVICE_LABEL: Record<UploadService, string> = {
  qrz: "QRZ Logbook",
  clublog: "Club Log",
  cloudlog: "Cloudlog / Wavelog",
  hrdlog: "HRDLOG",
  n3fjp: "N3FJP Amateur Contact Log",
  eqsl: "eQSL",
  lotw: "LoTW",
};

/** Chunked so a large batch does not build one enormous statement. */
const CHUNK = 500;

/**
 * Mark QSOs as uploaded to a service.
 *
 * Call this only after the service has ACCEPTED them. Marking optimistically —
 * before the reply, or on a partial failure — creates the one state that cannot
 * be recovered without a full remote download: a QSO believed uploaded that is
 * not there. The reverse (unmarked but present) is merely a duplicate the service
 * will reject.
 */
export async function markUploaded(
  service: UploadService,
  qsoIds: string[],
): Promise<number> {
  if (qsoIds.length === 0) return 0;
  const field = SENT_FIELD[service];
  let n = 0;
  for (let i = 0; i < qsoIds.length; i += CHUNK) {
    const r = await prisma.qso.updateMany({
      where: { id: { in: qsoIds.slice(i, i + CHUNK) } },
      // LoTW also records WHEN. Its acceptance is only a queue acknowledgement, so the flag
      // has to be checkable later against what LoTW actually holds, and that query is bounded
      // by receipt date — see lib/integrations/lotw-reconcile.ts. The other services answer
      // per contact and definitively, so they need no timestamp.
      data: service === "lotw" ? { [field]: true, lotwSentAt: new Date() } : { [field]: true },
    });
    n += r.count;
  }
  return n;
}

export interface PendingSummary {
  service: UploadService;
  total: number;
  sent: number;
  pending: number;
}

/** How much is left to upload, per service. */
export async function uploadSummary(): Promise<PendingSummary[]> {
  const total = await prisma.qso.count();
  const out: PendingSummary[] = [];
  for (const service of Object.keys(SENT_FIELD) as UploadService[]) {
    const sent = await prisma.qso.count({ where: { [SENT_FIELD[service]]: true } });
    out.push({ service, total, sent, pending: total - sent });
  }
  return out;
}

/** The next batch awaiting upload, oldest first so a partial run is contiguous. */
export async function pendingForUpload(
  service: UploadService,
  limit = 500,
): Promise<{ id: string; callsign: string; band: string; mode: string; startTime: Date }[]> {
  return prisma.qso.findMany({
    where: { [SENT_FIELD[service]]: false },
    select: { id: true, callsign: true, band: true, mode: true, startTime: true },
    orderBy: { startTime: "asc" },
    take: limit,
  });
}

// ---------------------------------------------------------------------------
// Matching a remote log against the local one
// ---------------------------------------------------------------------------

/**
 * Tolerance when matching a remote QSO to a local one.
 *
 * ±30 minutes, NOT minute-exact. A remote record carries whatever time the other
 * operator (or the service) logged, and clocks and habits differ. Matching
 * exactly against a real 2,391-row eQSL inbox rejected 52 % of it — including
 * contacts demonstrably present in the log — and moved to 81 % once widened.
 * ±30 minutes is the tolerance LoTW and the QSL bureaux use, so it is the
 * defensible number rather than a tuned one.
 */
export const MATCH_WINDOW_MS = 30 * 60_000;

export interface RemoteQso {
  callsign: string;
  band: string;
  mode: string;
  startTime: Date;
}

export interface MatchResult {
  /** Local QSO ids that a remote record matched. */
  matchedIds: string[];
  /** Remote records with no local counterpart. */
  unmatched: RemoteQso[];
}

/**
 * Match remote records to local QSOs on callsign + band within the time window.
 *
 * Extracted so eQSL, Club Log and QRZ reconciliation share one implementation.
 * Three copies of this would drift, and the ±30-minute window and the
 * claim-once rule are both non-obvious enough to be worth having in exactly one
 * place.
 *
 * Each local QSO can be claimed only once, so two remote records cannot collapse
 * onto a single contact — which would silently under-count and make the log look
 * more uploaded than it is.
 */
export async function matchRemoteToLocal(remote: RemoteQso[]): Promise<MatchResult> {
  const local = await prisma.qso.findMany({
    select: { id: true, callsign: true, band: true, mode: true, startTime: true },
  });
  return matchLists(remote, local);
}

/**
 * The matching itself, with no database.
 *
 * Split out so the tests exercise THIS rather than a copy of it. check-dxcc.ts
 * spent a long time asserting a rule its own local reimplementation followed
 * while the production resolver did something else; a windowed claim-once matcher
 * has more than enough edge cases to fall into the same trap.
 */
export function matchLists(
  remote: RemoteQso[],
  local: { id: string; callsign: string; band: string; mode: string; startTime: Date }[],
): MatchResult {
  const byCallBand = new Map<string, { id: string; mode: string; t: number }[]>();
  for (const q of local) {
    const k = `${q.callsign.toUpperCase()}|${q.band.toUpperCase()}`;
    const entry = { id: q.id, mode: q.mode.toUpperCase(), t: q.startTime.getTime() };
    const list = byCallBand.get(k);
    if (list) list.push(entry);
    else byCallBand.set(k, [entry]);
  }

  const claimed = new Set<string>();
  const matchedIds: string[] = [];
  const unmatched: RemoteQso[] = [];

  for (const r of remote) {
    const k = `${r.callsign.toUpperCase()}|${r.band.toUpperCase()}`;
    const want = r.startTime.getTime();
    let best: string | null = null;
    let bestScore = Infinity;

    for (const cand of byCallBand.get(k) ?? []) {
      if (claimed.has(cand.id)) continue;
      const dt = Math.abs(cand.t - want);
      if (dt > MATCH_WINDOW_MS) continue;
      // Nearest in time wins, same mode preferred. A mode mismatch is tolerated
      // but ranked worse: SSB/USB and MFSK/FT4 disagreements are routine in
      // third-party logs and are not a reason to reject a match.
      const score = dt + (cand.mode === r.mode.toUpperCase() ? 0 : MATCH_WINDOW_MS);
      if (score < bestScore) {
        bestScore = score;
        best = cand.id;
      }
    }

    if (best) {
      claimed.add(best);
      matchedIds.push(best);
    } else {
      unmatched.push(r);
    }
  }

  return { matchedIds, unmatched };
}

export interface ReconcileResult {
  service: UploadService;
  /** Records in the remote log. */
  remote: number;
  /** Local QSOs the remote log accounted for. */
  matched: number;
  /** Newly flagged (the rest were already marked). */
  newlyMarked: number;
  /** Remote records with no local QSO — usually never logged here. */
  unmatched: number;
  unmatchedSamples: string[];
  /** Local QSOs still not present remotely. */
  stillPending: number;
}

/**
 * Set a service's Sent flags from its remote log.
 *
 * This is how the flags get populated for QSOs uploaded before the columns
 * existed — including a batch of 32 sent to QRZ with nothing recording it. Run
 * once per service after a download; from then on `markUploaded` keeps it current
 * and no full download is needed.
 *
 * Never CLEARS a flag. A remote log can be incomplete, paginated, or filtered by
 * date, and clearing on absence would re-queue QSOs that are already there and
 * generate duplicates — the exact failure this module exists to prevent.
 */
export async function reconcileFromRemote(
  service: UploadService,
  remote: RemoteQso[],
  opts: { dryRun?: boolean } = {},
): Promise<ReconcileResult> {
  const { matchedIds, unmatched } = await matchRemoteToLocal(remote);
  const field = SENT_FIELD[service];

  // Which of the matches are not yet flagged.
  const toMark: string[] = [];
  for (let i = 0; i < matchedIds.length; i += CHUNK) {
    const slice = matchedIds.slice(i, i + CHUNK);
    const rows = await prisma.qso.findMany({
      where: { id: { in: slice }, [field]: false },
      select: { id: true },
    });
    toMark.push(...rows.map((r) => r.id));
  }

  if (!opts.dryRun) await markUploaded(service, toMark);

  const total = await prisma.qso.count();
  const sent = opts.dryRun
    ? (await prisma.qso.count({ where: { [field]: true } })) + toMark.length
    : await prisma.qso.count({ where: { [field]: true } });

  return {
    service,
    remote: remote.length,
    matched: matchedIds.length,
    newlyMarked: toMark.length,
    unmatched: unmatched.length,
    unmatchedSamples: unmatched
      .slice(0, 10)
      .map((u) => `${u.callsign} ${u.band} ${u.mode} ${u.startTime.toISOString().slice(0, 16)}`),
    stillPending: total - sent,
  };
}
