import type { NextApiRequest, NextApiResponse } from "next";
import { z } from "zod";

import { boolQuery } from "@/lib/validation/query";

import { sendError, sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import { importQrzLogbook } from "@/lib/integrations/qrz-import";

const querySchema = z.object({
  stationId: z.string().min(1, "stationId is required"),
  operatorId: z.string().min(1).optional(),
  /** Defaults to a dry run — see /api/integrations/lotw-sync for the reasoning. */
  dryRun: boolQuery(true),
  maxPages: z.coerce.number().int().min(1).max(50).default(1),
  /**
   * Omit for a differential download, which resumes where the last one finished.
   * Pass 0 to deliberately re-read the whole logbook.
   *
   * It used to default to 0, so every call re-downloaded everything.
   */
  afterLogId: z.coerce.number().int().min(0).optional(),
});

// Read-only against QRZ: only FETCH is called. Writes go to the local log.
async function post(req: NextApiRequest, res: NextApiResponse) {
  const opts = querySchema.parse(req.query);
  const report = await importQrzLogbook(opts);

  if (report.stoppedBecause === "error") {
    sendError(res, 502, report.error ?? "QRZ import failed", { report });
    return;
  }

  sendJson(res, 200, report);
}

export default authedRoute({ POST: { role: "ADMIN", handler: post } });
