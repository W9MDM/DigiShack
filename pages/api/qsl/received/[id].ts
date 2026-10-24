import type { NextApiRequest, NextApiResponse } from "next";
import { z } from "zod";

import { queryParam, sendError, sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import type { AuthContext } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { baseCall } from "@/lib/qsl/inbound/classify";
import { refreshEmailCardFlag } from "@/lib/qsl/inbound/run";

// PATCH /api/qsl/received/:id — a person deciding what a received card is for.
//
//   { action: "assign", qsoId }  link it to that contact (the one the importer could not pick)
//   { action: "unlink" }         it was linked to the wrong contact; back to the review list
//   { action: "dismiss" }        not worth a contact — spam, a duplicate, a card for someone else
//
// The contact's `emailQslRcvd` is recomputed from what is linked after every change, so a
// wrong match undone leaves no trace on the contact it was wrongly given to.

const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("assign"), qsoId: z.string().min(1).max(64) }),
  z.object({ action: z.literal("unlink") }),
  z.object({ action: z.literal("dismiss") }),
]);

async function patch(req: NextApiRequest, res: NextApiResponse, auth: AuthContext) {
  const id = queryParam(req, "id");
  if (!id) {
    sendError(res, 400, "Missing id");
    return;
  }
  const input = body.parse(req.body);
  const row = await prisma.receivedQsl.findUnique({ where: { id }, select: { id: true, kind: true, qsoId: true, callsign: true } });
  if (!row) {
    sendError(res, 404, "No such received card");
    return;
  }
  if (row.kind === "BOUNCE") {
    sendError(res, 400, "A bounce is one of our own cards coming back; it cannot be assigned or dismissed.");
    return;
  }
  const who = auth.user.callsign ?? auth.user.name ?? auth.user.email;

  if (input.action === "assign") {
    const qso = await prisma.qso.findUnique({ where: { id: input.qsoId }, select: { id: true, callsign: true } });
    if (!qso) {
      sendError(res, 404, "No such contact");
      return;
    }
    await prisma.$transaction(async (tx) => {
      await tx.receivedQsl.update({
        where: { id },
        data: {
          qsoId: qso.id,
          // A card read without a callsign takes the contact's; one with a different callsign
          // keeps what it said, so the mismatch stays visible beside the assignment.
          callsign: row.callsign || qso.callsign,
          matchStatus: "MATCHED",
          matchNote:
            row.callsign && baseCall(row.callsign) !== baseCall(qso.callsign)
              ? `Assigned by ${who} to ${qso.callsign}, although the card reads ${row.callsign}.`
              : `Assigned by ${who}.`,
        },
      });
      await refreshEmailCardFlag(qso.id, tx);
      if (row.qsoId && row.qsoId !== qso.id) await refreshEmailCardFlag(row.qsoId, tx);
    });
  } else {
    await prisma.$transaction(async (tx) => {
      await tx.receivedQsl.update({
        where: { id },
        data: {
          qsoId: null,
          matchStatus: input.action === "dismiss" ? "DISMISSED" : "UNMATCHED",
          matchNote: input.action === "dismiss" ? `Dismissed by ${who}.` : `Unlinked by ${who}.`,
        },
      });
      if (row.qsoId) await refreshEmailCardFlag(row.qsoId, tx);
    });
  }
  sendJson(res, 200, { ok: true });
}

export default authedRoute({ PATCH: { role: "OPERATOR", handler: patch } });
