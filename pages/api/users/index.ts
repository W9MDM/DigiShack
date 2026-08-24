import type { NextApiRequest, NextApiResponse } from "next";

import { sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import { hashPassword } from "@/lib/auth/password";
import { prisma } from "@/lib/db/prisma";
import { createUserSchema } from "@/lib/validation/auth";

// `passwordHash` is never in a select — it must not leave the server, not even
// to an admin.
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

async function get(_req: NextApiRequest, res: NextApiResponse) {
  const users = await prisma.user.findMany({
    orderBy: [{ role: "asc" }, { name: "asc" }],
    select: USER_SELECT,
  });

  sendJson(res, 200, { rows: users, total: users.length });
}

async function post(req: NextApiRequest, res: NextApiResponse) {
  const input = createUserSchema.parse(req.body);

  // A duplicate email surfaces as P2002 from the unique constraint, which
  // authedRoute translates to a 409.
  const user = await prisma.user.create({
    data: {
      email: input.email,
      name: input.name,
      callsign: input.callsign || null,
      passwordHash: await hashPassword(input.password),
      role: input.role,
    },
    select: USER_SELECT,
  });

  res.setHeader("Location", `/api/users/${user.id}`);
  sendJson(res, 201, user);
}

export default authedRoute({
  GET: { role: "ADMIN", handler: get },
  POST: { role: "ADMIN", handler: post },
});
