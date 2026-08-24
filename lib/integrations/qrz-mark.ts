// Marking local contacts from what QRZ's logbook says about them.
//
// QRZ was treated as a service that only accepts QSOs and never confirms them, which
// is not true: it marks a contact confirmed once both operators have logged it, and
// reports that in APP_QRZLOG_STATUS on the way back out. It also gives every record its
// own id in APP_QRZLOG_LOGID.
//
// Both were being thrown away, and that cost twice over. Nothing recorded that QRZ
// already HAD a contact, so an upload run offered the entire log every time and relied
// on QRZ rejecting duplicates. And nothing recorded how far a download had got, so every
// sync fetched the whole logbook to discover a handful of new records.

import { dupeKey, parseAdifRecords, recordsToQsos } from "@/lib/adif/parse";
import { prisma } from "@/lib/db/prisma";

/** How many callsigns to look up, and how many rows to update, at a time. */
const CHUNK = 500;

export interface QrzMarkResult {
  /** Records in the ADIF QRZ sent us. */
  records: number;
  /** Records that matched a contact in the local log. */
  matched: number;
  /** Of those, how many were not already marked as being in QRZ's logbook. */
  newlySent: number;
  /** Of those, how many QRZ reports as confirmed and we did not. */
  newlyConfirmed: number;
  /** Matched a local contact that already carried a different QRZ id. */
  idChanged: number;
  /**
   * Records with no local match.
   *
   * Not an error and usually not even surprising — during an import these are exactly
   * the contacts about to be created. Reported because a sync that matches nothing is
   * worth noticing.
   */
  unmatched: number;
  /** The highest QRZ record id seen, which is the cursor for the next fetch. */
  highestLogId: number | null;
}

export function emptyMarkResult(): QrzMarkResult {
  return {
    records: 0,
    matched: 0,
    newlySent: 0,
    newlyConfirmed: 0,
    idChanged: 0,
    unmatched: 0,
    highestLogId: null,
  };
}

/**
 * One QRZ record, reduced to what marking needs.
 *
 * `key` is built by the same `dupeKey` the ADIF importer dedupes with — deliberately,
 * because a second matching rule that disagreed with the importer's would mark the wrong
 * contact, or mark nothing while the importer skipped everything as a duplicate. Both
 * failures look like the sync working.
 */
export interface QrzMarkable {
  key: string;
  callsign: string;
  logId: number | null;
  confirmed: boolean;
}

/**
 * True when QRZ says both operators have logged this contact.
 *
 * QRZ's status field carries `C` for a confirmed contact. Other values appear — `V` for
 * validated, `N` and `Y` in older exports — and none of them is documented anywhere
 * authoritative, so only `C` is treated as confirmation and everything else is left
 * alone. Reading an unknown code as confirmed would put a confirmation in the log that
 * QRZ never claimed, and nothing downstream could tell it from a real one.
 */
export function isQrzConfirmed(status: string | undefined): boolean {
  return (status ?? "").trim().toUpperCase() === "C";
}

/**
 * Pull the markable facts out of an ADIF document from QRZ.
 *
 * Each record is converted through the project's own parser rather than by reading the
 * fields directly, so band, mode and time normalisation are whatever the importer would
 * have done. FT8 arrives as MODE:FT8 from some logging programs and MODE:MFSK
 * SUBMODE:FT8 from others; a hand-rolled reader would produce a key that matches nothing
 * for every digital contact in the log, which is most of them here.
 *
 * Records the parser rejects are skipped rather than guessed at. Converting one record at
 * a time keeps each QRZ id with the contact it belongs to — zipping two lists by index
 * would silently pair the wrong ones the first time a record failed to parse.
 */
export function qrzMarkables(adif: string): QrzMarkable[] {
  const out: QrzMarkable[] = [];
  for (const fields of parseAdifRecords(adif)) {
    const { qsos } = recordsToQsos([fields]);
    const qso = qsos[0];
    if (!qso) continue;

    // Upper case because parseAdifRecords upper-cases every tag name it reads.
    const rawId = fields.APP_QRZLOG_LOGID;
    const id = rawId === undefined ? NaN : Number.parseInt(rawId, 10);
    out.push({
      key: dupeKey(qso),
      callsign: qso.callsign,
      logId: Number.isFinite(id) && id > 0 ? id : null,
      confirmed: isQrzConfirmed(fields.APP_QRZLOG_STATUS),
    });
  }
  return out;
}

/**
 * Mark local contacts that QRZ's logbook already has.
 *
 * `qrzSent` here means "QRZ has this contact", which is the question the uploader needs
 * answered and is not quite the same as "DigiShack sent it" — a contact logged on QRZ's
 * own site, or uploaded by a previous program, is equally not in need of uploading. The
 * alternative is offering it again and depending on QRZ to reject the duplicate, which is
 * what this replaces.
 *
 * Never clears a flag. QRZ paging returns a window of the logbook, so a contact's absence
 * from this document says nothing about whether QRZ has it, and turning `qrzSent` off on
 * that basis would re-upload the log a page at a time.
 */
export async function markFromQrzAdif(
  adif: string,
  opts: { dryRun: boolean },
): Promise<QrzMarkResult> {
  const markables = qrzMarkables(adif);
  const result = emptyMarkResult();
  result.records = markables.length;
  if (markables.length === 0) return result;

  for (const m of markables) {
    if (m.logId !== null && (result.highestLogId === null || m.logId > result.highestLogId)) {
      result.highestLogId = m.logId;
    }
  }

  const byKey = new Map<string, QrzMarkable>();
  for (const m of markables) byKey.set(m.key, m);

  const callsigns = [...new Set(markables.map((m) => m.callsign))];

  // Grouped by the change to make, so a page of 5,000 records is a handful of updates
  // rather than 5,000 of them. The id has to go one at a time, being a different value
  // per row, but only for rows whose id is actually new.
  const toSend: string[] = [];
  const toConfirm: string[] = [];
  const idUpdates: { id: string; logId: number }[] = [];

  for (let i = 0; i < callsigns.length; i += CHUNK) {
    const rows = await prisma.qso.findMany({
      where: { callsign: { in: callsigns.slice(i, i + CHUNK) } },
      select: {
        id: true,
        callsign: true,
        band: true,
        mode: true,
        startTime: true,
        qrzSent: true,
        qrzRcvd: true,
        qrzLogId: true,
      },
    });

    for (const row of rows) {
      const m = byKey.get(dupeKey(row));
      if (!m) continue;
      result.matched++;
      if (!row.qrzSent) {
        result.newlySent++;
        toSend.push(row.id);
      }
      if (m.confirmed && !row.qrzRcvd) {
        result.newlyConfirmed++;
        toConfirm.push(row.id);
      }
      if (m.logId !== null && row.qrzLogId !== m.logId) {
        if (row.qrzLogId !== null) result.idChanged++;
        idUpdates.push({ id: row.id, logId: m.logId });
      }
    }
  }

  result.unmatched = markables.length - result.matched;
  if (opts.dryRun) return result;

  for (let i = 0; i < toSend.length; i += CHUNK) {
    await prisma.qso.updateMany({
      where: { id: { in: toSend.slice(i, i + CHUNK) } },
      data: { qrzSent: true },
    });
  }
  for (let i = 0; i < toConfirm.length; i += CHUNK) {
    await prisma.qso.updateMany({
      where: { id: { in: toConfirm.slice(i, i + CHUNK) } },
      data: { qrzRcvd: true },
    });
  }
  for (const u of idUpdates) {
    await prisma.qso.update({ where: { id: u.id }, data: { qrzLogId: u.logId } });
  }

  return result;
}

/** Where the last differential download got to. */
export const KEY_QRZ_CURSOR = "qrz.lastLogId";

/**
 * The resume point for the next fetch.
 *
 * Zero means the beginning of the logbook, which is also what a first run does.
 */
export async function getQrzCursor(): Promise<number> {
  const row = await prisma.setting.findUnique({ where: { key: KEY_QRZ_CURSOR } });
  const n = Number.parseInt(row?.value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Move the cursor forward. Never backwards.
 *
 * A run limited by `maxPages` stops part way through the logbook, and a later full
 * resync passes 0 deliberately — neither should drag the cursor back and cause the next
 * ordinary sync to re-fetch ground already covered.
 */
export async function setQrzCursor(logId: number): Promise<void> {
  if (!Number.isFinite(logId) || logId <= 0) return;
  const current = await getQrzCursor();
  if (logId <= current) return;
  await prisma.setting.upsert({
    where: { key: KEY_QRZ_CURSOR },
    create: { key: KEY_QRZ_CURSOR, value: String(logId), encrypted: false },
    update: { value: String(logId) },
  });
}
