// Voice mode: the station stops being a digital station.
//
// Not a display toggle. Two things must be true before a microphone is any use, and both
// of them are about the radio rather than the browser:
//
//   1. NOTHING DIGITAL MAY TRANSMIT. An auto operator answering a CQ while an operator is
//      talking would key over the top of them, on the same radio, from a different part of
//      the program. There is no arbitration between them and there should not be — the
//      right answer is that only one of the two owns the transmitter at a time.
//
//   2. The radio must be in a VOICE mode. FT8 runs in USB-D (data), which on most radios
//      routes modulation from the network or USB input and ignores the microphone
//      completely. An operator would hold the PTT, see the radio key, and transmit silence
//      — which is the exact fault this project already documents for `MOD Input`.
//
// Enforced at the transmit GATE rather than by hunting every path that might key. The gate
// is already consulted by the auto operator, the QSO controller, the tune button and the
// ATU, so one flag closes all of them and any future one, and each says why.

/** What the radio should be set to on the way in and out of voice. */
export type VoiceRadioMode = "USB" | "LSB";

/**
 * The conventional sideband for a band.
 *
 * Below 10 MHz is lower sideband, above is upper — a convention, not a rule, but it is what
 * every other station on the band will be using, and a voice contact on the wrong sideband
 * is inaudible rather than merely unconventional.
 */
export function conventionalSideband(dialHz: number | null): VoiceRadioMode {
  if (dialHz === null) return "USB";
  return dialHz < 10_000_000 ? "LSB" : "USB";
}

export interface VoiceState {
  active: boolean;
  /**
   * Reserved for a radio whose previous modulation is worth restoring. Always null today.
   *
   * The first attempt recorded `status.mode` here and got "FT8" — the digital mode, not the
   * modulation — which is the kind of near-miss that survives because both code paths fall
   * back correctly anyway. What digital needs on the way back is USB-D or DIGU whatever the
   * radio was in, so there is nothing to remember.
   */
  restoreTo: string | null;
  /** The sideband voice was entered with, for display. */
  mode: VoiceRadioMode | null;
  since: number | null;
}

export function idleVoiceState(): VoiceState {
  return { active: false, restoreTo: null, mode: null, since: null };
}

/**
 * Why a digital transmission is being refused.
 *
 * A message rather than a boolean because "Transmit is disabled in settings" sent an
 * operator to the wrong page for an hour once already, and voice mode is a state they can
 * see on the rig page and turn off in one click.
 */
export const VOICE_REFUSAL = "Voice mode is on — turn it off to let digital transmit again";

/**
 * Is this a mode the microphone works in?
 *
 * Used to warn rather than to refuse: a radio put into CW or a data mode from its own front
 * panel while voice mode is on is not something software should fight, but it IS something
 * the page should say out loud, because the symptom otherwise is a radio that keys and
 * transmits nothing.
 */
export function isVoiceCapableMode(mode: string | null): boolean {
  if (!mode) return false;
  const m = mode.toUpperCase();
  // USB-D, DIGU, DIGL and PKTUSB all key the transmitter and take their modulation from
  // somewhere other than the microphone.
  if (/-D$|^DIG|^PKT|^DATA/.test(m)) return false;
  return m === "USB" || m === "LSB" || m === "AM" || m === "FM";
}
