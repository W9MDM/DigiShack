import type { NextApiRequest, NextApiResponse } from "next";

import { queryParam, sendError, sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import { prisma } from "@/lib/db/prisma";
import { updateOperatorSchema } from "@/lib/validation/station";

async function get(req: NextApiRequest, res: NextApiResponse) {
  const id = queryParam(req, "id");
  if (!id) {
    sendError(res, 400, "Missing id");
    return;
  }

  const operator = await prisma.operator.findUnique({
    where: { id },
    include: {
      station: { select: { id: true, callsign: true, grid: true } },
      _count: { select: { qsos: true } },
    },
  });

  if (!operator) {
    sendError(res, 404, `No operator with id ${id}`);
    return;
  }

  sendJson(res, 200, operator);
}

async function patch(req: NextApiRequest, res: NextApiResponse) {
  const id = queryParam(req, "id");
  if (!id) {
    sendError(res, 400, "Missing id");
    return;
  }

  const input = updateOperatorSchema.parse(req.body);

  // Moving an operator to another station would orphan the station consistency
  // check on their existing QSOs, so it's refused while they have any.
  if (input.stationId) {
    const existing = await prisma.operator.findUnique({
      where: { id },
      select: { stationId: true, _count: { select: { qsos: true } } },
    });
    if (!existing) {
      sendError(res, 404, `No operator with id ${id}`);
      return;
    }
    if (existing.stationId !== input.stationId && existing._count.qsos > 0) {
      sendError(
        res,
        409,
        `Operator has ${existing._count.qsos} logged QSO${existing._count.qsos === 1 ? "" : "s"} and cannot be moved to another station`,
        { qsoCount: existing._count.qsos },
      );
      return;
    }
  }

  const operator = await prisma.operator.update({
    where: { id },
    data: {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.callsign !== undefined && { callsign: input.callsign }),
      ...(input.role !== undefined && { role: input.role }),
      ...(input.stationId !== undefined && { stationId: input.stationId }),
    },
    include: { station: { select: { id: true, callsign: true } } },
  });

  sendJson(res, 200, operator);
}

async function del(req: NextApiRequest, res: NextApiResponse) {
  const id = queryParam(req, "id");
  if (!id) {
    sendError(res, 400, "Missing id");
    return;
  }

  // Qso.operator is onDelete: SetNull, so deleting an operator detaches them
  // from their QSOs rather than deleting log entries. Warn rather than block —
  // but say what will happen.
  const qsoCount = await prisma.qso.count({ where: { operatorId: id } });
  await prisma.operator.delete({ where: { id } });

  sendJson(res, 200, { deleted: true, detachedQsos: qsoCount });
}

export default authedRoute({
  GET: { role: "VIEWER", handler: get },
  PATCH: { role: "OPERATOR", handler: patch },
  DELETE: { role: "ADMIN", handler: del },
});
