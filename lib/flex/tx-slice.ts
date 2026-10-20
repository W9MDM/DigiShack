// Is the radio's transmit slice the one this station is operating on?
//
// Pulled out of FlexDaxTransmitter.preflight() so the attach-time check and the bridge's
// live re-check on every slice update are the same code. Two copies of a blocker is how
// one of them goes stale while the other is right.

import type { FlexSlice } from "@/lib/flex/client";

/**
 * How far the transmit slice may sit from the operating frequency before it is a
 * different slice rather than a nudge.
 *
 * A tolerance rather than equality: the transmit slice sits at the dial and the operator
 * may have nudged it, but a whole band away is a different slice entirely.
 */
export const OFF_FREQUENCY_HZ = 50_000;

/** The opening words of each blocker this module raises, so a re-check can replace them. */
const NO_TX_SLICE = "No slice is set as the transmit slice";
const OFF_FREQUENCY = "The transmit slice is on ";

export interface TxSliceCheck {
  /** Every slice the radio reports. */
  slices: readonly FlexSlice[];
  /** The slice DigiShack decodes on and routes DAX through, when it has one. */
  operatingSliceIndex: number | null;
  /**
   * A frequency the caller explicitly asked to operate on, which wins over the slice.
   *
   * ONLY an explicit request. The transmitter's own fallback (7.074 MHz, for creating a
   * slice on a radio that has none) is not where anybody is operating: the bridge never
   * passes a frequency, and comparing the live transmit slice against that fallback raised
   * "The transmit slice is on 14.074000 MHz but this station is operating on 7.074000 MHz"
   * on /rig at every attach on 20 m, while the station was on the air working people.
   */
  intendedHz?: number | null;
}

/**
 * Conditions on the radio's slices that make keying wrong: no transmit slice at all, or a
 * transmit slice a band away from where the station is operating.
 *
 * The operating frequency is the one actually in use - an explicit request, else the
 * slice DigiShack is attached to. With neither known the frequency comparison is skipped
 * rather than made against a guess, because a guess is what produced the false alarm.
 */
export function txSliceBlockers({ slices, operatingSliceIndex, intendedHz }: TxSliceCheck): string[] {
  const blockers: string[] = [];
  const txSlice = slices.find((s) => s.tx);

  // Observed live 2026-08-30, with the station apparently working people and putting
  // 0.0 W on the air across every transmission:
  //
  //     slice 0 | 7.074000  | DIGU | tx 1 | dax 1 | active 0
  //     slice 1 | 14.074000 | CW   | tx 0 | dax 0 | active 1
  //
  // Transmit was bound to a 40 m slice while the operator worked 20 m on a second slice.
  if (slices.length > 0 && !txSlice) {
    blockers.push(
      `${NO_TX_SLICE} (${slices.length} slice(s) in use) — keying would produce no RF`,
    );
  }

  const operatingHz =
    intendedHz ?? slices.find((s) => s.index === operatingSliceIndex)?.freqHz ?? null;
  if (txSlice?.freqHz && operatingHz) {
    const offBy = Math.abs(txSlice.freqHz - operatingHz);
    if (offBy > OFF_FREQUENCY_HZ) {
      blockers.push(
        `${OFF_FREQUENCY}${(txSlice.freqHz / 1e6).toFixed(6)} MHz but this station is ` +
          `operating on ${(operatingHz / 1e6).toFixed(6)} MHz — transmissions would go out ` +
          `on the wrong frequency, or nowhere`,
      );
    }
  }
  return blockers;
}

/**
 * Replace the slice blockers in a list with a fresh reading, keeping every other blocker.
 *
 * The preflight runs once at attach; the slices move all session. Filtering by opening
 * words rather than remembering the previous strings keeps this right when the frequency
 * in the message changes, which is every time it matters.
 */
export function replaceTxSliceBlockers(current: readonly string[], fresh: readonly string[]): string[] {
  return [
    ...current.filter((b) => !b.startsWith(NO_TX_SLICE) && !b.startsWith(OFF_FREQUENCY)),
    ...fresh,
  ];
}
