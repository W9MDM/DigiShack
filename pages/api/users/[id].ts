import type { Prisma } from "@prisma/client";
import type { NextApiRequest, NextApiResponse } from "next";

import { queryParam, sendError, sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import type { AuthContext } from "@/lib/auth/session";
import { hashPassword } from "@/lib/auth/password";
import { destroyAllSessions } from "@/lib/auth/session";
import { LOCKS, withInvariantLock } from "@/lib/db/invariant-lock";
import { prisma } from "@/lib/db/prisma";
import { updateUserSchema } from "@/lib/validation/auth";

const USER_SELECT = {
  id: true,
  email: true,
  name: true,
  callsign: true,
  role: true,
  active: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { sessions: true } },
} as const;

const ORPHAN_MESSAGE = "That would leave no active admin. Promote another admin first.";

/**
 * Would this change leave the instance with no way in? Guards against an admin
 * demoting, disabling or deleting the last active admin — including themselves —
 * which would lock everyone out with no recovery path short of editing the
 * database by hand.
 *
 * Takes the TRANSACTION client, and must only ever be called under the admins lock, in the
 * same transaction as the write it guards. Called on its own it was a check-then-write race:
 * with exactly two active admins, two simultaneous demotions (or a disable and a delete) of
 * different admins each counted the other one still active, both went through, and nobody
 * could sign in. The lock is SHARED by every operation that can remove an admin, because the
 * invariant is about the set of admins, not about either row — locking the two target users
 * separately would serialize nothing.
 */
async function wouldOrphanAdmins(
  tx: Prisma.TransactionClient,
  targetId: string,
  next: { role?: string; active?: boolean; deleting?: boolean },
): Promise<boolean> {
  const target = await tx.user.findUnique({
    where: { id: targetId },
    select: { role: true, active: true },
  });
  if (!target) return false;
  if (target.role !== "ADMIN" || !target.active) return false;

  const stillAdmin =
    !next.deleting && (next.role ?? "ADMIN") === "ADMIN" && (next.active ?? true);
  if (stillAdmin) return false;

  const otherActiveAdmins = await tx.user.count({
    where: { role: "ADMIN", active: true, id: { not: targetId } },
  });
  return otherActiveAdmins === 0;
}

async function get(req: NextApiRequest, res: NextApiResponse) {
  const id = queryParam(req, "id");
  if (!id) {
    sendError(res, 400, "Missing id");
    return;
  }

  const user = await prisma.user.findUnique({
    where: { id },
    select: USER_SELECT,
  });

  if (!user) {
    sendError(res, 404, `No user with id ${id}`);
    return;
  }

  sendJson(res, 200, user);
}

async function patch(
  req: NextApiRequest,
  res: NextApiResponse,
  auth: AuthContext,
) {
  const id = queryParam(req, "id");
  if (!id) {
    sendError(res, 400, "Missing id");
    return;
  }

  const input = updateUserSchema.parse(req.body);

  // Before the lock: scrypt is slow, and nobody should wait behind it.
  const passwordHash =
    input.password !== undefined ? await hashPassword(input.password) : undefined;

  // Check and write under one lock — see wouldOrphanAdmins.
  const user = await withInvariantLock(LOCKS.admins, async (tx) => {
    if (await wouldOrphanAdmins(tx, id, { role: input.role, active: input.active })) {
      return null;
    }
    return tx.user.update({
      where: { id },
      data: {
        ...(input.email !== undefined && { email: input.email }),
        ...(input.name !== undefined && { name: input.name }),
        ...(input.callsign !== undefined && { callsign: input.callsign }),
        ...(input.role !== undefined && { role: input.role }),
        ...(input.active !== undefined && { active: input.active }),
        ...(passwordHash !== undefined && { passwordHash }),
      },
      select: USER_SELECT,
    });
  });

  if (!user) {
    sendError(res, 409, ORPHAN_MESSAGE);
    return;
  }

  // A password change or a deactivation must invalidate existing sessions —
  // otherwise a compromised session survives exactly the action taken to stop it.
  let revoked = 0;
  if (input.password !== undefined || input.active === false) {
    revoked = await destroyAllSessions(id);
  }

  sendJson(res, 200, {
    ...user,
    revokedSessions: revoked,
    // The caller may have just logged themselves out.
    selfSessionsRevoked: revoked > 0 && id === auth.user.id,
  });
}

async function del(
  req: NextApiRequest,
  res: NextApiResponse,
  auth: AuthContext,
) {
  const id = queryParam(req, "id");
  if (!id) {
    sendError(res, 400, "Missing id");
    return;
  }

  if (id === auth.user.id) {
    sendError(res, 409, "You cannot delete your own account");
    return;
  }

  // Sessions cascade. Operator.userId is SetNull, so QSO attribution survives —
  // deleting a login must never delete log data.
  const detached = await withInvariantLock(LOCKS.admins, async (tx) => {
    if (await wouldOrphanAdmins(tx, id, { deleting: true })) return null;
    const count = await tx.operator.count({ where: { userId: id } });
    await tx.user.delete({ where: { id } });
    return count;
  });

  if (detached === null) {
    sendError(res, 409, ORPHAN_MESSAGE);
    return;
  }

  sendJson(res, 200, { deleted: true, detachedOperators: detached });
}

export default authedRoute({
  GET: { role: "ADMIN", handler: get },
  PATCH: { role: "ADMIN", handler: patch },
  DELETE: { role: "ADMIN", handler: del },
});
