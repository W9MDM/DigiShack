import type { NextApiRequest, NextApiResponse } from "next";
import { z } from "zod";

import { sendError, sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import { prisma } from "@/lib/db/prisma";
import type { Prisma, QslStatus } from "@prisma/client";

// Physical QSL cards.
//
// GET  /api/qsl/cards — contacts owed a card, and recent batches
// POST /api/qsl/cards — mark a batch sent or received, by route
//
// Separate from the email queue because the workflow is different: cards are
// written and posted in batches, often via a bureau, and the useful operation is
// "mark these forty as gone out by bureau today" rather than per-contact review.

const postSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("mark-sent"),
    qsoIds: z.array(z.string().min(1)).min(1).max(500),
    via: z.enum(["BUREAU", "DIRECT", "MANAGER"]),
    /** Defaults to now; settable so a batch posted yesterday records correctly. */
    at: z.string().datetime().optional(),
  }),
  z.object({
    action: z.literal("mark-received"),
    qsoIds: z.array(z.string().min(1)).min(1).max(500),
    via: z.enum(["BUREAU", "DIRECT", "MANAGER"]),
    at: z.string().datetime().optional(),
  }),
  z.object({
    action: z.literal("mark-requested"),
    qsoIds: z.array(z.string().min(1)).min(1).max(500),
  }),
]);

async function get(req: NextApiRequest, res: NextApiResponse) {
  const which = typeof req.query.which === "string" ? req.query.which : "owed";
  const limit = Math.min(Number(req.query.limit ?? 100) || 100, 500);

  const select = {
    id: true,
    callsign: true,
    band: true,
    mode: true,
    startTime: true,
    freqHz: true,
    rstSent: true,
    rstRcvd: true,
    gridSquare: true,
    qslSent: true,
    qslRcvd: true,
    qslSentVia: true,
    qslRcvdVia: true,
    qslSentAt: true,
    station: { select: { callsign: true, grid: true } },
  } as const;

  // "Owed" = they sent us one and we have not answered, or the operator marked
  // it REQUESTED. Those are the two reasons to write a card.
  const CONFIRMED_IN: QslStatus[] = ["SENT", "CONFIRMED"];
  const UNSENT_IN: QslStatus[] = ["NONE", "REQUESTED"];

  const where: Prisma.QsoWhereInput =
    which === "sent"
      ? { qslSent: "SENT" }
      : which === "received"
        ? { qslRcvd: { in: CONFIRMED_IN } }
        : {
            qslSent: { in: UNSENT_IN },
            OR: [{ qslRcvd: { in: CONFIRMED_IN } }, { qslSent: "REQUESTED" }],
          };

  const [rows, counts] = await Promise.all([
    prisma.qso.findMany({
      where,
      orderBy: { startTime: "asc" },
      take: limit,
      select,
    }),
    prisma.qso.groupBy({ by: ["qslSent"], _count: { _all: true } }),
  ]);

  sendJson(res, 200, {
    which,
    qsos: rows,
    counts: Object.fromEntries(counts.map((c) => [c.qslSent, c._count._all])),
  });
}

async function post(req: NextApiRequest, res: NextApiResponse) {
  const parsed = postSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 400, "Bad card request", parsed.error.flatten().fieldErrors);
    return;
  }
  const body = parsed.data;

  if (body.action === "mark-requested") {
    const r = await prisma.qso.updateMany({
      where: { id: { in: body.qsoIds }, qslSent: "NONE" },
      data: { qslSent: "REQUESTED" },
    });
    sendJson(res, 200, { updated: r.count });
    return;
  }

  const at = body.at ? new Date(body.at) : new Date();

  if (body.action === "mark-sent") {
    const r = await prisma.qso.updateMany({
      where: { id: { in: body.qsoIds } },
      data: { qslSent: "SENT", qslSentAt: at, qslSentVia: body.via },
    });
    sendJson(res, 200, { updated: r.count });
    return;
  }

  // mark-received. CONFIRMED rather than SENT: an inbound card is a confirmation,
  // which is what the awards calculation counts.
  const r = await prisma.qso.updateMany({
    where: { id: { in: body.qsoIds } },
    data: { qslRcvd: "CONFIRMED", qslRcvdAt: at, qslRcvdVia: body.via },
  });
  sendJson(res, 200, { updated: r.count });
}

export default authedRoute({
  GET: { role: "OPERATOR", handler: get },
  POST: { role: "OPERATOR", handler: post },
});
