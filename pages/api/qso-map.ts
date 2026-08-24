// Where the contacts in this log actually are, relative to here.
//
// Aggregated on the server. A 26,000-contact log is megabytes of rows and the answer is a
// few hundred points, so sending the rows to the browser to reduce them there would be
// slower and would put a grid-square parser in two places.

import type { NextApiRequest, NextApiResponse } from "next";
import { z } from "zod";

import { sendError, sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import { prisma } from "@/lib/db/prisma";
import { bearingDeg, distanceKm, gridToLatLon } from "@/lib/propagation";

const querySchema = z.object({
  band: z.string().trim().max(12).optional(),
  mode: z.string().trim().max(12).optional(),
  /** Days back. Zero or absent means the whole log. */
  days: z.coerce.number().int().min(0).max(36_500).default(0),
  /**
   * Skip the point list and send only the aggregates. The grid map's worked-squares
   * shading wants `grids` over the whole log, and making it carry 4,000 points it
   * will not draw would be most of the payload for none of the answer.
   */
  slim: z.coerce.boolean().default(false),
});

export interface QsoMapPoint {
  /** Degrees true from the station. */
  bearing: number;
  km: number;
  /** Where the contact IS, for the grid map. The polar plot ignores these. */
  lat: number;
  lon: number;
  band: string;
  mode: string;
  callsign: string;
  continent: string | null;
  at: string;
}

export interface QsoMapResponse {
  home: { grid: string; lat: number; lon: number } | null;
  points: QsoMapPoint[];
  /** Contacts with no usable grid square, which cannot be placed at all. */
  unplaceable: number;
  total: number;
  furthest: { callsign: string; km: number; bearing: number } | null;
  /** Contacts per continent, for the stations a grid cannot describe. */
  byContinent: { continent: string; count: number }[];
  /**
   * Contacts per 4-character grid square, over EVERY placeable contact — the grid
   * map shades a square if this station has ever worked into it, and a shading that
   * changed with the point cap would claim squares were unworked that are not.
   */
  byGrid: { grid: string; count: number }[];
  /**
   * Where the antenna actually reaches, in sixteen compass sectors.
   *
   * The point of the whole page. A count per sector answers "am I being heard behind me?"
   * in a way a list of callsigns cannot.
   */
  bySector: { from: number; count: number; furthestKm: number }[];
  truncated: boolean;
}

const SECTORS = 16;
const SECTOR_WIDTH = 360 / SECTORS;
/** A bound, because this renders in a browser and a bigger scatter reads no better. */
const MAX_POINTS = 4_000;

async function get(req: NextApiRequest, res: NextApiResponse) {
  const q = querySchema.parse(req.query);

  const station = await prisma.station.findFirst({
    orderBy: { createdAt: "asc" },
    select: { grid: true },
  });
  const home = station?.grid ? gridToLatLon(station.grid) : null;
  if (!home || !station?.grid) {
    // Everything here is measured FROM somewhere. Without a station grid there is no
    // question to answer, and a plot centred on a guess would be worse than none.
    sendError(res, 409, "Set the station's grid square first — every bearing is measured from it");
    return;
  }

  const rows = await prisma.qso.findMany({
    where: {
      ...(q.band ? { band: q.band.toUpperCase() } : {}),
      ...(q.mode ? { mode: q.mode.toUpperCase() } : {}),
      ...(q.days > 0 ? { startTime: { gte: new Date(Date.now() - q.days * 86_400_000) } } : {}),
    },
    select: {
      callsign: true,
      band: true,
      mode: true,
      gridSquare: true,
      continent: true,
      startTime: true,
    },
    orderBy: { startTime: "desc" },
    take: 40_000,
  });

  const points: QsoMapPoint[] = [];
  const continents = new Map<string, number>();
  const gridCounts = new Map<string, number>();
  const sectors = Array.from({ length: SECTORS }, (_, i) => ({
    from: Math.round(i * SECTOR_WIDTH),
    count: 0,
    furthestKm: 0,
  }));
  let unplaceable = 0;
  let furthest: QsoMapResponse["furthest"] = null;

  for (const r of rows) {
    if (r.continent) continents.set(r.continent, (continents.get(r.continent) ?? 0) + 1);

    const there = r.gridSquare ? gridToLatLon(r.gridSquare) : null;
    if (!there) {
      // Not an error and not rare: a contact from a callsign lookup with no grid, or an
      // imported one where the other operator never sent theirs. Counted so the page can
      // say what it is not showing rather than quietly showing less.
      unplaceable++;
      continue;
    }

    const grid4 = r.gridSquare!.trim().toUpperCase().slice(0, 4);
    gridCounts.set(grid4, (gridCounts.get(grid4) ?? 0) + 1);

    const km = Math.round(distanceKm(home, there));
    const bearing = Math.round(bearingDeg(home, there));

    // Sector and furthest are computed over EVERY placeable contact, not over the points
    // that survive the cap — a coverage answer that changed with the page size would be
    // worthless.
    const sector = sectors[Math.floor((bearing % 360) / SECTOR_WIDTH)]!;
    sector.count++;
    if (km > sector.furthestKm) sector.furthestKm = km;
    if (!furthest || km > furthest.km) furthest = { callsign: r.callsign, km, bearing };

    if (!q.slim && points.length < MAX_POINTS) {
      points.push({
        bearing,
        km,
        lat: there.lat,
        lon: there.lon,
        band: r.band,
        mode: r.mode,
        callsign: r.callsign,
        continent: r.continent,
        at: r.startTime.toISOString(),
      });
    }
  }

  const body: QsoMapResponse = {
    home: { grid: station.grid.toUpperCase(), lat: home.lat, lon: home.lon },
    points,
    unplaceable,
    total: rows.length,
    furthest,
    byContinent: [...continents.entries()]
      .map(([continent, count]) => ({ continent, count }))
      .sort((a, b) => b.count - a.count),
    byGrid: [...gridCounts.entries()].map(([grid, count]) => ({ grid, count })),
    bySector: sectors,
    truncated: points.length < rows.length - unplaceable,
  };
  sendJson(res, 200, body);
}

export default authedRoute({ GET: { role: "VIEWER", handler: get } });
