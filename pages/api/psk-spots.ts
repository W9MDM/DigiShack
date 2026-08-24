// Who has heard this station lately.
//
// The per-contact "Heard by" panel answers a narrow question, and most reception reports
// cannot answer it at all: a CQ nobody replied to produced no contact to hang them on. Those
// reports are the interesting ones for an antenna, though — a CQ heard 6,000 km away says
// the station is working whether or not anybody came back.
//
// Aggregated here rather than in the browser. A busy hour is thousands of rows and the
// answer is a few dozen receivers.

import type { NextApiRequest, NextApiResponse } from "next";
import { z } from "zod";

import { sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import { prisma } from "@/lib/db/prisma";
import { freqToBand } from "@/lib/ham/bands";
import { distanceKm, gridToLatLon } from "@/lib/propagation";

const querySchema = z.object({
  /** How far back to look. A day at most: this is a live view, not a history. */
  minutes: z.coerce.number().int().min(5).max(1_440).default(60),
  limit: z.coerce.number().int().min(1).max(200).default(40),
});

export interface HeardByReceiver {
  receiverCall: string;
  receiverGrid: string | null;
  /** Best report they gave us in the window. */
  bestSnr: number | null;
  reports: number;
  lastAt: string;
  band: string | null;
  km: number | null;
}

export interface HeardByResponse {
  since: string;
  receivers: HeardByReceiver[];
  /** Every receiver in the window, not only the ones returned. */
  totalReceivers: number;
  totalReports: number;
  /** The furthest receiver with a readable grid, which is the antenna's headline number. */
  furthest: { receiverCall: string; km: number } | null;
  truncated: boolean;
}

async function get(req: NextApiRequest, res: NextApiResponse) {
  const { minutes, limit } = querySchema.parse(req.query);
  const since = new Date(Date.now() - minutes * 60_000);

  const station = await prisma.station.findFirst({
    orderBy: { createdAt: "asc" },
    select: { grid: true },
  });
  const home = station?.grid ? gridToLatLon(station.grid) : null;

  const rows = await prisma.pskSpot.findMany({
    where: { reportedAt: { gte: since } },
    select: { receiverCall: true, receiverGrid: true, snr: true, freqHz: true, reportedAt: true },
    orderBy: { reportedAt: "desc" },
    // A bound, because this is a live panel and an unbounded read of a busy day is a
    // request that can take the page down rather than render slowly.
    take: 20_000,
  });

  const byCall = new Map<string, HeardByReceiver>();
  for (const r of rows) {
    const existing = byCall.get(r.receiverCall);
    const band = freqToBand(Number(r.freqHz));
    if (!existing) {
      const grid = r.receiverGrid;
      const there = grid ? gridToLatLon(grid) : null;
      byCall.set(r.receiverCall, {
        receiverCall: r.receiverCall,
        receiverGrid: grid,
        bestSnr: r.snr,
        reports: 1,
        // Rows arrive newest first, so the first one seen for a receiver is their latest.
        lastAt: r.reportedAt.toISOString(),
        band,
        km: home && there ? Math.round(distanceKm(home, there)) : null,
      });
      continue;
    }
    existing.reports++;
    // A missing SNR is not a bad one: some modes carry no report, and treating absent as
    // -infinity would let a report with no number beat a real one.
    if (r.snr !== null && (existing.bestSnr === null || r.snr > existing.bestSnr)) {
      existing.bestSnr = r.snr;
    }
    if (existing.receiverGrid === null && r.receiverGrid) {
      existing.receiverGrid = r.receiverGrid;
      const there = gridToLatLon(r.receiverGrid);
      existing.km = home && there ? Math.round(distanceKm(home, there)) : null;
    }
  }

  const all = [...byCall.values()];
  // Furthest is computed over everything, not over the page returned — a distance record
  // that changed with the page size would be worthless.
  const furthest = all.reduce<{ receiverCall: string; km: number } | null>((best, r) => {
    if (r.km === null) return best;
    if (!best || r.km > best.km) return { receiverCall: r.receiverCall, km: r.km };
    return best;
  }, null);

  // Strongest first: this panel is read to answer "is the antenna working", and the best
  // report in the window is the closest thing to an answer.
  all.sort((a, b) => (b.bestSnr ?? -99) - (a.bestSnr ?? -99));

  const body: HeardByResponse = {
    since: since.toISOString(),
    receivers: all.slice(0, limit),
    totalReceivers: all.length,
    totalReports: rows.length,
    furthest,
    truncated: all.length > limit,
  };
  sendJson(res, 200, body);
}

export default authedRoute({ GET: { role: "VIEWER", handler: get } });
