import type { NextApiRequest, NextApiResponse } from "next";
import { z } from "zod";

import { sendError, sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import type { AuthContext } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import {
  approveQsl,
  enqueueQsl,
  findQslCandidates,
  requeueGatewayAffected,
  sendApprovedQsls,
  skipQsl,
} from "@/lib/qsl/queue";

// GET  /api/qsl/queue  — the queue, plus candidates worth queuing
// POST /api/qsl/queue  — enqueue / approve / skip / send
//
// Sending is a separate, explicit action from approving, and approving is
// separate from queuing. Three deliberate steps for outbound unsolicited mail.

const postSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("enqueue"),
    qsoIds: z.array(z.string().min(1)).min(1).max(100),
    note: z.string().trim().max(500).nullish(),
  }),
  // Send one contact's card again, from the log. Separate from `enqueue` because it
  // deliberately overrides the already-sent guard, and that override should be something a
  // caller asks for by name rather than a flag that could be set by accident on a batch.
  z.object({ action: z.literal("resend"), qsoId: z.string().min(1) }),
  z.object({ action: z.literal("approve"), ids: z.array(z.string().min(1)).min(1).max(500) }),
  z.object({ action: z.literal("skip"), ids: z.array(z.string().min(1)).min(1).max(500) }),
  z.object({ action: z.literal("send"), limit: z.number().int().min(1).max(100).optional() }),
  // Re-send QSLs that went out before the gateway rules existed. `dryRun` reports
  // what would happen without touching anything, because this rewrites rows that
  // currently read SENT.
  z.object({
    action: z.literal("requeue-gateways"),
    dryRun: z.boolean().optional(),
    limit: z.number().int().min(1).max(1000).optional(),
    // Omitted means the safe default: only what is known undeliverable. arrl.net
    // has to be asked for by name — see requeueGatewayAffected.
    reasons: z.array(z.enum(["placeholder", "winlink", "arrl"])).min(1).optional(),
  }),
]);

async function get(req: NextApiRequest, res: NextApiResponse) {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;

  const [queue, counts, candidates] = await Promise.all([
    prisma.qslEmail.findMany({
      where: status ? { status: status as never } : { status: { not: "SKIPPED" } },
      orderBy: { createdAt: "asc" },
      take: 200,
      include: {
        qso: { select: { band: true, mode: true, startTime: true, gridSquare: true } },
        approvedBy: { select: { name: true } },
      },
    }),
    prisma.qslEmail.groupBy({ by: ["status"], _count: { _all: true } }),
    findQslCandidates({ limit: 25 }),
  ]);

  sendJson(res, 200, {
    queue,
    counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
    candidates,
  });
}

async function post(req: NextApiRequest, res: NextApiResponse, auth: AuthContext) {
  const parsed = postSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 400, "Bad queue request", parsed.error.flatten().fieldErrors);
    return;
  }
  const body = parsed.data;

  switch (body.action) {
    case "enqueue": {
      // Sequential: each one is a QRZ lookup, and QRZ asks not to be hammered.
      const results = [];
      for (const id of body.qsoIds) {
        results.push(await enqueueQsl(id, { note: body.note }));
      }
      sendJson(res, 200, { results });
      return;
    }
    case "resend": {
      // NO NOTE. `note` is rendered INTO the message the recipient reads — it is the
      // operator's personal line, not an audit field — so "re-sent by ..." would be
      // addressed to the wrong person entirely. The re-send is visible in the queue.
      const result = await enqueueQsl(body.qsoId, { force: true });
      sendJson(res, 200, { result });
      return;
    }
    case "approve": {
      const count = await approveQsl(body.ids, auth.user.id);
      sendJson(res, 200, { approved: count });
      return;
    }
    case "skip": {
      const count = await skipQsl(body.ids);
      sendJson(res, 200, { skipped: count });
      return;
    }
    case "send": {
      const result = await sendApprovedQsls({ limit: body.limit });
      sendJson(res, 200, result);
      return;
    }
    case "requeue-gateways": {
      const result = await requeueGatewayAffected({
        dryRun: body.dryRun,
        limit: body.limit,
        reasons: body.reasons,
      });
      sendJson(res, 200, result);
      return;
    }
  }
}

export default authedRoute({
  GET: { role: "OPERATOR", handler: get },
  POST: { role: "ADMIN", handler: post },
});
