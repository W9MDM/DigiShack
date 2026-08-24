import type { NextApiRequest, NextApiResponse } from "next";

import { sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import { prisma } from "@/lib/db/prisma";

// GET /api/stats/today — contacts logged since 00:00 UTC, and nothing else.
//
// Deliberately separate from /api/stats/summary, which runs ten queries including
// group-bys over the whole log. This is polled from the Digital page while operating
// and refreshed on every logged contact, so it has to stay a single indexed COUNT.
//
// UTC, because that is the day the log runs on. A local midnight would disagree with
// every timestamp it is counting.

async function get(_req: NextApiRequest, res: NextApiResponse) {
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);

  const [today, lastQso] = await Promise.all([
    prisma.qso.count({ where: { startTime: { gte: midnight } } }),
    prisma.qso.findFirst({
      orderBy: { startTime: "desc" },
      select: { startTime: true, callsign: true },
    }),
  ]);

  sendJson(res, 200, {
    today,
    // How long since the last contact — the other half of "is this working?".
    lastAt: lastQso?.startTime.toISOString() ?? null,
    lastCallsign: lastQso?.callsign ?? null,
  });
}

export default authedRoute({ GET: { role: "VIEWER", handler: get } });
