import type { NextApiRequest, NextApiResponse } from "next";

import { sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import { prisma } from "@/lib/db/prisma";
import { fetchPotaProfile, type PotaProfile } from "@/lib/pota/profile";
import { fetchPotaSpots, type PotaSpot } from "@/lib/pota/spots";

// GET /api/pota — everything the POTA page needs, in one request.
//
// Three sources, and the page keeps them apart because they know different things:
//
//   profile   POTA's own record of this callsign — every award, every endorsement,
//             lifetime hunter and activator totals. Authoritative, and the only
//             place the history before this logger exists.
//   log       our database. Holds every park reference imported from POTA plus
//             everything recorded since, and knows every callsign ever worked —
//             which is what decides whether a spot is worth chasing.
//   spots     who is on the air right now.
//
// POTA and the log are both allowed to be absent. A page that fails because a
// volunteer-run API is having a bad afternoon is worse than a page showing what it
// still has.

export interface PotaSpotRow extends Omit<PotaSpot, "spottedAt"> {
  spottedAt: string;
  /** Have we ever logged this callsign, on any band or mode? */
  workedActivator: boolean;
  /** Have we logged this exact reference before? */
  workedPark: boolean;
  /** Worked this activator today — almost certainly this same activation. */
  workedToday: boolean;
}

export interface PotaReport {
  callsign: string | null;
  profile: PotaProfile | null;
  profileError: string | null;
  spots: PotaSpotRow[];
  spotsError: string | null;
  /** What OUR log knows about parks, which starts from when the column was added. */
  local: {
    parkQsos: number;
    parks: number;
    /** Distinct references, most-worked first. */
    topParks: { reference: string; qsos: number }[];
    /** Park contacts we have logged, newest first. */
    recent: {
      id: string;
      callsign: string;
      /** Every park on the contact — a nested-park contact has several. */
      references: string[];
      band: string;
      mode: string;
      startTime: string;
    }[];
  };
  fetchedAt: string;
}

async function get(req: NextApiRequest, res: NextApiResponse) {
  const station = await prisma.station.findFirst({
    orderBy: { createdAt: "asc" },
    select: { callsign: true },
  });
  const callsign =
    typeof req.query.callsign === "string" && req.query.callsign.trim()
      ? req.query.callsign.trim().toUpperCase()
      : (station?.callsign ?? null);

  // POTA's two endpoints and our own log, together — the page is one round trip and
  // a slow spot feed must not hold up the profile.
  const [profile, spotsResult, parkQsos, parkAgg, distinctParks, recent] = await Promise.all([
    callsign ? fetchPotaProfile(callsign) : Promise.resolve(null),
    fetchPotaSpots().then(
      (s) => ({ ok: true as const, spots: s }),
      (e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : "unavailable" }),
    ),
    prisma.qso.count({ where: { sigRefs: { some: { sig: "POTA" } } } }),
    // Grouped over the reference rows, not the mirrored column: a three-fer is
    // three parks worked, and counting the mirror would report one.
    prisma.qsoSigRef.groupBy({
      by: ["sigInfo"],
      where: { sig: "POTA" },
      _count: { _all: true },
      orderBy: { _count: { sigInfo: "desc" } },
      take: 25,
    }),
    // Separate from the top-25 list above, which is capped and therefore cannot be
    // counted. "545 parks" being silently clipped to 25 is the kind of wrong number
    // nobody questions.
    prisma.qsoSigRef
      .findMany({ where: { sig: "POTA" }, distinct: ["sigInfo"], select: { sigInfo: true } })
      .then((r) => r.length),
    prisma.qso.findMany({
      where: { sigRefs: { some: { sig: "POTA" } } },
      orderBy: { startTime: "desc" },
      take: 30,
      select: {
        id: true,
        callsign: true,
        band: true,
        mode: true,
        startTime: true,
        sigRefs: {
          where: { sig: "POTA" },
          select: { sigInfo: true, primary: true },
          orderBy: [{ primary: "desc" }, { sigInfo: "asc" }],
        },
      },
    }),
  ]);

  const spots = spotsResult.ok ? spotsResult.spots : [];

  // Cross-reference the live spots against the log. Two queries for the whole list
  // rather than two per spot: 50 spots would otherwise be 100 round trips for
  // questions that one `IN` clause each answers.
  const activators = [...new Set(spots.map((s) => s.activator))];
  const refs = [...new Set(spots.map((s) => s.reference))];
  const midnightUtc = new Date();
  midnightUtc.setUTCHours(0, 0, 0, 0);

  const [workedCalls, workedRefs, todayCalls] = await Promise.all([
    activators.length
      ? prisma.qso.findMany({
          where: { callsign: { in: activators } },
          select: { callsign: true },
          distinct: ["callsign"],
        })
      : Promise.resolve([]),
    refs.length
      ? prisma.qsoSigRef.findMany({
          where: { sigInfo: { in: refs } },
          select: { sigInfo: true },
          distinct: ["sigInfo"],
        })
      : Promise.resolve([]),
    activators.length
      ? prisma.qso.findMany({
          where: { callsign: { in: activators }, startTime: { gte: midnightUtc } },
          select: { callsign: true },
          distinct: ["callsign"],
        })
      : Promise.resolve([]),
  ]);

  const workedSet = new Set(workedCalls.map((q) => q.callsign.toUpperCase()));
  const refSet = new Set(workedRefs.map((q) => q.sigInfo));
  const todaySet = new Set(todayCalls.map((q) => q.callsign.toUpperCase()));

  const report: PotaReport = {
    callsign,
    profile,
    // A null profile is either "POTA is down" or "POTA has never heard of this
    // callsign", and the page should not present the second as a failure.
    profileError: callsign && !profile ? "No POTA profile for this callsign" : null,
    spots: spots.map((s) => ({
      ...s,
      spottedAt: s.spottedAt.toISOString(),
      workedActivator: workedSet.has(s.activator),
      workedPark: refSet.has(s.reference),
      workedToday: todaySet.has(s.activator),
    })),
    spotsError: spotsResult.ok ? null : spotsResult.error,
    local: {
      parkQsos,
      parks: distinctParks,
      topParks: parkAgg.map((g) => ({
        reference: g.sigInfo,
        qsos: g._count._all,
      })),
      recent: recent.map((q) => ({
        id: q.id,
        callsign: q.callsign,
        references: q.sigRefs.map((r) => r.sigInfo),
        band: q.band,
        mode: q.mode,
        startTime: q.startTime.toISOString(),
      })),
    },
    fetchedAt: new Date().toISOString(),
  };

  sendJson(res, 200, report);
}

export default authedRoute({ GET: { role: "VIEWER", handler: get } });
