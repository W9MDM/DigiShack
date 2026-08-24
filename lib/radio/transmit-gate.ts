// May this radio transmit?
//
// The gate used to be a single setting, `flex.allowTransmit`, and the Icom path read it
// too — so arming transmit on one radio armed both. That is the wrong shape for a
// safety switch. An operator who arms a FlexRadio sitting on a proper antenna has not
// thereby said anything about an IC-7300 that might be on a dummy load, in a different
// room, or halfway through being set up.
//
// So the gate is per radio now, each answering on its own key, inheriting nothing, and
// defaulting to off.

import { getBooleanSetting } from "@/lib/settings";

export type RadioKind = "flex" | "icom";

/** The per-radio setting key. */
export function transmitGateKey(kind: RadioKind): string {
  return `${kind}.allowTransmit`;
}

/**
 * Is transmit armed for this radio?
 *
 * Each radio answers on its own key and inherits nothing. An earlier draft had the Icom
 * fall back to the FlexRadio's setting "so an existing install is not silently
 * disarmed", which was wrong twice:
 *
 *   - It protected against a situation that cannot exist. No install has ever had an
 *     armed Icom, because the Icom is new. There was nothing to migrate.
 *   - `getSetting` returns the registry default when a key is unset, not null, so
 *     "has this ever been set?" could not be answered that way and the fallback would
 *     never have fired anyway. The test caught it.
 *
 * Independent and defaulting to off is also simply the right shape for a safety gate.
 * Arming a Flex on a real antenna says nothing about an IC-7300 that might be on a
 * dummy load.
 */
export async function isTransmitArmed(kind: RadioKind): Promise<boolean> {
  // The hold comes first, and it is not a setting.
  //
  // Voice mode used to be enforced in the radio service's own wrapper around this function.
  // That closed every ENDPOINT — auto, tune, ATU — and left the one path that matters open:
  // the transmitters take their gate from `transmitGate` below and never went near the
  // wrapper. So switching to voice stopped anything NEW from starting while a QSO already in
  // flight carried on keying the radio and sending FT8, which is precisely the collision
  // voice mode exists to prevent. Reported from the operating position, not found by a test.
  //
  // Here, it covers both radios, both transmitters and every caller by construction.
  if (digitalTransmitHeld()) return false;
  return getBooleanSetting(transmitGateKey(kind), false);
}

/**
 * A hold that closes the transmit gate for DIGITAL, without touching the operator's setting.
 *
 * Distinct from the setting on purpose. The setting is a standing decision about whether this
 * radio may ever key; the hold is a temporary "not now, something else owns the transmitter".
 * Writing the setting instead would leave an operator's own configuration changed by a mode
 * switch, and a crash mid-voice would leave a station that refuses to transmit for reasons
 * nobody can find.
 *
 * Module state rather than a database row, for the same reason voice mode is: a restart must
 * come back with nothing held.
 */
let digitalHold = false;

export function setDigitalTransmitHold(on: boolean): void {
  digitalHold = on;
}

export function digitalTransmitHeld(): boolean {
  return digitalHold;
}

/**
 * A closure the transmitters re-read at transmit time.
 *
 * Snapshotting the gate at startup was a real bug once: `setAllowTransmit` had no
 * callers, so flipping the setting did nothing until the service restarted while the
 * setting's own help text promised "off means nothing can key the radio, ever".
 */
export function transmitGate(kind: RadioKind): () => Promise<boolean> {
  return () => isTransmitArmed(kind);
}
