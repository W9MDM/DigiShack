import type { NextApiRequest, NextApiResponse } from "next";

import { sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import { computeStatsSummary } from "@/lib/stats/summary";

async function get(_req: NextApiRequest, res: NextApiResponse) {
  sendJson(res, 200, await computeStatsSummary());
}

export default authedRoute({ GET: { role: "VIEWER", handler: get } });
