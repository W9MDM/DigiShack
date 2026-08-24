import type { NextApiRequest, NextApiResponse } from "next";
import { z } from "zod";

import { sendError, sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import { prisma } from "@/lib/db/prisma";
import { fetchPotaLogbook } from "@/lib/pota/logbook";
import {
  groupRows,
  otherStation,
  planMerge,
  type LocalQso,
  type MergeDecision,
  type RemoteRow,
} from "@/lib/pota/merge";
import { addSigRefs } from "@/lib/pota/refs";
import { getSetting } from "@/lib/settings";

// POST /api/pota/import — backfill park references from POTA's own logbook.
//
// Dry run by DEFAULT, and the UI shows the plan before anything is written. This
// touches thousands of existing contacts, and a wrong park reference is
// indistinguishable from a right one afterwards — the only defence is looking at
// what it intends to do first.
//
// Matching is in lib/pota/merge.ts, pure and tested, and it refuses rather than
// guesses whenever two contacts are equally plausible.

const Body = z.object({
  /** Nothing is written unless this is explicitly false. */
  dryRun: z.boolean().default(true),
  kind: z.enum(["hunter", "activator"]).default("hunter"),
  /** Replace references that are already there and disagree with POTA. */
  overwrite: z.boolean().default(false),
  /** How far apart the two timestamps may be, in minutes. */
  windowMinutes: z.number().int().min(1).max(120).default(10),
});

/** Decisions worth showing individually; the rest are only counted. */
const REPORT_LIMIT = 200;

async function post(req: NextApiRequest, res: NextApiResponse) {
  const parsed = Body.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendError(res, 400, parsed.error.issues[0]?.message ?? "Bad request");
    return;
  }
  const { dryRun, kind, overwrite, windowMinutes } = parsed.data;

  const token = await getSetting("pota.userToken");
  if (!token) {
    sendError(
      res,
      400,
      "No POTA session token configured. Settings → POTA chasing explains where to find one.",
    );
    return;
  }

  // Every callsign this operator uses, so their own log never reads as the other
  // station. Portable and club calls are ordinary in park work.
  const stations = await prisma.station.findMany({ select: { callsign: true } });
  const operators = await prisma.operator.findMany({ select: { callsign: true } });
  const ourCalls = new Set(
    [...stations, ...operators].map((s) => s.callsign.toUpperCase()).filter(Boolean),
  );
  if (ourCalls.size === 0) {
    sendError(res, 400, "No station callsign configured");
    return;
  }

  let book;
  try {
    book = await fetchPotaLogbook({ token, kind });
  } catch (err) {
    sendError(res, 502, err instanceof Error ? err.message : "POTA logbook unavailable");
    return;
  }

  // Reduce POTA's rows to what identifies a contact. Rows we cannot use at all are
  // dropped here and counted, rather than reaching the matcher as noise.
  let unusable = 0;
  const rows: RemoteRow[] = [];
  for (const e of book.entries) {
    const call = otherStation(e, ourCalls);
    const timeMs = e.qsoDateTime ? Date.parse(`${e.qsoDateTime.replace(" ", "T")}Z`) : NaN;
    if (!call || !e.reference || !Number.isFinite(timeMs)) {
      unusable++;
      continue;
    }
    rows.push({
      callsign: call,
      band: e.band,
      mode: e.mode,
      timeMs,
      reference: e.reference,
    });
  }

  // POTA sends one row per (contact, reference), so a two-fer arrives as two rows
  // differing only in the park. Grouping them back into contacts is what stops a
  // legitimate n-fer looking like two records fighting over one QSO — which is
  // exactly what the first version of this reported, for 126 of 863 contacts.
  const remotes = groupRows(rows);

  // One query for every callsign POTA mentions, rather than one per row. At a
  // thousand rows the difference is a second against several minutes.
  const calls = [...new Set(remotes.map((r) => r.callsign))];
  const locals = calls.length
    ? await prisma.qso.findMany({
        where: { callsign: { in: calls } },
        select: {
          id: true,
          callsign: true,
          band: true,
          mode: true,
          startTime: true,
          sigRefs: { where: { sig: "POTA" }, select: { sigInfo: true } },
        },
      })
    : [];

  const byCall = new Map<string, LocalQso[]>();
  for (const r of locals) {
    const key = r.callsign.toUpperCase();
    const list = byCall.get(key) ?? [];
    list.push({
      id: r.id,
      callsign: r.callsign,
      band: r.band,
      mode: r.mode,
      startTimeMs: r.startTime.getTime(),
      refs: r.sigRefs.map((s) => s.sigInfo),
    });
    byCall.set(key, list);
  }

  const plan = planMerge(remotes, byCall, {
    windowMs: windowMinutes * 60_000,
    overwrite,
  });

  let applied = 0;
  let referencesWritten = 0;
  if (!dryRun) {
    // Per contact rather than batched by reference, because references are a set
    // now: `addSigRefs` reads what is there, adds what is missing and keeps the
    // primary and the mirrored Qso.sigInfo consistent. Batching would have to
    // reimplement that, and two implementations of this invariant is one too many.
    for (const u of plan.updates) {
      const r = await addSigRefs(prisma, u.qsoId, "POTA", u.references);
      if (r.added.length > 0) {
        applied++;
        referencesWritten += r.added.length;
      }
    }
  }

  // Interesting decisions first. "matched" at a thousand rows is a number, not a
  // list; conflicts and ambiguities are the ones an operator needs to look at.
  const rank: Record<MergeDecision["outcome"], number> = {
    conflict: 0,
    ambiguous: 1,
    missing: 2,
    unusable: 3,
    matched: 4,
    "already-set": 5,
  };

  sendJson(res, 200, {
    dryRun,
    kind,
    potaCount: book.count,
    fetched: book.entries.length,
    /** Rows POTA sent, before grouping — one per (contact, reference). */
    rows: rows.length,
    /** Distinct contacts those rows describe. The difference is the n-fers. */
    contacts: remotes.length,
    /** Contacts carrying more than one park. */
    multiRef: remotes.filter((r) => r.references.length > 1).length,
    unusableRows: unusable,
    counts: plan.counts,
    updates: plan.updates.length,
    referencesToAdd: plan.referencesAdded,
    applied,
    referencesWritten,
    windowMinutes,
    overwrite,
    sample: [...plan.decisions]
      .sort((a, b) => rank[a.outcome] - rank[b.outcome])
      .slice(0, REPORT_LIMIT)
      .map((d) => ({
        outcome: d.outcome,
        callsign: d.remote.callsign,
        references: d.remote.references,
        adding: d.adding ?? [],
        band: d.remote.band,
        at: d.remote.timeMs ? new Date(d.remote.timeMs).toISOString() : null,
        qsoId: d.qsoId ?? null,
        existing: d.existing ?? [],
        detail: d.detail ?? null,
      })),
  });
}

export default authedRoute({ POST: { role: "ADMIN", handler: post } });
