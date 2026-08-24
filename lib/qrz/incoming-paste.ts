// Parsing the QRZ "incoming QSL requests" table out of a paste.
//
// WHY A PASTE. QRZ's logbook API has no access to this queue — measured: `REQUESTS`, `QSLREQ`
// and `INCOMING` all come back `unrecognized command`, and the documented actions are STATUS,
// FETCH, INSERT and DELETE. The list exists only in the web UI, so the way to get it into this
// application is for the operator to copy it out of the browser.
//
// THE COLUMN THAT MATTERS IS "QSO Date", NOT "Request Received", and they are routinely months
// apart — one row here has a QSO on 2025-10-25 and a request filed on 2026-04-20. Reconciling
// against the wrong one produces a comparison that looks plausible and is wrong everywhere.
//
// The paste is whatever the browser put on the clipboard, which varies: tab-separated from a
// table selection, or several lines per row when the row wraps. So this looks for the SHAPE of
// a row rather than assuming a delimiter — two dates and a callsign after "de".

export interface IncomingRequest {
  /** When QRZ received the request. Kept for display; never used for matching. */
  requestedAt: Date | null;
  /** The contact date the far operator is claiming. THIS is what gets matched. */
  qsoDate: string;
  callsign: string;
}

export interface PasteResult {
  requests: IncomingRequest[];
  /** Lines that looked like data and could not be read, so a bad paste is visible. */
  unread: string[];
  /** Rows dropped as exact repeats of an earlier one — QRZ's own list contains duplicates. */
  duplicates: number;
}

/** `K9XYZ de EA8ATE` → `EA8ATE`. Also tolerates a bare callsign. */
function callsignFrom(text: string): string | null {
  const de = /\bde\s+([A-Z0-9/]{3,})\s*$/i.exec(text.trim());
  if (de) return de[1]!.toUpperCase();
  const bare = /^([A-Z0-9/]{3,})$/i.exec(text.trim());
  return bare ? bare[1]!.toUpperCase() : null;
}

const DATE = /(\d{4}-\d{2}-\d{2})/g;

/**
 * Read the pasted table.
 *
 * A row is recognised by containing a callsign and at least one ISO date. With TWO dates the
 * SECOND is the QSO date, matching QRZ's column order — request received first, QSO date
 * second. With one date, that is the QSO date: some clipboard formats drop the timestamp
 * column entirely.
 */
export function parseIncomingPaste(text: string): PasteResult {
  const out: PasteResult = { requests: [], unread: [], duplicates: 0 };
  const seen = new Set<string>();

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    // The header, and QRZ's row-number column on its own.
    if (/request\s*received/i.test(line) && /qso\s*date/i.test(line)) continue;
    if (/^\d+$/.test(line)) continue;

    const dates = [...line.matchAll(DATE)].map((m) => m[1]!);
    const call = callsignFrom(line.replace(/\s+$/, ""));
    if (!call || dates.length === 0) {
      // Only complain about lines that look like they were meant to be data.
      if (/\bde\b/i.test(line) || dates.length > 0) out.unread.push(line.slice(0, 120));
      continue;
    }

    const qsoDate = dates.length >= 2 ? dates[1]! : dates[0]!;
    const requestedAt = dates.length >= 2 ? new Date(`${dates[0]!}T00:00:00Z`) : null;

    const key = `${qsoDate}|${call}`;
    if (seen.has(key)) {
      out.duplicates++;
      continue;
    }
    seen.add(key);
    out.requests.push({
      requestedAt: requestedAt && !Number.isNaN(requestedAt.getTime()) ? requestedAt : null,
      qsoDate,
      callsign: call,
    });
  }
  return out;
}
