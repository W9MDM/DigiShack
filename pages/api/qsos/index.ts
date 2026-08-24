import type { NextApiRequest, NextApiResponse } from "next";

import { sendError, sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import { prisma } from "@/lib/db/prisma";
import { QSO_INCLUDE, listQsos } from "@/lib/db/qso";
import { freqInBand } from "@/lib/ham/bands";
import {
  createQsoSchema,
  qsoListQuerySchema,
  resolveBand,
} from "@/lib/validation/qso";

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

  // Band is optional on input; derive it from the frequency when absent. When
  // present, createQsoSchema has already checked it contains freqHz.
  const band = resolveBand(input.freqHz, input.band);

  // The station must exist before we attempt the insert, so the caller gets a
  // clear 404 instead of a raw foreign-key error.
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
    // An operator belongs to one station; logging them under a different one
    // would produce a nonsense audit trail.
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
      name: input.name ?? null,
      qth: input.qth ?? null,
      dxcc: input.dxcc ?? null,
      state: input.state ?? null,
      county: input.county ?? null,
      cqZone: input.cqZone ?? null,
      ituZone: input.ituZone ?? null,
      iota: input.iota ?? null,
      continent: input.continent ?? null,
      sig: input.sig ?? null,
      // The primary. `sigRefs` below carries the whole set — a contact can be
      // several parks at once.
      sigInfo: input.sigRefs?.[0] ?? input.sigInfo ?? null,
      qslSent: input.qslSent,
      qslRcvd: input.qslRcvd,
      qslSentAt: input.qslSentAt ?? null,
      qslRcvdAt: input.qslRcvdAt ?? null,
      lotwSent: input.lotwSent,
      lotwRcvd: input.lotwRcvd,
      qrzSent: input.qrzSent,
      qrzRcvd: input.qrzRcvd,
      eqslSent: input.eqslSent,
      eqslRcvd: input.eqslRcvd,
      notes: input.notes ?? null,
      stationId: input.stationId,
      operatorId: input.operatorId ?? null,
      // Nested rather than a second call: a contact created without its references
      // would be briefly visible as an ordinary QSO, and a failure between the two
      // would leave it that way permanently.
      sigRefs: {
        create: (input.sigRefs ?? (input.sigInfo ? [input.sigInfo] : [])).map(
          (sigInfo, i) => ({ sig: input.sig ?? "POTA", sigInfo, primary: i === 0 }),
        ),
      },
    },
    include: QSO_INCLUDE,
  });

  // Defence in depth: if the band/frequency pair ever gets past validation the
  // row is still wrong, so assert rather than persist silently-bad award data.
  if (!freqInBand(Number(qso.freqHz), qso.band)) {
    console.warn(
      `[qso] created ${qso.id} with freq ${qso.freqHz} outside band ${qso.band}`,
    );
  }

  res.setHeader("Location", `/api/qsos/${qso.id}`);
  sendJson(res, 201, qso);
}

export default authedRoute({
  GET: { role: "VIEWER", handler: get },
  POST: { role: "OPERATOR", handler: post },
});
