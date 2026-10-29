// Who is at the radio: operator sign-on for a shared station.
//
// A club station runs shifts: several people take turns at one radio, and every contact must
// say who made it. Qso.operatorId always existed, but only the manual form and the imports
// filled it in - the two loggers that write nearly every contact (the native sequencer and the
// WSJT-X UDP path) wrote the station and nothing else. Now an operator signs on, and every
// contact logged until they sign off carries them.
//
// One open shift per install: an install drives one radio, so "who is on this radio" and "who
// is on this install" are the same question. Read uncached from its own table, never from
// Setting, whose 30 s cache would credit the first contacts of a new shift to the last one.

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";

const SHIFT_INCLUDE = {
  operator: {
    select: {
      id: true,
      name: true,
      callsign: true,
      stationId: true,
      station: { select: { callsign: true } },
    },
  },
} satisfies Prisma.OperatorShiftInclude;

export type OpenShift = Prisma.OperatorShiftGetPayload<{ include: typeof SHIFT_INCLUDE }>;

/** The shift in progress, or null when nobody is signed on. */
export async function currentShift(): Promise<OpenShift | null> {
  return prisma.operatorShift.findFirst({
    where: { endedAt: null },
    orderBy: { startedAt: "desc" },
    include: SHIFT_INCLUDE,
  });
}

/**
 * The operator to credit a contact logged now at `stationId`, or null.
 *
 * Only an operator of THAT station: a contact's operator must belong to its station (the
 * manual form refuses anything else), and an install can hold several station records.
 * Never throws - a contact is worth logging without an operator, and refusing to log one
 * because this lookup failed would be far worse.
 */
export async function operatorIdFor(stationId: string): Promise<string | null> {
  try {
    const shift = await currentShift();
    return shift && shift.operator.stationId === stationId ? shift.operator.id : null;
  } catch {
    return null;
  }
}

/** The station sign-on applies to when none is named: the one the bridge logs to. */
async function defaultStation(): Promise<{ id: string } | null> {
  return prisma.station.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true } });
}

export class SignOnError extends Error {}

/**
 * Sign an operator on, closing whatever shift was open.
 *
 * `operatorId` names the operator outright (a shift lead signing someone else on). Without
 * it, the user signs themselves on: the Operator at this station linked to their login, or a
 * new one made from their name and callsign when there is none yet.
 */
export async function signOn(opts: {
  user: { id: string; name: string; callsign?: string | null; email: string };
  operatorId?: string;
  stationId?: string;
}): Promise<OpenShift> {
  const station = opts.stationId
    ? await prisma.station.findUnique({ where: { id: opts.stationId }, select: { id: true } })
    : await defaultStation();
  if (!station) throw new SignOnError("There is no station to sign on to - create one first");

  let operatorId: string;
  if (opts.operatorId) {
    const op = await prisma.operator.findUnique({ where: { id: opts.operatorId }, select: { id: true, stationId: true } });
    if (!op) throw new SignOnError(`No operator with id ${opts.operatorId}`);
    if (op.stationId !== station.id) throw new SignOnError("That operator belongs to a different station");
    operatorId = op.id;
  } else {
    const mine = await prisma.operator.findFirst({
      where: { userId: opts.user.id, stationId: station.id },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (mine) {
      operatorId = mine.id;
    } else {
      const callsign = (opts.user.callsign ?? "").trim().toUpperCase();
      if (!callsign) {
        throw new SignOnError("Your account has no callsign. Add one on your account page, then sign on.");
      }
      const made = await prisma.operator.create({
        data: { name: opts.user.name, callsign, stationId: station.id, userId: opts.user.id },
        select: { id: true },
      });
      operatorId = made.id;
    }
  }

  const now = new Date();
  return prisma.$transaction(async (tx) => {
    await tx.operatorShift.updateMany({ where: { endedAt: null }, data: { endedAt: now } });
    return tx.operatorShift.create({
      data: { operatorId, signedOnBy: opts.user.callsign?.toUpperCase() || opts.user.email.slice(0, 32), startedAt: now },
      include: SHIFT_INCLUDE,
    });
  });
}

/** Sign off whoever is on. Returns how many shifts were closed (0 when nobody was). */
export async function signOff(): Promise<number> {
  const r = await prisma.operatorShift.updateMany({ where: { endedAt: null }, data: { endedAt: new Date() } });
  return r.count;
}

/** The shape /api/operators/current and /api/v1/operator answer with. */
export function shiftView(shift: OpenShift | null) {
  if (!shift) return { signedOn: false as const, operator: null, since: null, signedOnBy: null };
  return {
    signedOn: true as const,
    operator: {
      id: shift.operator.id,
      name: shift.operator.name,
      callsign: shift.operator.callsign,
      stationId: shift.operator.stationId,
      stationCallsign: shift.operator.station.callsign,
    },
    since: shift.startedAt.toISOString(),
    signedOnBy: shift.signedOnBy,
  };
}
