// Whether the card importer can have run, in one sentence — the same discipline as the eQSL
// inbox (eqslInboxDetail): a page must never present "no cards" when the truth is "nothing
// has looked". Pure, so check:qsl-inbound can enumerate every state.

export interface InboundCheck {
  /** `qsl.inbound.enabled`. */
  enabled: boolean;
  /** What is missing from the chosen mailbox's settings, or null when complete. */
  configProblem: string | null;
  provider: "graph" | "imap";
  /** Is the radio service — the only thing that runs the timer — answering? */
  running: boolean;
  intervalMinutes: number;
  /** Null means never. */
  lastRunAt: string | null;
  port: number;
}

/**
 * One sentence, or "" when the importer is on, configured, being run and has run.
 *
 * Ordered by what to fix first. Off comes first because this is off by default and nothing
 * else matters until somebody chooses to read a mailbox; then the settings, then the process
 * that runs it, then "it has not run yet".
 */
export function inboundDetail(s: InboundCheck): string {
  if (!s.enabled) {
    return (
      "Importing received cards is off, so nothing reads the mailbox on a schedule. Settings → " +
      "QSL → Received cards (email). Import now still works once the mailbox is set up."
    );
  }
  if (s.configProblem) return `Switched on, but the mailbox is not set up: ${s.configProblem}`;
  if (!s.running) {
    return (
      `Nothing is importing on a schedule. The timer runs inside the radio service, and it is not ` +
      `answering on 127.0.0.1:${s.port}. Start it (pm2 start digishack-bridge), or use Import now.`
    );
  }
  if (!s.lastRunAt) {
    return `Switched on, but no import has run yet. The first runs about two minutes after the radio service starts, then every ${s.intervalMinutes} min.`;
  }
  return "";
}
