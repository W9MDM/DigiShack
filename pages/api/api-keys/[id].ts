import type { NextApiRequest, NextApiResponse } from "next";
import { z } from "zod";

import { queryParam, sendError, sendJson } from "@/lib/api/respond";
import { API_KEY_ROLES } from "@/lib/auth/apikey";
import { authedRoute } from "@/lib/auth/guard";
import { prisma } from "@/lib/db/prisma";

const patchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  role: z.enum(API_KEY_ROLES).optional(),
  /** Setting false revokes the key immediately — it is checked per request. */
  active: z.boolean().optional(),
});

const KEY_SELECT = {
  id: true,
  name: true,
  prefix: true,
  role: true,
  active: true,
  lastUsedAt: true,
  expiresAt: true,
  createdById: true,
  createdAt: true,
} as const;

async function patch(req: NextApiRequest, res: NextApiResponse) {
  const id = queryParam(req, "id");
  if (!id) {
    sendError(res, 400, "Missing id");
    return;
  }

  const input = patchSchema.parse(req.body);

  sendJson(
    res,
    200,
    await prisma.apiKey.update({
      where: { id },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.role !== undefined && { role: input.role }),
        ...(input.active !== undefined && { active: input.active }),
      },
      select: KEY_SELECT,
    }),
  );
}

async function del(req: NextApiRequest, res: NextApiResponse) {
  const id = queryParam(req, "id");
  if (!id) {
    sendError(res, 400, "Missing id");
    return;
  }

  await prisma.apiKey.delete({ where: { id } });
  res.status(204).end();
}

export default authedRoute({
  PATCH: { role: "ADMIN", handler: patch },
  DELETE: { role: "ADMIN", handler: del },
});
