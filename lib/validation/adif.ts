import { z } from "zod";

import { boolQuery } from "@/lib/validation/query";

/** Query options shared by /api/adif/import and /api/v1/adif. */
export const importOptionsSchema = z.object({
  /** Station every imported QSO is attributed to. */
  stationId: z.string().min(1, "stationId is required"),
  /**
   * Fallback operator for records whose OPERATOR field doesn't match anyone at
   * the station. Records that DO match are linked to that operator regardless.
   */
  operatorId: z.string().min(1).optional(),
  /** Parse and report without writing. */
  dryRun: boolQuery(false),
  /** Skip QSOs already in the log. Off means import everything. */
  dedupe: boolQuery(true),
  /**
   * Queue the imported contacts for upload to QRZ, Club Log, Cloudlog and N3FJP.
   *
   * DEFAULTS TO FALSE. An imported log is history and is already wherever it was going to
   * be — usually the very service it was exported from. Defaulting the other way sent one
   * operator's 7,384-contact QRZ log to N3FJP, which already had every one of them, and
   * left him with 14,347. See ImportOptions.uploadImported.
   *
   * The default matters more here than in most places, because the damage lands on
   * somebody else's service and cannot be undone from this application.
   */
  uploadImported: boolQuery(false),
});

export type ImportOptionsInput = z.infer<typeof importOptionsSchema>;
