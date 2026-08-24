// Attaching reception reports to the contacts they belong to.
//
// A reception report says "at 14:03:15 on 14.074 MHz, K1ABC heard K9XYZ". Making that
// useful means deciding which of our contacts it belongs to, and the honest answer is
// often "none of them" — see MATCHING below.

import { prisma } from "@/lib/db/prisma";
import { freqToBand } from "@/lib/ham/bands";
import { getSetting } from "@/lib/settings";
import {
  DEFAULT_LOOKBACK_SECONDS,
  fetchReceptionReports,
  MIN_QUERY_INTERVAL_MS,
  type ReceptionReport,
} from "@/lib/pskreporter/retrieve";

/**
 * How far either side of a contact a report may fall and still belong to it.
 *
 * A minute. Wide enough to take in the CQ that led into the contact — a report of that CQ
 * genuinely belongs with the exchange it started — and narrow enough that a CQ from
 * twenty minutes earlier does not get attached to whatever contact happened later.
 */
export const MATCH_MARGIN_MS = 60_000;

export interface CollectResult {
  ran: boolean;
  /** Why not, when it did not run. */
  skipped?: string;
  fetched: number;
  /** Reports attached to a contact. */
  attached: number;
  /** Already stored — PSKReporter windows overlap between polls by design. */
  duplicates: number;
  /**
   * Reports stored with no contact attached.
   *
   * Usually the majority, and not an error: most reports of an FT8 station are of its
   * CQs, and a CQ nobody answered produced no contact for the report to belong to.
   *
   * These used to be counted and thrown away, because `PskSpot.qsoId` was required —
   * 193 of 368 on the first real query, which is most of the evidence about who can hear
   * this station discarded for want of somewhere to put it. A CQ heard in Slovenia says
   * as much about the antenna as one that turned into a contact.
   */
  unattached: number;
  /** Reports naming a sender that is not us, which should never happen. */
  foreign: number;
}

function empty(): CollectResult {
  return { ran: false, fetched: 0, attached: 0, duplicates: 0, unattached: 0, foreign: 0 };
}

/** Where the last query went out, so a restart cannot reset the rate limit. */
const KEY_LAST_QUERY = "pskreporter.lastQueryAt";

async function lastQueryAt(): Promise<number> {
  const row = await prisma.setting.findUnique({ where: { key: KEY_LAST_QUERY } });
  const n = Number.parseInt(row?.value ?? "", 10);
  return Number.isFinite(n) ? n : 0;
}

async function noteQuery(at: number): Promise<void> {
  await prisma.setting.upsert({
    where: { key: KEY_LAST_QUERY },
    create: { key: KEY_LAST_QUERY, value: String(at), encrypted: false },
    update: { value: String(at) },
  });
}

/**
 * MATCHING — which contact a report belongs to.
 *
 * By band and time. The report carries the frequency of the transmission heard, which
 * gives the band, and the time it went out, which has to fall within a contact's span
 * plus MATCH_MARGIN_MS.
 *
 * Not by callsign, because a reception report does not name the station we were working —
 * the receiver heard our transmission, not the conversation. That is also why a report of
 * a CQ can only ever be attributed by time.
 *
 * The closest contact wins when more than one is in range. In practice there is never
 * more than one: this station has a single transmitter and cannot hold two contacts at
 * once. The tie-break exists so that two contacts a minute apart cannot both claim a
 * report, which would double-count the same reception.
 */
export function pickQso<T extends { id: string; band: string; startTime: Date; endTime: Date | null }>(
  report: ReceptionReport,
  qsos: T[],
): T | null {
  const band = freqToBand(report.freqHz);
  if (!band) return null;
  const at = report.reportedAt.getTime();

  let best: T | null = null;
  let bestGap = Infinity;

  for (const q of qsos) {
    if (q.band.toUpperCase() !== band.toUpperCase()) continue;
    const from = q.startTime.getTime() - MATCH_MARGIN_MS;
    const to = (q.endTime ?? q.startTime).getTime() + MATCH_MARGIN_MS;
    if (at < from || at > to) continue;

    // Distance from the contact itself, not from its padded window, so a report inside
    // the exchange always beats one that only reached the margin.
    const gap =
      at < q.startTime.getTime()
        ? q.startTime.getTime() - at
        : at > (q.endTime ?? q.startTime).getTime()
          ? at - (q.endTime ?? q.startTime).getTime()
          : 0;
    if (gap < bestGap) {
      best = q;
      bestGap = gap;
    }
  }

  return best;
}

/**
 * Ask PSKReporter who heard us, and store what can be attached to a contact.
 *
 * Rate limited against a persisted timestamp rather than an in-memory one, so restarting
 * the bridge — which happened 162 times on this install in a day of Icom work — cannot
 * turn a five-minute limit into a query per restart.
 */
export async function collectReceptionReports(opts?: {
  lookbackSeconds?: number;
  /** Ignore the rate limit. For a manual, operator-initiated lookup only. */
  force?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<CollectResult> {
  const result = empty();

  // The oldest station, which is how every other caller in the radio path picks one.
  // A query needs a callsign to ask about and there is nothing sensible to guess.
  const station = await prisma.station.findFirst({
    orderBy: { createdAt: "asc" },
    select: { callsign: true },
  });
  const callsign = station?.callsign?.toUpperCase() ?? null;
  if (!callsign) {
    result.skipped = "no station callsign is set";
    return result;
  }

  const now = Date.now();
  const since = now - (await lastQueryAt());
  if (!opts?.force && since < MIN_QUERY_INTERVAL_MS) {
    result.skipped = `${Math.ceil((MIN_QUERY_INTERVAL_MS - since) / 1_000)}s until the next query is allowed`;
    return result;
  }

  // Look back far enough to cover the gap since the last successful query, because a
  // report that arrived while we were not asking is not resent. Bounded by the fetch
  // itself; a first run or a long outage takes the maximum rather than the whole day.
  const lookback =
    opts?.lookbackSeconds ??
    Math.max(DEFAULT_LOOKBACK_SECONDS, Math.ceil(since / 1_000) + 120);

  // Recorded BEFORE the request, not after. A query that times out has still been made
  // as far as PSKReporter is concerned, and retrying it immediately is exactly the
  // behaviour the limit exists to stop.
  await noteQuery(now);

  const fetched = await fetchReceptionReports({
    senderCallsign: callsign,
    lookbackSeconds: lookback,
    contact: await getSetting("pskreporter.contact"),
    fetchImpl: opts?.fetchImpl,
  });

  result.ran = true;
  if (!fetched.ok) {
    result.skipped = fetched.error ?? "the query failed";
    return result;
  }

  result.fetched = fetched.reports.length;
  if (fetched.reports.length === 0) return result;

  // One query for the contacts any of these reports could belong to, rather than one per
  // report. The oldest report bounds it.
  const oldest = fetched.reports.reduce(
    (min, r) => Math.min(min, r.reportedAt.getTime()),
    Number.POSITIVE_INFINITY,
  );
  const qsos = await prisma.qso.findMany({
    where: {
      startTime: { gte: new Date(oldest - MATCH_MARGIN_MS - 6 * 3_600_000) },
    },
    select: { id: true, band: true, startTime: true, endTime: true },
    orderBy: { startTime: "desc" },
    take: 500,
  });

  const rows: {
    qsoId: string | null;
    receiverCall: string;
    receiverGrid: string | null;
    snr: number | null;
    freqHz: bigint;
    reportedAt: Date;
  }[] = [];

  for (const r of fetched.reports) {
    // We queried by our own callsign, so anything else is PSKReporter answering a
    // question we did not ask. Storing it would put someone else's reception in our log.
    if (r.senderCall && r.senderCall !== callsign.toUpperCase()) {
      result.foreign++;
      continue;
    }
    // Stored either way. A report that belongs to no contact is still a receiver that
    // heard this station, which is the question the coverage view answers.
    const qso = pickQso(r, qsos);
    if (!qso) result.unattached++;
    rows.push({
      qsoId: qso?.id ?? null,
      receiverCall: r.receiverCall,
      receiverGrid: r.receiverGrid,
      snr: r.snr,
      freqHz: BigInt(r.freqHz),
      reportedAt: r.reportedAt,
    });
  }

  if (rows.length === 0) return result;

  // skipDuplicates against psk_spot_dedupe — who heard us, when, on what frequency.
  // Polling windows overlap deliberately, so a report seen twice is the design working
  // rather than a fault, and must not be stored twice.
  //
  // The key deliberately does NOT include the contact. It used to, and with a nullable
  // column MySQL would have treated every unattached row as distinct from every other —
  // dropping the duplicate protection on exactly the rows that now dominate the table.
  const written = await prisma.pskSpot.createMany({ data: rows, skipDuplicates: true });
  result.duplicates = rows.length - written.count;
  // `attached` counts what the query attributed to a contact, not what was inserted:
  // a duplicate is a report already stored, and re-reporting it as newly attached would
  // make an idle sweep look like a productive one.
  result.attached = rows.length - result.unattached;
  return result;
}
