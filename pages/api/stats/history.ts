import type { NextApiRequest, NextApiResponse } from "next";

import { sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import { computeHistory } from "@/lib/stats/history";

// Per-year figures, most-worked stations, and the mode/band/continent breakdowns.
//
// VIEWER, like the rest of the read-only log views: these are counts from a log a viewer can
// already page through, so gating them higher would hide a summary of data they can see in
// full.

async function get(req: NextApiRequest, res: NextApiResponse) {
  const raw = typeof req.query.top === "string" ? Number(req.query.top) : NaN;
  const report = await computeHistory({
    topCalls: Number.isFinite(raw) ? raw : undefined,
  });
  sendJson(res, 200, report);
}

export default authedRoute({ GET: { role: "VIEWER", handler: get } });
