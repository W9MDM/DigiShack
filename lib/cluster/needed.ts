// Which spots this log still needs: a new DXCC entity, a new band for one, a new mode for one.
//
// Two GROUP BY queries — entity x band and entity x mode — rather than reading QSO rows, and
// cached for five minutes, because spots arrive several a second and the answer only changes
// when a contact is logged. lib/awards/compute.ts answers the same question for the Awards
// page but loads every row to do it, which is right for a page and wrong per spot;
// lib/digital/worked-index.ts is per band and has no entity-by-mode table.
//
// QSOs with no `dxcc` are not counted. A log that was never backfilled from the DXCC page
// therefore shows entities as needed that are not — which is the backfill's job to fix, not a
// reason to guess here.

import { prisma } from "@/lib/db/prisma";
import { slotsFromRows, type WorkedSlots } from "@/lib/cluster/slots";

const TTL_MS = 5 * 60_000;
/** After a failed read, how long before asking the database again. */
const RETRY_MS = 60_000;

let cached: { at: number; slots: WorkedSlots } | null = null;
let inflight: Promise<WorkedSlots | null> | null = null;
let failedAt = 0;

/** The log's worked slots, or null when the log cannot be read. Never throws. */
export async function workedSlots(): Promise<WorkedSlots | null> {
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) return cached.slots;
  if (inflight) return inflight;
  // A stale answer is better than none while the database is away, and asking again on
  // every spot would turn an outage into a query storm.
  if (now - failedAt < RETRY_MS) return cached?.slots ?? null;

  inflight = (async () => {
    try {
      const [bandRows, modeRows] = await Promise.all([
        prisma.qso.groupBy({ by: ["dxcc", "band"], where: { dxcc: { not: null } } }),
        prisma.qso.groupBy({ by: ["dxcc", "mode"], where: { dxcc: { not: null } } }),
      ]);
      const slots = slotsFromRows(bandRows, modeRows);
      cached = { at: Date.now(), slots };
      return slots;
    } catch (err) {
      failedAt = Date.now();
      console.error("[cluster] reading worked slots failed:", err instanceof Error ? err.message : err);
      return cached?.slots ?? null;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
