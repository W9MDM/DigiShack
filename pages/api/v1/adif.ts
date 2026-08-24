import type { NextApiRequest, NextApiResponse } from "next";

import { BodyTooLargeError, readRawBody } from "@/lib/api/raw-body";
import { sendError, sendJson } from "@/lib/api/respond";
import { importAdifDocument } from "@/lib/adif/import-service";
import { authedRoute } from "@/lib/auth/guard";
import { importOptionsSchema } from "@/lib/validation/adif";

// Public ADIF ingest — the endpoint third-party tools should post to.
//
// Body is the raw ADIF document; options are query parameters, so a caller can
// POST a file directly without wrapping it in JSON:
//
//   curl -X POST 'https://host/api/v1/adif?stationId=…' \
//        -H 'Authorization: Bearer dsk_…' \
//        -H 'Content-Type: text/plain' \
//        --data-binary @log.adi
//
// Shares importAdifDocument() with the app's own import, so dedupe, band
// derivation and per-record problem reporting behave identically.

async function post(req: NextApiRequest, res: NextApiResponse) {
  const opts = importOptionsSchema.parse(req.query);

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
      "Request body is empty — send the ADIF document as the request body.",
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

export default authedRoute({
  POST: { role: "OPERATOR", handler: post, allowApiKey: true },
});

export const config = {
  api: {
    // Raw bytes — ADIF field lengths are byte counts, so nothing may decode and
    // re-encode the body first.
    bodyParser: false,
  },
};
