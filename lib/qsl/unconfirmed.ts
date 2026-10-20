// A QSL send whose outcome was never recorded.
//
// No imports on purpose: the QSL page imports this to mark such rows, and anything that pulls
// in Prisma or nodemailer cannot be bundled for the browser (scripts/check-client-bundle.ts).
// lib/qsl/queue.ts re-exports the same names, so the server side reads them from there.

/**
 * What `error` holds while a sender owns a row: `sending since <ISO time> [claim <uuid>]`.
 *
 * The claim is also the compare-and-set token for every later write that sender makes to the
 * row. A SENT row whose `error` still starts with this is a send whose outcome was never
 * recorded — see "AT MOST ONCE" on sendApprovedQsls in lib/qsl/queue.ts.
 */
export const UNCONFIRMED_SEND_PREFIX = "sending since ";

/**
 * How long a claim may stand before it reads as a sender that died rather than one still busy.
 *
 * The transport sets no timeouts of its own, so nodemailer's defaults apply: two minutes to
 * connect, thirty seconds for the greeting, ten minutes of socket inactivity — plus rendering
 * the card. Fifteen minutes is past the worst of those, so a row older than this is not
 * somebody's send still in progress, and offering Resend on it cannot race a live sender.
 */
export const SEND_STALE_AFTER_MS = 15 * 60_000;

/** Claimed by a sender that has not (yet) recorded what happened. Delivery unknown. */
export function isUnconfirmedSend(row: { status: string; error: string | null }): boolean {
  return row.status === "SENT" && (row.error ?? "").startsWith(UNCONFIRMED_SEND_PREFIX);
}

/** When the claim was taken, read back out of the claim text. Null when it is not a claim. */
export function claimStartedAt(error: string | null): Date | null {
  if (!error?.startsWith(UNCONFIRMED_SEND_PREFIX)) return null;
  const rest = error.slice(UNCONFIRMED_SEND_PREFIX.length);
  const end = rest.indexOf(" ");
  const when = new Date(end === -1 ? rest : rest.slice(0, end));
  return Number.isNaN(when.getTime()) ? null : when;
}

/**
 * `in-flight` while a sender may still be working on it, `interrupted` once it cannot be, and
 * null for a row whose outcome is recorded. A claim whose time cannot be read falls back to
 * `sentAt` (set in the same write as the claim) and, failing that, counts as interrupted:
 * an unknown age is not evidence that anybody is still sending it.
 */
export function unconfirmedSendState(
  row: { status: string; error: string | null; sentAt?: Date | string | null },
  now: number = Date.now(),
): "in-flight" | "interrupted" | null {
  if (!isUnconfirmedSend(row)) return null;
  const started = claimStartedAt(row.error) ?? (row.sentAt ? new Date(row.sentAt) : null);
  if (!started || Number.isNaN(started.getTime())) return "interrupted";
  return now - started.getTime() < SEND_STALE_AFTER_MS ? "in-flight" : "interrupted";
}
