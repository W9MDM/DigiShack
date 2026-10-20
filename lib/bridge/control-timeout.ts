// How long the web tier waits on the radio service for each control action.
//
// Most actions are one command to the radio and answer in milliseconds, so five seconds is
// already generous. A few genuinely run longer, and the bridge WAITS for them on purpose
// (an ATU tune answers when the antenna is matched, not when tuning started). Cutting
// those off at five seconds told the operator the service was "not answering" while the
// radio was halfway through doing exactly what it was asked.
//
// Every figure is the bridge's own worst case plus a little, and every one stays under the
// browser's 30 s deadline in lib/client/api.ts, so the operator gets this tier's answer
// rather than a bare network timeout.

/** The ordinary wait: one command to the radio. */
export const DEFAULT_CONTROL_TIMEOUT_MS = 5_000;

/**
 * Actions that legitimately run long, with what they wait for in the bridge:
 *
 * - atu: Icom `tuneAtu()` polls for up to 20 s before reporting "still tuning".
 * - source: tears the old radio down, then the Icom waits up to 20 s for its three streams
 *   (FlexRadio discovery alone is 8 s).
 * - ft0: releasing reconnects the radio through the same start path as `source`.
 * - stream: ffmpeg is given 20 s to start encoding.
 * - time/sync: four SNTP exchanges at up to 3 s each.
 * - tune, voice: a FlexRadio command may take up to 10 s before it is given up on.
 */
const SLOW_ACTIONS: Readonly<Record<string, number>> = {
  atu: 25_000,
  source: 25_000,
  ft0: 25_000,
  stream: 25_000,
  "time/sync": 15_000,
  tune: 15_000,
  voice: 15_000,
};

/** The ATU cycle behind the CAT panel's Tune button on the Icom: same wait as /atu. */
const RIG_TUNE_TIMEOUT_MS = 25_000;

/** How long to wait for `action`. `payload` matters only to "rig", whose tune flag runs the ATU. */
export function controlTimeoutMs(action: string, payload: Record<string, unknown> = {}): number {
  if (action === "rig" && payload.tune === true) return RIG_TUNE_TIMEOUT_MS;
  return SLOW_ACTIONS[action] ?? DEFAULT_CONTROL_TIMEOUT_MS;
}

/** True for the error AbortSignal.timeout() produces when the wait runs out. */
export function isTimeoutError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    ((err as { name: unknown }).name === "TimeoutError" || (err as { name: unknown }).name === "AbortError")
  );
}

/**
 * What to tell the operator when the wait runs out.
 *
 * The request reached a running service — a dead one refuses the connection at once — so
 * "not answering" would be wrong. The action is most likely still in progress.
 */
export function controlTimeoutMessage(action: string, timeoutMs: number): string {
  return (
    `"${action}" is still running on the radio after ${Math.round(timeoutMs / 1000)} seconds. ` +
    "It may yet finish — check the Rig page for the result before trying again."
  );
}
