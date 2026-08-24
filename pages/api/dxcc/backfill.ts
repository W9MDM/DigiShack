import type { NextApiRequest, NextApiResponse } from "next";
import { z } from "zod";

import { boolQuery } from "@/lib/validation/query";

import { sendError, sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import { isDxccDataLoaded, resolveDxcc } from "@/lib/dxcc/resolve";
import { prisma } from "@/lib/db/prisma";

const querySchema = z.object({
  /** Report what would change without writing. */
  dryRun: boolQuery(false),
  /**
   * Also revisit QSOs that already have a dxcc value. Off by default: a
   * hand-entered or LoTW-supplied code is more trustworthy than a prefix guess.
   */
  overwrite: boolQuery(false),
  limit: z.coerce.number().int().min(1).max(100_000).default(50_000),
});

/** Rows per pass. */
const BATCH = 500;

// Fills Qso.dxcc for contacts that lack it, resolving each against the entity
// that was valid at the QSO's own date rather than today's.
async function post(req: NextApiRequest, res: NextApiResponse) {
  const { dryRun, overwrite, limit } = querySchema.parse(req.query);

  if (!(await isDxccDataLoaded())) {
    sendError(
      res,
      409,
      "No DXCC data loaded. Fetch or upload cty.xml first.",
    );
    return;
  }

  // Candidates are QSOs missing ANY of the three values cty.xml can supply, not
  // just dxcc — a contact imported with a DXCC code but no CQ zone still can't
  // count toward WAZ.
  const where = overwrite
    ? {}
    : {
        OR: [{ dxcc: null }, { cqZone: null }, { continent: null }],
      };

  const total = await prisma.qso.count({ where });

  let examined = 0;
  let resolved = 0;
  let unchanged = 0;
  let unresolved = 0;
  const samples: { callsign: string; adif: number; name: string }[] = [];
  const misses: string[] = [];

  // Cache per callsign+year: a run of FT8 contacts with the same station would
  // otherwise re-resolve identically hundreds of times.
  type Resolved = { adif: number; cqZone: number | null; continent: string | null };
  const cache = new Map<string, Resolved | null>();

  let cursor: string | undefined;

  while (examined < Math.min(total, limit)) {
    const batch = await prisma.qso.findMany({
      where,
      select: {
        id: true,
        callsign: true,
        startTime: true,
        dxcc: true,
        cqZone: true,
        continent: true,
      },
      orderBy: { id: "asc" },
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });

    if (batch.length === 0) break;
    cursor = batch[batch.length - 1]?.id;

    for (const qso of batch) {
      examined++;

      const key = `${qso.callsign}|${qso.startTime.getUTCFullYear()}`;
      let hit = cache.get(key);

      if (hit === undefined) {
        const result = await resolveDxcc(qso.callsign, qso.startTime);
        hit =
          result.status === "found"
            ? {
                adif: result.match.adif,
                cqZone: result.match.cqZone,
                continent: result.match.continent,
              }
            : null;
        cache.set(key, hit);

        if (hit && samples.length < 10) {
          samples.push({
            callsign: qso.callsign,
            adif: hit.adif,
            name: result.status === "found" ? result.match.name : "",
          });
        }
      }

      if (hit === null) {
        unresolved++;
        if (misses.length < 50 && !misses.includes(qso.callsign)) {
          misses.push(qso.callsign);
        }
        continue;
      }

      // Fill only what's missing, unless explicitly overwriting: a code already
      // present came from LoTW or an operator and outranks a prefix guess.
      const data: {
        dxcc?: number;
        cqZone?: number | null;
        continent?: string | null;
      } = {};

      if (overwrite || qso.dxcc === null) {
        if (qso.dxcc !== hit.adif) data.dxcc = hit.adif;
      }
      if ((overwrite || qso.cqZone === null) && hit.cqZone !== null) {
        if (qso.cqZone !== hit.cqZone) data.cqZone = hit.cqZone;
      }
      if ((overwrite || qso.continent === null) && hit.continent !== null) {
        if (qso.continent !== hit.continent) data.continent = hit.continent;
      }

      if (Object.keys(data).length === 0) {
        unchanged++;
        continue;
      }

      if (!dryRun) {
        await prisma.qso.update({ where: { id: qso.id }, data });
      }
      resolved++;
    }
  }

  sendJson(res, 200, {
    dryRun,
    overwrite,
    candidates: total,
    examined,
    resolved,
    unchanged,
    unresolved,
    distinctCallsignsResolved: cache.size,
    samples,
    unresolvedCallsigns: misses,
  });
}

export default authedRoute({ POST: { role: "ADMIN", handler: post } });
