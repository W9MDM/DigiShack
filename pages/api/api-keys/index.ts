import type { NextApiRequest, NextApiResponse } from "next";
import { z } from "zod";

import { sendJson } from "@/lib/api/respond";
import { API_KEY_ROLES, generateApiKey } from "@/lib/auth/apikey";
import { authedRoute } from "@/lib/auth/guard";
import type { AuthContext } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";

// ADMIN, cookie-only (no allowApiKey): a key must never be able to mint another
// key. That would turn one leaked VIEWER token into permanent OPERATOR access.

const createSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  role: z.enum(API_KEY_ROLES).default("VIEWER"),
  /** Days until expiry. Omit for a key that does not expire on its own. */
  expiresInDays: z.number().int().min(1).max(3650).nullish(),
});

/** keyHash is never selected — it must not leave the server. */
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

async function get(_req: NextApiRequest, res: NextApiResponse) {
  const rows = await prisma.apiKey.findMany({
    orderBy: [{ active: "desc" }, { createdAt: "desc" }],
    select: KEY_SELECT,
  });

  sendJson(res, 200, { rows, total: rows.length });
}

async function post(
  req: NextApiRequest,
  res: NextApiResponse,
  auth: AuthContext,
) {
  const input = createSchema.parse(req.body);
  const { token, hash, prefix } = generateApiKey();

  const key = await prisma.apiKey.create({
    data: {
      name: input.name,
      keyHash: hash,
      prefix,
      role: input.role,
      createdById: auth.user.id.slice(0, 32),
      expiresAt: input.expiresInDays
        ? new Date(Date.now() + input.expiresInDays * 86_400_000)
        : null,
    },
    select: KEY_SELECT,
  });

  // The only time the token is ever returned. It is stored as a SHA-256 hash, so
  // there is no way to show it again — the UI must make that clear.
  sendJson(res, 201, {
    key,
    token,
    warning:
      "Copy this token now. It is stored only as a hash and cannot be shown again.",
  });
}

export default authedRoute({
  GET: { role: "ADMIN", handler: get },
  POST: { role: "ADMIN", handler: post },
});
