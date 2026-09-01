// Recognising the same logged contact twice.
//
// An external decoder announces a finished QSO over UDP, and it can announce the same one
// more than once — a resend, a second client, a restart replaying its queue. Writing every
// announcement produces duplicate rows in the operator's log, so the bridge keeps a short
// memory of what it has just written and declines repeats.
//
// THE MEMORY HAS TO BE KEYED ON WHAT GETS STORED, and for a long time it was not:
//
//     const key = `${msg.dxCall}|${band}|${msg.mode}`;   // raw, off the wire
//     ...
//     callsign: msg.dxCall.toUpperCase(),                // stored
//     mode: normaliseMode(msg.mode),                     // stored
//
// WSJT-X reports FT4 as MFSK, so the same contact arriving once as `MFSK` and once as `FT4`
// produced two different keys, collided with neither, and wrote two rows that are identical
// in every column a person looks at. Reported from another station as three log entries per
// callsign on FT4 — one carrying the grid, the others not.
//
// The window was never the problem. The guard was watching for a collision that could not
// happen. Pure and exported so that is provable without a radio.

/**
 * The mode as the log should record it.
 *
 * WSJT-X reports FT4 as `MFSK` — the ADIF MODE for the modulation, with FT4 in SUBMODE.
 * An operator looking at their log wants to read FT4.
 */
export function normaliseMode(mode: string): string {
  const m = mode.trim().toUpperCase();
  if (m === "MFSK") return "FT4";
  return m.slice(0, 12) || "FT8";
}

/** The callsign as the log should record it. */
export function normaliseCallsign(call: string): string {
  return call.trim().toUpperCase();
}

/**
 * The dedup key for a logged contact.
 *
 * Built from the NORMALISED values, so two spellings of one contact collide the way they
 * are supposed to. Every field here must match the field actually written to the row — if
 * a caller ever normalises something differently on the way to the database, this key stops
 * protecting it and the duplicates come back.
 */
export function logDedupKey(call: string, band: string, mode: string): string {
  return `${normaliseCallsign(call)}|${band.trim().toUpperCase()}|${normaliseMode(mode)}`;
}
