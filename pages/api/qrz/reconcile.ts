import type { NextApiRequest, NextApiResponse } from "next";
import { z } from "zod";

import { sendError, sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import { prisma } from "@/lib/db/prisma";
import { parseIncomingPaste } from "@/lib/qrz/incoming-paste";
import { reconcileRequests, tally } from "@/lib/qrz/reconcile";

// Compare a pasted QRZ incoming-request list against the log.
//
// READ ONLY. It changes nothing — the verdicts are advice, and acting on one is a separate,
// explicit POST to /api/incomplete/[id]. That separation is deliberate: this endpoint is the
// place an operator pastes 130 lines to see where they stand, and it must be safe to run twice.
//
// A paste rather than an API call because QRZ has no API for this queue: `REQUESTS`, `QSLREQ`
// and `INCOMING` all answer `unrecognized command`, and the documented actions are STATUS,
// FETCH, INSERT and DELETE.

const bodySchema = z.object({
  // 500 kB: a year of requests pasted with the surrounding page furniture is a few tens of kB.
  paste: z.string().max(500_000),
});

async function post(req: NextApiRequest, res: NextApiResponse) {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 400, "Bad request", parsed.error.flatten().fieldErrors);
    return;
  }

  const read = parseIncomingPaste(parsed.data.paste);
  if (read.requests.length === 0) {
    sendJson(res, 200, {
      requests: [],
      unread: read.unread,
      duplicates: read.duplicates,
      tally: { "in-log": 0, promotable: 0, "wrong-date": 0, unknown: 0 },
    });
    return;
  }

  // Cached per callsign. A list of 130 requests contains the same station several times, and
  // each lookup is two indexed queries — worth not repeating.
  const qsoCache = new Map<string, Awaited<ReturnType<typeof loadQsos>>>();
  const incCache = new Map<string, Awaited<ReturnType<typeof loadIncomplete>>>();

  const rows = await reconcileRequests(read.requests, {
    qsosFor: async (call) => {
      const hit = qsoCache.get(call);
      if (hit) return hit;
      const v = await loadQsos(call);
      qsoCache.set(call, v);
      return v;
    },
    incompleteFor: async (call) => {
      const hit = incCache.get(call);
      if (hit) return hit;
      const v = await loadIncomplete(call);
      incCache.set(call, v);
      return v;
    },
  });

  sendJson(res, 200, {
    requests: rows,
    unread: read.unread,
    duplicates: read.duplicates,
    tally: tally(rows),
  });
}

function loadQsos(callsign: string) {
  return prisma.qso.findMany({
    where: { callsign },
    select: { id: true, startTime: true, band: true, mode: true, qrzSent: true },
    orderBy: { startTime: "asc" },
  });
}

function loadIncomplete(callsign: string) {
  return prisma.incompleteExchange.findMany({
    where: { callsign },
    select: {
      id: true,
      startedAt: true,
      band: true,
      mode: true,
      reportSent: true,
      reportRcvd: true,
      promotedQsoId: true,
      dismissedAt: true,
    },
    orderBy: { startedAt: "asc" },
  });
}

export default authedRoute({ POST: { role: "OPERATOR", handler: post } });
