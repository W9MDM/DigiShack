// Where to put our signal in the audio passband.
//
// The manual-call form asked for an offset in hertz and defaulted to 1500, which is the
// middle of the passband and therefore the single most contested frequency on a busy
// band. Typing a number is not the question an operator is actually asking — "put me
// somewhere nobody else is" is — and answering it by eye off a waterfall is exactly the
// kind of arithmetic a computer should be doing.
//
// Pure, and separate from the page, because the only way to know a slot picker works is
// to hand it a band and assert where it lands. See scripts/check-slot.ts.

/**
 * The transmittable passband.
 *
 * 2900 rather than 3000: most radios will not place audio above about 2.9 kHz whatever
 * the receiver hears, so a slot above that is decodable and not answerable. 200 rather
 * than 0 for the same reason at the other end — the transmit filter rolls off.
 */
export const MIN_SLOT_HZ = 200;
export const MAX_SLOT_HZ = 2900;

/**
 * Occupied width of one signal, in hertz.
 *
 * FT8 is eight tones 6.25 Hz apart — 50 Hz. FT4 is four tones 20.83 Hz apart, about
 * 83 Hz. The wider of the two is the safe assumption when the mode is not known, since
 * being generous costs a slightly narrower choice and being mean costs a collision.
 */
export const SIGNAL_WIDTH_HZ: Record<string, number> = { FT8: 50, FT4: 90, FT2: 90 };

export interface ClearSlot {
  /** Where to transmit, in hertz. */
  hz: number;
  /** Distance to the nearest occupied frequency. Larger is better. */
  clearanceHz: number;
  /**
   * True when even the best slot is narrower than a signal.
   *
   * Reported rather than hidden: on a packed band there IS no clear slot, and a picker
   * that silently returns the least-bad one while looking confident is worse than one
   * that says the band is full. The operator may still choose to transmit there.
   */
  crowded: boolean;
}

/**
 * The emptiest place to transmit, given what has been heard.
 *
 * Widest-gap rather than first-fit: first-fit packs everyone against the bottom edge of
 * the passband, which is where the transmit filter is already rolling off and where every
 * other first-fit picker would also land. The MIDDLE of the widest gap maximises the
 * distance to the nearest neighbour on both sides, which is what "clear" means when the
 * neighbours may drift a few hertz between cycles.
 *
 * The passband edges count as occupied. Without that the widest gap on an empty band is
 * the whole passband and its middle is 1550 — indistinguishable from the hardcoded 1500
 * this replaces, and wrong for the same reason.
 */
export function pickClearSlot(
  occupiedHz: readonly number[],
  opts: { min?: number; max?: number; signalHz?: number } = {},
): ClearSlot {
  const min = opts.min ?? MIN_SLOT_HZ;
  const max = opts.max ?? MAX_SLOT_HZ;
  const signal = opts.signalHz ?? SIGNAL_WIDTH_HZ.FT8!;

  // Only what is inside the passband can be collided with, and duplicates carry no extra
  // information — two stations on the same frequency crowd it exactly as much as one.
  const walls = [min, max];
  const inBand = [...new Set(occupiedHz.filter((f) => Number.isFinite(f) && f > min && f < max))];
  const marks = [...walls, ...inBand].sort((a, b) => a - b);

  let best = { hz: Math.round((min + max) / 2), clearanceHz: 0 };
  for (let i = 0; i < marks.length - 1; i++) {
    const lo = marks[i]!;
    const hi = marks[i + 1]!;
    const mid = Math.round((lo + hi) / 2);
    // Half the gap IS the clearance: the midpoint is that far from both neighbours.
    const clearance = Math.round((hi - lo) / 2);
    if (clearance > best.clearanceHz) best = { hz: mid, clearanceHz: clearance };
  }

  // `<=`, not `<`. Clearance is measured centre to centre, and both signals are
  // `signal` wide — so at exactly one signal width apart their EDGES touch and there is
  // no gap at all. Strictly-less would have called that clear.
  return { ...best, crowded: best.clearanceHz <= signal };
}

/**
 * Pull the occupied frequencies out of recent decodes.
 *
 * `withinMs` exists because a band is a moving picture: a station heard four minutes ago
 * has very often finished and gone, and treating them as occupying a slot forever fills
 * the passband with ghosts until nothing is clear. Two cycles is enough to catch both
 * halves of an exchange without accumulating history.
 */
export function occupiedFrom(
  decodes: readonly { freqOffset: number; timestamp: string }[],
  now: number,
  withinMs = 120_000,
): number[] {
  return decodes
    .filter((d) => {
      const t = Date.parse(d.timestamp);
      // A timestamp we cannot read is kept rather than dropped: an unparsed date must not
      // silently empty the band and make everything look clear.
      return !Number.isFinite(t) || now - t <= withinMs;
    })
    .map((d) => d.freqOffset);
}
