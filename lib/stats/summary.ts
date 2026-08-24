import { prisma } from "@/lib/db/prisma";

// Dashboard counters, shared by /api/stats/summary and /api/v1/stats.
//
// The full per-award progress views live in lib/awards/compute.ts; this is the
// cheap overview.

/**
 * How many of today's values had never been worked before today.
 *
 * Two queries rather than a subquery so this stays inside the typed client: the
 * distinct values seen today (a small set — a busy day is a few hundred), then which
 * of THOSE also appear before today. The difference is what was new.
 *
 * The "before" test is what makes this honest. Counting distinct values worked today
 * would call a station new every single day it was worked, which is the number an
 * operator would notice was wrong within a week.
 */
async function countNew<T>(
  todayValues: T[],
  seenBefore: (values: T[]) => Promise<T[]>,
): Promise<number> {
  if (todayValues.length === 0) return 0;
  const before = await seenBefore(todayValues);
  return todayValues.length - before.length;
}

export async function computeStatsSummary() {
  const confirmedWhere = {
    OR: [
      { qslRcvd: "CONFIRMED" as const },
      { lotwRcvd: true },
      { eqslRcvd: true },
    ],
  };

  // "Today" is a UTC day, not a local one. Every log entry, every ADIF record and
  // every contest period is UTC, so a dashboard counting local midnights would
  // disagree with the log it is summarising.
  const utcMidnight = new Date();
  utcMidnight.setUTCHours(0, 0, 0, 0);
  // Yesterday is the full UTC day before this one — bounded at both ends, so it does
  // not silently mean "the last 48 hours" as the day wears on.
  const yesterdayMidnight = new Date(utcMidnight.getTime() - 86_400_000);
  const weekAgo = new Date(utcMidnight.getTime() - 7 * 86_400_000);

  const [
    total,
    confirmed,
    todayCount,
    yesterdayCount,
    weekCount,
    newCallsToday,
    newParksToday,
    newDxccToday,
    newGridsToday,
    byBand,
    byMode,
    distinctCallsigns,
    distinctGrids,
    distinctDxcc,
    stationCount,
    latest,
  ] = await Promise.all([
    prisma.qso.count(),
    prisma.qso.count({ where: confirmedWhere }),
    prisma.qso.count({ where: { startTime: { gte: utcMidnight } } }),
    prisma.qso.count({
      where: { startTime: { gte: yesterdayMidnight, lt: utcMidnight } },
    }),
    prisma.qso.count({ where: { startTime: { gte: weekAgo } } }),
    // The four "new today" figures. Each is: distinct values seen today, minus
    // those that also appear before today. The queries are written out per field
    // rather than parameterised because Prisma's groupBy cannot take a dynamic
    // column and stay typed — and an untyped query here would silently return the
    // wrong column one refactor from now.
    prisma.qso
      .groupBy({ by: ["callsign"], where: { startTime: { gte: utcMidnight } } })
      .then((rows) =>
        countNew(
          rows.map((r) => r.callsign),
          (values) =>
            prisma.qso
              .groupBy({
                by: ["callsign"],
                where: { callsign: { in: values }, startTime: { lt: utcMidnight } },
              })
              .then((r) => r.map((x) => x.callsign)),
        ),
      ),
    prisma.qso
      .groupBy({
        by: ["sigInfo"],
        where: { sig: "POTA", sigInfo: { not: null }, startTime: { gte: utcMidnight } },
      })
      .then((rows) =>
        countNew(
          rows.map((r) => r.sigInfo).filter((v): v is string => v !== null),
          (values) =>
            prisma.qso
              .groupBy({
                by: ["sigInfo"],
                where: { sig: "POTA", sigInfo: { in: values }, startTime: { lt: utcMidnight } },
              })
              .then((r) => r.map((x) => x.sigInfo).filter((v): v is string => v !== null)),
        ),
      ),
    prisma.qso
      .groupBy({
        by: ["dxcc"],
        where: { dxcc: { not: null }, startTime: { gte: utcMidnight } },
      })
      .then((rows) =>
        countNew(
          rows.map((r) => r.dxcc).filter((v): v is number => v !== null),
          (values) =>
            prisma.qso
              .groupBy({
                by: ["dxcc"],
                where: { dxcc: { in: values }, startTime: { lt: utcMidnight } },
              })
              .then((r) => r.map((x) => x.dxcc).filter((v): v is number => v !== null)),
        ),
      ),
    prisma.qso
      .groupBy({
        by: ["gridSquare"],
        where: { gridSquare: { not: null }, startTime: { gte: utcMidnight } },
      })
      .then((rows) =>
        countNew(
          rows.map((r) => r.gridSquare).filter((v): v is string => v !== null),
          (values) =>
            prisma.qso
              .groupBy({
                by: ["gridSquare"],
                where: { gridSquare: { in: values }, startTime: { lt: utcMidnight } },
              })
              .then((r) => r.map((x) => x.gridSquare).filter((v): v is string => v !== null)),
        ),
      ),
    prisma.qso.groupBy({
      by: ["band"],
      _count: { _all: true },
      orderBy: { _count: { band: "desc" } },
    }),
    prisma.qso.groupBy({
      by: ["mode"],
      _count: { _all: true },
      orderBy: { _count: { mode: "desc" } },
    }),
    // groupBy rather than raw COUNT(DISTINCT ...) to stay inside the typed
    // client. Fine at club-log scale; revisit if a log reaches ~1e6 rows.
    prisma.qso.groupBy({ by: ["callsign"] }),
    prisma.qso.groupBy({
      by: ["gridSquare"],
      where: { gridSquare: { not: null } },
    }),
    prisma.qso.groupBy({ by: ["dxcc"], where: { dxcc: { not: null } } }),
    prisma.station.count(),
    prisma.qso.findMany({
      orderBy: { startTime: "desc" },
      take: 8,
      include: {
        station: { select: { callsign: true } },
        operator: { select: { callsign: true } },
      },
    }),
  ]);

  return {
    total,
    confirmed,
    /** QSOs since 00:00 UTC — the day the log itself runs on. */
    today: todayCount,
    /** The whole UTC day before this one, bounded at both ends. */
    yesterday: yesterdayCount,
    /** Rolling seven days, for whether today is a good day or a good week. */
    week: weekCount,
    /** Stations worked today that appear nowhere in the log before today. */
    newCallsToday,
    /** POTA references worked today and never before. */
    newParksToday,
    /** DXCC entities worked today and never before — rare, and worth seeing. */
    newDxccToday,
    /** Grid squares worked today and never before. */
    newGridsToday,
    unconfirmed: total - confirmed,
    uniqueCallsigns: distinctCallsigns.length,
    uniqueGrids: distinctGrids.length,
    uniqueDxcc: distinctDxcc.length,
    stationCount,
    byBand: byBand.map((r) => ({ band: r.band, count: r._count._all })),
    byMode: byMode.map((r) => ({ mode: r.mode, count: r._count._all })),
    latest,
  };
}
