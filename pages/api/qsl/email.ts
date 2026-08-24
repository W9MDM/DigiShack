import type { NextApiRequest, NextApiResponse } from "next";
import { z } from "zod";

import { sendError, sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import { prisma } from "@/lib/db/prisma";
import { sendQslEmail, verifySmtp } from "@/lib/qsl/email";
import { getSetting } from "@/lib/settings";
import { boolQuery } from "@/lib/validation/query";

// GET  /api/qsl/email        — check the SMTP settings (connects, does not send)
// POST /api/qsl/email        — render, and send only when told to
//
// Sending defaults to a DRY RUN. These are unsolicited emails to other
// operators, so the safe default has to be "show me what you would send", and
// actually sending has to be an explicit act.

const bodySchema = z.object({
  qsoId: z.string().min(1),
  to: z.string().trim().email(),
  note: z.string().trim().max(500).nullish(),
  /** Must be explicitly true to actually send. */
  send: z.boolean().optional(),
});

async function get(_req: NextApiRequest, res: NextApiResponse) {
  const result = await verifySmtp();
  sendJson(res, result.ok ? 200 : 400, result);
}

async function post(req: NextApiRequest, res: NextApiResponse) {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 400, "Bad QSL email request", parsed.error.flatten().fieldErrors);
    return;
  }
  const { qsoId, to, note, send } = parsed.data;

  const qso = await prisma.qso.findUnique({
    where: { id: qsoId },
    include: { station: true },
  });
  if (!qso) {
    sendError(res, 404, "No such QSO");
    return;
  }

  const result = await sendQslEmail({
    to,
    qso: {
      callsign: qso.callsign,
      band: qso.band,
      mode: qso.mode,
      startTime: qso.startTime,
      freqHz: qso.freqHz === null ? null : Number(qso.freqHz),
      rstSent: qso.rstSent,
      rstRcvd: qso.rstRcvd,
      gridSquare: qso.gridSquare,
    },
    sender: {
      callsign: qso.station?.callsign ?? "",
      grid: qso.station?.grid ?? null,
      name: (await getSetting("qsl.operatorName")) ?? null,
    },
    note,
    logUrl: (await getSetting("app.baseUrl")) ?? null,
    // Anything other than an explicit `true` is a dry run.
    dryRun: send !== true,
  });

  // Record that an EMAIL went out, so the log reflects it and a second click is a
  // visible re-send rather than a silent duplicate.
  //
  // emailQslSent, not qslSent: `qslSent` means a paper card, and setting it here
  // made the contact look fully answered — so it would be skipped when working
  // through the people who sent a card and want one back.
  if (result.sent) {
    await prisma.qso.update({
      where: { id: qsoId },
      data: { emailQslSent: true, emailQslSentAt: new Date() },
    });
  }

  sendJson(res, 200, result);
}

export default authedRoute({
  GET: { role: "ADMIN", handler: get },
  POST: { role: "OPERATOR", handler: post },
});
