// POST /api/sstv/log - log an SSTV contact from the decodes page.
//
// SSTV has no exchange for the bridge to follow, so a contact is whatever the operator says
// it was: their call, the RSV given, the RSV received. Those arrive filled in from what the
// bridge measured and read off the picture (see lib/digital/sstv-read.ts), corrected by the
// operator where the OCR slipped. With a picture named, the frequency and the time come
// from where and when it was heard, and the picture is marked logged so it is not logged
// twice; without one (we called first), the page sends the frequency the radio is on.
import type { NextApiRequest, NextApiResponse } from "next";
import { z } from "zod";

import { sendError, sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import { prisma } from "@/lib/db/prisma";
import { readSstvMeta, SSTV_PICTURE_NAME, writeSstvMeta } from "@/lib/digital/sstv-meta";
import { resolveDxcc } from "@/lib/dxcc/resolve";
import { freqToBand } from "@/lib/ham/bands";
import { operatorIdFor } from "@/lib/operators/shift";

const bodySchema = z.object({
  file: z.string().regex(SSTV_PICTURE_NAME).nullish(),
  callsign: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{1,4}\/?[A-Z0-9]{2,8}(\/[A-Z0-9]{1,4})?$/, "Not a callsign"),
  rstSent: z.string().trim().regex(/^\d{2,3}$/, "An RSV is three digits, like 595").nullish(),
  rstRcvd: z.string().trim().regex(/^\d{2,3}$/, "An RSV is three digits, like 595").nullish(),
  /** Only used when no picture is named, or the picture's notes have no frequency. */
  freqHz: z.number().int().positive().nullish(),
  notes: z.string().max(2000).nullish(),
});

async function post(req: NextApiRequest, res: NextApiResponse) {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 400, "Check the contact", parsed.error.flatten().fieldErrors);
    return;
  }
  const input = parsed.data;
  const meta = input.file ? await readSstvMeta(input.file) : null;
  if (meta?.logged) {
    sendError(res, 409, `This picture is already logged, as ${meta.logged.callsign}`);
    return;
  }
  const freqHz = meta?.freqHz ?? input.freqHz ?? null;
  const band = freqHz ? freqToBand(freqHz) : null;
  if (!freqHz || !band) {
    sendError(res, 400, "No frequency for this contact: tune to SSTV first");
    return;
  }
  // The station the bridge logs to.
  const station = await prisma.station.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true } });
  if (!station) {
    sendError(res, 409, "Set up a station first (Settings → Station)");
    return;
  }
  let entity: { adif: number; cqZone: number | null; continent: string | null } | null = null;
  try {
    const r = await resolveDxcc(input.callsign);
    if (r.status === "found") entity = { adif: r.match.adif, cqZone: r.match.cqZone, continent: r.match.continent };
  } catch {
    /* no cty data: still worth logging */
  }
  const heardAt = meta ? new Date(meta.at) : new Date();
  const qso = await prisma.qso.create({
    data: {
      callsign: input.callsign,
      band,
      freqHz: BigInt(freqHz),
      mode: "SSTV",
      startTime: heardAt,
      endTime: new Date(),
      rstSent: input.rstSent ?? null,
      rstRcvd: input.rstRcvd ?? null,
      dxcc: entity?.adif ?? null,
      cqZone: entity?.cqZone ?? null,
      continent: entity?.continent ?? null,
      notes: input.notes || (meta ? `DigiShack SSTV · received ${meta.mode}` : "DigiShack SSTV"),
      stationId: station.id,
      operatorId: await operatorIdFor(station.id),
    },
    select: { id: true, callsign: true },
  });
  if (input.file && meta) {
    await writeSstvMeta(input.file, { ...meta, logged: { qsoId: qso.id, callsign: qso.callsign, at: new Date().toISOString() } }).catch(() => undefined);
  }
  sendJson(res, 201, { id: qso.id, callsign: qso.callsign, band, freqHz });
}

export default authedRoute({ POST: { role: "OPERATOR", handler: post } });
