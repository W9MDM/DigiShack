import type { NextApiRequest, NextApiResponse } from "next";

import { sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import { prisma } from "@/lib/db/prisma";
import { activeStation } from "@/lib/station/scope";

// Which station the radio is operating as, and the ones it could switch to. Switching goes
// through the bridge (POST /api/bridge/control, action "station"), never a write here, so it
// is refused mid-transmission and rebuilds the operating layer - see switchStation.
async function get(_req: NextApiRequest, res: NextApiResponse) {
  const [active, stations] = await Promise.all([
    activeStation(),
    prisma.station.findMany({ orderBy: { createdAt: "asc" }, select: { id: true, callsign: true, grid: true } }),
  ]);
  sendJson(res, 200, { activeId: active?.id ?? null, stations });
}

export default authedRoute({ GET: { role: "VIEWER", handler: get } });
