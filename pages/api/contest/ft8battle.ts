import type { NextApiRequest, NextApiResponse } from "next";

import { sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import { prisma } from "@/lib/db/prisma";
import {
  deriveClaims,
  serializeClaim,
  serializeEvent,
  type FeedEvent,
  type FeedEventType,
  type FeedSource,
  type Ft8brFeedResponse,
} from "@/lib/contest/ft8battle-feed";

// The Battle Royale feed the bridge has been keeping, and who holds what today.
//
// Two things for the decodes page in BR mode: the last couple of hours of events, to show,
// and the day's holdings, to score with. The holdings are derived here from every event of
// the UTC day rather than only the hours asked for, because a station somebody worked at
// 02:00 is still claimed - and still stealable - at 22:00.
//
// VIEWER, like the switches: it is a view of a public feed, and showing it changes nothing
// about what the station does.

async function get(req: NextApiRequest, res: NextApiResponse) {
  const asked = Number(req.query.hours ?? 2);
  const hours = Math.min(24, Math.max(1, Number.isFinite(asked) ? asked : 2));
  const now = new Date();
  const since = new Date(now.getTime() - hours * 3_600_000);
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  const rows = await prisma.ft8brActivity.findMany({
    where: { at: { gte: since < dayStart ? since : dayStart } },
    orderBy: { at: "desc" },
    take: 4000,
  });
  const events: FeedEvent[] = rows.map((r) => ({
    at: r.at,
    type: r.type as FeedEventType,
    station: r.station,
    contact: r.contact,
    band: r.band,
    mode: r.mode,
    points: r.points,
    victim: r.victim,
    stolen: r.stolen,
    first: r.first,
    source: r.source as FeedSource,
  }));

  const { claims, claimedBands } = deriveClaims(events, now);
  const body: Ft8brFeedResponse = {
    activity: events.filter((e) => e.at >= since).map(serializeEvent),
    claims: [...claims.values()].map(serializeClaim),
    claimedBands: [...claimedBands],
    updatedAt: now.toISOString(),
  };
  sendJson(res, 200, body);
}

export default authedRoute({
  GET: { role: "VIEWER", handler: get },
});
