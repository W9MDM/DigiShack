// Which logged contact a received card is for.
//
// Pure: the importer hands in the contacts with that callsign and what the card said about
// itself, and gets back a decision with a sentence explaining it. Tested on its own by
// scripts/check-qsl-inbound.ts.
//
// THE RULE, in the order it is applied, and why each step stops where it does:
//
//   1. A reply to OUR card is matched through the card we sent: we know exactly which
//      contact that email was about. Only when there is no such card does it fall through.
//   2. A card that states its time (K9XYZ_20261023_1838_20M_FT4.jpg) matches a contact within
//      ten minutes of it, on the same band and mode where the card says. Several equally good
//      is AMBIGUOUS — a person picks. Right time, wrong band or mode is ambiguous too, never
//      a match: the card is evidence about a specific contact, and quietly crediting a
//      different one is the failure this module exists to avoid.
//   3. A card with only a date matches the ONE contact with that station within a day of it.
//   4. A card with no date at all matches the one contact in the two months before it arrived
//      — or, failing that, the only contact with that station ever logged.
//   Anything else is ambiguous (candidates named) or unmatched, never a guess.

import { baseCall } from "@/lib/qsl/inbound/classify";
import type { FileHints } from "@/lib/qsl/inbound/classify";

export interface QsoCandidate {
  id: string;
  callsign: string;
  band: string;
  mode: string;
  startTime: Date;
}

/** One of OUR emailed cards to this station, for matching a reply or a bounce to it. */
export interface SentCard {
  qsoId: string;
  /** When it went; createdAt where sentAt was never recorded. */
  at: Date;
}

export type MatchStatus = "MATCHED" | "AMBIGUOUS" | "UNMATCHED";

export interface MatchResult {
  status: MatchStatus;
  qsoId: string | null;
  /** The contacts a person should choose between, when ambiguous. */
  candidateIds: string[];
  note: string;
}

export interface MatchInput {
  callsign: string | null;
  kind: "card" | "reply" | "notice";
  receivedAt: Date;
  hints: FileHints;
  /** Our cards to this station, for a reply. */
  sentCards?: SentCard[];
}

const MIN = 60_000;
const DAY = 86_400_000;
/** How far a card's stated time may be from the logged one. Clocks and logging differ. */
export const EXACT_WINDOW_MS = 10 * MIN;
/** How far back an undated card is assumed to reach. */
export const UNDATED_WINDOW_MS = 60 * DAY;
/** How far back a reply looks for the card it answers. */
const REPLY_WINDOW_MS = 30 * DAY;

function describe(q: QsoCandidate): string {
  return `${q.callsign} ${q.band} ${q.mode} ${q.startTime.toISOString().slice(0, 16).replace("T", " ")}Z`;
}

function listed(qs: QsoCandidate[]): string {
  const shown = qs.slice(0, 6).map(describe).join("; ");
  return qs.length > 6 ? `${shown}; and ${qs.length - 6} more` : shown;
}

function sameBandMode(q: QsoCandidate, hints: FileHints): boolean {
  if (hints.band && q.band.toUpperCase() !== hints.band.toUpperCase()) return false;
  if (hints.mode && q.mode.toUpperCase() !== hints.mode.toUpperCase()) return false;
  return true;
}

function one(q: QsoCandidate, note: string): MatchResult {
  return { status: "MATCHED", qsoId: q.id, candidateIds: [q.id], note };
}

function ambiguous(qs: QsoCandidate[], why: string): MatchResult {
  const sorted = [...qs].sort((a, b) => b.startTime.getTime() - a.startTime.getTime());
  return {
    status: "AMBIGUOUS",
    qsoId: null,
    candidateIds: sorted.slice(0, 20).map((q) => q.id),
    note: `${why}: ${listed(sorted)}`,
  };
}

function none(note: string): MatchResult {
  return { status: "UNMATCHED", qsoId: null, candidateIds: [], note };
}

/** The card's stated moment, from its filename, as a UTC instant. */
function statedTime(h: FileHints): Date | null {
  if (!h.date || !h.time) return null;
  const t = new Date(`${h.date}T${h.time.slice(0, 2)}:${h.time.slice(2, 4)}:00Z`);
  return Number.isNaN(t.getTime()) ? null : t;
}

export function matchQso(input: MatchInput, candidates: QsoCandidate[]): MatchResult {
  if (!input.callsign) return none("No callsign could be read from the message.");
  const call = baseCall(input.callsign);

  // Only this station, and only contacts that existed when the card arrived — a card cannot
  // confirm a contact made after it was sent. A few minutes' grace for clock differences.
  const pool = candidates.filter(
    (q) => baseCall(q.callsign) === call && q.startTime.getTime() <= input.receivedAt.getTime() + EXACT_WINDOW_MS,
  );
  if (pool.length === 0) return none(`No contact with ${call} is in the log.`);

  // 1. A reply answers a card we sent.
  if (input.kind === "reply" && input.sentCards && input.sentCards.length > 0) {
    const ids = new Set(pool.map((q) => q.id));
    const before = input.sentCards.filter(
      (c) => ids.has(c.qsoId) && c.at.getTime() <= input.receivedAt.getTime(),
    );
    const recent = before.filter((c) => input.receivedAt.getTime() - c.at.getTime() <= REPLY_WINDOW_MS);
    const choose = recent.length > 0 ? recent : before;
    const distinct = [...new Set(choose.map((c) => c.qsoId))];
    if (distinct.length === 1) {
      const q = pool.find((p) => p.id === distinct[0])!;
      return one(q, `A reply to the card emailed for ${describe(q)}.`);
    }
    if (distinct.length > 1) {
      return ambiguous(
        pool.filter((q) => distinct.includes(q.id)),
        `A reply, and ${distinct.length} cards were emailed to ${call}`,
      );
    }
  }

  // 2. A stated time.
  const at = statedTime(input.hints);
  if (at) {
    const near = pool.filter((q) => Math.abs(q.startTime.getTime() - at.getTime()) <= EXACT_WINDOW_MS);
    const exact = near.filter((q) => sameBandMode(q, input.hints));
    if (exact.length === 1) {
      const q = exact[0]!;
      const off = Math.round(Math.abs(q.startTime.getTime() - at.getTime()) / MIN);
      return one(q, `The card's time matches ${describe(q)}${off > 0 ? ` (${off} min apart)` : ""}.`);
    }
    if (exact.length > 1) return ambiguous(exact, "Several contacts fit the card's time");
    if (near.length > 0) {
      return ambiguous(near, "The time fits but the band or mode on the card differs from the log");
    }
  }

  // 3. A stated date.
  if (input.hints.date) {
    const dayStart = new Date(`${input.hints.date}T00:00:00Z`).getTime();
    const inWindow = pool.filter(
      (q) => q.startTime.getTime() >= dayStart - DAY && q.startTime.getTime() < dayStart + 2 * DAY,
    );
    const fitting = inWindow.filter((q) => sameBandMode(q, input.hints));
    if (fitting.length === 1) {
      return one(fitting[0]!, `The only contact with ${call} near ${input.hints.date}${at ? " (the time on the card differs)" : ""}.`);
    }
    if (fitting.length > 1) return ambiguous(fitting, `Several contacts with ${call} near ${input.hints.date}`);
    if (inWindow.length > 0) {
      return ambiguous(inWindow, `Contacts with ${call} near ${input.hints.date}, but not on the card's band or mode`);
    }
    // A card that names a day and fits no contact near it is not credited to some other day.
    return none(`No contact with ${call} near ${input.hints.date}, the date on the card.`);
  }

  // 4. No date: recent contacts first, then the only one there has ever been.
  const recent = pool.filter(
    (q) => input.receivedAt.getTime() - q.startTime.getTime() <= UNDATED_WINDOW_MS && sameBandMode(q, input.hints),
  );
  if (recent.length === 1) return one(recent[0]!, `The only recent contact with ${call}: ${describe(recent[0]!)}.`);
  if (recent.length > 1) return ambiguous(recent, `Several recent contacts with ${call}`);
  if (pool.length === 1) return one(pool[0]!, `The only contact with ${call} in the log: ${describe(pool[0]!)}.`);
  return ambiguous(pool, `${pool.length} contacts with ${call}, none recent`);
}
