// Opting out of QSL email.
//
// Two ways in, because operators use whichever they know about:
//
//   1. THE LINK in every message we send. One click, no login, no reply needed.
//   2. THE QRZ MARKER — `NOQSOCC` or `NOEQSL` in the QSL-route field, which is the
//      convention n1et's opt-out page documents and which several logging programs already
//      honour. Someone who has set it has opted out of this whole class of mail globally,
//      and would otherwise get a first email from us before they could tell us not to.
//
// The link exists because the convention is not enough on its own. K2XYZ replied to a QSL
// email with the single word "Unsubscribe" — he did not know about the QRZ field, and had
// nothing to click, so he used the only mechanism available to him and hoped a human read
// it. Expecting a stranger to edit their QRZ profile to stop OUR mail is asking them to do
// our work.

import { createHmac, timingSafeEqual } from "node:crypto";

import { prisma } from "@/lib/db/prisma";

export type QslOptOutSource = "MANUAL" | "LINK" | "QRZ_MARKER";

/** Upper-cased, trimmed. One operator, one row. */
export function normaliseCall(call: string): string {
  return call.trim().toUpperCase();
}

/**
 * The community opt-out markers, as documented on n1et.com/optout.
 *
 * Matched as substrings of the QRZ QSL-route field, case-insensitively, because that field
 * is free text and people write "NOQSOCC" alongside a bureau or a manager. Both spellings
 * are honoured: the page offers either, and an operator who typed the eQSL one plainly did
 * not mean "but electronic cards from other software are fine".
 */
const QRZ_MARKERS = ["NOQSOCC", "NOEQSL"] as const;

export function qrzMarkerIn(qslVia: string | null | undefined): string | null {
  if (!qslVia) return null;
  const hay = qslVia.toUpperCase();
  return QRZ_MARKERS.find((m) => hay.includes(m)) ?? null;
}

/** Already opted out? */
export async function hasOptedOut(call: string): Promise<boolean> {
  const row = await prisma.qslOptOut.findUnique({
    where: { callsign: normaliseCall(call) },
    select: { id: true },
  });
  return row !== null;
}

/** Record an opt-out. Idempotent: a second request must not fail or duplicate. */
export async function optOut(
  call: string,
  source: QslOptOutSource,
  note: string | null,
): Promise<void> {
  const callsign = normaliseCall(call);
  if (!callsign) throw new Error("A callsign is required");
  await prisma.qslOptOut.upsert({
    where: { callsign },
    // Never downgrade an existing record's story. A later QRZ-marker sighting should not
    // overwrite the note somebody wrote when the operator actually asked in words.
    update: {},
    create: { callsign, source, note },
  });

  // CANCEL ANYTHING ALREADY QUEUED FOR THEM.
  //
  // Recording the request is not the same as honouring it. `enqueueQsl` checks the list
  // before queueing, but a message queued BEFORE they asked is already past that gate and
  // would go out on the next send run — so the click that was meant to stop the email
  // would be followed by one more. The whole point of a one-click link is that one click
  // is enough.
  //
  // SKIPPED rather than deleted, because the queue is the record of what went to whom and
  // why; a row that vanishes cannot answer that later. Only live entries are touched —
  // anything already SENT is history and stays as it is.
  const cancelled = await prisma.qslEmail.updateMany({
    where: { callsign, status: { in: ["PENDING", "APPROVED"] } },
    data: { status: "SKIPPED" },
  });
  if (cancelled.count > 0) {
    console.log(
      `[qsl] ${callsign} opted out — cancelled ${cancelled.count} queued message(s)`,
    );
  }
}

export async function optIn(call: string): Promise<boolean> {
  const r = await prisma.qslOptOut.deleteMany({
    where: { callsign: normaliseCall(call) },
  });
  return r.count > 0;
}

export async function listOptOuts(): Promise<
  { callsign: string; source: QslOptOutSource; note: string | null; createdAt: Date }[]
> {
  const rows = await prisma.qslOptOut.findMany({
    orderBy: { callsign: "asc" },
    select: { callsign: true, source: true, note: true, createdAt: true },
  });
  return rows.map((r) => ({ ...r, source: r.source as QslOptOutSource }));
}

/**
 * The unsubscribe token.
 *
 * An HMAC of the callsign under `SETTINGS_KEY`, which every install already has and which
 * never leaves the server. Deliberately NOT a random token in a table: a stored token is
 * one more thing to expire, clean up and fail to find, and this needs to work from a link
 * in an email somebody kept for a year.
 *
 * It carries no expiry for the same reason. A request not to be emailed does not go stale,
 * and an expired unsubscribe link is a worse failure than a permanent one — it turns a
 * one-click courtesy back into "reply and hope", which is the situation being fixed.
 *
 * Not a secret worth attacking: the only thing it authorises is REMOVING an address from
 * our mail. The failure mode of a forged token is that somebody stops receiving cards they
 * never asked for, which is why there is no rate limit and no login on the endpoint.
 */
function secret(): string {
  const k = process.env.SETTINGS_KEY;
  if (!k) throw new Error("SETTINGS_KEY is not set, so unsubscribe links cannot be signed");
  return k;
}

export function unsubscribeToken(call: string): string {
  return createHmac("sha256", secret())
    .update(`qsl-unsub:${normaliseCall(call)}`)
    .digest("base64url")
    .slice(0, 32);
}

export function tokenValid(call: string, token: string): boolean {
  try {
    const want = Buffer.from(unsubscribeToken(call));
    const got = Buffer.from(token ?? "");
    return want.length === got.length && timingSafeEqual(want, got);
  } catch {
    return false;
  }
}

/** The link that goes in an email. `base` is the public URL of this instance. */
export function unsubscribeUrl(base: string, call: string): string {
  const c = normaliseCall(call);
  const root = base.replace(/\/+$/, "");
  return `${root}/api/qsl/unsubscribe?call=${encodeURIComponent(c)}&t=${unsubscribeToken(c)}`;
}
