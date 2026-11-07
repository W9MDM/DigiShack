// POST /api/digital/log - log a contact made in a text mode from the decodes page.
//
// RTTY, CW, PSK, Olivia, Contestia and the Hell modes have no exchange the bridge follows,
// unlike FT8, so a contact is what the operator says it was: their call, the reports, and
// what else they caught. The mode arrives as DigiShack stores it (lib/ham/modes.ts), so
// each one exports as its proper ADIF MODE and SUBMODE (lib/adif/fields.ts): FM Hell-105 is
// MODE=HELL SUBMODE=FSKH105, PSK63 is MODE=PSK SUBMODE=PSK63. The frequency is the signal's,
// dial plus carrier, as fldigi logs it.
import type { NextApiRequest, NextApiResponse } from "next";
import { z } from "zod";

import { sendError, sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import { prisma } from "@/lib/db/prisma";
import { resolveDxcc } from "@/lib/dxcc/resolve";
import { freqToBand } from "@/lib/ham/bands";
import { isLoggableMode, TEXT_LOG_MODES } from "@/lib/ham/modes";
import { operatorIdFor } from "@/lib/operators/shift";
import { activeStation } from "@/lib/station/scope";

const report = z.string().trim().regex(/^\d{2,3}$/, "A report is two or three digits, like 599").nullish();

const bodySchema = z.object({
  mode: z.string().refine((m) => TEXT_LOG_MODES.includes(m) && isLoggableMode(m), "Not a text mode this logs"),
  callsign: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{1,4}\/?[A-Z0-9]{2,8}(\/[A-Z0-9]{1,4})?$/, "Not a callsign"),
  rstSent: report,
  rstRcvd: report,
  freqHz: z.number().int().positive(),
  name: z.string().trim().max(64).nullish(),
  qth: z.string().trim().max(96).nullish(),
  grid: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-R]{2}\d{2}([A-X]{2})?$/, "A grid is like EN61 or EN61aa")
    .nullish()
    .or(z.literal("")),
  /** When the contact started, ms; the log time otherwise. */
  startedAt: z.number().int().positive().nullish(),
  notes: z.string().max(2000).nullish(),
});

async function post(req: NextApiRequest, res: NextApiResponse) {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 400, "Check the contact", parsed.error.flatten().fieldErrors);
    return;
  }
  const input = parsed.data;
  const band = freqToBand(input.freqHz);
  if (!band) {
    sendError(res, 400, "That frequency is not in an amateur band");
    return;
  }
  const station = await activeStation();
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
  const now = new Date();
  const start = input.startedAt && input.startedAt < now.getTime() ? new Date(input.startedAt) : now;
  const qso = await prisma.qso.create({
    data: {
      callsign: input.callsign,
      band,
      freqHz: BigInt(input.freqHz),
      mode: input.mode,
      startTime: start,
      endTime: now,
      rstSent: input.rstSent || null,
      rstRcvd: input.rstRcvd || null,
      name: input.name || null,
      qth: input.qth || null,
      gridSquare: input.grid ? input.grid.slice(0, 4).toUpperCase() + input.grid.slice(4).toLowerCase() : null,
      dxcc: entity?.adif ?? null,
      cqZone: entity?.cqZone ?? null,
      continent: entity?.continent ?? null,
      notes: input.notes || `DigiShack ${input.mode}`,
      stationId: station.id,
      operatorId: await operatorIdFor(station.id),
    },
    select: { id: true, callsign: true },
  });
  sendJson(res, 201, { id: qso.id, callsign: qso.callsign, band, mode: input.mode });
}

export default authedRoute({ POST: { role: "OPERATOR", handler: post } });
