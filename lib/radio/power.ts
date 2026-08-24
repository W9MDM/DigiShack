// What the radio actually put out, in watts.
//
// NOT the power slider. The slider is a request — a percentage of the radio's rated
// output that the operator asked for — and it says nothing about what left the
// antenna socket. An ATU mid-tune, a hot PA backing itself off, a rig that never
// reached the setting: all of them read 100 % on the slider. The FlexRadio has a
// real forward-power meter (`src=TX-`, `nam=FWDPWR`) and that is what this reads.
//
// The meter reports dBm. The conversion is the standard one, and the codebase
// already carried a live verification of the scaling: FWDPWR raw 6342 = 49.5 dBm,
// which this makes 89 W — the figure observed at the time. See lib/flex/dax.ts.

/** dBm to watts. 30 dBm = 1 W, 50 dBm = 100 W. */
export function dbmToWatts(dbm: number): number {
  return 10 ** ((dbm - 30) / 10);
}

/**
 * Round a wattage the way an operator writes it on a QSL.
 *
 * Whole watts above 10, one decimal below — a QRP contact at 2.5 W rounded to 3
 * loses the entire point of the contact, while "87.3 W" on a card is false
 * precision about a meter that is not calibrated to a tenth.
 */
export function roundWatts(w: number): number {
  return w >= 10 ? Math.round(w) : Math.round(w * 10) / 10;
}

/**
 * Anything above this is a misread, not a transmitter.
 *
 * The meter is a raw int16 scaled by 128, so a corrupt or misidentified packet can
 * decode to an enormous dBm. A legal amateur station runs 1.5 kW at the very most;
 * treating 10 kW as real would put a fabricated number on a QSL card and, worse,
 * one that suggests an illegal station.
 */
const MAX_PLAUSIBLE_WATTS = 2_000;

/**
 * Follows forward power across one contact.
 *
 * PEAK rather than mean, because FT8 and FT4 are constant-envelope: the transmitter
 * sits at full output for the whole 12.6 s of a transmission, and the only reason a
 * sample reads low is that it caught the key-up or key-down ramp. Averaging those in
 * would under-report every contact by a few watts. The peak of a flat-topped signal
 * IS its steady-state output.
 *
 * Samples are only offered while the radio is actually transmitting — the source
 * emits `fwdDbm: null` on receive precisely so a stale reading cannot be mistaken
 * for a live one.
 */
export class TxPowerTracker {
  private peak: number | null = null;

  /** Feed one meter reading. Nulls (i.e. not transmitting) are ignored. */
  sample(fwdDbm: number | null | undefined): void {
    if (fwdDbm === null || fwdDbm === undefined || !Number.isFinite(fwdDbm)) return;
    const w = dbmToWatts(fwdDbm);
    // A transmitter that is off reads a very low dBm rather than nothing, so a
    // floor is needed as well as a ceiling: without it, the ramp at the end of a
    // transmission would register as a 0.01 W contact.
    if (w <= 0.05 || w > MAX_PLAUSIBLE_WATTS) return;
    if (this.peak === null || w > this.peak) this.peak = w;
  }

  /** The contact's transmit power, rounded, or null if nothing was ever measured. */
  watts(): number | null {
    return this.peak === null ? null : roundWatts(this.peak);
  }

  /** Start a new contact. */
  reset(): void {
    this.peak = null;
  }
}
