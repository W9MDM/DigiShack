import type { NextApiRequest, NextApiResponse } from "next";
import { z } from "zod";

import { sendError, sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import {
  UPLOADABLE,
  qsoDestinations,
  runUploads,
  type UploadableService,
} from "@/lib/integrations/upload-runner";

// Where one contact went, and sending it again.
//
// > "need a way on a contact in the log to reprocess, like if it didnt hit any logs so if
// >  they open the contact and hit reprocess they pick which logging softwares or
// >  integrations to send it to again"
//
// The flags were always on the row and nothing ever rendered them, so a contact that
// reached nothing looked exactly like one that reached everything — and the only remedy
// was a sweep, which skips anything already marked sent and therefore cannot fix the case
// where the mark is the thing that is wrong.
//
// GET answers where it stands. POST sends it to the services named in the body, bypassing
// the sent flag, the cutoff, the eQSL reciprocal rule and the failure breaker — every one
// of which is restraint about sending things UNASKED, and somebody has just asked.
//
// It is a genuine upload, not a flag flip: the record goes to the service and the answer
// comes back per service, duplicates included. A service that answers "duplicate" is
// reported as such rather than as a failure, because that answer means the contact IS
// there — which is exactly what the operator wanted to find out.

async function get(req: NextApiRequest, res: NextApiResponse) {
  const id = typeof req.query.id === "string" ? req.query.id : "";
  const rows = await qsoDestinations(id);
  if (!rows) {
    sendError(res, 404, "No such QSO");
    return;
  }
  sendJson(res, 200, { destinations: rows });
}

const bodySchema = z.object({
  // At least one, because "reprocess to nothing" is a no-op that would report success and
  // teach the operator that the button does nothing.
  services: z.array(z.enum(UPLOADABLE)).min(1),
});

async function post(req: NextApiRequest, res: NextApiResponse) {
  const id = typeof req.query.id === "string" ? req.query.id : "";
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendError(res, 400, "Pick at least one destination", parsed.error.flatten().fieldErrors);
    return;
  }

  // Confirm the contact exists BEFORE uploading. `runUploads` with an id that matches
  // nothing finds no rows and reports a clean run of zero — success, for a contact that
  // does not exist.
  const before = await qsoDestinations(id);
  if (!before) {
    sendError(res, 404, "No such QSO");
    return;
  }

  const result = await runUploads({
    qsoIds: [id],
    services: parsed.data.services as UploadableService[],
  });

  sendJson(res, 200, { ...result, destinations: await qsoDestinations(id) });
}

export default authedRoute({
  GET: { role: "VIEWER", handler: get },
  // OPERATOR, matching every other route that talks to somebody else's log. This puts a
  // record into services other people read.
  POST: { role: "OPERATOR", handler: post },
});
