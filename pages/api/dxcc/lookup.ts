import type { NextApiRequest, NextApiResponse } from "next";
import { z } from "zod";

import { sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import { resolveDxcc } from "@/lib/dxcc/resolve";

const querySchema = z.object({
  callsign: z.string().trim().min(1).max(32),
  /** QSO date, so historical contacts resolve against the entity of the day. */
  at: z.coerce.date().optional(),
});

// VIEWER: this is a read against reference data, and the entry form calls it on
// every callsign. Returns 200 with a status rather than 404 for "no match" —
// "unknown entity" is a normal answer for a callsign, not a request failure.
async function get(req: NextApiRequest, res: NextApiResponse) {
  const { callsign, at } = querySchema.parse(req.query);
  const result = await resolveDxcc(callsign, at ?? new Date());

  sendJson(res, 200, {
    callsign: callsign.toUpperCase(),
    ...result,
  });
}

export default authedRoute({ GET: { role: "VIEWER", handler: get } });
