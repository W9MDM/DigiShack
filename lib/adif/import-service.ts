import { dupeKey, parseAdif, type RecordProblem } from "@/lib/adif/parse";
import { prisma } from "@/lib/db/prisma";

// Shared ADIF ingest, used by both the app's /api/adif/import and the public
// /api/v1/adif. One implementation so the public surface cannot drift into
// accepting something the UI would reject, or skipping a dedupe the UI applies.

const CHUNK = 500;
const MAX_REPORTED_PROBLEMS = 100;

export interface ImportOptions {
  stationId: string;
  operatorId?: string;
  dryRun: boolean;
  dedupe: boolean;
}

export type ImportOutcome =
  | { ok: false; status: number; error: string; details?: unknown }
  | { ok: true; report: ImportReport };

export interface ImportReport {
  dryRun: boolean;
  dedupe: boolean;
  station: { id: string; callsign: string };
  parsed: number;
  valid: number;
  duplicatesInFile: number;
  alreadyInLog: number;
  imported: number;
  pending: number;
  rejected: number;
  problems: RecordProblem[];
  problemsTruncated: number;
  frequencyInferred: number;
  otherStationCallsigns: string[];
  unmatchedOperators: string[];
}

export async function importAdifDocument(
  raw: Buffer,
  opts: ImportOptions,
): Promise<ImportOutcome> {
  const station = await prisma.station.findUnique({
    where: { id: opts.stationId },
    select: {
      id: true,
      callsign: true,
      operators: { select: { id: true, callsign: true } },
    },
  });

  if (!station) {
    return {
      ok: false,
      status: 404,
      error: `No station with id ${opts.stationId}`,
    };
  }

  if (opts.operatorId && !station.operators.some((o) => o.id === opts.operatorId)) {
    return {
      ok: false,
      status: 400,
      error: "That operator belongs to a different station",
      details: { operatorId: ["Operator is not registered to this station"] },
    };
  }

  const { qsos, problems } = parseAdif(raw);

  const operatorByCall = new Map(
    station.operators.map((o) => [o.callsign.toUpperCase(), o.id]),
  );

  // De-duplicate within the file: a re-exported log frequently contains the same
  // QSO twice.
  const seen = new Set<string>();
  const fileDupes: RecordProblem[] = [];
  const unique = qsos.filter((q, idx) => {
    const key = dupeKey(q);
    if (seen.has(key)) {
      fileDupes.push({
        record: idx + 1,
        callsign: q.callsign,
        message: "Duplicate of an earlier record in this file",
      });
      return false;
    }
    seen.add(key);
    return true;
  });

  let existingKeys = new Set<string>();
  if (opts.dedupe && unique.length > 0) {
    existingKeys = await loadExistingKeys([
      ...new Set(unique.map((q) => q.callsign)),
    ]);
  }

  const toInsert = opts.dedupe
    ? unique.filter((q) => !existingKeys.has(dupeKey(q)))
    : unique;

  const alreadyInLog = unique.length - toInsert.length;
  const freqInferred = toInsert.filter((q) => q.freqInferred).length;

  const foreignStation = [
    ...new Set(
      qsos
        .map((q) => q.stationCallsign)
        .filter(
          (c): c is string => c !== null && c !== station.callsign.toUpperCase(),
        ),
    ),
  ];
  const unmatchedOperators = [
    ...new Set(
      qsos
        .map((q) => q.operatorCallsign)
        .filter((c): c is string => c !== null && !operatorByCall.has(c)),
    ),
  ];

  let imported = 0;

  if (!opts.dryRun && toInsert.length > 0) {
    for (let i = 0; i < toInsert.length; i += CHUNK) {
      const chunk = toInsert.slice(i, i + CHUNK);
      const { count } = await prisma.qso.createMany({
        data: chunk.map((q) => ({
          callsign: q.callsign,
          band: q.band,
          freqHz: BigInt(q.freqHz),
          mode: q.mode,
          startTime: q.startTime,
          endTime: q.endTime,
          rstSent: q.rstSent,
          rstRcvd: q.rstRcvd,
          gridSquare: q.gridSquare,
          txPowerW: q.txPowerW,
          name: q.name,
          qth: q.qth,
          dxcc: q.dxcc,
          state: q.state,
          county: q.county,
          cqZone: q.cqZone,
          ituZone: q.ituZone,
          iota: q.iota,
          continent: q.continent,
          sig: q.sig,
          sigInfo: q.sigInfo,
          radio: q.radio,
          qslSent: q.qslSent,
          qslRcvd: q.qslRcvd,
          qslSentAt: q.qslSentAt,
          qslRcvdAt: q.qslRcvdAt,
          lotwSent: q.lotwSent,
          lotwRcvd: q.lotwRcvd,
          eqslSent: q.eqslSent,
          eqslRcvd: q.eqslRcvd,
          notes: q.notes,
          stationId: station.id,
          operatorId:
            (q.operatorCallsign
              ? operatorByCall.get(q.operatorCallsign)
              : undefined) ??
            opts.operatorId ??
            null,
        })),
      });
      imported += count;

      // Special-activity references, as rows.
      //
      // `createMany` cannot return ids, so the QSOs just written are read back by
      // (callsign, startTime) — the pair the dupe check already treats as
      // identifying — and their references inserted. Only chunk rows that carry a
      // reference at all are looked up, which for a typical log is none of them.
      const withRefs = chunk.filter((q) => q.sig && (q.sigRefs?.length || q.sigInfo));
      if (withRefs.length > 0) {
        const written = await prisma.qso.findMany({
          where: {
            OR: withRefs.map((q) => ({ callsign: q.callsign, startTime: q.startTime })),
          },
          select: { id: true, callsign: true, startTime: true },
        });
        const idByKey = new Map(
          written.map((w) => [`${w.callsign}|${w.startTime.getTime()}`, w.id]),
        );
        const refRows: { qsoId: string; sig: string; sigInfo: string; primary: boolean }[] = [];
        for (const q of withRefs) {
          const id = idByKey.get(`${q.callsign}|${q.startTime.getTime()}`);
          if (!id || !q.sig) continue;
          // The primary is whatever SIG_INFO said, so a round trip through ADIF
          // preserves which reference is the exported one.
          const refs = [
            ...new Set([q.sigInfo, ...(q.sigRefs ?? [])].filter((r): r is string => Boolean(r))),
          ];
          for (const sigInfo of refs) {
            refRows.push({ qsoId: id, sig: q.sig, sigInfo, primary: sigInfo === q.sigInfo });
          }
        }
        if (refRows.length > 0) {
          await prisma.qsoSigRef.createMany({ data: refRows, skipDuplicates: true });
        }
      }
    }
  }

  const allProblems = [...problems, ...fileDupes];

  return {
    ok: true,
    report: {
      dryRun: opts.dryRun,
      dedupe: opts.dedupe,
      station: { id: station.id, callsign: station.callsign },
      parsed: qsos.length + problems.length,
      valid: qsos.length,
      duplicatesInFile: fileDupes.length,
      alreadyInLog,
      imported,
      pending: opts.dryRun ? toInsert.length : 0,
      rejected: problems.length,
      problems: allProblems.slice(0, MAX_REPORTED_PROBLEMS),
      problemsTruncated: Math.max(0, allProblems.length - MAX_REPORTED_PROBLEMS),
      frequencyInferred: freqInferred,
      otherStationCallsigns: foreignStation.slice(0, 20),
      unmatchedOperators: unmatchedOperators.slice(0, 20),
    },
  };
}

/**
 * Existing dupe keys for the callsigns in this file. Fetched by callsign rather
 * than by exact tuple because MySQL has no efficient way to match a large set of
 * composite tuples, and callsign is indexed.
 */
async function loadExistingKeys(callsigns: string[]): Promise<Set<string>> {
  const keys = new Set<string>();

  for (let i = 0; i < callsigns.length; i += CHUNK) {
    const rows = await prisma.qso.findMany({
      where: { callsign: { in: callsigns.slice(i, i + CHUNK) } },
      select: { callsign: true, band: true, mode: true, startTime: true },
    });
    for (const row of rows) keys.add(dupeKey(row));
  }

  return keys;
}
