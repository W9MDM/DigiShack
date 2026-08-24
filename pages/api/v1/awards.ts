import type { NextApiRequest, NextApiResponse } from "next";
import { z } from "zod";

import { sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import { computeAwards } from "@/lib/awards/compute";

const querySchema = z.object({
  stationId: z.string().optional(),
  band: z.string().trim().toUpperCase().optional(),
  mode: z.string().trim().toUpperCase().optional(),
});

async function get(req: NextApiRequest, res: NextApiResponse) {
  sendJson(res, 200, await computeAwards(querySchema.parse(req.query)));
}

export default authedRoute({
  GET: { role: "VIEWER", handler: get, allowApiKey: true },
});
