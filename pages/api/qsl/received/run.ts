import type { NextApiRequest, NextApiResponse } from "next";
import { z } from "zod";

import { sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import { API_HEAVY_LIMIT } from "@/lib/auth/throttle";
import { runInboundImport, testInbound } from "@/lib/qsl/inbound/run";

// POST /api/qsl/received/run — { action: "import" } or { action: "test" }
//
// "import" runs one pass now, in this process, whether or not the timer is switched on —
// pressing the button is the decision. The database lock in runInboundImport keeps it from
// racing the radio service's timer.
//
// "test" signs in and counts the Inbox. It reads no message and imports nothing.
//
// Both reach Microsoft, so both are ADMIN and on the heavy budget: a few a minute is plenty
// for a person, and a script hammering this would be hammering the tenant.

const body = z.object({ action: z.enum(["import", "test"]) });

async function post(req: NextApiRequest, res: NextApiResponse) {
  const { action } = body.parse(req.body);
  if (action === "test") {
    const r = await testInbound();
    sendJson(res, 200, r);
    return;
  }
  const r = await runInboundImport({ manual: true });
  sendJson(res, 200, {
    ran: r.ran,
    reason: r.reason ?? null,
    summary: r.summary ?? null,
    error: r.report?.error ?? null,
  });
}

export default authedRoute({ POST: { role: "ADMIN", qsl: true, handler: post, rateLimit: API_HEAVY_LIMIT } });
