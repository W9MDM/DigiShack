// The station's idea of the time, corrected.
//
// One offset, measured by SNTP, and one function that applies it. Everything that needs
// real time — where a T/R window starts, when to key, what time to write on a contact —
// asks here instead of asking the operating system.
//
// WHY THIS EXISTS RATHER THAN "FIX YOUR NTP". Because the advice is not always actionable.
// DigiShack cannot set the system clock: `w32tm /resync` needs elevation, Linux needs root,
// and under PM2 it is neither. And in a container it is not even possible in principle —
// the clock belongs to the host — which is exactly where the Proxmox installer puts it.
//
// A station whose clock is 800 ms out does not need a lecture; it needs its transmissions
// 800 ms earlier. That is all this does.
//
// THE TRAP, and it is the reason `nowMs` exists rather than a correction applied only to
// the radio: correcting the transmit instant but timestamping the log from the OS clock
// writes every contact's time wrong by exactly the correction that made the radio work.
// One clock, used everywhere, or the log and the air disagree.

/**
 * Beyond this the correction is refused.
 *
 * Not a safety margin — a diagnosis. FT8 is hopeless past a couple of seconds, so an
 * offset of thirty is not a clock that needs nudging, it is a machine whose time is
 * wrong: the log will be wrong, the file timestamps will be wrong, and TLS will start
 * failing. Correcting silently would hide that and produce a log nobody can reconcile.
 */
export const MAX_CORRECTION_MS = 5_000;

/** Below this, applying a correction is not worth the confusion of having one. */
export const MIN_CORRECTION_MS = 50;

export interface ClockState {
  /** Applied correction in milliseconds. Positive means the OS clock is slow. */
  offsetMs: number;
  /** What the last measurement said, whether or not it was applied. */
  measuredMs: number | null;
  /** Round-trip delay of the measurement it came from. */
  delayMs: number | null;
  source: string | null;
  at: number | null;
  /** Why a measurement was not applied, when it was not. */
  refused: string | null;
}

const state: ClockState = {
  offsetMs: 0,
  measuredMs: null,
  delayMs: null,
  source: null,
  at: null,
  refused: null,
};

/**
 * Real time, in Unix milliseconds.
 *
 * Use this instead of `Date.now()` anywhere the answer is compared against the rest of the
 * world: window boundaries, transmit instants, logged QSO times. Not needed for measuring
 * durations — an offset cancels in a subtraction — and not worth the indirection there.
 */
export function nowMs(): number {
  return Date.now() + state.offsetMs;
}

/** Real time as a Date, for the places that want one. */
export function nowDate(): Date {
  return new Date(nowMs());
}

export function clockState(): ClockState {
  return { ...state };
}

/**
 * Take a measurement and decide whether to apply it.
 *
 * Returns what happened, so a caller can log it once rather than every caller working out
 * how to describe it.
 */
export function applyMeasurement(m: {
  offsetMs: number;
  delayMs: number;
  source: string;
  correct: boolean;
}): { applied: boolean; reason: string } {
  state.measuredMs = m.offsetMs;
  state.delayMs = m.delayMs;
  state.source = m.source;
  state.at = Date.now();

  const abs = Math.abs(m.offsetMs);

  if (!m.correct) {
    state.offsetMs = 0;
    state.refused = "correction is switched off";
    return {
      applied: false,
      reason: `clock is ${describe(m.offsetMs)} (measuring only — time.correct is off)`,
    };
  }

  if (abs > MAX_CORRECTION_MS) {
    // Deliberately NOT applied. See MAX_CORRECTION_MS.
    state.offsetMs = 0;
    state.refused = `${describe(m.offsetMs)} is too far out to correct`;
    return {
      applied: false,
      reason:
        `clock is ${describe(m.offsetMs)} — REFUSING to correct that much. This is not a ` +
        `clock that needs nudging, it is a machine whose time is wrong: fix NTP on the ` +
        `host, or the log will be wrong too`,
    };
  }

  if (abs < MIN_CORRECTION_MS) {
    state.offsetMs = 0;
    state.refused = null;
    return { applied: false, reason: `clock is within ${MIN_CORRECTION_MS}ms — nothing to correct` };
  }

  state.offsetMs = Math.round(m.offsetMs);
  state.refused = null;
  return {
    applied: true,
    reason: `clock is ${describe(m.offsetMs)} — correcting internally by ${state.offsetMs}ms`,
  };
}

/** Drop any correction. Used when the operator switches it off. */
export function clearCorrection(): void {
  state.offsetMs = 0;
  state.refused = "correction is switched off";
}

/** "0.83 s behind" / "120 ms ahead of" real time, in words the direction cannot be
 * misread. Getting the sign backwards sends an operator adjusting the wrong way. */
export function describe(offsetMs: number): string {
  const abs = Math.abs(offsetMs);
  const magnitude = abs >= 1000 ? `${(abs / 1000).toFixed(2)} s` : `${Math.round(abs)} ms`;
  if (abs < 1) return "exactly right";
  return `${magnitude} ${offsetMs > 0 ? "behind" : "ahead of"} real time`;
}
