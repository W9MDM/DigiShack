import type { NextApiRequest, NextApiResponse } from "next";
import { z } from "zod";

import { sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import { findDuplicate } from "@/lib/db/qso";

const querySchema = z.object({
  callsign: z.string().trim().toUpperCase().min(1),
  band: z.string().trim().toUpperCase().min(1),
  mode: z.string().trim().toUpperCase().min(1),
  excludeId: z.string().optional(),
});

// Called from the entry form as the operator leaves the callsign field. A "dupe"
// here is advisory only — worked-before on the same band and mode. It never
// blocks logging, because a second QSO on a different day is perfectly valid.
async function get(req: NextApiRequest, res: NextApiResponse) {
  const q = querySchema.parse(req.query);
  const previous = await findDuplicate(q);

  sendJson(res, 200, {
    duplicate: previous !== null,
    previous,
  });
}

export default authedRoute({ GET: { role: "VIEWER", handler: get } });
