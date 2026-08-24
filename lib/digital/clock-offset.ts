// Is this station's clock right?
//
// Every decode carries a DT: how far into the window the other station's transmission
// actually started, in seconds. Propagation and their own clock error move it by a
// few tenths. Across many stations those errors are independent and cancel, so the
// MEDIAN DT over a batch of decodes is a measurement of one thing only — how far off
// *we* are. Everyone else cannot all be wrong in the same direction.
//
// This matters more than it sounds. FT8 tolerates roughly ±2 s before decoding falls
// apart, FT4 rather less, and FT2 less again. A clock drifting past that produces a
// screen full of nothing, which looks exactly like a dead band, a wrong frequency or
// a broken audio path — and those are the three things an operator will check first,
// for an hour, before thinking of the clock.
//
// The median rather than the mean: one decode at the edge of the window, or one
// station with a badly wrong clock, moves a mean and does not move a median.

/** Below this the clock is fine and nothing is shown. */
const OK_SECONDS = 0.7;

/** Above this, decoding is actively degrading. */
const BAD_SECONDS = 1.5;

/**
 * Fewer decodes than this is not a measurement.
 *
 * Two stations agreeing proves nothing — they might both be off, or one of them might
 * be the only thing audible and running on a phone.
 */
const MIN_SAMPLES = 8;

export type ClockVerdict = "unknown" | "ok" | "drifting" | "bad";

export interface ClockOffset {
  verdict: ClockVerdict;
  /** Median DT in seconds, positive meaning our clock is BEHIND. */
  offsetSeconds: number | null;
  samples: number;
  message: string | null;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * Judge the clock from a batch of recent decode DTs.
 *
 * Sign convention follows WSJT-X: a positive DT means the signal arrived later in the
 * window than expected, which happens when our clock is running BEHIND real time — we
 * think the window started later than it did, so everyone appears early... The
 * direction is stated in the message rather than left to the reader, because getting
 * it backwards sends the operator adjusting the wrong way.
 */
export function assessClock(dts: readonly number[]): ClockOffset {
  // A decode at the very edge is usually a false one; it should not drag the estimate.
  const usable = dts.filter((d) => Number.isFinite(d) && Math.abs(d) <= 5);

  if (usable.length < MIN_SAMPLES) {
    return {
      verdict: "unknown",
      offsetSeconds: median(usable),
      samples: usable.length,
      message: null,
    };
  }

  const offset = median(usable)!;
  const abs = Math.abs(offset);
  const direction = offset > 0 ? "behind" : "ahead of";
  const rounded = abs.toFixed(1);

  if (abs < OK_SECONDS) {
    return { verdict: "ok", offsetSeconds: offset, samples: usable.length, message: null };
  }
  if (abs < BAD_SECONDS) {
    return {
      verdict: "drifting",
      offsetSeconds: offset,
      samples: usable.length,
      message:
        `This station's clock looks about ${rounded} s ${direction} everyone else ` +
        `(median DT over ${usable.length} decodes). Decoding still works, but it is drifting — ` +
        `check time synchronisation before it gets worse.`,
    };
  }
  return {
    verdict: "bad",
    offsetSeconds: offset,
    samples: usable.length,
    message:
      `This station's clock is about ${rounded} s ${direction} everyone else ` +
      `(median DT over ${usable.length} decodes). That is enough to lose decodes and to stop ` +
      `other stations decoding you. Fix time synchronisation — this is not a band or antenna problem.`,
  };
}
