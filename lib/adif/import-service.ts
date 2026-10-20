import { randomBytes } from "node:crypto";

import { dupeKey, parseAdif, type ParsedQso, type RecordProblem } from "@/lib/adif/parse";
import { prisma } from "@/lib/db/prisma";

// Shared ADIF ingest, used by both the app's /api/adif/import and the public
// /api/v1/adif. One implementation so the public surface cannot drift into
// accepting something the UI would reject, or skipping a dedupe the UI applies.

const CHUNK = 500;
const MAX_REPORTED_PROBLEMS = 100;

/**
 * Limits for one chunk's transaction: two multi-row INSERTs. Prisma's 5 s default is
 * close enough to a slow disk's 500-row insert to be worth not betting on.
 */
const CHUNK_TX = { timeout: 60_000, maxWait: 30_000 } as const;

let idCounter = 0;

/**
 * A Qso primary key chosen HERE, before the insert, so the reference rows can name it.
 *
 * `createMany` returns no ids on MySQL (`createManyAndReturn` is PostgreSQL/SQLite only),
 * and rediscovering the rows afterwards is what R03 was. Shaped like Prisma's own
 * `cuid()` — "c", base-36 milliseconds, a per-process counter, then 12 base-36 characters
 * from the CSPRNG — so imported rows are indistinguishable from the rest and still sort
 * roughly by creation. Nothing parses ids; a collision (about 62 random bits on top of the
 * same millisecond and counter) would fail the insert with a duplicate key and roll the
 * chunk back, never overwrite a row.
 */
function newQsoId(): string {
  const time = Date.now().toString(36).padStart(8, "0").slice(-8);
  idCounter = (idCounter + 1) % 36 ** 4;
  const count = idCounter.toString(36).padStart(4, "0");
  const random = (randomBytes(8).readBigUInt64BE() % 36n ** 12n).toString(36).padStart(12, "0");
  return `c${time}${count}${random}`;
}

/** `dupeKey` inside one station's namespace. */
function stationDupeKey(stationId: string, q: Parameters<typeof dupeKey>[0]): string {
  return `${stationId}|${dupeKey(q)}`;
}

/**
 * The reference rows for one contact. The primary is whatever SIG_INFO said, so a round
 * trip through ADIF preserves which reference is the exported one.
 */
function referenceRows(
  qsoId: string,
  q: ParsedQso,
): { qsoId: string; sig: string; sigInfo: string; primary: boolean }[] {
  if (!q.sig) return [];
  const sig = q.sig;
  const refs = [
    ...new Set([q.sigInfo, ...(q.sigRefs ?? [])].filter((r): r is string => Boolean(r))),
  ];
  return refs.map((sigInfo) => ({ qsoId, sig, sigInfo, primary: sigInfo === q.sigInfo }));
}

export interface ImportOptions {
  stationId: string;
  operatorId?: string;
  dryRun: boolean;
  dedupe: boolean;
  /**
   * Push the imported contacts out to QRZ, Club Log, Cloudlog and N3FJP.
   *
   * DEFAULTS TO FALSE, AND THE DEFAULT IS THE WHOLE POINT. An imported log is HISTORY: it
   * is already wherever it was going to be, which is usually the very service it was
   * exported from.
   *
   * WHAT HAPPENED WITHOUT IT. An operator imported his QRZ log — 7,384 contacts — and the
   * upload sweep pushed every one of them to N3FJP, which already had them. His N3FJP log
   * went to 14,347. ADIF carries LOTW_QSL_SENT and EQSL_QSL_SENT so those two were read
   * from the file and honoured; there is no such field for QRZ, Club Log, Cloudlog or
   * N3FJP, so all four defaulted to "not sent yet" and the sweep believed it.
   *
   * The damage lands on somebody ELSE'S service and cannot be undone from here, which is
   * why this is off unless asked for rather than on unless refused.
   */
  uploadImported?: boolean;
}

export type ImportOutcome =
  | { ok: false; status: number; error: string; details?: unknown }
  | { ok: true; report: ImportReport };

export interface ImportReport {
  dryRun: boolean;
  dedupe: boolean;
  /** True when the imported contacts were queued for upload rather than treated as history. */
  uploadImported: boolean;
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

  // Against the log: THIS station's contacts only. A matching call/band/mode/minute at
  // another station is that station's contact, not this one's, and used to suppress the
  // import (R09). Note the consequence for an operator with several Station rows under one
  // callsign (portable grids): each is its own dedupe namespace now.
  let existingKeys = new Set<string>();
  if (opts.dedupe && unique.length > 0) {
    existingKeys = await loadExistingKeys(station.id, [
      ...new Set(unique.map((q) => q.callsign)),
    ]);
  }

  const toInsert = opts.dedupe
    ? unique.filter((q) => !existingKeys.has(stationDupeKey(station.id, q)))
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
      const chunk = toInsert.slice(i, i + CHUNK).map((q) => ({ id: newQsoId(), q }));

      // Special-activity references, as rows, keyed by the id each contact is about to be
      // inserted under — not rediscovered afterwards. The old read-back by
      // (callsign, startTime) kept the last match per pair, and another contact with the
      // same call at the same minute (another band, another station) could win: a new
      // 20 m contact's park was written onto an existing 40 m contact (R03).
      const refRows = chunk.flatMap(({ id, q }) => referenceRows(id, q));

      const qsoRows = chunk.map(({ id, q }) => ({
        id,
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
        // OUR OWN activation, from MY_SIG / MY_SIG_INFO / MY_GRIDSQUARE.
        //
        // Stored on import as well as on export, or the round trip is a half-truth: a
        // log exported from here and restored from that file — the backup path, and
        // the one that gets exercised on the worst day — would come back with every
        // activation reduced to an ordinary contact, and no way to tell which
        // contacts had been an activation.
        mySig: q.mySig,
        mySigInfo: q.mySigInfo,
        myGridSquare: q.myGridSquare,
        radio: q.radio,
        qslSent: q.qslSent,
        qslRcvd: q.qslRcvd,
        qslSentAt: q.qslSentAt,
        qslRcvdAt: q.qslRcvdAt,
        lotwSent: q.lotwSent,
        lotwRcvd: q.lotwRcvd,
        eqslSent: q.eqslSent,
        eqslRcvd: q.eqslRcvd,
        // MARKED AS ALREADY SENT unless the operator asked for the opposite. See
        // ImportOptions.uploadImported: LoTW and eQSL come from the file because ADIF
        // has fields for them; these four have no ADIF field at all, so without this
        // they read as "never uploaded" and the sweep re-sends the entire history.
        qrzSent: !opts.uploadImported,
        clublogSent: !opts.uploadImported,
        cloudlogSent: !opts.uploadImported,
        n3fjpSent: !opts.uploadImported,
        notes: q.notes,
        stationId: station.id,
        operatorId:
          (q.operatorCallsign
            ? operatorByCall.get(q.operatorCallsign)
            : undefined) ??
          opts.operatorId ??
          null,
      }));

      // The chunk and its references in ONE transaction. They used to be separate writes,
      // so a failure between them left contacts carrying a `sigInfo` with no reference rows
      // — the parent and the table that is the authority on "have I worked this park?"
      // disagreeing. Now a chunk lands whole or not at all; chunks already committed stay,
      // and a re-run with dedupe skips them.
      imported += await prisma.$transaction(async (tx) => {
        const { count } = await tx.qso.createMany({ data: qsoRows });
        if (refRows.length > 0) {
          await tx.qsoSigRef.createMany({ data: refRows, skipDuplicates: true });
        }
        return count;
      }, CHUNK_TX);
    }
  }

  const allProblems = [...problems, ...fileDupes];

  return {
    ok: true,
    report: {
      dryRun: opts.dryRun,
      dedupe: opts.dedupe,
      uploadImported: Boolean(opts.uploadImported),
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
 * Existing dupe keys, at `stationId` only, for the callsigns in this file. Fetched by
 * callsign rather than by exact tuple because MySQL has no efficient way to match a large
 * set of composite tuples, and callsign is indexed. The station is in the key as well as
 * the filter, so a row from another station could not match even if one came back.
 */
async function loadExistingKeys(stationId: string, callsigns: string[]): Promise<Set<string>> {
  const keys = new Set<string>();

  for (let i = 0; i < callsigns.length; i += CHUNK) {
    const rows = await prisma.qso.findMany({
      where: { stationId, callsign: { in: callsigns.slice(i, i + CHUNK) } },
      select: { stationId: true, callsign: true, band: true, mode: true, startTime: true },
    });
    for (const row of rows) keys.add(stationDupeKey(row.stationId, row));
  }

  return keys;
}
