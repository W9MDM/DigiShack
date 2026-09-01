// Is a directed CQ addressed to us?
//
// "CQ KH KD2TC" is a station calling HAWAII. Answering it from Indiana is both rude and
// futile — they will not come back, and the four transmit cycles spent finding that out
// were cycles nobody got a contact from. Reported from a live station:
//
//     ▼ CQ KH KD2TC   52:30 -17
//     ▲ KD2TC W9ABC EN61   53:15
//     ▲ KD2TC W9ABC EN61   53:45
//
// The parser has captured the modifier since it was written; nothing ever read it except
// the POTA hunt. Every other directed CQ was answered as if it were a plain one.
//
// THE RULE IS DELIBERATELY PERMISSIVE ABOUT WHAT IT DOES NOT KNOW. A modifier this file
// cannot classify is answered, because a missed contact is a worse outcome than an
// occasional wasted call, and amateurs invent modifiers faster than anyone can enumerate
// them. Only a modifier that is RECOGNISED and does not match is refused.

/** Continent codes as they appear after CQ, and as `resolveDxcc` reports them. */
const CONTINENTS = new Set(["NA", "SA", "EU", "AF", "AS", "OC", "AN"]);

/**
 * Modifiers that describe what the CALLER is doing, not who they want.
 *
 * "CQ POTA" is "I am in a park, call me" — the opposite of a restriction, and answering it
 * is the entire point of the POTA hunt. Same for a contest, a summit, an island or a
 * lighthouse: the modifier advertises the caller rather than filtering the answerer.
 */
const ACTIVITIES = new Set([
  "POTA",
  "SOTA",
  "IOTA",
  "WWFF",
  "GOTA",
  "FD",
  "TEST",
  "CONTEST",
  "QRP",
  "WW",
  "DIGI",
  "FT8",
  "FT4",
  "SKED",
  "QSO",
  "PARK",
  "SUMMIT",
  "LIGHTHOUSE",
]);

export interface CqAudience {
  /** Our callsign, for prefix and call-area matching. */
  myCall: string;
  /** Our continent as `resolveDxcc` reports it ("NA"), or null when unknown. */
  myContinent?: string | null;
  /** Our DXCC entity number, for "CQ DX". Null when unknown. */
  myDxcc?: number | null;
  /** The caller's DXCC entity number, for "CQ DX". Null when unknown. */
  theirDxcc?: number | null;
}

export interface CqVerdict {
  /** May we answer it? */
  forUs: boolean;
  /** Why not, for the status line and the log. Null when answerable. */
  reason: string | null;
}

/**
 * Decide whether a CQ's modifier excludes us.
 *
 * Answerable, in order: no modifier at all; an activity; a continent we are on; "DX" from
 * another entity; a prefix or call area our own callsign matches; anything unrecognised.
 */
export function cqIsForUs(modifier: string | null, who: CqAudience): CqVerdict {
  if (!modifier) return { forUs: true, reason: null };

  const m = modifier.toUpperCase();
  const call = who.myCall.toUpperCase();

  if (ACTIVITIES.has(m)) return { forUs: true, reason: null };

  // "CQ DX" — they want a different DXCC entity from their own. Answered when we KNOW we
  // are one, and also when either entity is unknown: refusing on missing data would make
  // an un-looked-up callsign look like a restriction it never carried.
  if (m === "DX") {
    if (who.myDxcc == null || who.theirDxcc == null) return { forUs: true, reason: null };
    return who.myDxcc === who.theirDxcc
      ? { forUs: false, reason: "calling DX, and we are in their own DXCC entity" }
      : { forUs: true, reason: null };
  }

  if (CONTINENTS.has(m)) {
    const mine = (who.myContinent ?? "").toUpperCase();
    if (!mine) return { forUs: true, reason: null };
    return mine === m
      ? { forUs: true, reason: null }
      : { forUs: false, reason: `calling ${m}, and we are ${mine}` };
  }

  // A BARE CALL AREA: "CQ 9" wants US ninth-district stations. Matched against the digit in
  // our own callsign rather than its position, because a prefix may be one or two letters.
  if (/^\d$/.test(m)) {
    const ourArea = /\d/.exec(call)?.[0] ?? null;
    return ourArea === m
      ? { forUs: true, reason: null }
      : { forUs: false, reason: `calling call area ${m}, and we are ${ourArea ?? "unknown"}` };
  }

  // A PREFIX: "CQ KH", "CQ JA", "CQ VK", "CQ W", "CQ DL". Recognised by shape — one to
  // three characters, letters possibly followed by a digit, which is what a callsign prefix
  // looks like. Answered when our own call starts with it.
  if (/^[A-Z]{1,2}\d?$/.test(m) && m.length <= 3) {
    return call.startsWith(m)
      ? { forUs: true, reason: null }
      : { forUs: false, reason: `calling ${m} stations, and we are ${call}` };
  }

  // Anything else — a contest abbreviation, a club, something invented last week. Answered,
  // because guessing that an unknown word is a restriction would cost real contacts.
  return { forUs: true, reason: null };
}
