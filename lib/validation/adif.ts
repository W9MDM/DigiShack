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
});

export type ImportOptionsInput = z.infer<typeof importOptionsSchema>;
