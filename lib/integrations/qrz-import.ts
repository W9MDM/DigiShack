import { importAdifDocument } from "@/lib/adif/import-service";
import { FETCH_PAGE, fetchQrzPage } from "@/lib/integrations/qrz-logbook";
import {
  emptyMarkResult,
  getQrzCursor,
  markFromQrzAdif,
  type QrzMarkResult,
  setQrzCursor,
} from "@/lib/integrations/qrz-mark";

// Pull an entire QRZ logbook into DigiShack.
//
// Read-only against QRZ — this only ever calls FETCH. It is the practical way to
// seed a real log, and it reuses importAdifDocument() so dedupe, band derivation
// from frequency, and per-record problem reporting behave exactly as they do for
// a hand-uploaded file.

export interface QrzImportReport {
  dryRun: boolean;
  pages: number;
  fetched: number;
  /** Records that parsed into usable QSOs. */
  valid: number;
  imported: number;
  /** On a dry run, how many WOULD be inserted. Zero on a real run. */
  pending: number;
  alreadyInLog: number;
  rejected: number;
  duplicatesInFile: number;
  frequencyInferred: number;
  problems: { record: number; callsign?: string; message: string }[];
  lastLogId: number | null;
  stoppedBecause: "complete" | "page-limit" | "error";
  error?: string;
  /**
   * What the download taught us about contacts we already had.
   *
   * An import that reports 0 imported and 400 alreadyInLog used to be a wasted run.
   * It is not: those 400 are contacts QRZ demonstrably HAS, and marking them is what
   * stops the uploader offering them again.
   */
  marked: QrzMarkResult;
  /** Where the fetch started. Non-zero means it was a differential download. */
  startedAfterLogId: number;
  /** The cursor stored for next time, or null when nothing moved it. */
  cursorNow: number | null;
}

export interface QrzImportOptions {
  stationId: string;
  operatorId?: string;
  dryRun: boolean;
  /** Safety stop. Each page is up to FETCH_PAGE records. */
  maxPages: number;
  /**
   * Resume point.
   *
   * Omit it for an ordinary differential download, which starts where the last one
   * finished. Pass 0 to deliberately re-read the whole logbook — worth having, because
   * QRZ can be edited on their site and a full pass is the only way to see that.
   */
  afterLogId?: number;
}

/**
 * Fetch from QRZ, mark what it already has, and remember where we got to.
 *
 * The cursor is saved however this returns — including on an error part way through.
 * A run that fetched eight pages and failed on the ninth has still learnt where those
 * eight ended, and throwing that away means the retry does the same work again.
 */
export async function importQrzLogbook(
  opts: QrzImportOptions,
): Promise<QrzImportReport> {
  const report = await runImport(opts);
  if (!opts.dryRun && report.marked.highestLogId !== null) {
    await setQrzCursor(report.marked.highestLogId);
  }
  report.cursorNow = await getQrzCursor();
  return report;
}

async function runImport(opts: QrzImportOptions): Promise<QrzImportReport> {
  const report: QrzImportReport = {
    dryRun: opts.dryRun,
    pages: 0,
    fetched: 0,
    valid: 0,
    imported: 0,
    pending: 0,
    alreadyInLog: 0,
    rejected: 0,
    duplicatesInFile: 0,
    frequencyInferred: 0,
    problems: [],
    lastLogId: null,
    stoppedBecause: "complete",
    marked: emptyMarkResult(),
    startedAfterLogId: 0,
    cursorNow: null,
  };

  // Where to start. Every run used to start at zero and re-download the entire logbook
  // to discover a handful of new records — QRZ's AFTERLOGID paging was already being
  // used, but only within a run, and the position was thrown away at the end of it.
  const cursor0 = opts.afterLogId ?? (await getQrzCursor());
  report.startedAfterLogId = cursor0;
  let cursor = cursor0;
  let previousCursor = -1;

  while (report.pages < opts.maxPages) {
    const page = await fetchQrzPage(cursor, FETCH_PAGE);

    if (!page.ok) {
      report.stoppedBecause = "error";
      report.error = page.error;
      return report;
    }

    const ids = page.adif ? page.adif.trim() : "";
    if (!ids || page.count === 0 || page.lastLogId === undefined) {
      // No more records.
      return report;
    }

    report.pages++;
    report.fetched += page.count;
    report.lastLogId = page.lastLogId;

    // Mark BEFORE importing, so "already in the log" still means what it says.
    //
    // Order matters here. Importing first creates the missing contacts, and they would
    // then be marked as being in QRZ's logbook by the very document that proves QRZ has
    // them — which is true, and harmless, but it makes the counts unreadable: every new
    // contact would report as newly-marked-sent as well as imported. Marking first means
    // newlySent counts only contacts we already had and did not know QRZ had too.
    const marks = await markFromQrzAdif(page.adif!, { dryRun: opts.dryRun });
    report.marked.records += marks.records;
    report.marked.matched += marks.matched;
    report.marked.newlySent += marks.newlySent;
    report.marked.newlyConfirmed += marks.newlyConfirmed;
    report.marked.idChanged += marks.idChanged;
    report.marked.unmatched += marks.unmatched;
    if (
      marks.highestLogId !== null &&
      (report.marked.highestLogId === null || marks.highestLogId > report.marked.highestLogId)
    ) {
      report.marked.highestLogId = marks.highestLogId;
    }

    const outcome = await importAdifDocument(Buffer.from(page.adif!, "utf8"), {
      stationId: opts.stationId,
      operatorId: opts.operatorId,
      dryRun: opts.dryRun,
      // Always dedupe: paging is inclusive of the boundary record, and an
      // interrupted run should be safe to restart from the beginning.
      dedupe: true,
    });

    if (!outcome.ok) {
      report.stoppedBecause = "error";
      report.error = outcome.error;
      return report;
    }

    report.valid += outcome.report.valid;
    report.imported += outcome.report.imported;
    report.pending += outcome.report.pending;
    report.alreadyInLog += outcome.report.alreadyInLog;
    report.rejected += outcome.report.rejected;
    report.duplicatesInFile += outcome.report.duplicatesInFile;
    report.frequencyInferred += outcome.report.frequencyInferred;

    // Keep only a bounded sample across all pages.
    for (const p of outcome.report.problems) {
      if (report.problems.length < 100) report.problems.push(p);
    }

    // A page shorter than the limit is the last one.
    if (page.count < FETCH_PAGE) return report;

    // Guard against a non-advancing cursor turning this into an endless loop —
    // AFTERLOGID being inclusive means a single-record final page would
    // otherwise repeat forever.
    if (page.lastLogId <= previousCursor) return report;

    previousCursor = cursor;
    cursor = page.lastLogId;
  }

  report.stoppedBecause = "page-limit";
  return report;
}
