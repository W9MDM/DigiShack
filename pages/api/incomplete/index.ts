import type { NextApiRequest, NextApiResponse } from "next";

import { sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import { prisma } from "@/lib/db/prisma";

// Exchanges that swapped reports and were never acknowledged.
//
// Not contacts. Listed so an operator can see what the sequencer gave up on and promote the
// ones something else corroborates — a card request, an eQSL confirmation, a direct email.
// Promoted and dismissed rows are excluded by default: the list is a work queue, and the whole
// point is that it empties.

async function get(req: NextApiRequest, res: NextApiResponse) {
  const all = req.query.all === "1";
  const rows = await prisma.incompleteExchange.findMany({
    where: all ? {} : { promotedQsoId: null, dismissedAt: null },
    orderBy: { startedAt: "desc" },
    take: 500,
    include: { promotedQso: { select: { id: true } } },
  });

  sendJson(res, 200, {
    rows: rows.map((r) => ({
      id: r.id,
      callsign: r.callsign,
      band: r.band,
      mode: r.mode,
      freqHz: r.freqHz === null ? null : Number(r.freqHz),
      startedAt: r.startedAt.toISOString(),
      endedAt: r.endedAt.toISOString(),
      stage: r.stage,
      reportSent: r.reportSent,
      reportRcvd: r.reportRcvd,
      gridSquare: r.gridSquare,
      reason: r.reason,
      transcript: r.transcript,
      promotedQsoId: r.promotedQsoId,
      dismissedAt: r.dismissedAt?.toISOString() ?? null,
    })),
    // Shown next to the list so an empty queue reads as "nothing outstanding" rather than
    // "this feature does not work".
    total: await prisma.incompleteExchange.count(),
    outstanding: await prisma.incompleteExchange.count({
      where: { promotedQsoId: null, dismissedAt: null },
    }),
  });
}

export default authedRoute({ GET: { role: "VIEWER", handler: get } });
