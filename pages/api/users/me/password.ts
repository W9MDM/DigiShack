import type { NextApiRequest, NextApiResponse } from "next";

import { sendError, sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import type { AuthContext } from "@/lib/auth/session";
import { createSession, destroyAllSessions } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { changePasswordSchema } from "@/lib/validation/auth";

// A signed-in user changing their own password — any role, no admin involved.
//
// Requires the CURRENT password even though the caller is already authenticated:
// a session is a device, not a person. Without this, anyone at an unlocked browser
// (or holding a stolen cookie) could rotate the password and own the account; with
// it, a stolen session can snoop but cannot lock the owner out.

async function post(req: NextApiRequest, res: NextApiResponse, auth: AuthContext) {
  const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: auth.user.id },
    select: { id: true, passwordHash: true },
  });

  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    sendError(res, 403, "Current password is incorrect");
    return;
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword(newPassword) },
  });

  // Every session dies — including any stolen one, which is half the reason anyone
  // rotates a password — and the browser that made the change gets a fresh one, so
  // the person doing the right thing is not punished with a logout.
  const revoked = await destroyAllSessions(user.id);
  await createSession(user.id, req, res);

  sendJson(res, 200, { ok: true, revokedSessions: revoked });
}

export default authedRoute({ POST: { role: "VIEWER", handler: post } });
