import type { NextApiRequest, NextApiResponse } from "next";

import { sendError, sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import { prisma } from "@/lib/db/prisma";
import { QSO_INCLUDE, listQsos } from "@/lib/db/qso";
import {
  createQsoSchema,
  qsoListQuerySchema,
  resolveBand,
} from "@/lib/validation/qso";

// Public: list and create QSOs.
//
// Shares the validation and query builders with the app's own routes rather than
// reimplementing them, so the public surface cannot drift into accepting something
// the UI would reject.

async function get(req: NextApiRequest, res: NextApiResponse) {
  const query = qsoListQuerySchema.parse(req.query);
  const { rows, total } = await listQsos(query);

  sendJson(res, 200, {
    rows,
    total,
    take: query.take,
    skip: query.skip,
  });
}

async function post(req: NextApiRequest, res: NextApiResponse) {
  const input = createQsoSchema.parse(req.body);
  const band = resolveBand(input.freqHz, input.band);

  const station = await prisma.station.findUnique({
    where: { id: input.stationId },
    select: { id: true },
  });
  if (!station) {
    sendError(res, 404, `No station with id ${input.stationId}`);
    return;
  }

  if (input.operatorId) {
    const operator = await prisma.operator.findUnique({
      where: { id: input.operatorId },
      select: { id: true, stationId: true },
    });
    if (!operator) {
      sendError(res, 404, `No operator with id ${input.operatorId}`);
      return;
    }
    if (operator.stationId !== input.stationId) {
      sendError(res, 400, "That operator belongs to a different station", {
        operatorId: ["Operator is not registered to this station"],
      });
      return;
    }
  }

  const qso = await prisma.qso.create({
    data: {
      callsign: input.callsign,
      band,
      freqHz: BigInt(input.freqHz),
      mode: input.mode,
      startTime: input.startTime,
      endTime: input.endTime ?? null,
      rstSent: input.rstSent ?? null,
      rstRcvd: input.rstRcvd ?? null,
      gridSquare: input.gridSquare ?? null,
      dxcc: input.dxcc ?? null,
      state: input.state ?? null,
      county: input.county ?? null,
      cqZone: input.cqZone ?? null,
      ituZone: input.ituZone ?? null,
      iota: input.iota ?? null,
      continent: input.continent ?? null,
      qslSent: input.qslSent,
      qslRcvd: input.qslRcvd,
      qslSentAt: input.qslSentAt ?? null,
      qslRcvdAt: input.qslRcvdAt ?? null,
      lotwSent: input.lotwSent,
      lotwRcvd: input.lotwRcvd,
      eqslSent: input.eqslSent,
      eqslRcvd: input.eqslRcvd,
      notes: input.notes ?? null,
      stationId: input.stationId,
      operatorId: input.operatorId ?? null,
    },
    include: QSO_INCLUDE,
  });

  res.setHeader("Location", `/api/v1/qsos/${qso.id}`);
  sendJson(res, 201, qso);
}

export default authedRoute({
  GET: { role: "VIEWER", handler: get, allowApiKey: true },
  POST: { role: "OPERATOR", handler: post, allowApiKey: true },
});
