import type { NextApiRequest, NextApiResponse } from "next";
import { z } from "zod";

import { sendError, sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import type { AuthContext } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { promoteIncomplete } from "@/lib/qso/promote-incomplete";

// Promote an incomplete exchange to a contact, or dismiss it.
//
// PROMOTION IS A DELIBERATE ACT and that is the entire design. An exchange reached the point
// where we sent the final roger and heard nothing back, which fits both a contact the far
// station kept and one they abandoned too — so nothing here happens automatically. Once
// promoted the contact is an ordinary QSO and the upload sweeps will send it to LoTW, QRZ and
// the rest, which is why it needs a person to say so.
//
// ADMIN, not OPERATOR: this creates a record that becomes a claim against somebody else's log.

const bodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("promote"),
    /** Free text recording WHY, e.g. the card request that corroborated it. */
    because: z.string().trim().max(300).optional(),
  }),
  z.object({ action: z.literal("dismiss") }),
  z.object({ action: z.literal("restore") }),
]);

async function post(req: NextApiRequest, res: NextApiResponse, auth: AuthContext) {
  const id = typeof req.query.id === "string" ? req.query.id : "";
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 400, "Bad request", parsed.error.flatten().fieldErrors);
    return;
  }

  const x = await prisma.incompleteExchange.findUnique({ where: { id } });
  if (!x) {
    sendError(res, 404, "No such exchange");
    return;
  }

  if (parsed.data.action === "dismiss") {
    await prisma.incompleteExchange.update({ where: { id }, data: { dismissedAt: new Date() } });
    sendJson(res, 200, { ok: true, dismissed: true });
    return;
  }
  if (parsed.data.action === "restore") {
    await prisma.incompleteExchange.update({ where: { id }, data: { dismissedAt: null } });
    sendJson(res, 200, { ok: true, dismissed: false });
    return;
  }

  const result = await promoteIncomplete(id, {
    because: parsed.data.because,
    by: auth.user.email,
  });
  if (!result) {
    sendError(res, 404, "No such exchange");
    return;
  }
  if (result.alreadyPromoted) {
    // Idempotent rather than an error: a double-click must not create a second contact.
    sendJson(res, 200, { ok: true, qsoId: result.qsoId, alreadyPromoted: true });
    return;
  }
  sendJson(res, 200, { ok: true, qsoId: result.qsoId });
}

export default authedRoute({ POST: { role: "ADMIN", handler: post } });
