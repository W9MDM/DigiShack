// Recording "forgot password" requests so an operator can see them.
//
// "in the admin UI log password reset requests and the ip they came from" — asked after an
// afternoon spent establishing, over SSH and through pm2, that four requests had reached
// the server that day and all four were mine. That evidence should have been a page.
//
// WHY IT IS A TABLE AND NOT A LOG LINE. The response this endpoint gives is identical for
// every outcome by design, so it cannot be used to discover which addresses have accounts.
// The server is therefore the only place the truth exists, and a console line is the truth
// in a form nobody reads until they already suspect something.

import { prisma } from "@/lib/db/prisma";

/** What became of a request. Stored as a short string rather than a Prisma enum so adding
 *  a case later is a code change and not a migration. */
export type ResetOutcome = "sent" | "no-account" | "throttled" | "send-failed";

/** How long attempts are kept. Long enough to see a pattern, short enough to forget. */
export const RETENTION_DAYS = 30;

/**
 * How many rows may exist at all.
 *
 * THE REASON THERE IS A CAP: this endpoint is unauthenticated and the row's key material —
 * the email — is chosen by the caller. The throttle bounds attempts per (ip, email) pair,
 * so it does NOT bound an attacker who varies the address, and each varied address is a
 * fresh budget and a fresh row. Unbounded, that is a disk-filling loop aimed at the same
 * machine that is transmitting.
 */
export const MAX_ROWS = 5_000;

/**
 * Prune every N writes rather than on every write.
 *
 * Two extra queries on every forgot-password request would put the pruning cost on the path
 * that sends mail, which is the path that must stay quick. One in fifty keeps the table
 * inside its cap within a rounding error of it and costs nothing on the common request.
 */
const PRUNE_EVERY = 50;
let sinceLastPrune = 0;

/**
 * Record one attempt. Never throws.
 *
 * DELIBERATELY SWALLOWS ITS OWN FAILURES. This is called from the forgot-password handler,
 * and an audit write that could reject would turn a database hiccup into a 500 on a page
 * whose entire job is to be indistinguishable between outcomes — a 500 that appeared only
 * for real addresses would leak exactly what the neutral response protects. The audit is
 * worth less than the endpoint it observes, and it says so here rather than at the call
 * site, where it would be one more thing to remember.
 */
export async function recordResetAttempt(args: {
  email: string;
  ip: string | null;
  outcome: ResetOutcome;
  detail?: string | null;
  userAgent?: string | null;
}): Promise<void> {
  try {
    await prisma.passwordResetAttempt.create({
      data: {
        // Lower-cased so one address is one address in the list. The lookup that decides
        // whether an account exists is done on the submitted value by the caller; this is
        // for the operator's eyes.
        email: args.email.toLowerCase().slice(0, 190),
        ip: args.ip ? args.ip.slice(0, 45) : null,
        outcome: args.outcome,
        detail: args.detail ? args.detail.slice(0, 255) : null,
        userAgent: args.userAgent ? args.userAgent.slice(0, 255) : null,
      },
    });
  } catch (err) {
    console.error("[auth] could not record the reset attempt:", err);
    return;
  }

  sinceLastPrune++;
  if (sinceLastPrune < PRUNE_EVERY) return;
  sinceLastPrune = 0;
  try {
    await pruneResetAttempts();
  } catch (err) {
    console.error("[auth] could not prune reset attempts:", err);
  }
}

/**
 * Drop what is too old, then what is simply too much.
 *
 * BOTH RULES, because either alone leaves a hole. Age alone lets a flood inside the window
 * fill the disk; a row cap alone keeps a year of history for a station nobody attacks, which
 * is a year of typed email addresses kept for no reason.
 *
 * Exported so a check can call it directly rather than writing fifty rows to trip the
 * counter.
 */
export async function pruneResetAttempts(): Promise<{ byAge: number; byCount: number }> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const byAge = await prisma.passwordResetAttempt.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });

  const total = await prisma.passwordResetAttempt.count();
  if (total <= MAX_ROWS) return { byAge: byAge.count, byCount: 0 };

  // OLDEST FIRST. Under a flood the newest rows are the attack in progress, which is the
  // part worth keeping; dropping those and retaining last month's would be backwards.
  const excess = await prisma.passwordResetAttempt.findMany({
    orderBy: { createdAt: "asc" },
    take: total - MAX_ROWS,
    select: { id: true },
  });
  const byCount = await prisma.passwordResetAttempt.deleteMany({
    where: { id: { in: excess.map((r) => r.id) } },
  });
  return { byAge: byAge.count, byCount: byCount.count };
}

/** One page of attempts, newest first. */
export async function listResetAttempts(limit = 100): Promise<
  {
    id: string;
    email: string;
    ip: string | null;
    outcome: string;
    detail: string | null;
    userAgent: string | null;
    createdAt: Date;
  }[]
> {
  return prisma.passwordResetAttempt.findMany({
    orderBy: { createdAt: "desc" },
    take: Math.max(1, Math.min(500, limit)),
  });
}
