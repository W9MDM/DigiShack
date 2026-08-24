import type { NextApiRequest, NextApiResponse } from "next";

import { queryParam, sendError, sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import type { AuthContext } from "@/lib/auth/session";
import { hashPassword } from "@/lib/auth/password";
import { destroyAllSessions } from "@/lib/auth/session";
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

/**
 * Would this change leave the instance with no way in? Guards against an admin
 * demoting, disabling or deleting the last active admin — including themselves —
 * which would lock everyone out with no recovery path short of editing the
 * database by hand.
 */
async function wouldOrphanAdmins(
  targetId: string,
  next: { role?: string; active?: boolean; deleting?: boolean },
): Promise<boolean> {
  const target = await prisma.user.findUnique({
    where: { id: targetId },
    select: { role: true, active: true },
  });
  if (!target) return false;
  if (target.role !== "ADMIN" || !target.active) return false;

  const stillAdmin =
    !next.deleting && (next.role ?? "ADMIN") === "ADMIN" && (next.active ?? true);
  if (stillAdmin) return false;

  const otherActiveAdmins = await prisma.user.count({
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

  if (await wouldOrphanAdmins(id, { role: input.role, active: input.active })) {
    sendError(
      res,
      409,
      "That would leave no active admin. Promote another admin first.",
    );
    return;
  }

  const user = await prisma.user.update({
    where: { id },
    data: {
      ...(input.email !== undefined && { email: input.email }),
      ...(input.name !== undefined && { name: input.name }),
      ...(input.callsign !== undefined && { callsign: input.callsign }),
      ...(input.role !== undefined && { role: input.role }),
      ...(input.active !== undefined && { active: input.active }),
      ...(input.password !== undefined && {
        passwordHash: await hashPassword(input.password),
      }),
    },
    select: USER_SELECT,
  });

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

  if (await wouldOrphanAdmins(id, { deleting: true })) {
    sendError(
      res,
      409,
      "That would leave no active admin. Promote another admin first.",
    );
    return;
  }

  // Sessions cascade. Operator.userId is SetNull, so QSO attribution survives —
  // deleting a login must never delete log data.
  const detached = await prisma.operator.count({ where: { userId: id } });
  await prisma.user.delete({ where: { id } });

  sendJson(res, 200, { deleted: true, detachedOperators: detached });
}

export default authedRoute({
  GET: { role: "ADMIN", handler: get },
  PATCH: { role: "ADMIN", handler: patch },
  DELETE: { role: "ADMIN", handler: del },
});
