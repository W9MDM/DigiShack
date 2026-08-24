import type { NextApiRequest, NextApiResponse } from "next";

import { sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import { prisma } from "@/lib/db/prisma";
import { createStationSchema } from "@/lib/validation/station";

async function get(_req: NextApiRequest, res: NextApiResponse) {
  const stations = await prisma.station.findMany({
    orderBy: { callsign: "asc" },
    include: {
      operators: {
        orderBy: { name: "asc" },
        select: { id: true, name: true, callsign: true, role: true },
      },
      _count: { select: { qsos: true } },
    },
  });

  sendJson(res, 200, { rows: stations, total: stations.length });
}

async function post(req: NextApiRequest, res: NextApiResponse) {
  const input = createStationSchema.parse(req.body);

  const station = await prisma.station.create({
    data: { callsign: input.callsign, grid: input.grid },
    include: { operators: true },
  });

  res.setHeader("Location", `/api/stations/${station.id}`);
  sendJson(res, 201, station);
}

export default authedRoute({
  GET: { role: "VIEWER", handler: get },
  POST: { role: "OPERATOR", handler: post },
});
