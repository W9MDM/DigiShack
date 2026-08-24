import { parseAdif } from "@/lib/adif/parse";
import { prisma } from "@/lib/db/prisma";
import { fetchLotwQsls, getLotwCredentials } from "@/lib/integrations/lotw";

// Check that LoTW actually kept what we sent it.
//
// WHY THIS IS NECESSARY. An accepted upload answers
//
//     File k9xyz-2026-08-23-13-57-11-digishack.tq8 queued for processing.
//
// QUEUED. The file passed initial validation and was taken; the records are processed
// afterwards and the outcome arrives by email. So marking a batch sent on acceptance is
// OPTIMISTIC, and if LoTW refuses records during processing the flags here say sent, nothing
// retries them, and the contacts are lost from the operator's LoTW log silently — the worst
// failure shape there is, because everything looks fine.
//
// The fix is to ask LoTW what it holds rather than to trust the acknowledgement.
// `lotwreport.adi` with `qso_qsl=no&qso_qsorxsince=<date>` returns our OWN uploaded contacts,
// which is the only authoritative answer. This is the check that was run by hand to confirm
// the first 26 uploads; doing it automatically is the point.
//
// It only ever CLEARS a flag. Nothing here marks a contact as sent — a contact absent from
// our query result gets another attempt on the next sweep, and LoTW discards duplicates, so
// the cost of being wrong in that direction is one redundant upload. Being wrong the other
// way loses the contact.

export interface LotwReconcileResult {
  ok: boolean;
  error?: string;
  /** Records LoTW says it holds, in the window asked about. */
  remote: number;
  /** Contacts marked sent locally, in the same window. */
  local: number;
  /** Marked sent here and NOT present at LoTW. */
  missing: number;
  /** Flags actually cleared. Zero when `dryRun`. */
  cleared: number;
  /** A few of the missing, for the log. */
  samples: string[];
}

/**
 * The key both sides are compared on.
 *
 * Callsign, band and the UTC day. NOT the minute: LoTW stores what it was sent, but the ADIF
 * it hands back has been through its own normalisation, and a comparison that fails on a
 * one-minute difference would report healthy uploads as missing and un-mark them — turning a
 * safety net into a machine for re-uploading the whole log.
 *
 * Mode is deliberately absent for the same reason. LoTW maps submodes onto its own list, so a
 * contact sent as FT4 can come back described differently, and the day-plus-callsign-plus-band
 * triple is already specific enough that a collision would be two contacts with the same
 * station on the same band on the same day — which the duplicate rules make uninteresting.
 */
function key(callsign: string, band: string, when: Date): string {
  return `${callsign.trim().toUpperCase()}|${band.trim().toUpperCase()}|${when
    .toISOString()
    .slice(0, 10)}`;
}

/** Build the key set LoTW reports for our own uploads since a date. */
export function keysFromAdif(adif: string): Set<string> {
  const { qsos } = parseAdif(adif);
  const out = new Set<string>();
  for (const q of qsos) {
    if (!q.callsign || !q.band || !q.startTime) continue;
    out.add(key(q.callsign, q.band, q.startTime));
  }
  return out;
}

/**
 * Compare what we think we sent against what LoTW holds, and clear the flags that are wrong.
 *
 * `since` bounds the LoTW query by RECEIPT date, so it asks "of what you took from me since
 * then, what is there". The local side is bounded the same way — by `lotwSentAt` — because
 * comparing every contact ever marked sent against a recent window would report the entire
 * back catalogue as missing.
 */
export async function reconcileLotwSent(
  opts: { since: Date; dryRun?: boolean } = { since: new Date(Date.now() - 7 * 86_400_000) },
): Promise<LotwReconcileResult> {
  const base: LotwReconcileResult = {
    ok: false,
    remote: 0,
    local: 0,
    missing: 0,
    cleared: 0,
    samples: [],
  };

  const creds = await getLotwCredentials();
  if (!creds) return { ...base, error: "LoTW username and password are not configured" };

  const day = opts.since.toISOString().slice(0, 10);
  const res = await fetchLotwQsls(creds, {
    // Our own log, not the confirmations.
    qsl: "no",
    rxSince: day,
    ownCall: creds.username.toUpperCase(),
  });
  if (!res.ok || !res.adif) {
    return { ...base, error: res.error ?? "LoTW returned no data" };
  }

  const remote = keysFromAdif(res.adif);

  // Only contacts whose upload we can DATE. A contact marked sent before this column
  // existed has no upload time, so it cannot be placed inside or outside the window — and
  // treating an unknown date as "in the window" would report the whole back catalogue as
  // missing and un-mark it. Those are left alone; a full reconciliation of pre-existing
  // flags is a different job with a different blast radius.
  const local = await prisma.qso.findMany({
    where: { lotwSent: true, lotwSentAt: { gte: opts.since } },
    select: { id: true, callsign: true, band: true, startTime: true },
  });

  const missing = local.filter((q) => !remote.has(key(q.callsign, q.band, q.startTime)));

  const result: LotwReconcileResult = {
    ok: true,
    remote: remote.size,
    local: local.length,
    missing: missing.length,
    cleared: 0,
    samples: missing
      .slice(0, 5)
      .map((q) => `${q.callsign} ${q.band} ${q.startTime.toISOString().slice(0, 10)}`),
  };

  if (opts.dryRun || missing.length === 0) return result;

  // CLEARED, never set. `lotwSentAt` goes too, so the next reconciliation does not keep
  // finding the same contact inside its window after it has been queued again.
  const r = await prisma.qso.updateMany({
    where: { id: { in: missing.map((q) => q.id) } },
    data: { lotwSent: false, lotwSentAt: null },
  });
  result.cleared = r.count;
  return result;
}
