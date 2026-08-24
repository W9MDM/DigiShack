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
  const filter = querySchema.parse(req.query);
  sendJson(res, 200, await computeAwards(filter));
}

export default authedRoute({ GET: { role: "VIEWER", handler: get } });
