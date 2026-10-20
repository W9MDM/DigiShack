import { randomUUID } from "node:crypto";

import { prisma } from "@/lib/db/prisma";
import { hasOptedOut, optOut, qrzMarkerIn, unsubscribeUrl } from "@/lib/qsl/opt-out";
import { cardUrl } from "@/lib/qsl/card-link";
import { lookupCallsign } from "@/lib/qrz/lookup";
import { loadCardSettings, renderQslCard } from "@/lib/qsl/card";
import {
  buildQslEmail,
  renderQslEmail,
  sendQslEmail,
  type RenderedEmail,
} from "@/lib/qsl/email";
import { getBooleanSetting, getNumberSetting, getSetting } from "@/lib/settings";
import { detectGateway, isPlaceholderAddress, prepareForGateway } from "@/lib/qsl/gateways";

// The QSL email review queue.
//
// Bulk QSL is unsolicited mail to other operators, so nothing here sends on its
// own. Entries are queued PENDING with the message already rendered, a human
// approves them, and only then does a separate call send. Storing the rendered
// body at queue time means what was reviewed is provably what goes out —
// re-rendering at send time would let a template edit change an approved message.

export interface QueueCandidate {
  qsoId: string;
  callsign: string;
  band: string;
  mode: string;
  startTime: Date;
}

export interface EnqueueOutcome {
  qsoId: string;
  callsign: string;
  status:
    | "queued"
    | "no-address"
    | "already-queued"
    | "already-sent"
    | "opted-out"
    | "error";
  detail?: string;
}

/**
 * Find QSOs worth a QSL email.
 *
 * Deliberately conservative: only contacts not already confirmed or emailed, and
 * only those with no live queue entry. Ordered oldest-first so a backlog is
 * worked through in the order the contacts happened.
 */
export async function findQslCandidates(opts: {
  limit?: number;
  since?: Date;
  band?: string;
  mode?: string;
}): Promise<QueueCandidate[]> {
  const rows = await prisma.qso.findMany({
    where: {
      qslSent: { in: ["NONE", "REQUESTED"] },
      // Never email the same contact twice. The qslEmails clause below already
      // covers it via the queue, but the flag is the durable record and a queue row
      // could be pruned one day.
      emailQslSent: false,
      ...(opts.since ? { startTime: { gte: opts.since } } : {}),
      ...(opts.band ? { band: opts.band } : {}),
      ...(opts.mode ? { mode: opts.mode } : {}),
      // No live entry already waiting or sent for this QSO.
      qslEmails: { none: { status: { in: ["PENDING", "APPROVED", "SENT"] } } },
    },
    orderBy: { startTime: "asc" },
    take: Math.min(opts.limit ?? 25, 200),
    select: { id: true, callsign: true, band: true, mode: true, startTime: true },
  });
  return rows.map((r) => ({
    qsoId: r.id,
    callsign: r.callsign,
    band: r.band,
    mode: r.mode,
    startTime: r.startTime,
  }));
}

/**
 * Queue one QSO, resolving the address from QRZ.
 *
 * A missing email is an ordinary outcome — plenty of operators do not publish
 * one — so it is reported rather than thrown, and nothing is queued.
 */
export async function enqueueQsl(
  qsoId: string,
  opts: { note?: string | null; force?: boolean } = {},
): Promise<EnqueueOutcome> {
  const qso = await prisma.qso.findUnique({
    where: { id: qsoId },
    include: { station: true },
  });
  if (!qso) return { qsoId, callsign: "?", status: "error", detail: "No such QSO" };

  // `force` is the operator saying "send this one again" from the log. It skips the two
  // guards below and NOTHING ELSE — in particular it does not skip the opt-out checks. A
  // resend button that could mail somebody who asked not to be contacted would be worse
  // than no button, and the request came from wanting to re-send a card after changing the
  // artwork, not from wanting to override anybody's wishes.
  if (!opts.force) {
    if (qso.qslSent === "SENT" || qso.qslSent === "CONFIRMED") {
      return { qsoId, callsign: qso.callsign, status: "already-sent" };
    }

    const existing = await prisma.qslEmail.findUnique({ where: { qsoId } });
    if (existing && ["PENDING", "APPROVED", "SENT"].includes(existing.status)) {
      return { qsoId, callsign: qso.callsign, status: "already-queued" };
    }
  }

  // OUR OWN LIST FIRST, before spending a QRZ lookup on somebody we already know we must
  // not email. This is also the cheapest possible place for it — one indexed read.
  if (await hasOptedOut(qso.callsign)) {
    return {
      qsoId,
      callsign: qso.callsign,
      status: "opted-out",
      detail: `${qso.callsign} has asked not to receive QSL email`,
    };
  }

  const lookup = await lookupCallsign(qso.callsign);
  if (lookup.status !== "found" || !lookup.info.email) {
    return {
      qsoId,
      callsign: qso.callsign,
      status: lookup.status === "found" ? "no-address" : "no-address",
      detail:
        lookup.status === "found"
          ? "QRZ has no published email for this callsign"
          : lookup.status === "no-credentials"
            ? "QRZ credentials are not configured"
            : lookup.status === "not-found"
              ? "QRZ has no record for this callsign"
              : lookup.reason,
    };
  }

  // THE COMMUNITY MARKER, now that QRZ has answered.
  //
  // `NOQSOCC` or `NOEQSL` in the QSL-route field is the convention documented at
  // n1et.com/optout, and somebody who has set it opted out of this entire class of mail
  // before ever hearing of us. Recorded in our own list as we go, so the next contact with
  // them short-circuits above without another lookup — and so the reason survives if they
  // later tidy their QRZ page.
  const marker = qrzMarkerIn(lookup.info.qslVia);
  if (marker) {
    await optOut(qso.callsign, "QRZ_MARKER", `QRZ QSL route says ${marker}`);
    return {
      qsoId,
      callsign: qso.callsign,
      status: "opted-out",
      detail: `QRZ QSL route says ${marker} — opted out of QSL email`,
    };
  }

  // buildQslEmail, not renderQslEmail: the queue must store the card alongside
  // the text, because what a human approves is what gets sent. Rendering the card
  // at send time instead would let a template or artwork change slip into an
  // already-approved message.
  const base = (await getSetting("app.baseUrl")) ?? null;
  // NO PUBLIC URL, NO UNSOLICITED EMAIL.
  //
  // Without `app.baseUrl` there is no link to put in the message, and this refuses to queue
  // rather than sending one without a way out. That is a deliberate hard stop, not a
  // defensive nicety: sending unsolicited mail that offers no route out is the precise
  // fault that produced K2XYZ's one-word reply, and quietly reverting to it whenever a
  // setting happens to be blank would guarantee the same complaint again.
  //
  // Loud and fixable beats silent and wrong. The operator sees this in the queue with the
  // setting named in it, and one field turns everything back on.
  if (!base) {
    return {
      qsoId,
      callsign: qso.callsign,
      status: "error",
      detail:
        "app.baseUrl is not set, so no unsubscribe link can be generated — " +
        "refusing to send unsolicited email with no way out. Set it in Settings → General.",
    };
  }
  const rendered = await buildQslEmail(
    {
      callsign: qso.callsign,
      band: qso.band,
      mode: qso.mode,
      startTime: qso.startTime,
      freqHz: qso.freqHz === null ? null : Number(qso.freqHz),
      rstSent: qso.rstSent,
      rstRcvd: qso.rstRcvd,
      gridSquare: qso.gridSquare,
      txPowerW: qso.txPowerW,
    },
    {
      callsign: qso.station?.callsign ?? "",
      grid: qso.station?.grid ?? null,
      name: (await getSetting("qsl.operatorName")) ?? null,
      qth: (await getSetting("qsl.qth")) ?? null,
      // The station-wide fallback. The contact's own measured watts win over it
      // when the radio reported any — see the POWER token in lib/qsl/template.ts.
      txPower: (await getSetting("qsl.txPower")) ?? null,
    },
    {
      note: opts.note,
      // NO LOG LINK. `app.baseUrl` is set so an unsubscribe link can be built, and it
      // must not smuggle a second link into the message as a side effect: the setting was
      // blank for as long as this station has been running, so the pre-existing "Log:"
      // line had never appeared, and switching it on came as a surprise — "why the hell is
      // this in the qsl email... it should just be the unsubscribe!!!"
      //
      // A QSL is a confirmation of a contact. Anything else in it is advertising, and an
      // unsolicited email that advertises is the thing people unsubscribe from.
      logUrl: null,
      // Only when a public URL is configured. A link to a host the recipient cannot reach
      // is worse than none: it looks like a way out and is not one, and there would be no
      // way for them to discover that except by clicking.
      unsubscribeUrl: unsubscribeUrl(base, qso.callsign),
    },
  );

  // Gateway handling decided HERE, so what a human approves is what will be sent:
  // the real address rather than a `mycall@` placeholder, and a subject already
  // carrying the //WL2K key when the recipient is on Winlink.
  const prepared = prepareForGateway({
    address: lookup.info.email,
    subject: rendered.subject,
    callsign: qso.callsign,
  });

  // A placeholder we could not resolve is not an address. Queuing it would send a
  // guaranteed bounce and spend our sending reputation to do it.
  if (prepared.unresolved) {
    return {
      qsoId,
      callsign: qso.callsign,
      status: "no-address",
      detail:
        `QRZ lists "${lookup.info.email}", which is a placeholder for the operator's own ` +
        `callsign — and "${qso.callsign}" could not be reduced to one to substitute in.`,
    };
  }

  // Upsert: a SKIPPED or FAILED entry is replaced rather than duplicated, which
  // is why the table has one row per QSO.
  await prisma.qslEmail.upsert({
    where: { qsoId },
    create: {
      qsoId,
      toAddress: prepared.address,
      callsign: qso.callsign,
      subject: prepared.subject,
      bodyText: rendered.text,
      bodyHtml: rendered.html,
      status: "PENDING",
    },
    update: {
      toAddress: prepared.address,
      subject: prepared.subject,
      bodyText: rendered.text,
      bodyHtml: rendered.html,
      status: "PENDING",
      error: null,
      approvedById: null,
      approvedAt: null,
      sentAt: null,
    },
  });

  return { qsoId, callsign: qso.callsign, status: "queued" };
}

/** Approve entries for sending. Records who did it. */
/**
 * Approve entries for sending.
 *
 * `userId` is nullable so an AUTOMATIC approval can record that it had no human
 * approver. `approvedById` is a real foreign key; passing a placeholder id would
 * both violate it and put a false name in the audit trail for outbound mail.
 */
export async function approveQsl(ids: string[], userId: string | null): Promise<number> {
  const result = await prisma.qslEmail.updateMany({
    where: { id: { in: ids }, status: "PENDING" },
    data: { status: "APPROVED", approvedById: userId, approvedAt: new Date() },
  });
  return result.count;
}

/** Decline entries. Kept rather than deleted so they are not re-queued forever. */
export async function skipQsl(ids: string[]): Promise<number> {
  const result = await prisma.qslEmail.updateMany({
    where: { id: { in: ids }, status: { in: ["PENDING", "FAILED"] } },
    data: { status: "SKIPPED" },
  });
  return result.count;
}

export interface SendQueueResult {
  /** Messages this run tried to send — `sent + failed`. */
  attempted: number;
  sent: number;
  failed: number;
  /** Claimed, then not sent: the recipient had opted out by the time it was their turn. */
  skipped: number;
  /**
   * Approved when the batch was read, but no longer this run's to send when it got to them:
   * another sender claimed them first, or they were cancelled or re-queued in the meantime.
   */
  contended: number;
  failures: { id: string; callsign: string; reason: string }[];
}

/**
 * What `error` holds while a sender owns a row: `sending since <ISO time> [claim <uuid>]`.
 *
 * The claim is also the compare-and-set token for every later write that sender makes to the
 * row. A SENT row whose `error` still starts with this is a send whose outcome was never
 * recorded — see "AT MOST ONCE" on sendApprovedQsls.
 */
export const UNCONFIRMED_SEND_PREFIX = "sending since ";

/** Claimed by a sender that stopped before recording what happened. Delivery unknown. */
export function isUnconfirmedSend(row: { status: string; error: string | null }): boolean {
  return row.status === "SENT" && (row.error ?? "").startsWith(UNCONFIRMED_SEND_PREFIX);
}

/**
 * Take one approved row for sending. Compare-and-set: only a row that is STILL approved moves,
 * and only one caller can move it — `count` is 1 for exactly one of any number of racers,
 * whichever process they are in. Null when it is not ours to send.
 *
 * SENT is the claim state because it is the one status every other path already leaves alone:
 * the candidate search and a non-forced enqueue skip it, `skipQsl` and the opt-out cancel do
 * not touch it, and the daily cap counts it from `sentAt` — so a send in flight is charged
 * against the cap as it starts. A new SENDING status would say the same thing at the cost of
 * a migration and every one of those paths learning it.
 */
async function claimForSending(id: string, claim: string) {
  const won = await prisma.qslEmail.updateMany({
    where: { id, status: "APPROVED" },
    data: { status: "SENT", sentAt: new Date(), error: claim },
  });
  if (won.count !== 1) return null;
  // Send the row as it stands NOW, not as the batch read found it: a forced re-send re-renders
  // a row, and it can be approved again in between.
  const row = await prisma.qslEmail.findUnique({ where: { id } });
  return row && row.status === "SENT" && row.error === claim ? row : null;
}

/**
 * Move a claimed row to its outcome — only while it is still this sender's claim. Something
 * that replaced the row meanwhile (a forced re-send, a gateway re-queue, then perhaps an
 * opt-out) wins; in particular a SKIPPED row is never overwritten.
 */
async function settleClaim(
  id: string,
  claim: string,
  data: { status?: "SKIPPED" | "FAILED"; sentAt: Date | null; error: string | null },
): Promise<boolean> {
  const r = await prisma.qslEmail.updateMany({
    where: { id, status: "SENT", error: claim },
    data,
  });
  return r.count === 1;
}

/**
 * The card for one queue row, or undefined.
 *
 * RE-RENDERED here, not stored on the queue row.
 *
 * The stored body says "The QSL card is attached." and carries an
 * <img src="cid:..."> — but `preRendered` used to pass only subject/text/html,
 * so `attachments` resolved to undefined and the message went out claiming an
 * attachment that was not there. Invisible until cards were switched on.
 *
 * Re-rendering rather than adding a BLOB column is a deliberate trade: a
 * 200 kB JPEG per row would put gigabytes into the database for a log this
 * size, and the card is fully determined by the QSO plus settings. What a human
 * approves is the WORDING, which is still the stored copy. The cost is that
 * changing the artwork between approval and sending changes the card — far
 * better than an email that promises an attachment and has none.
 */
async function cardFor(qsoId: string): Promise<RenderedEmail["card"]> {
  const qsoRow = await prisma.qso.findUnique({
    where: { id: qsoId },
    select: {
      callsign: true, band: true, mode: true, startTime: true, freqHz: true,
      rstSent: true, rstRcvd: true, gridSquare: true, txPowerW: true,
      station: { select: { callsign: true, grid: true } },
    },
  });
  if (!qsoRow) return undefined;
  const cardCfg = await loadCardSettings();
  if (!cardCfg.enabled) return undefined;
  try {
    const rendered = await renderQslCard(
      {
        callsign: qsoRow.callsign,
        band: qsoRow.band,
        mode: qsoRow.mode,
        startTime: qsoRow.startTime,
        freqHz: qsoRow.freqHz === null ? null : Number(qsoRow.freqHz),
        rstSent: qsoRow.rstSent,
        rstRcvd: qsoRow.rstRcvd,
        gridSquare: qsoRow.gridSquare,
        txPowerW: qsoRow.txPowerW,
      },
      {
        callsign: qsoRow.station.callsign,
        grid: qsoRow.station.grid,
        name: await getSetting("qsl.operatorName"),
        qth: await getSetting("qsl.qth"),
        txPower: await getSetting("qsl.txPower"),
      },
      cardCfg,
    );
    return {
      jpeg: rendered.jpeg,
      filename: `QSL-${qsoRow.station.callsign.toUpperCase()}-${qsoRow.callsign.toUpperCase()}-${qsoRow.startTime.toISOString().slice(0, 10)}.jpg`,
      // Must match the cid in the STORED html, or the inline image breaks.
      cid: `qslcard-${qsoRow.startTime.getTime().toString(36)}@digishack`,
      disposition: (await getBooleanSetting("qsl.email.attachCard", true))
        ? "attachment"
        : "inline",
    };
  } catch {
    // A card that will not render must not block the QSL. The body still
    // reads correctly without it; only the image is missing.
    return undefined;
  }
}

/**
 * Send approved entries.
 *
 * Sends the STORED body, not a fresh render — that is the point of the queue.
 * Sequential with a small gap: a burst of identical-looking mail from one host is
 * how a server earns a spam reputation, and there is no hurry.
 *
 * EVERY ROW IS CLAIMED BEFORE IT IS SENT (R07 in the 1.185.2 review).
 *
 * Two things call this: the Send button (the web process) and the bridge's automatic run (a
 * different process). Each used to read the APPROVED rows, mail them, and only then mark them
 * SENT — so the two could read the same rows and mail the same stranger twice, and no flag in
 * either process could have seen the other. Worse, the batch was read once: an opt-out that
 * cancelled a row to SKIPPED after the read was neither noticed before SMTP nor respected after
 * it — the row was mailed and then overwritten SKIPPED → SENT. Now each row is claimed with a
 * compare-and-set in the database (`claimForSending`) immediately before its turn, the opt-out
 * list is asked again after the claim and right before SMTP, and every write after that is
 * conditioned on the claim still being this sender's.
 *
 * Why after the claim: `optOut()` records the callsign FIRST and cancels queued rows SECOND.
 * A row cancelled before a sender reaches it cannot be claimed; a row claimed first is past the
 * cancel, but its sender's check sees the recorded opt-out unless that check ran before the
 * request arrived at all — which no ordering can help.
 *
 * AT MOST ONCE. SMTP accepting a message and this database recording it cannot be made one
 * atomic step, so a process that dies between them leaves either "sent, not recorded" or
 * "recorded, not sent", and one of those has to be chosen. This chooses at-most-once: the claim
 * is written before SMTP and is never undone automatically. A row whose sender died reads SENT
 * with `error` still `sending since …` (`isUnconfirmedSend`), and nothing automatic selects it
 * again. These are unsolicited messages to strangers; a duplicate is exactly the failure the
 * queue exists to prevent, while a missing QSL is cheap to put right by hand — Resend from the
 * log re-queues it through review. The cost is the window between claim and SMTP acceptance:
 * a crash there loses that one message, never more than one per sender.
 */
export async function sendApprovedQsls(opts: { limit?: number } = {}): Promise<SendQueueResult> {
  // One lookup for the whole run rather than one per message.
  const sendBase = (await getSetting("app.baseUrl")) ?? null;
  // Which rows to TRY, oldest approval first. Nothing below trusts this read.
  const batch = await prisma.qslEmail.findMany({
    where: { status: "APPROVED" },
    orderBy: { approvedAt: "asc" },
    take: Math.min(opts.limit ?? 25, 100),
    select: { id: true },
  });

  const result: SendQueueResult = {
    attempted: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    contended: 0,
    failures: [],
  };

  for (const { id } of batch) {
    const claim = `${UNCONFIRMED_SEND_PREFIX}${new Date().toISOString()} [claim ${randomUUID()}]`;
    const entry = await claimForSending(id, claim);
    if (!entry) {
      result.contended++;
      continue;
    }

    const card = await cardFor(entry.qsoId);

    // The last look before SMTP — see "Why after the claim" above.
    if (await hasOptedOut(entry.callsign)) {
      await settleClaim(id, claim, {
        status: "SKIPPED",
        sentAt: null,
        error: `Not sent: ${entry.callsign} opted out of QSL email before it went out`,
      });
      result.skipped++;
      continue;
    }

    result.attempted++;
    const outcome = await sendQslEmail({
      to: entry.toAddress,
      // The header, not the body. The stored body already carries the link that was
      // approved; this adds List-Unsubscribe at send time so the recipient's own mail
      // client offers its button too. Recomputed rather than stored because it is derived
      // from the callsign and a setting, and a queue entry approved before the public URL
      // was configured should still go out with a working header once it is.
      unsubscribeUrl: sendBase ? unsubscribeUrl(sendBase, entry.callsign) : null,
      // Only reaches the message when the gateway rules drop the card — see the send
      // path. Passed unconditionally because the decision belongs with the rules rather
      // than duplicated here, where it would drift.
      cardUrl: sendBase ? cardUrl(sendBase, entry.qsoId) : null,
      // The stored copy is authoritative; these only shape a re-render that is
      // then discarded in favour of the stored body below.
      qso: {
        callsign: entry.callsign,
        band: "",
        mode: "",
        startTime: entry.createdAt,
      },
      sender: { callsign: "" },
      preRendered: {
        subject: entry.subject,
        text: entry.bodyText,
        html: entry.bodyHtml,
        card,
      },
    });

    if (outcome.sent) {
      result.sent++;
      const sentAt = new Date();
      const [settled] = await prisma.$transaction([
        prisma.qslEmail.updateMany({
          where: { id, status: "SENT", error: claim },
          data: { sentAt, error: null },
        }),
        // The QSO flag is set whatever happened to the row meanwhile: the message WAS
        // accepted, and that is what the flag records. updateMany so a QSO deleted
        // mid-send cannot turn a delivered message into a thrown error.
        prisma.qso.updateMany({
          where: { id: entry.qsoId },
          // emailQslSent, and deliberately NOT qslSent.
          //
          // `qslSent` means a QSL card — paper, in an envelope or through a bureau.
          // Setting it for an email made the contact look fully answered, so it
          // would be skipped when working through the people who sent a card and
          // want one back. Emailing a card image and owing someone a physical card
          // are different obligations; conflating them loses the second one.
          //
          // The recipient address and the exact body sent are on the QslEmail row.
          data: { emailQslSent: true, emailQslSentAt: sentAt },
        }),
      ]);
      if (settled.count !== 1) {
        console.warn(
          `[qsl] ${entry.callsign}: sent, but the queue row was replaced while it was sending — left as it now is`,
        );
      }
    } else {
      result.failed++;
      result.failures.push({
        id,
        callsign: entry.callsign,
        reason: outcome.reason ?? "unknown",
      });
      await settleClaim(id, claim, {
        status: "FAILED",
        sentAt: null,
        error: outcome.reason ?? "unknown",
      });
    }

    // Pace it. Nothing here is time-critical.
    await new Promise((r) => setTimeout(r, 400));
  }

  return result;
}

// ---------------------------------------------------------------------------
// Re-sending what the gateway rules would have got through
// ---------------------------------------------------------------------------

export interface GatewayAffected {
  id: string;
  qsoId: string;
  callsign: string;
  /** The address as it was stored — possibly a placeholder. */
  toAddress: string;
  /** What it will be re-sent to. */
  newAddress: string;
  status: string;
  reason: "placeholder" | "winlink" | "arrl";
}

/**
 * QSLs that went out before the gateway rules existed, and did not arrive.
 *
 * Found by ADDRESS, not by status, and that distinction is the whole point. A
 * Winlink rejection and the `mycall@wia.org.au` bounce both happen AFTER our SMTP
 * server has accepted the message — the far end takes it, decides, and mails a
 * bounce back hours later. The queue row says SENT and the QSO says
 * `emailQslSent`. Filtering on FAILED would find almost none of them.
 *
 * The whole table is read and filtered here rather than in SQL: "is this local part
 * a placeholder" is a list of spellings with optional brackets, which is not a LIKE
 * pattern, and one projection of three short columns over a queue this size is
 * nothing next to getting it wrong.
 */
export async function findGatewayAffected(): Promise<GatewayAffected[]> {
  const rows = await prisma.qslEmail.findMany({
    where: { status: { in: ["SENT", "FAILED"] } },
    select: { id: true, qsoId: true, callsign: true, toAddress: true, status: true },
    orderBy: { createdAt: "asc" },
  });

  const out: GatewayAffected[] = [];
  for (const r of rows) {
    const placeholder = isPlaceholderAddress(r.toAddress);
    const gateway = detectGateway(r.toAddress);
    if (!placeholder && !gateway) continue;

    const prepared = prepareForGateway({
      address: r.toAddress,
      subject: "",
      callsign: r.callsign,
    });
    // Nothing to re-send to. Reported by the caller rather than silently dropped —
    // the operator may be able to find an address by hand.
    if (prepared.unresolved) continue;

    out.push({
      id: r.id,
      qsoId: r.qsoId,
      callsign: r.callsign,
      toAddress: r.toAddress,
      newAddress: prepared.address,
      status: r.status,
      reason: placeholder ? "placeholder" : (gateway as "winlink" | "arrl"),
    });
  }
  return out;
}

export interface GatewayRequeueResult {
  /** Rows examined. */
  scanned: number;
  requeued: number;
  byReason: { placeholder: number; winlink: number; arrl: number };
  /** Placeholders whose callsign could not be reduced to an address. */
  unresolvable: { callsign: string; toAddress: string }[];
}

/**
 * Put those QSLs back in the queue, corrected.
 *
 * Sets PENDING rather than APPROVED, so a re-send goes through exactly the same
 * gate a new QSL does — including `qsl.auto.approve` and the daily cap. A few
 * hundred of these will therefore drain over several days rather than arriving as
 * one burst from a single host, which is the behaviour that earns a spam
 * reputation.
 *
 * `emailQslSent` is cleared on the QSO too. It means "this operator has been
 * emailed", and for these contacts that was never true.
 */
export async function requeueGatewayAffected(
  opts: { dryRun?: boolean; limit?: number; reasons?: GatewayAffected["reason"][] } = {},
): Promise<GatewayRequeueResult> {
  // Default to the two we can PROVE did not arrive.
  //
  // A placeholder address bounced — there is no mailbox called "mycall" — and
  // Winlink rejects anything from outside the recipient's accept-list that does not
  // carry the //WL2K key. Both are certainties.
  //
  // arrl.net is NOT. It is a forwarder that mostly works, and the changes here make
  // future sends more likely to survive its filtering; that is not evidence the
  // earlier ones failed. Re-sending them by default would put a duplicate
  // unsolicited email in 120 inboxes to fix a problem that may not exist, which is
  // how a station earns the spam reputation the whole queue is designed to avoid.
  // It stays available as a deliberate choice.
  const wanted = new Set(opts.reasons ?? ["placeholder", "winlink"]);
  const affected = (await findGatewayAffected()).filter((a) => wanted.has(a.reason));
  const all = await prisma.qslEmail.count({ where: { status: { in: ["SENT", "FAILED"] } } });

  const result: GatewayRequeueResult = {
    scanned: all,
    requeued: 0,
    byReason: { placeholder: 0, winlink: 0, arrl: 0 },
    unresolvable: [],
  };

  // Reported separately from the requeue list: these need a human, not a retry.
  const rows = await prisma.qslEmail.findMany({
    where: { status: { in: ["SENT", "FAILED"] } },
    select: { callsign: true, toAddress: true },
  });
  for (const r of rows) {
    if (!isPlaceholderAddress(r.toAddress)) continue;
    if (prepareForGateway({ address: r.toAddress, subject: "", callsign: r.callsign }).unresolved) {
      result.unresolvable.push({ callsign: r.callsign, toAddress: r.toAddress });
    }
  }

  const batch = opts.limit ? affected.slice(0, opts.limit) : affected;
  if (opts.dryRun) {
    for (const a of batch) result.byReason[a.reason]++;
    result.requeued = batch.length;
    return result;
  }

  for (const a of batch) {
    // The subject is re-derived from the STORED one so a Winlink row picks up the
    // //WL2K key without re-rendering the body a human may already have approved.
    const existing = await prisma.qslEmail.findUnique({
      where: { id: a.id },
      select: { subject: true },
    });
    if (!existing) continue;
    const prepared = prepareForGateway({
      address: a.toAddress,
      subject: existing.subject,
      callsign: a.callsign,
    });

    await prisma.$transaction([
      prisma.qslEmail.update({
        where: { id: a.id },
        data: {
          toAddress: prepared.address,
          subject: prepared.subject,
          status: "PENDING",
          error: null,
          approvedById: null,
          approvedAt: null,
          sentAt: null,
        },
      }),
      prisma.qso.update({
        where: { id: a.qsoId },
        data: { emailQslSent: false, emailQslSentAt: null },
      }),
    ]);
    result.byReason[a.reason]++;
    result.requeued++;
  }

  return result;
}
