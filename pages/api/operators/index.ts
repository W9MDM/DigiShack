import type { NextApiRequest, NextApiResponse } from "next";

import { queryParam, sendError, sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import { prisma } from "@/lib/db/prisma";
import { createOperatorSchema } from "@/lib/validation/station";

async function get(req: NextApiRequest, res: NextApiResponse) {
  const stationId = queryParam(req, "stationId");

  const operators = await prisma.operator.findMany({
    where: stationId ? { stationId } : undefined,
    orderBy: [{ stationId: "asc" }, { name: "asc" }],
    include: {
      station: { select: { id: true, callsign: true } },
      _count: { select: { qsos: true } },
    },
  });

  sendJson(res, 200, { rows: operators, total: operators.length });
}

async function post(req: NextApiRequest, res: NextApiResponse) {
  const input = createOperatorSchema.parse(req.body);

  const station = await prisma.station.findUnique({
    where: { id: input.stationId },
    select: { id: true },
  });
  if (!station) {
    sendError(res, 404, `No station with id ${input.stationId}`);
    return;
  }

  const operator = await prisma.operator.create({
    data: {
      name: input.name,
      callsign: input.callsign,
      stationId: input.stationId,
      role: input.role,
    },
    include: { station: { select: { id: true, callsign: true } } },
  });

  res.setHeader("Location", `/api/operators/${operator.id}`);
  sendJson(res, 201, operator);
}

export default authedRoute({
  GET: { role: "VIEWER", handler: get },
  POST: { role: "OPERATOR", handler: post },
});
