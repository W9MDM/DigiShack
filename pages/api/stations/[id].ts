import type { NextApiRequest, NextApiResponse } from "next";

import { queryParam, sendError, sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import { prisma } from "@/lib/db/prisma";
import { activeStation, homeStationId } from "@/lib/station/scope";
import { updateStationSchema } from "@/lib/validation/station";

async function get(req: NextApiRequest, res: NextApiResponse) {
  const id = queryParam(req, "id");
  if (!id) {
    sendError(res, 400, "Missing id");
    return;
  }

  const station = await prisma.station.findUnique({
    where: { id },
    include: {
      operators: { orderBy: { name: "asc" } },
      _count: { select: { qsos: true } },
    },
  });

  if (!station) {
    sendError(res, 404, `No station with id ${id}`);
    return;
  }

  sendJson(res, 200, station);
}

async function patch(req: NextApiRequest, res: NextApiResponse) {
  const id = queryParam(req, "id");
  if (!id) {
    sendError(res, 400, "Missing id");
    return;
  }

  const input = updateStationSchema.parse(req.body);

  // A station's callsign is fixed once it has logged contacts. Renaming it relabels every one
  // of them - K9XYZ's whole log would become K9PC's - and they would then upload and be signed
  // as the new call. A different call is a new station; add one.
  if (input.callsign !== undefined) {
    const current = await prisma.station.findUnique({ where: { id }, select: { callsign: true } });
    const changing = current && current.callsign.trim().toUpperCase() !== input.callsign.trim().toUpperCase();
    if (changing && (await prisma.qso.count({ where: { stationId: id } })) > 0) {
      sendError(
        res,
        409,
        `${current.callsign} has logged contacts, so its callsign cannot change - they would all be relabelled. Add a new station for ${input.callsign.toUpperCase()} instead.`,
      );
      return;
    }
  }

  const station = await prisma.station.update({
    where: { id },
    data: {
      ...(input.callsign !== undefined && { callsign: input.callsign }),
      ...(input.grid !== undefined && { grid: input.grid }),
    },
    include: { operators: true },
  });

  sendJson(res, 200, station);
}

async function del(req: NextApiRequest, res: NextApiResponse) {
  const id = queryParam(req, "id");
  if (!id) {
    sendError(res, 400, "Missing id");
    return;
  }

  // Operators cascade, but QSOs deliberately do NOT (Qso.station has no
  // cascade). Deleting a station out from under logged contacts would destroy
  // log data, so refuse and make the caller deal with the QSOs first.
  const qsoCount = await prisma.qso.count({ where: { stationId: id } });
  if (qsoCount > 0) {
    sendError(
      res,
      409,
      `Station has ${qsoCount} logged QSO${qsoCount === 1 ? "" : "s"} and cannot be deleted`,
      { qsoCount },
    );
    return;
  }

  // The home station owns the original accounts, the .env credentials and data/lotw/cert.json;
  // the active one is on the air. Deleting either would hand those to another station or
  // leave the radio with no identity, so both are refused.
  if (id === (await homeStationId())) {
    sendError(res, 409, "This is the home station: it owns the original logbook accounts and LoTW certificate. It cannot be deleted.");
    return;
  }
  if (id === (await activeStation())?.id) {
    sendError(res, 409, "This station is on the air. Switch the radio to another station first.");
    return;
  }
  await prisma.station.delete({ where: { id } });
  res.status(204).end();
}

// Deleting a station is ADMIN-only: it is already refused while QSOs reference
// it, but it also cascades away every operator and rig underneath.
export default authedRoute({
  GET: { role: "VIEWER", handler: get },
  PATCH: { role: "OPERATOR", handler: patch },
  DELETE: { role: "ADMIN", handler: del },
});
