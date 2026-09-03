// Reading the live chat, so a viewer can ask to be worked.
//
// "read chat comments so people can comment what band they are on or their callsign and i
// will go hunt them."
//
// WHAT MAKES THIS DIFFERENT FROM EVERY OTHER INPUT THIS PROGRAM TAKES. A decode comes off
// the air and is bounded by the protocol: thirteen characters, a fixed alphabet, parsed by
// a codec. A chat message is arbitrary text typed by anyone on the internet, and the thing
// it is being turned into is a station this transmitter might call.
//
// So this file EXTRACTS and REFUSES. It does not call anyone. What it produces is a list of
// requests for the operator to look at — the operator said "I will go hunt them", and that
// is also the only defensible default: a stranger typing a callsign must not key a radio.
// If auto-calling is ever wanted, it belongs behind `mayCall`, the do-not-call list and the
// dupe guard exactly like a decode, and behind a setting that is off.
//
// QUOTA IS THE REAL CONSTRAINT, not the code. `liveChatMessages.list` costs units per call
// against a daily allowance, and YouTube's own suggested polling interval would exhaust a
// default quota long before the operating day ended. The interval is therefore a setting
// with a conservative default, and the poller obeys whichever is LONGER — ours or the
// interval YouTube asks for.

/** A callsign somebody asked us to work, with whatever else they said. */
export interface ChatRequest {
  /** The callsign, upper-cased. */
  callsign: string;
  /** A band if they gave one, normalised to "20M" form. Null otherwise. */
  band: string | null;
  /** Who asked, for the overlay. */
  from: string;
  /** When the message was published. */
  at: number;
  /** The message verbatim, so the operator can see what was actually said. */
  text: string;
}

/**
 * Callsign shape.
 *
 * Deliberately STRICTER than the ITU allows in one direction and looser in another: it must
 * contain a digit and at least one letter after it, which is what separates a callsign from
 * the ordinary words chat is full of. "HELLO" and "GOOD" and "73" are not callsigns; "W1AW",
 * "VK9/W1ABC" and "K5MGY/P" are.
 *
 * Anchored, because an unanchored callsign pattern matches inside words — "SCOTLAND"
 * contains no digit, but "COVID19" would satisfy a lazier rule and there is no shortage of
 * chat text that would.
 */
const CALLSIGN = /^(?:[A-Z0-9]{1,4}\/)?[A-Z]{1,2}[0-9][A-Z]{1,4}(?:\/[A-Z0-9]{1,4})?$/;

/** Bands a request may name, in the spellings people actually type. */
const BANDS = new Map<string, string>([
  ["160", "160M"], ["160M", "160M"],
  ["80", "80M"], ["80M", "80M"],
  ["60", "60M"], ["60M", "60M"],
  ["40", "40M"], ["40M", "40M"],
  ["30", "30M"], ["30M", "30M"],
  ["20", "20M"], ["20M", "20M"],
  ["17", "17M"], ["17M", "17M"],
  ["15", "15M"], ["15M", "15M"],
  ["12", "12M"], ["12M", "12M"],
  ["10", "10M"], ["10M", "10M"],
  ["6", "6M"], ["6M", "6M"],
  ["2", "2M"], ["2M", "2M"],
]);

/**
 * Pull a callsign and optional band out of one chat message.
 *
 * Returns null for anything that does not clearly contain a callsign, which is most chat.
 * Being wrong in this direction costs a request nobody made; being wrong in the other puts
 * a word on the operator's screen labelled as a station.
 *
 * ONE REQUEST PER MESSAGE, taking the FIRST callsign. A message naming several is somebody
 * chatting about a pile-up, not asking to be worked, and turning it into four requests is
 * how a screen fills with noise.
 */
export function parseChatRequest(
  text: string,
  from: string,
  at: number,
): ChatRequest | null {
  if (!text || text.length > 500) return null;
  // Punctuation around a callsign is normal — "W1AW!" or "on 20m, W1AW" — so tokens are
  // split on anything that is not part of a callsign rather than on spaces alone.
  const tokens = text.toUpperCase().split(/[^A-Z0-9/]+/).filter(Boolean);

  let callsign: string | null = null;
  let band: string | null = null;
  for (const t of tokens) {
    if (!callsign && CALLSIGN.test(t)) {
      callsign = t;
      continue;
    }
    if (!band) {
      // "20M", "20", and "ON 20 METERS" all reach here as separate tokens.
      const b = BANDS.get(t);
      if (b) band = b;
    }
  }
  if (!callsign) return null;
  return { callsign, band, from: from.slice(0, 40), at, text: text.slice(0, 200) };
}

/**
 * Fold a page of chat into the request list.
 *
 * NEWEST WINS PER CALLSIGN, and the list is capped. Somebody repeating themselves — which
 * is what people do when nothing appears to happen — should occupy one line, not five, and
 * the newer message is the one carrying their current band.
 */
export function mergeRequests(
  existing: ChatRequest[],
  incoming: ChatRequest[],
  opts: { max?: number; ttlMs?: number; now?: number } = {},
): ChatRequest[] {
  const max = opts.max ?? 8;
  const ttl = opts.ttlMs ?? 30 * 60_000;
  const now = opts.now ?? Date.now();
  const byCall = new Map<string, ChatRequest>();
  for (const r of [...existing, ...incoming]) {
    const prev = byCall.get(r.callsign);
    if (!prev || r.at >= prev.at) byCall.set(r.callsign, r);
  }
  return [...byCall.values()]
    // EXPIRED REQUESTS LEAVE. A callsign asked for an hour ago is not on the air now, and a
    // stale list is worse than a short one: it invites calling somebody who has gone.
    .filter((r) => now - r.at <= ttl)
    .sort((a, b) => b.at - a.at)
    .slice(0, max);
}

/**
 * How long to wait before polling again.
 *
 * YouTube returns a `pollingIntervalMillis` it would like to be obeyed, and following it
 * exactly would exhaust a default daily quota well before an operating day ended. So the
 * LONGER of the two wins: YouTube's floor is respected, and the operator's setting is what
 * actually paces it.
 */
export function nextPollDelay(
  youtubeSuggestionMs: number | null,
  configuredSeconds: number,
): number {
  const ours = Math.max(5, configuredSeconds) * 1000;
  return Math.max(ours, youtubeSuggestionMs ?? 0);
}
