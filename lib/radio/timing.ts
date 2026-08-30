// When a transmission is supposed to start.
//
// Vendor-neutral, because it is a property of the mode and not of the radio, and both
// the Flex and the Icom transmitters were getting it wrong in the same way.
//
// THE THING THIS FILE EXISTS FOR: FT8 and FT4 do not start at the T/R period boundary.
// They start half a second into it. A station that keys on the boundary transmits 0.5 s
// early and every receiving station decodes it at dt around -0.5.
//
// Measured rather than taken on trust. Feeding the decoder a signal placed at +0.5 s in
// the window buffer yields dt of -0.005 (FT8) and +0.047 (FT4); placing the same signal
// at the boundary yields -0.505 and -0.452. `scripts/check-pipeline-golden.ts` asserts
// it, so this cannot quietly regress.
//
// FT2 is the exception: it starts at the boundary itself, and its DT search spans only
// 0.5 s, so an FT2 signal half a second late does not decode at all. Applying the FT8
// convention to FT2 would not merely be untidy, it would make the mode unreadable.

import { nowMs } from "@/lib/time/clock";
import type { TxMode } from "@/lib/radio/waveform";

/** T/R period per mode, ms. */
export const PERIOD_MS: Record<TxMode, number> = {
  FT8: 15_000,
  FT4: 7_500,
  FT2: 3_750,
};

/**
 * How far into the period the audio begins.
 *
 * Not a fudge factor — it is the protocol. WSJT-X starts FT8 and FT4 transmissions
 * 0.5 s after the boundary, leaving the receiving station's buffer a moment to fill
 * before the signal arrives.
 */
export const TX_START_OFFSET_MS: Record<TxMode, number> = {
  FT8: 500,
  FT4: 500,
  FT2: 0,
};

/**
 * On-air length of a transmission, ms — where the guard time begins.
 *
 * FT2's 1947 includes the modulator's two-symbol pulse tail, not just its 144 channel
 * symbols; cutting at 1920 would clip the last symbol's energy.
 *
 * Lives here rather than in the decode pipeline because it is a property of the MODE, like
 * everything else in this file, and because two consumers now need it who must not import
 * each other: the pipeline decides when to cut a window, and the transmitter decides how
 * late is too late. `decode-pipeline.ts` already imports `PERIOD_MS` from here, so the
 * dependency only runs one way.
 */
export const TRANSMISSION_MS: Record<TxMode, number> = {
  FT8: 12_640,
  FT4: 5_040,
  FT2: 1_947,
};

/** A late transmission may never eat more of the window's margin than it leaves behind. */
const LATE_TX_SLACK_FRACTION = 0.5;

/**
 * The measured DT cliff per mode, ms — the last lateness that still decoded, less a step.
 *
 * FT8 has no cliff inside its own slack (2,000 ms still decodes), so its entry is the slack
 * itself and the timing rule is what binds. FT4 decoded at 900 and was gone at 1,000; FT2
 * decoded at 400 and was gone at 500, which is why FT2 is pinned to zero — there is no such
 * thing as a usefully late FT2 transmission. Asserted against the real decoder in
 * scripts/check-first-tx.ts rather than trusted.
 */
const DECODABLE_LATE_MS: Record<TxMode, number> = {
  FT8: 1_860,
  FT4: 800,
  FT2: 0,
};

/**
 * How late this mode's transmission may start and still be worth sending, ms.
 *
 * FT8 930, FT4 800, FT2 0.
 *
 * THE ONE NUMBER, IN ONE PLACE. It used to exist twice and disagree: the QSO controller
 * derived it per mode, while `lib/flex/tx.ts` refused only below a hardcoded −1,500 ms for
 * every mode. So the transmitter would happily send **FT2 1.5 s late**, and FT2 at 500 ms
 * late was measured not to decode at all — the last line of defence was the one that had
 * the wrong number. Two copies of a timing constant is also how the 0.5 s start offset came
 * to be wrong in two transmitters at once.
 */
export function lateTxToleranceMs(mode: TxMode): number {
  const slack = PERIOD_MS[mode] - TX_START_OFFSET_MS[mode] - TRANSMISSION_MS[mode];
  const byTiming = Math.floor(slack * LATE_TX_SLACK_FRACTION);
  return Math.max(0, Math.min(byTiming, DECODABLE_LATE_MS[mode]));
}

/** The next period boundary at or after `from`. */
export function nextWindowStart(mode: TxMode, from = nowMs()): number {
  const period = PERIOD_MS[mode];
  return Math.ceil(from / period) * period;
}

/**
 * The instant audio should actually start, given a period boundary.
 *
 * Callers schedule on boundaries because that is what the decode windows are aligned
 * to; this converts a boundary into the moment to key.
 */
export function transmitStartAt(mode: TxMode, windowStartMs: number): number {
  return windowStartMs + TX_START_OFFSET_MS[mode];
}
