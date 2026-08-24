import type { NextApiRequest, NextApiResponse } from "next";
import { z } from "zod";

import { sendError, sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import type { AuthContext } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { resolveDxcc } from "@/lib/dxcc/resolve";

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

  if (x.promotedQsoId) {
    // Idempotent rather than an error: a double-click must not create a second contact.
    sendJson(res, 200, { ok: true, qsoId: x.promotedQsoId, alreadyPromoted: true });
    return;
  }

  // The entity is resolved here, not left for a backfill. Every contact this station logged
  // itself was once missing dxcc, cqZone and continent, and none of them counted toward an
  // award — see the note in services/radio/operating.ts.
  let entity: { adif: number; cqZone: number | null; continent: string | null } | null = null;
  try {
    const r = await resolveDxcc(x.callsign, x.startedAt);
    if (r.status === "found") {
      entity = { adif: r.match.adif, cqZone: r.match.cqZone, continent: r.match.continent };
    }
  } catch {
    /* no cty data loaded — the contact is still worth having */
  }

  const why = parsed.data.because?.trim();
  const created = await prisma.qso.create({
    data: {
      callsign: x.callsign,
      band: x.band,
      mode: x.mode,
      freqHz: x.freqHz ?? BigInt(0),
      startTime: x.startedAt,
      endTime: x.endedAt,
      rstSent: x.reportSent,
      rstRcvd: x.reportRcvd,
      gridSquare: x.gridSquare,
      dxcc: entity?.adif ?? null,
      cqZone: entity?.cqZone ?? null,
      continent: entity?.continent ?? null,
      stationId: x.stationId,
      // The provenance travels WITH the contact, not only on the row it came from. A reader
      // looking at this QSO in a year needs to know it was promoted from an unacknowledged
      // exchange rather than logged live, and by whom.
      notes:
        `Promoted from an incomplete exchange: reports exchanged both ways, no acknowledgement ` +
        `decoded (${x.stage}). Promoted by ${auth.user.email}` +
        (why ? ` — ${why}` : "") +
        (x.transcript ? `\n\n${x.transcript}` : ""),
    },
    select: { id: true },
  });

  await prisma.incompleteExchange.update({
    where: { id },
    data: { promotedQsoId: created.id },
  });

  sendJson(res, 200, { ok: true, qsoId: created.id });
}

export default authedRoute({ POST: { role: "ADMIN", handler: post } });
