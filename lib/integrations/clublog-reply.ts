// How Club Log's replies are read.
//
// A separate file from `clublog.ts` so these rules can be asserted without importing
// settings, which reaches the database — the same reason `broadcast-policy.ts` is not
// part of the bridge. `scripts/check-clublog.ts` calls THESE, not a copy of them:
// check-dxcc.ts spent a long time asserting a rule only its own reimplementation
// followed.
//
// EVERY CASE HERE WAS MEASURED against the live service on 2026-08-30, from the station's
// own address, with a valid API key attached:
//
//     realtime.php   a new contact            200   "OK"
//     realtime.php   a contact already held   200   "Dupe"
//     putlogs.php    a 22-record file         200   "digishack.adi (546 bytes) => K9XYZ :
//                                                    Upload accepted and queued!"
//
// Club Log says what happened in the BODY and answers 200 either way, so the status alone
// never distinguishes accepted from rejected.

/** What Club Log's answer meant. */
export interface ClubLogReplyVerdict {
  /** The contact is on Club Log — including when it was already there. */
  ok: boolean;
  /**
   * Club Log already held this contact.
   *
   * SUCCESS, not failure, and the distinction is load-bearing. The goal is for the
   * contact to BE on Club Log; "Dupe" means it is. Reading it as a failure would leave
   * the row flagged unsent and re-send it every sweep for ever — a self-inflicted,
   * permanent stream of requests aimed at a service that blocks addresses for exactly
   * that.
   *
   * Counted separately only so a run can report "24 delivered" apart from "24 were
   * already there".
   */
  duplicate: boolean;
  /** Club Log's own words wherever it wrote any, because guessing at them helps nobody. */
  detail: string;
}

/**
 * Words Club Log uses when it is refusing, checked against a 200 body.
 *
 * Deliberately does NOT include "missing": a refusal for a missing field arrives as a
 * non-200, and the word is common enough in ordinary prose to risk reading an acceptance
 * as a rejection. A false rejection is the cheaper mistake here — it re-sends and earns a
 * "Dupe" — but only because the dupe case above is handled first.
 */
const REFUSAL_WORDS = /error|invalid|denied|fail|reject/i;

/** An nginx error page rather than anything Club Log wrote. */
const EDGE_PAGE = /<html|nginx/i;

/**
 * Read one reply from Club Log.
 *
 * WHAT THE BARE 403 ACTUALLY MEANT, corrected. Both write endpoints answered a bare nginx
 * 403 from this installation for a month, and the conclusion drawn — and written into
 * this file's predecessor as settled fact — was that Club Log refuses uploads from here
 * at its edge and NOTHING could change it. That was wrong. The cause was a missing `api`
 * key: without one the request is refused before PHP, so there is no error text, no
 * mention of credentials, and nothing to separate it from a firewall rule. Reads kept
 * working from the same address throughout, which made the false diagnosis fit perfectly
 * — "the refusal follows the path, reads pass and writes do not" describes a missing form
 * field exactly as well as it describes a block.
 *
 * So the edge refusal is no longer reported as permanent. It is an ordinary failure
 * carrying an ACTIONABLE message, because the operator can in fact fix it, and telling
 * somebody a fixable problem is hopeless is worse than saying nothing. The retry pressure
 * that `permanent` was invented to suppress belongs to the circuit breaker instead, which
 * is the right mechanism for it: three failed sweeps and the service stands down on its
 * own.
 */
export function classifyClubLogReply(status: number, rawBody: string): ClubLogReplyVerdict {
  const body = rawBody.trim();

  if (status < 200 || status >= 300) {
    // Club Log's OWN 403 carries its own words and means something entirely different
    // from the edge's, so this matches on the body rather than the status alone.
    if (status === 403 && EDGE_PAGE.test(body) && !/clublog/i.test(body)) {
      return {
        ok: false,
        duplicate: false,
        detail:
          "Club Log refused the upload before it reached the application (a bare nginx 403). " +
          "That is what a missing or wrong API key looks like from here — refused at the edge, " +
          "so there is no message about credentials. Set the Club Log API key in Settings; it " +
          "is requested from Club Log's helpdesk rather than generated on the site.",
      };
    }
    return { ok: false, duplicate: false, detail: `HTTP ${status}: ${body.slice(0, 300)}` };
  }

  // Checked BEFORE the refusal words, and it has to be: a body that is only "Dupe" is an
  // accepted outcome, and any ordering that let it reach the refusal test would be one
  // regex change away from re-sending every already-held contact for ever.
  if (/^dupe\b/i.test(body)) {
    return { ok: true, duplicate: true, detail: body.slice(0, 300) };
  }

  // AN EMPTY 200 IS A FAILURE, and this is a judgement call rather than a measurement.
  // Club Log answered every one of the requests above with words. Silence means something
  // went wrong that it did not describe, and the two ways to be wrong are not equal:
  // reading it as success marks the contact sent and it is then never retried and never
  // arrives, while reading it as failure costs one repeat that earns a "Dupe".
  if (body === "") {
    return { ok: false, duplicate: false, detail: "Club Log returned 200 with an empty body" };
  }

  const refused = REFUSAL_WORDS.test(body);
  return { ok: !refused, duplicate: false, detail: body.slice(0, 300) };
}
