import type { NextApiRequest, NextApiResponse } from "next";
import { z } from "zod";

import { boolQuery } from "@/lib/validation/query";

import { sendError, sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import { syncLotwConfirmations } from "@/lib/integrations/lotw";
import { inStationFromQuery } from "@/lib/station/api-scope";

const querySchema = z.object({
  /** Report what would change without writing. Defaults to a dry run. */
  dryRun: boolQuery(true),
  /** Ignore the incremental marker and download the whole QSL history. */
  full: boolQuery(false),
  /** Restrict to one of your own callsigns. */
  ownCall: z.string().trim().toUpperCase().max(32).optional(),
});

// Downloads confirmations from LoTW and marks matching QSOs. Read-only against
// ARRL; the only writes are to our own `lotwRcvd` flags.
//
// dryRun defaults to TRUE: the first thing an operator should see is what would
// change, not a log that has already changed.
async function postForStation(req: NextApiRequest, res: NextApiResponse) {
  const opts = querySchema.parse(req.query);
  const outcome = await syncLotwConfirmations(opts);

  if (!outcome.ok) {
    sendError(res, 502, outcome.error);
    return;
  }

  sendJson(res, 200, outcome.report);
}

/** For the station in `?stationId=` (its own accounts and contacts), else the home station. */
async function post(req: NextApiRequest, res: NextApiResponse) {
  const r = await inStationFromQuery(req, () => postForStation(req, res));
  if (!r.ok) sendJson(res, 404, { error: "No such station" });
}

export default authedRoute({ POST: { role: "ADMIN", handler: post } });
