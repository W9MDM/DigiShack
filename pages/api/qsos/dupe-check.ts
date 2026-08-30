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
  /**
   * Narrow the search to contacts at or after this instant.
   *
   * Sent by the entry form while an activation is in progress, set to the UTC day
   * boundary — because during an activation the only dupe that means anything is a
   * repeat inside THIS activation, and the all-time answer fires on a large share of
   * callers and is therefore read by nobody.
   *
   * OPTIONAL, and an unparseable value is dropped rather than rejected: the whole check
   * is advisory, and answering 400 would turn a hint into an outage on the logging page.
   */
  since: z.coerce.date().optional().catch(undefined),
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
    // What was actually searched, so the form can word the badge honestly instead of
    // claiming an all-time answer it did not ask for.
    scope: q.since ? "session" : "all-time",
  });
}

export default authedRoute({ GET: { role: "VIEWER", handler: get } });
