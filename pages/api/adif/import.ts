import type { NextApiRequest, NextApiResponse } from "next";

import { BodyTooLargeError, readRawBody } from "@/lib/api/raw-body";
import { sendError, sendJson } from "@/lib/api/respond";
import { importAdifDocument } from "@/lib/adif/import-service";
import { authedRoute } from "@/lib/auth/guard";
import { importOptionsSchema } from "@/lib/validation/adif";

async function post(req: NextApiRequest, res: NextApiResponse) {
  const opts = importOptionsSchema.parse(req.query);

  // The ADIF document is the raw request body. Options travel in the query
  // string so a 20 MB logbook doesn't have to be JSON-escaped into a field.
  //
  // Read as a Buffer and handed to the parser as bytes: ADIF field lengths are
  // byte counts, so letting anything decode and re-encode the body first is a
  // route to exactly the record-swallowing bug fixed in 0.4.1.
  let raw: Buffer;
  try {
    raw = await readRawBody(req, { maxBytes: 64 * 1024 * 1024 });
  } catch (err) {
    sendError(
      res,
      413,
      err instanceof BodyTooLargeError ? err.message : "Could not read the upload",
    );
    return;
  }

  if (raw.length === 0) {
    sendError(
      res,
      400,
      "Request body is empty — POST the ADIF file contents as text/plain",
    );
    return;
  }

  const outcome = await importAdifDocument(raw, opts);
  if (!outcome.ok) {
    sendError(res, outcome.status, outcome.error, outcome.details);
    return;
  }

  sendJson(res, 200, outcome.report);
}

export default authedRoute({ POST: { role: "OPERATOR", handler: post } });

export const config = {
  api: {
    // Raw bytes, not a decoded string — see readRawBody. The 64 MB ceiling is
    // enforced there; keep NGINX's client_max_body_size at least as large
    // (deploy/nginx/digishack.conf sets 64m).
    bodyParser: false,
  },
};
