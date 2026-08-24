// Password-reset tokens: issue one, consume one.
//
// The shape mirrors sessions on purpose — 256 bits of CSPRNG in the user's hands,
// only its SHA-256 in the database — because the failure this guards against is the
// same: a database leak must not hand anyone the ability to take an account.
//
// What is deliberately DIFFERENT from a session:
//   * 30 minutes, not days. The token travels by email, and mail sits in inboxes,
//     forwarders and provider logs indefinitely. Short expiry is what bounds that.
//   * Single use. The first consumption marks it used; replaying the same link
//     afterwards fails, so a token fished out of an inbox later is worthless.
//   * Issuing a new token revokes the outstanding ones — only the newest email
//     works, so a stack of reset mails is not a stack of live credentials.

import { createHash, randomBytes } from "node:crypto";

import { hashPassword } from "@/lib/auth/password";
import { destroyAllSessions } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";

export const RESET_TTL_MS = 30 * 60_000;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Issue a reset token for a user. Returns the RAW token — the only copy that will
 * ever exist; it goes into the email link and nowhere else.
 */
export async function createPasswordReset(userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  // Older outstanding tokens die now, not at their own expiry. See the header.
  await prisma.passwordReset.deleteMany({ where: { userId } });
  await prisma.passwordReset.create({
    data: {
      tokenHash: hashToken(token),
      userId,
      expiresAt: new Date(Date.now() + RESET_TTL_MS),
    },
  });
  return token;
}

/**
 * Redeem a token: set the new password and revoke every session.
 *
 * One error message for every failure mode — unknown, expired, already used,
 * account disabled. Distinguishing them would tell whoever is probing which tokens
 * were once real.
 */
export async function consumePasswordReset(
  rawToken: string,
  newPassword: string,
): Promise<{ ok: true; email: string } | { ok: false }> {
  const reset = await prisma.passwordReset.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    include: { user: { select: { id: true, email: true, active: true } } },
  });

  if (!reset || reset.usedAt !== null || reset.expiresAt < new Date() || !reset.user.active) {
    return { ok: false };
  }

  const passwordHash = await hashPassword(newPassword);
  // Mark used FIRST, guarded on it still being unused — two racing submissions of
  // the same link collapse to one winner instead of both "succeeding".
  const claimed = await prisma.passwordReset.updateMany({
    where: { id: reset.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (claimed.count === 0) return { ok: false };

  await prisma.user.update({
    where: { id: reset.user.id },
    data: { passwordHash },
  });
  // The reset exists because the old credential may be compromised; sessions made
  // with it must die with it.
  await destroyAllSessions(reset.user.id);

  return { ok: true, email: reset.user.email };
}
