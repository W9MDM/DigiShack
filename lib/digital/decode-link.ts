// Attaching the decodes of a contact to the contact.
//
// `DigitalDecode.qsoId` has existed since the schema was written and nothing ever set it.
// Two things depended on it and neither worked:
//
//   * the "Linked decodes" panel on a contact, which said "Populated by the bridge in
//     Phase 4a" for every contact ever logged
//   * the decode retention sweep, which deletes decodes past a cutoff but deliberately
//     KEEPS any attached to a logged contact. With nothing ever attached, the exception
//     protected nothing, and the raw decodes of every real contact were pruned at thirty
//     days along with the noise
//
// The transcript on the contact covers what was said. This is the measurement underneath
// it: the signal report and audio offset of each decode, which is what tells you a contact
// was worked at -21 dB on a dying band rather than comfortably.

/**
 * How far outside a contact's span a decode may fall and still belong to it.
 *
 * One T/R period, which takes in the CQ that started the exchange — the decode that
 * caused the contact belongs to it — without reaching into whatever was heard a minute
 * later on a busy band.
 */
export const LINK_MARGIN_MS = 20_000;

/**
 * Does this message involve the station we worked?
 *
 * As a whole token. A substring test matches K1AB inside K1ABC, and on FT8 the wrong
 * callsign in a log entry is the one error that cannot be recovered from the recording.
 *
 * Both directions count: `<them> <us>` is our transmission to them, `<us> <them>` is
 * theirs to us, and `CQ <them>` is the call that started it. All three are part of the
 * exchange as an operator would describe it.
 */
export function mentionsCall(message: string, call: string): boolean {
  const want = call.trim().toUpperCase();
  if (!want) return false;
  // Callsigns are letters, digits and slashes; anything else is a separator.
  return message
    .toUpperCase()
    .split(/[^A-Z0-9/]+/)
    .some((token) => token === want);
}

/**
 * Was this message SENT by one of the two stations in the contact?
 *
 * The distinction matters, and it took reading a rebuilt transcript to see it. Filtering
 * on "mentions their callsign" pulled in a third station's traffic:
 *
 *     RX  II1ABC W2ABC -07      <- W2ABC transmitting to II1ABC. Not our contact.
 *     RX  W2ABC II1ABC R-16     <- II1ABC transmitting. Theirs, and worth keeping.
 *
 * The second line belongs in the transcript: the station we are working answering somebody
 * else is why our own call went unanswered for a cycle, and the live transcript records it
 * the same way. The first line is a different conversation that happens to name them.
 *
 * A message whose sender cannot be read — free text, a fragment — is not attributed to
 * anyone, because guessing would put words in a station's mouth.
 */
export function sentByEither(
  message: string,
  parseFrom: (message: string) => string | null,
  theirCall: string,
  myCall: string,
): boolean {
  const from = parseFrom(message)?.toUpperCase() ?? null;
  if (!from) return false;
  return from === theirCall.trim().toUpperCase() || from === myCall.trim().toUpperCase();
}

export interface DecodeLinkWindow {
  from: Date;
  to: Date;
}

/**
 * The span of decodes that could belong to a contact.
 *
 * An in-progress contact has no end time, so its own start is all there is to measure
 * from — which is right: a contact still running has nothing after it yet.
 */
export function linkWindow(qso: { startTime: Date; endTime: Date | null }): DecodeLinkWindow {
  const start = qso.startTime.getTime();
  const end = (qso.endTime ?? qso.startTime).getTime();
  return {
    from: new Date(start - LINK_MARGIN_MS),
    to: new Date(end + LINK_MARGIN_MS),
  };
}
