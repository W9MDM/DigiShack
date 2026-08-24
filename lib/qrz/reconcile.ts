import type { IncomingRequest } from "@/lib/qrz/incoming-paste";

// Reconciling pasted QRZ card requests against the log and the incomplete exchanges.
//
// Done by hand once across 134 requests, which is what established the categories below. Each
// one implies a different action, and collapsing them loses the distinction that matters:
//
//   in-log        nothing to do; if the request is still open, QRZ is not matching our upload
//   promotable    an incomplete exchange on that date — reports both ways, no acknowledgement.
//                 The request is the second record that makes it a contact.
//   wrong-date    we worked them, but not near the date claimed. Their date or our record is
//                 off and NOTHING here distinguishes which, so this is never actioned
//                 automatically.
//   unknown       no contact and no exchange. Either never worked, or outside what we hold.
//
// `wrong-date` is the category that must not be quietly folded into `promotable`. 37 of the
// operator's requests were stations already in the QRZ log on OTHER dates — an operator with
// nine contacts with us can easily cite the wrong one, and importing on that basis invents
// contacts.

export type Verdict = "in-log" | "promotable" | "wrong-date" | "unknown";

export interface ReconciledRequest {
  request: IncomingRequest;
  verdict: Verdict;
  /** The matching contact, when there is one. */
  qso?: { id: string; startTime: Date; band: string; mode: string; qrzSent: boolean };
  /** The incomplete exchange that could be promoted, when there is one. */
  incomplete?: {
    id: string;
    startedAt: Date;
    band: string;
    mode: string;
    reportSent: string | null;
    reportRcvd: string | null;
  };
  /** For `wrong-date`: when we DID work them, so the operator can see the discrepancy. */
  workedAt?: Date;
  /** One line explaining the verdict, shown on the row. */
  note: string;
}

/** A day either side. A contact near UTC midnight is routinely filed on the adjacent date. */
export const MATCH_WINDOW_MS = 36 * 3_600_000;

/** What the reconciler needs to look things up. Injected, so it is testable without a database. */
export interface ReconcileLookups {
  qsosFor(callsign: string): Promise<
    { id: string; startTime: Date; band: string; mode: string; qrzSent: boolean }[]
  >;
  incompleteFor(callsign: string): Promise<
    {
      id: string;
      startedAt: Date;
      band: string;
      mode: string;
      reportSent: string | null;
      reportRcvd: string | null;
      promotedQsoId: string | null;
      dismissedAt: Date | null;
    }[]
  >;
}

function day(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getTime();
}

/** Nearest by absolute distance to the claimed date. */
function nearest<T>(items: T[], at: (x: T) => number, target: number): T | undefined {
  let best: T | undefined;
  let bestGap = Infinity;
  for (const x of items) {
    const gap = Math.abs(at(x) - target);
    if (gap < bestGap) {
      bestGap = gap;
      best = x;
    }
  }
  return best;
}

export async function reconcileRequests(
  requests: IncomingRequest[],
  look: ReconcileLookups,
): Promise<ReconciledRequest[]> {
  const out: ReconciledRequest[] = [];

  for (const request of requests) {
    const target = day(request.qsoDate);
    const qsos = await look.qsosFor(request.callsign);

    const onDate = qsos.filter((q) => Math.abs(q.startTime.getTime() - target) <= MATCH_WINDOW_MS);
    if (onDate.length > 0) {
      const q = nearest(onDate, (x) => x.startTime.getTime(), target)!;
      out.push({
        request,
        verdict: "in-log",
        qso: q,
        note: q.qrzSent
          ? "Already in the log and uploaded to QRZ. If the request is still open, QRZ is not matching it."
          : "In the log but not yet uploaded to QRZ — the next upload sweep should settle it.",
      });
      continue;
    }

    // No contact near that date. Is there an exchange that got as far as reports?
    const inc = (await look.incompleteFor(request.callsign)).filter(
      (x) =>
        x.promotedQsoId === null &&
        x.dismissedAt === null &&
        Math.abs(x.startedAt.getTime() - target) <= MATCH_WINDOW_MS,
    );
    if (inc.length > 0) {
      const x = nearest(inc, (i) => i.startedAt.getTime(), target)!;
      out.push({
        request,
        verdict: "promotable",
        incomplete: x,
        note:
          `Reports exchanged both ways (${x.reportSent ?? "?"} sent, ${x.reportRcvd ?? "?"} received) ` +
          "and no acknowledgement decoded. Their request is the second record.",
      });
      continue;
    }

    // We have worked them, just not around the claimed date. NOT actionable: their date or our
    // record is wrong and nothing here says which.
    if (qsos.length > 0) {
      const q = nearest(qsos, (x) => x.startTime.getTime(), target)!;
      const days = Math.round((q.startTime.getTime() - target) / 86_400_000);
      out.push({
        request,
        verdict: "wrong-date",
        workedAt: q.startTime,
        note:
          `Worked ${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} ` +
          `${days < 0 ? "earlier" : "later"}, on ${q.startTime.toISOString().slice(0, 10)}. ` +
          "Their date or ours is wrong and nothing here says which.",
      });
      continue;
    }

    out.push({
      request,
      verdict: "unknown",
      note: "No contact and no exchange with this station on record.",
    });
  }

  return out;
}

/** Counts per verdict, for the summary line above the table. */
export function tally(rows: ReconciledRequest[]): Record<Verdict, number> {
  const t: Record<Verdict, number> = {
    "in-log": 0,
    promotable: 0,
    "wrong-date": 0,
    unknown: 0,
  };
  for (const r of rows) t[r.verdict]++;
  return t;
}
