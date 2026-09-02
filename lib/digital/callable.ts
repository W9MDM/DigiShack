// Which decoded messages mean "this station can be called right now".
//
// Until now the answer was one line in `rankWindow`: `p.kind === "cq"`. A station calling
// CQ is asking to be called, so nothing else needed considering.
//
// THE OPERATOR'S POINT: a station that has just sent RR73 has finished. It is not merely
// callable, it is the BEST moment on the band to call — they are free, they are still warm,
// and everyone else is still waiting for their next CQ. GridTracker exposes this as
// "Highlight also messages with 73 or RR73".
//
// AND THE REASONING IS ALREADY IN THIS CODEBASE. `QsoSequencer` draws exactly the
// distinction, at lib/digital/qso.ts:571, written for a different question:
//
//     // A CLOSING TOKEN FREES THEM. `KO4OIG N5MIG/P RR73` ends their exchange, so this
//     // is the best possible moment to be calling rather than a reason to stop — the
//     // next window is the one to be in, ahead of everyone else who was waiting.
//
// That comment was written about abandoning our own call. The rule it states is the rule
// this file needs, so it is lifted here rather than restated: a CLOSING token frees them, a
// grid or a report means they are committed to somebody else for several windows and are
// not listening.
//
// WHY THIS IS ITS OWN FILE. It decides what keys a transmitter. `rankWindow` is described
// in its own comments as "the one source of truth" for callability, and the way to keep it
// that way while adding a second admission rule is to make the rule a pure function that
// can be asserted exhaustively — rather than a second condition bolted onto a filter, which
// is how two paths come to disagree about one question.

import { parseMessage, type ParsedMessage } from "@/lib/digital/qso";

/**
 * Payload types that mean the sender has FINISHED with whoever they were working.
 *
 * `rrr` is included: it is an acknowledgement that ends the exchange in the older sequence,
 * and a station sending it is as free as one sending RR73.
 */
const CLOSING = new Set(["rr73", "rrr", "73"]);

export interface CallableOptions {
  /** Our own callsign, so we never treat our own transmission as an invitation. */
  myCall: string;
  /**
   * Admit stations that just closed a contact with somebody else.
   *
   * Off by default. On, it widens the hunt from "stations asking to be called" to "stations
   * asking to be called, plus stations that have just become free".
   */
  treatClosingAsCallable?: boolean;
}

export type CallableVerdict =
  | { callable: false; reason: string }
  | { callable: true; via: "cq" | "closing" };

/**
 * May the hunt call the sender of this message?
 *
 * Takes an already-parsed message so callers that have one do not parse twice —
 * `rankWindow` parses every decode in the window exactly once.
 */
export function callableFrom(p: ParsedMessage, opts: CallableOptions): CallableVerdict {
  const me = opts.myCall.trim().toUpperCase();

  // "other" is anything the parser could not read as a CQ or a directed exchange. It has no
  // sender to call, so it is never callable and there is nothing further to ask about it.
  if (p.kind === "other") return { callable: false, reason: "unparsed message" };

  // OURSELVES, FIRST AND UNCONDITIONALLY. A decoder that hears its own transmission — and
  // it does, on a shared receiver or from a loud neighbour — must never produce a candidate.
  if (p.from.toUpperCase() === me) {
    return { callable: false, reason: "our own transmission" };
  }

  if (p.kind === "cq") return { callable: true, via: "cq" };

  if (!opts.treatClosingAsCallable) {
    return { callable: false, reason: "not a CQ" };
  }

  // A CLOSING TOKEN ADDRESSED TO US IS OUR OWN CONTACT ENDING, not an opportunity. The
  // sequencer is already handling that exchange; treating it as an invitation would have
  // the hunt queue up the station we have just finished working — which the dupe guard
  // would then refuse, but only after spending a window on it.
  if (p.to && p.to.toUpperCase() === me) {
    return { callable: false, reason: "their sign-off to us — our own contact closing" };
  }

  if (CLOSING.has(p.payload.type)) {
    return { callable: true, via: "closing" };
  }

  // MID-EXCHANGE. A grid, a report, an R-report, a contest exchange: they are committed to
  // that station for several windows and are not listening for anyone else. Calling now is
  // doubling on somebody else's contact, which is the exact rudeness this feature must not
  // introduce while chasing the one it fixes.
  return {
    callable: false,
    reason: `mid-exchange with ${p.to ?? "another station"}`,
  };
}

/** Convenience for callers holding only the raw message text. */
export function callableFromMessage(message: string, opts: CallableOptions): CallableVerdict {
  return callableFrom(parseMessage(message), opts);
}
