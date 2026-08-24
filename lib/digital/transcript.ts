// The full exchange, kept with the contact.
//
// An FT8 QSO is six or so messages of thirteen characters, and until now the log kept
// two of them: the report sent and the report received. Everything else — what we
// actually transmitted, what came back, when, at what signal level, which transmissions
// the radio refused — existed only in the console output of a process that gets
// restarted, and in `DigitalDecode` rows that are pruned after thirty days and were
// never linked to the contact they belong to.
//
// That is a strange thing to throw away. The exchange IS the contact. It is what
// answers, months later, "did they actually get my report or did I log an optimistic
// QSO", which is the one question a doubted contact turns on, and it is the only record
// of a transmission the gate refused in the middle of an otherwise complete exchange.
//
// Stored as text rather than JSON. It goes in a database column, gets read by a person
// on the QSO page, and is small — a fixed-width line per message reads at a glance, and
// nothing downstream needs to parse it back.

/** One message, in one direction. */
export interface TranscriptEntry {
  /** UTC ms — the window boundary the message belongs to, not when it was recorded. */
  at: number;
  dir: "tx" | "rx";
  message: string;
  /** Their signal, receive only. */
  snr?: number | null;
  /** Audio offset within the passband. Ours on transmit, theirs on receive. */
  offsetHz?: number | null;
  /**
   * Why a transmission did not go out.
   *
   * Recorded rather than dropped: a contact that completed with a refused transmission
   * in the middle is a different story from a clean one, and the refusal is exactly what
   * an operator wants to see when a QSO looked wrong.
   */
  refused?: string | null;
}

/**
 * Cap on entries kept.
 *
 * A normal FT8 QSO is four to six messages. A pathological one — repeats, a station
 * that keeps calling, a long POTA pile-up answer — can run longer, and this is a log
 * field rather than a debug trace. Sixty is far above any real exchange and still
 * bounded, and the oldest go first so the completion is always visible.
 */
export const TRANSCRIPT_MAX_ENTRIES = 60;

function hhmmss(at: number): string {
  return new Date(at).toISOString().slice(11, 19);
}

function snrText(snr: number | null | undefined): string {
  if (snr === null || snr === undefined || !Number.isFinite(snr)) return "     ";
  const s = snr > 0 ? `+${Math.round(snr)}` : `${Math.round(snr)}`;
  return s.padStart(3) + "dB";
}

function offsetText(hz: number | null | undefined): string {
  if (hz === null || hz === undefined || !Number.isFinite(hz)) return "      ";
  return `${Math.round(hz)}`.padStart(4) + "Hz";
}

/**
 * Render the exchange, one line per message, oldest first.
 *
 * Times are UTC, like every other time in DigiShack. Returns null for an empty
 * exchange, so a caller can store null rather than an empty string — "no transcript"
 * and "a transcript with nothing in it" should not look different in the database.
 */
export function formatTranscript(entries: TranscriptEntry[]): string | null {
  const kept = entries.slice(-TRANSCRIPT_MAX_ENTRIES);
  if (kept.length === 0) return null;

  const dropped = entries.length - kept.length;
  const lines = kept.map((e) => {
    const line = [
      hhmmss(e.at),
      e.dir === "tx" ? "TX" : "RX",
      e.dir === "rx" ? snrText(e.snr) : "     ",
      offsetText(e.offsetHz),
      e.message,
    ].join(" ");
    return e.refused ? `${line}   [not sent: ${e.refused}]` : line;
  });

  if (dropped > 0) lines.unshift(`… ${dropped} earlier message(s) not kept`);
  return lines.join("\n");
}
