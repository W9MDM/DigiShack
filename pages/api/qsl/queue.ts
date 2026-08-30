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
import { getBooleanSetting, getNumberSetting } from "@/lib/settings";

// GET  /api/qsl/queue  — the queue, plus candidates worth queuing
// POST /api/qsl/queue  — enqueue / approve / skip / send
//
// Sending is a separate, explicit action from approving, and approving is
// separate from queuing. Three deliberate steps for outbound unsolicited mail.

/**
 * What a caller needs in order to say whether anything will send this queue.
 *
 * THE FAULT. A queue sitting unsent because nothing is sending looks EXACTLY like a queue
 * waiting for somebody to review it — same rows, same badges, same counts. The difference is
 * invisible and lives entirely in settings and in whether a separate process is up.
 *
 * The same shape as `sweeper` in pages/api/uploads/index.ts and `collectorState` in
 * pages/api/psk-spots.ts: the only thing that ever calls `runAutoQsl` is a timer inside the
 * radio service, so an installation not running it sends nothing, ever, and no page said so.
 *
 * Note `autoApprove` is a real third state and not a detail. With `qsl.auto.enabled` on and
 * `qsl.auto.approve` off, the timer QUEUES and never sends — the queue GROWS while nothing
 * leaves it, which is the most confusing configuration of the lot and the easiest to reach.
 */
export interface QslSenderCheck {
  /** `qsl.auto.enabled` — the timer that queues candidates. */
  enabled: boolean;
  /** `qsl.auto.approve` — without it the timer approves and sends nothing at all. */
  autoApprove: boolean;
  /** Is the radio service — the only thing that runs the timer — answering? */
  running: boolean;
  /** `qsl.auto.intervalMinutes`, for the sentence. */
  intervalMinutes: number;
  /** `bridge.port`, so the message names the address that was tried. */
  port: number;
}

export interface QslSenderStatus extends QslSenderCheck {
  /** True only when something will send an approved message with nobody watching. */
  sending: boolean;
  /** One sentence for the page. Empty ONLY when something really is sending. */
  detail: string;
}

/**
 * One sentence for the QSL page, ordered by what to fix FIRST.
 *
 * The ordering is the load-bearing part. Telling an operator "the radio service is not
 * running" when they have never switched automatic emailing on points them at the wrong
 * thing entirely — and automatic emailing being off is not a fault, it is the deliberate
 * default for unsolicited mail, so it has to be reported as a fact rather than as an error.
 *
 * Empty is reserved for "switched on, approving on its own, and something is running it".
 * Anything short of that gets a sentence, because the alternative is a queue that silently
 * never empties.
 */
export function qslSenderDetail(s: QslSenderCheck): string {
  if (!s.enabled) {
    return (
      "Automatic QSL emailing is off, so nothing here goes out on its own — an approved " +
      "message waits until somebody presses Send. That is the deliberate default for " +
      "unsolicited mail, not a fault; Settings → QSL → automatic QSL emailing changes it."
    );
  }
  if (!s.running) {
    return (
      `Nothing is sending. Automatic QSL emailing runs inside the radio service, and it is ` +
      `not answering on 127.0.0.1:${s.port} — so approved messages sit here however the ` +
      `settings are configured, and nothing new is queued either. Start it ` +
      `(pm2 start digishack-bridge, or npm run bridge), or press Send below.`
    );
  }
  if (!s.autoApprove) {
    return (
      `The radio service is queuing contacts every ${s.intervalMinutes} min, but sending ` +
      `without review is off — so it approves nothing and sends nothing. Everything below is ` +
      `waiting for a person, which is what this configuration means rather than a failure.`
    );
  }
  return "";
}

/**
 * Is the radio service answering?
 *
 * A local copy — uploads, psk-spots and the integrations status each have their own. The
 * shared-helper version would end up imported by the bridge, which would then be asking
 * itself over TCP whether it exists.
 */
async function bridgeUp(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/status`, {
      signal: AbortSignal.timeout(2_000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

async function qslSenderStatus(): Promise<QslSenderStatus> {
  const [enabled, autoApprove, intervalMinutes, port] = await Promise.all([
    getBooleanSetting("qsl.auto.enabled", false),
    getBooleanSetting("qsl.auto.approve", false),
    getNumberSetting("qsl.auto.intervalMinutes", 30),
    getNumberSetting("bridge.port", 3101),
  ]);
  const check: QslSenderCheck = {
    enabled,
    autoApprove,
    running: await bridgeUp(port),
    intervalMinutes,
    port,
  };
  return {
    ...check,
    // All three, because `runAutoQsl` returns before `sendApprovedQsls` unless every one of
    // them holds. Two out of three sends exactly as much mail as none of them.
    sending: check.enabled && check.autoApprove && check.running,
    detail: qslSenderDetail(check),
  };
}

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

  const [queue, counts, candidates, sender] = await Promise.all([
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
    qslSenderStatus(),
  ]);

  sendJson(res, 200, {
    queue,
    counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
    candidates,
    // Whether anything will send any of the above. Without this the page can only show what
    // is in the queue, which is the half of the picture that never explains itself.
    sender,
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
