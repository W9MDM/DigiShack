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
