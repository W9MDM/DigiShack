// Automatic QSL emailing.
//
// These are unsolicited emails to other operators, so this is off by default and
// every limit below is deliberate rather than defensive padding. A logging program
// that mails a few hundred strangers because a setting was flipped without being
// understood earns its operator a reputation, and the operator's mail server a
// blocklist entry.
//
// The queue stays in the loop even when auto-approval is on. Every message still
// gets a `QslEmail` row recording the recipient, the exact body sent, and the
// outcome — so "what went to whom" is answerable after the fact, which is the
// whole point of having a queue rather than firing from the log directly.

import { prisma } from "@/lib/db/prisma";
import { approveQsl, enqueueQsl, findQslCandidates, sendApprovedQsls } from "@/lib/qsl/queue";
import { getBooleanSetting, getNumberSetting } from "@/lib/settings";

export interface AutoQslSettings {
  enabled: boolean;
  /** Approve and send without a human looking. Separate switch on purpose. */
  autoApprove: boolean;
  /** Ceiling on messages actually sent in a rolling 24 hours. */
  maxPerDay: number;
  /** Per run, so one pass cannot empty a 26,000-QSO backlog. */
  maxPerRun: number;
  /**
   * How old a QSO must be before it is queued.
   *
   * A wrong callsign is usually noticed within a minute or two of logging it, and
   * an emailed QSL cannot be recalled. This is the window in which a mistake is
   * still free.
   */
  minAgeMinutes: number;
  /** Ignore anything older than this, so enabling it does not mail years of log. */
  maxAgeDays: number;
}

export async function loadAutoQslSettings(): Promise<AutoQslSettings> {
  return {
    enabled: await getBooleanSetting("qsl.auto.enabled", false),
    autoApprove: await getBooleanSetting("qsl.auto.approve", false),
    maxPerDay: await getNumberSetting("qsl.auto.maxPerDay", 25),
    maxPerRun: await getNumberSetting("qsl.auto.maxPerRun", 5),
    minAgeMinutes: await getNumberSetting("qsl.auto.minAgeMinutes", 15),
    maxAgeDays: await getNumberSetting("qsl.auto.maxAgeDays", 7),
  };
}

/** Messages actually sent in the last 24 hours, from the queue's own record. */
export async function sentInLastDay(): Promise<number> {
  return prisma.qslEmail.count({
    where: { status: "SENT", sentAt: { gte: new Date(Date.now() - 24 * 3_600_000) } },
  });
}

export interface AutoQslResult {
  ran: boolean;
  reason?: string;
  /** QSOs examined as candidates. */
  considered: number;
  /** Queued — an address was found on QRZ. */
  queued: number;
  /** Skipped because QRZ had no published address. */
  noAddress: number;
  approved: number;
  sent: number;
  failed: number;
  remainingToday: number;
  samples: string[];
}

/**
 * One pass of the automatic QSL emailer.
 *
 * Safe to call on a timer. Returns without doing anything when disabled, when the
 * daily ceiling is reached, or when there is nothing eligible.
 *
 * Deliberately NOT triggered by the QSO-logged event: a burst of FT8 contacts would
 * fire a burst of mail, and the age floor exists precisely to put distance between
 * logging and sending.
 */
export async function runAutoQsl(): Promise<AutoQslResult> {
  const out: AutoQslResult = {
    ran: false,
    considered: 0,
    queued: 0,
    noAddress: 0,
    approved: 0,
    sent: 0,
    failed: 0,
    remainingToday: 0,
    samples: [],
  };

  const cfg = await loadAutoQslSettings();
  if (!cfg.enabled) {
    out.reason = "qsl.auto.enabled is off";
    return out;
  }

  const alreadySent = await sentInLastDay();
  out.remainingToday = Math.max(0, cfg.maxPerDay - alreadySent);
  if (out.remainingToday === 0) {
    out.reason = `daily limit reached (${alreadySent}/${cfg.maxPerDay} in the last 24h)`;
    return out;
  }

  out.ran = true;
  const budget = Math.min(cfg.maxPerRun, out.remainingToday);

  // The age window. `findQslCandidates` filters on `since`, so the upper bound is
  // applied here.
  const now = Date.now();
  const notAfter = new Date(now - cfg.minAgeMinutes * 60_000);
  const notBefore = new Date(now - cfg.maxAgeDays * 86_400_000);

  const candidates = (
    await findQslCandidates({ since: notBefore, limit: budget * 4 })
  ).filter((c) => c.startTime <= notAfter);
  out.considered = candidates.length;

  for (const c of candidates) {
    if (out.queued >= budget) break;
    const res = await enqueueQsl(c.qsoId);
    if (res.status === "queued") {
      out.queued++;
      if (out.samples.length < 10) out.samples.push(`${c.callsign} ${c.band} ${c.mode}`);
    } else {
      // Overwhelmingly "QRZ has no published address", which is an ordinary
      // outcome and not a failure worth logging loudly.
      out.noAddress++;
    }
  }

  if (!cfg.autoApprove) {
    out.reason = out.queued > 0 ? "queued for review — qsl.auto.approve is off" : "nothing eligible";
    return out;
  }

  // Approve only what this pass queued, and attribute it to nobody: `approveQsl`
  // records an approver for accountability, and inventing a human there would be a
  // lie in the audit trail. An automatic approval is recorded as such.
  const pending = await prisma.qslEmail.findMany({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
    take: budget,
    select: { id: true },
  });
  if (pending.length > 0) {
    // null, not a fabricated user id. `approvedById` is a real foreign key and
    // inventing a human there would put a lie in the audit trail — an automatic
    // approval genuinely had no approver, and the null records that honestly.
    out.approved = await approveQsl(
      pending.map((p) => p.id),
      null,
    );
  }

  const sendResult = await sendApprovedQsls({ limit: budget });
  out.sent = sendResult.sent;
  out.failed = sendResult.failed;
  out.remainingToday = Math.max(0, cfg.maxPerDay - (await sentInLastDay()));
  return out;
}
