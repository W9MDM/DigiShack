import type { NextApiRequest, NextApiResponse } from "next";

import { queryParam, sendError, sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import { prisma } from "@/lib/db/prisma";
import { QSO_INCLUDE } from "@/lib/db/qso";
import { setSigRefs } from "@/lib/pota/refs";
import { freqInBand, freqToBand } from "@/lib/ham/bands";
import { updateQsoSchema } from "@/lib/validation/qso";

function idOf(req: NextApiRequest): string | undefined {
  return queryParam(req, "id");
}

async function get(req: NextApiRequest, res: NextApiResponse) {
  const id = idOf(req);
  if (!id) {
    sendError(res, 400, "Missing id");
    return;
  }

  const qso = await prisma.qso.findUnique({
    where: { id },
    include: {
      ...QSO_INCLUDE,
      // Reception reports (Phase 5) and the decodes this QSO came from
      // (Phase 4a) — both empty until those phases land, but the detail view
      // shape shouldn't change later.
      spots: { orderBy: { reportedAt: "desc" } },
      decodes: { orderBy: { timestamp: "desc" }, take: 50 },
      // The QSL email record: who it went to, when, and whether it worked.
      // `qslSent` on the QSO says a QSL happened; this says WHERE it went, which
      // is the question actually asked when someone replies or bounces. Bodies are
      // excluded — they are large and the detail view does not show them.
      qslEmails: {
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          toAddress: true,
          subject: true,
          status: true,
          error: true,
          approvedAt: true,
          approvedById: true,
          sentAt: true,
          createdAt: true,
        },
      },
    },
  });

  if (!qso) {
    sendError(res, 404, `No QSO with id ${id}`);
    return;
  }

  sendJson(res, 200, qso);
}

async function patch(req: NextApiRequest, res: NextApiResponse) {
  const id = idOf(req);
  if (!id) {
    sendError(res, 400, "Missing id");
    return;
  }

  const input = updateQsoSchema.parse(req.body);

  const existing = await prisma.qso.findUnique({
    where: { id },
    select: { id: true, freqHz: true, band: true, stationId: true },
  });
  if (!existing) {
    sendError(res, 404, `No QSO with id ${id}`);
    return;
  }

  // Band and frequency have to stay consistent across a partial update. Merge
  // the incoming values over the stored ones, then re-check the pair:
  //   - freq changed, band not supplied  -> re-derive the band
  //   - band changed, freq not supplied  -> validate against the stored freq
  //   - both supplied                    -> already validated by the schema
  const effectiveFreq =
    input.freqHz !== undefined ? input.freqHz : Number(existing.freqHz);
  let effectiveBand = input.band ?? existing.band;

  if (input.freqHz !== undefined && input.band === undefined) {
    const derived = freqToBand(effectiveFreq);
    if (!derived) {
      sendError(res, 400, "Validation failed", {
        freqHz: [
          `${(effectiveFreq / 1e6).toFixed(6)} MHz falls outside every amateur band — supply a band explicitly if this is intentional`,
        ],
      });
      return;
    }
    effectiveBand = derived;
  } else if (!freqInBand(effectiveFreq, effectiveBand)) {
    sendError(res, 400, "Validation failed", {
      band: [
        `${(effectiveFreq / 1e6).toFixed(6)} MHz is not inside ${effectiveBand}`,
      ],
    });
    return;
  }

  // Re-run the operator/station consistency check when either side moves.
  const targetStationId = input.stationId ?? existing.stationId;
  if (input.operatorId) {
    const operator = await prisma.operator.findUnique({
      where: { id: input.operatorId },
      select: { id: true, stationId: true },
    });
    if (!operator) {
      sendError(res, 404, `No operator with id ${input.operatorId}`);
      return;
    }
    if (operator.stationId !== targetStationId) {
      sendError(res, 400, "That operator belongs to a different station", {
        operatorId: ["Operator is not registered to this station"],
      });
      return;
    }
  }

  const qso = await prisma.qso.update({
    where: { id },
    data: {
      ...(input.callsign !== undefined && { callsign: input.callsign }),
      ...(input.freqHz !== undefined && { freqHz: BigInt(input.freqHz) }),
      // Written whenever freq or band moved, so the pair can never drift apart.
      band: effectiveBand,
      ...(input.mode !== undefined && { mode: input.mode }),
      ...(input.startTime !== undefined && { startTime: input.startTime }),
      ...(input.endTime !== undefined && { endTime: input.endTime }),
      ...(input.rstSent !== undefined && { rstSent: input.rstSent }),
      ...(input.rstRcvd !== undefined && { rstRcvd: input.rstRcvd }),
      ...(input.gridSquare !== undefined && { gridSquare: input.gridSquare }),
      ...(input.name !== undefined && { name: input.name }),
      ...(input.qth !== undefined && { qth: input.qth }),
      ...(input.dxcc !== undefined && { dxcc: input.dxcc }),
      ...(input.state !== undefined && { state: input.state }),
      ...(input.county !== undefined && { county: input.county }),
      ...(input.cqZone !== undefined && { cqZone: input.cqZone }),
      ...(input.ituZone !== undefined && { ituZone: input.ituZone }),
      ...(input.iota !== undefined && { iota: input.iota }),
      ...(input.continent !== undefined && { continent: input.continent }),
      ...(input.sig !== undefined && { sig: input.sig }),
      // The reference rows are written after the update, by setSigRefs; this only
      // mirrors the primary so ADIF and the single-value exports have one value.
      ...(input.sigRefs !== undefined
        ? { sigInfo: input.sigRefs[0] ?? null }
        : input.sigInfo !== undefined
          ? { sigInfo: input.sigInfo }
          : {}),
      // OUR OWN activation. Editable, and it has to be: an activation reference is set
      // once for a session, so a mistyped one is on every contact of that session and
      // the correction is made in this form. Without these three lines an edit to any
      // other field would silently write the activation away, which is the worst shape
      // this could take — the operator would fix a callsign and lose the activation.
      ...(input.mySig !== undefined && { mySig: input.mySig }),
      ...(input.mySigInfo !== undefined && { mySigInfo: input.mySigInfo }),
      ...(input.myGridSquare !== undefined && { myGridSquare: input.myGridSquare }),
      ...(input.qslSent !== undefined && { qslSent: input.qslSent }),
      ...(input.qslRcvd !== undefined && { qslRcvd: input.qslRcvd }),
      ...(input.qslSentAt !== undefined && { qslSentAt: input.qslSentAt }),
      ...(input.qslRcvdAt !== undefined && { qslRcvdAt: input.qslRcvdAt }),
      ...(input.lotwSent !== undefined && { lotwSent: input.lotwSent }),
      ...(input.lotwRcvd !== undefined && { lotwRcvd: input.lotwRcvd }),
      ...(input.qrzSent !== undefined && { qrzSent: input.qrzSent }),
      ...(input.qrzRcvd !== undefined && { qrzRcvd: input.qrzRcvd }),
      ...(input.eqslSent !== undefined && { eqslSent: input.eqslSent }),
      ...(input.emailQslSent !== undefined && {
        emailQslSent: input.emailQslSent,
        // Stamp a time when it is turned on by hand and there is none, so the field
        // never reads "sent" with no date.
        ...(input.emailQslSent ? {} : { emailQslSentAt: null }),
      }),
      ...(input.eqslRcvd !== undefined && { eqslRcvd: input.eqslRcvd }),
      ...(input.notes !== undefined && { notes: input.notes }),
      ...(input.stationId !== undefined && { stationId: input.stationId }),
      ...(input.operatorId !== undefined && { operatorId: input.operatorId }),
    },
    include: QSO_INCLUDE,
  });

  // References are a set, so an edit replaces them wholesale — that is what an
  // operator clearing the field means. Only when the field was actually submitted:
  // a PATCH that omits it must leave the parks alone.
  if (input.sigRefs !== undefined || input.sigInfo !== undefined) {
    const refs = input.sigRefs ?? (input.sigInfo ? [input.sigInfo] : []);
    await setSigRefs(prisma, qso.id, input.sig ?? qso.sig ?? "POTA", refs);
  }

  sendJson(res, 200, qso);
}

async function del(req: NextApiRequest, res: NextApiResponse) {
  const id = idOf(req);
  if (!id) {
    sendError(res, 400, "Missing id");
    return;
  }

  // PskSpot rows cascade; DigitalDecode rows are detached (qsoId -> null) so the
  // raw decode history survives deleting a mis-logged QSO.
  await prisma.qso.delete({ where: { id } });
  res.status(204).end();
}

export default authedRoute({
  GET: { role: "VIEWER", handler: get },
  PATCH: { role: "OPERATOR", handler: patch },
  DELETE: { role: "OPERATOR", handler: del },
});
