/**
 * What the RADIO says its receiver is doing, as opposed to what we last asked for.
 *
 * One definition, imported by both radios and by everything that displays them. It was
 * four separate inline literals — `{ agc; nb; nr }` written out in lib/flex/dax.ts,
 * lib/icom/rig.ts, services/radio/index.ts and pages/rig.tsx — and the cost of that
 * showed up the moment a fifth field was needed: the FlexRadio has parsed `filter_lo`
 * and `filter_hi` off every slice status since the client was written, and the rig page
 * still drew four filter buttons that could not show which one was in force, because
 * the shape in between had nowhere to put them.
 *
 * Null means THE RADIO HAS NOT SAID, which is not the same as off or zero. Every
 * consumer has to keep that distinction: a receiver panel that renders "off" for a
 * noise blanker it has simply not read yet is worse than one that renders nothing.
 */
export interface ReceiverControls {
  agc: string | null;
  nb: boolean | null;
  nr: boolean | null;
  /**
   * The receive passband edges in Hz, relative to the dial and SIGNED — on lower
   * sideband both are negative, because the receiver listens below the dial. This is
   * the same convention the filter buttons send and the same one the panadapter shades
   * with, and it is the reason these are two numbers rather than a single width: a
   * width cannot say which side of the dial it is on.
   *
   * Only radios that take a passband in Hz report these. The Icom selects FIL1/2/3,
   * whose widths live in its own menu and are not readable over CI-V, so it leaves them
   * null and its UI offers no width buttons at all — see `filterEdgesHz` in
   * lib/radio/capabilities.ts.
   */
  filterLo?: number | null;
  filterHi?: number | null;
}

/** A receiver whose state is entirely unknown. The honest starting point. */
export const UNREAD_RECEIVER: ReceiverControls = {
  agc: null,
  nb: null,
  nr: null,
  filterLo: null,
  filterHi: null,
};

/** Does this modulation listen BELOW the dial? */
export function isLowerSideband(mode: string | null | undefined): boolean {
  const m = (mode ?? "").toUpperCase();
  return m.startsWith("LSB") || m === "DIGL" || m === "CWL";
}

/**
 * A filter preset's edges, with the sign the current modulation actually requires.
 *
 * The presets are written the way a filter is spoken about — "SSB is 100 to 2800" — which
 * is the upper-sideband convention. The radio does not take a convention; it takes two
 * signed offsets from the dial, and on lower sideband both of them are negative because
 * that is the side the receiver is listening on.
 *
 * Without this the SSB button sent `filt 0 100 2800` while the slice was on LSB, which
 * asks the radio to listen 100–2800 Hz ABOVE a dial whose signal is entirely below it.
 * The same mistake made the button highlight impossible: the radio reports −2800…−100 on
 * LSB and nothing was ever going to match a preset stored as 100…2800. Both symptoms,
 * one cause, so both are fixed by making the sign a property of the mode rather than of
 * the table.
 *
 * A preset that already straddles the dial — CW at −250…250 — is left alone. Mirroring a
 * symmetric filter is a no-op, and forcing it negative would narrow it to one side.
 */
export function filterEdgesFor(
  mode: string | null | undefined,
  lo: number,
  hi: number,
): { lo: number; hi: number } {
  const straddlesDial = lo < 0 && hi > 0;
  if (straddlesDial || !isLowerSideband(mode)) return { lo, hi };
  return { lo: -hi, hi: -lo };
}

/**
 * Does the radio's current passband match these edges?
 *
 * Exact, deliberately, once the preset has been given the mode's sign. A radio set to
 * something other than one of the offered presets should light NONE of them rather than
 * the nearest — the whole failure being fixed here is a row of buttons that implied a
 * state they had not read, and "close to DIG" is the same lie in a quieter voice. The
 * measured width is printed alongside instead, so an operator on a custom filter can
 * still see where they are.
 */
export function filterMatches(
  rx: ReceiverControls | undefined,
  mode: string | null | undefined,
  lo: number,
  hi: number,
): boolean {
  if (!rx || rx.filterLo == null || rx.filterHi == null) return false;
  const want = filterEdgesFor(mode, lo, hi);
  return rx.filterLo === want.lo && rx.filterHi === want.hi;
}
