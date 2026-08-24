import { prisma } from "@/lib/db/prisma";

// One station's history with us.
//
// "Have I worked them, when, and on what" — as a view rather than a log filter. The log can
// already be filtered to a callsign, and that answers the question badly: it returns rows in
// date order and leaves the operator to work out from twenty of them whether 20 m is already
// confirmed. The useful shape is per-band-and-mode, because that is the unit awards are
// counted in and the unit a decision to call is made in.
//
// Reached from the decodes and from the Statistics page, so it has to be cheap enough to open
// on a whim: three indexed queries against one callsign.

export interface CallsignSlice {
  band: string;
  mode: string;
  qsos: number;
  /** Confirmed by any route — paper, LoTW or eQSL. */
  confirmed: boolean;
  lastWorked: Date;
}

export interface CallsignHistory {
  callsign: string;
  /** False when this station has never been worked, which is the interesting answer. */
  worked: boolean;
  qsos: number;
  firstWorked: Date | null;
  lastWorked: Date | null;
  /** Distinct bands and modes, for the one-line summary. */
  bands: string[];
  modes: string[];
  confirmedQsos: number;
  slices: CallsignSlice[];
  /** What we know about them from the log itself, most recent non-empty value. */
  name: string | null;
  qth: string | null;
  gridSquare: string | null;
  dxcc: number | null;
  state: string | null;
  /** True when they are on the do-not-call list, which a decision to call must respect. */
  doNotCall: boolean;
  /** True when they have asked not to receive QSL email. */
  qslOptOut: boolean;
  /** The most recent contacts, for the detail table. */
  recent: {
    id: string;
    startTime: Date;
    band: string;
    mode: string;
    freqHz: number | null;
    rstSent: string | null;
    rstRcvd: string | null;
    confirmed: boolean;
    lotwRcvd: boolean;
    eqslRcvd: boolean;
    qslRcvd: string;
  }[];
}

function isConfirmed(q: {
  qslRcvd: string;
  lotwRcvd: boolean;
  eqslRcvd: boolean;
}): boolean {
  return q.qslRcvd === "CONFIRMED" || q.lotwRcvd || q.eqslRcvd;
}

export async function computeCallsignHistory(
  raw: string,
  opts: { recent?: number } = {},
): Promise<CallsignHistory> {
  const callsign = raw.trim().toUpperCase();
  const take = Math.min(200, Math.max(1, opts.recent ?? 50));

  const empty: CallsignHistory = {
    callsign,
    worked: false,
    qsos: 0,
    firstWorked: null,
    lastWorked: null,
    bands: [],
    modes: [],
    confirmedQsos: 0,
    slices: [],
    name: null,
    qth: null,
    gridSquare: null,
    dxcc: null,
    state: null,
    doNotCall: false,
    qslOptOut: false,
    recent: [],
  };
  if (!callsign) return empty;

  // Every contact with them, newest first. A station worked hundreds of times is unusual and
  // still small, so this is loaded whole rather than aggregated in SQL — the per-band-and-mode
  // slices, the distinct lists and the confirmed count all come from the same rows, and three
  // more round trips to avoid holding a few hundred objects would be the wrong trade.
  const all = await prisma.qso.findMany({
    where: { callsign },
    orderBy: { startTime: "desc" },
    select: {
      id: true,
      startTime: true,
      band: true,
      mode: true,
      freqHz: true,
      rstSent: true,
      rstRcvd: true,
      qslRcvd: true,
      lotwRcvd: true,
      eqslRcvd: true,
      name: true,
      qth: true,
      gridSquare: true,
      dxcc: true,
      state: true,
    },
  });

  const [doNotCall, qslOptOut] = await Promise.all([
    prisma.doNotCall
      .findFirst({ where: { callsign }, select: { id: true } })
      .then((r) => r !== null),
    prisma.qslOptOut
      .findFirst({ where: { callsign }, select: { id: true } })
      .then((r) => r !== null),
  ]);

  if (all.length === 0) return { ...empty, doNotCall, qslOptOut };

  // Slices keyed band+mode. A station confirmed on 20 m FT8 and merely worked on 40 m FT8 is
  // two different situations, and a single "confirmed" flag on the callsign would hide that —
  // which is the whole reason the log filter answers this question badly.
  const byKey = new Map<string, CallsignSlice>();
  for (const q of all) {
    const key = `${q.band}|${q.mode}`;
    const s = byKey.get(key);
    const conf = isConfirmed(q);
    if (!s) {
      byKey.set(key, {
        band: q.band,
        mode: q.mode,
        qsos: 1,
        confirmed: conf,
        lastWorked: q.startTime,
      });
    } else {
      s.qsos++;
      // ANY confirmed contact confirms the slice. A later unconfirmed contact on the same
      // band and mode does not undo an earlier credit.
      s.confirmed = s.confirmed || conf;
      if (q.startTime > s.lastWorked) s.lastWorked = q.startTime;
    }
  }

  // The most recent non-empty value wins for each detail. An operator's grid and QTH change,
  // and the newest contact is the best guess — but a blank field on the newest contact should
  // not erase what an older one recorded.
  const newestOf = <K extends "name" | "qth" | "gridSquare" | "state">(k: K): string | null => {
    for (const q of all) {
      const v = q[k];
      if (typeof v === "string" && v.trim() !== "") return v;
    }
    return null;
  };

  return {
    callsign,
    worked: true,
    qsos: all.length,
    firstWorked: all[all.length - 1]!.startTime,
    lastWorked: all[0]!.startTime,
    bands: [...new Set(all.map((q) => q.band))],
    modes: [...new Set(all.map((q) => q.mode))],
    confirmedQsos: all.filter(isConfirmed).length,
    slices: [...byKey.values()].sort(
      (a, b) => b.qsos - a.qsos || a.band.localeCompare(b.band),
    ),
    name: newestOf("name"),
    qth: newestOf("qth"),
    gridSquare: newestOf("gridSquare"),
    dxcc: all.find((q) => q.dxcc !== null)?.dxcc ?? null,
    state: newestOf("state"),
    doNotCall,
    qslOptOut,
    recent: all.slice(0, take).map((q) => ({
      id: q.id,
      startTime: q.startTime,
      band: q.band,
      mode: q.mode,
      freqHz: q.freqHz === null ? null : Number(q.freqHz),
      rstSent: q.rstSent,
      rstRcvd: q.rstRcvd,
      confirmed: isConfirmed(q),
      lotwRcvd: q.lotwRcvd,
      eqslRcvd: q.eqslRcvd,
      qslRcvd: q.qslRcvd,
    })),
  };
}
