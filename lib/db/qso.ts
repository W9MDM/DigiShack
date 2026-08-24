import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import type { QsoListQuery } from "@/lib/validation/qso";

/** Relations included wherever a QSO is returned to a client. */
export const QSO_INCLUDE = {
  station: { select: { id: true, callsign: true, grid: true } },
  operator: { select: { id: true, name: true, callsign: true } },
  // Park references come along everywhere a QSO does, because `Qso.sigInfo` only
  // carries the primary. Showing one park for a contact that was three would be
  // wrong in the list, wrong in the detail view, and wrong in the edit form —
  // where it would then be saved back, losing the rest.
  sigRefs: {
    select: { sigInfo: true, primary: true },
    orderBy: [{ primary: "desc" }, { sigInfo: "asc" }],
  },
} satisfies Prisma.QsoInclude;

export type QsoWithRelations = Prisma.QsoGetPayload<{
  include: typeof QSO_INCLUDE;
}>;

export function buildQsoWhere(q: QsoListQuery): Prisma.QsoWhereInput {
  const where: Prisma.QsoWhereInput = {};

  if (q.callsign) where.callsign = q.callsign;
  if (q.band) where.band = q.band;
  if (q.mode) where.mode = q.mode;
  if (q.stationId) where.stationId = q.stationId;
  if (q.operatorId) where.operatorId = q.operatorId;

  if (q.from || q.to) {
    where.startTime = {};
    if (q.from) where.startTime.gte = q.from;
    if (q.to) where.startTime.lte = q.to;
  }

  // "Confirmed" means confirmed by *any* method — a card, LoTW or eQSL. This is
  // the definition award tracking uses, so the filter has to match it.
  if (q.confirmed === "yes") {
    where.OR = [
      { qslRcvd: "CONFIRMED" },
      { lotwRcvd: true },
      { eqslRcvd: true },
    ];
  } else if (q.confirmed === "no") {
    where.AND = [
      { qslRcvd: { not: "CONFIRMED" } },
      { lotwRcvd: false },
      { eqslRcvd: false },
    ];
  }

  if (q.q) {
    // Free-text search. Kept as a separate AND clause so it composes with the
    // `confirmed` filter above instead of overwriting its OR.
    const contains = q.q;
    const search: Prisma.QsoWhereInput = {
      OR: [
        { callsign: { contains } },
        { gridSquare: { contains } },
        { notes: { contains } },
      ],
    };
    where.AND = where.AND ? [...(where.AND as Prisma.QsoWhereInput[]), search] : [search];
  }

  return where;
}

export async function listQsos(q: QsoListQuery) {
  const where = buildQsoWhere(q);

  const [rows, total] = await Promise.all([
    prisma.qso.findMany({
      where,
      include: QSO_INCLUDE,
      orderBy: [{ [q.sort]: q.dir }, { id: "desc" }],
      take: q.take,
      skip: q.skip,
    }),
    prisma.qso.count({ where }),
  ]);

  return { rows, total };
}

/**
 * Has this callsign been worked on this band+mode before? Used by the entry
 * form to warn on a likely duplicate. `excludeId` lets an edit skip itself.
 */
export async function findDuplicate(args: {
  callsign: string;
  band: string;
  mode: string;
  excludeId?: string;
}) {
  return prisma.qso.findFirst({
    where: {
      callsign: args.callsign,
      band: args.band,
      mode: args.mode,
      ...(args.excludeId ? { id: { not: args.excludeId } } : {}),
    },
    orderBy: { startTime: "desc" },
    select: { id: true, startTime: true, rstSent: true, rstRcvd: true },
  });
}
