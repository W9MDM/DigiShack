// What a contact is worth in FT8 Battle Royale.
//
// WHY THIS IS SCORING AND NOT OPERATING. FT8BR requires human-operated contacts — "auto-CQ
// bots, or any program that makes QSOs without operator interaction" are banned and detected,
// with a permanent ban as the stated penalty. So nothing here calls anybody. It ranks what is
// on the waterfall and the operator decides, which is the only arrangement that is both
// within their rules and actually worth having: the arithmetic below is the hard part of that
// game, and it has to be done inside a fifteen-second window.
//
// WHAT THIS CAN AND CANNOT KNOW, stated up front because the gap is the whole design.
//
// Computable from this station alone:
//   * the base point, the POTA/SOTA bonus, the band and mode multipliers, Happy Hour
//   * THE DUPLICATE PENALTY, which is the one that costs real points — working a station
//     again on the same band and mode in the same UTC day is minus TWICE what it would have
//     scored. Our own log knows that, and it is the single most valuable thing here.
//
// NOT computable from this station:
//   * the First Contact +4, which asks whether anybody ANYWHERE worked them first today
//   * the steal value, which asks who currently holds the points for that station
//
// Both of those live on FT8BR's servers and there is no public feed for them. So they are
// reported as a RANGE rather than guessed at: a scorer that invented a steal value would
// rank the operator's screen by a number with nothing behind it, which is worse than
// admitting the bound.
//
// The arithmetic follows their published order exactly — their own worked example is an
// assertion in scripts/check-ft8battle.ts:
//
//     (base + pota + firstContact) x band x mode x happyHour
//     (1 + 2 + 4) x 1.5 x 2.0 x 2.0 = 42

/** Bands that carry the 1.5x multiplier. */
const BAND_BONUS = new Set(["6M", "10M"]);

/** Modes that carry the 2x multiplier. FT8 is the baseline at 1x. */
const MODE_BONUS = new Set(["FT4", "FT2"]);

export const BASE_POINTS = 1;
export const POTA_BONUS = 2;
export const FIRST_CONTACT_BONUS = 4;

/**
 * The two daily Happy Hours, as UTC hours.
 *
 * 07:00-07:59 ("Aussie") and 17:00-17:59 ("Evening"). Both apply to every player regardless
 * of location, so this is a pure function of the clock and nothing else.
 *
 * The ATH Happy Hour — triggered when the day's player count breaks the all-time high — is
 * deliberately absent: it fires on their side, is announced on their site, and cannot be
 * predicted from here. Guessing it would double every estimate on the screen for an hour
 * that may never come.
 */
export const HAPPY_HOURS_UTC = [7, 17];

export function isHappyHour(at: Date): boolean {
  return HAPPY_HOURS_UTC.includes(at.getUTCHours());
}

export interface ScoreInput {
  /** The band as DigiShack spells it: "20M", "10M". */
  band: string;
  /** FT8 / FT4 / FT2. */
  mode: string;
  /** When the contact would be logged. Decides Happy Hour. */
  at: Date;
  /** Would this be logged as a park contact? Worth +2 and changes the duplicate rule. */
  pota?: boolean;
  /**
   * Have WE already worked this station on this band and mode in the same UTC day?
   *
   * The caller answers this from our own log. It is the difference between a contact worth
   * points and one that costs double.
   */
  alreadyWorkedToday?: boolean;
  /**
   * Somebody already worked them on this band today, per the FT8BR feed.
   *
   * The First Contact bonus is per band per day and it is gone: the range collapses to its
   * floor. Known only for stations the tracker has seen - see ft8battle-feed.ts.
   */
  claimedOnBand?: boolean;
  /**
   * Another player holds this station on this band and mode, and working them takes their
   * points. `min`/`max` is what they hold - exact when the feed said, a range when only the
   * holder is known. Never set when WE are the holder: that is a duplicate, not a steal.
   */
  steal?: { from: string; min: number; max: number };
}

export interface Score {
  /** Points if we are NOT first to work them today — the floor. */
  min: number;
  /** Points if we ARE first to work them today — the ceiling, First Contact included. */
  max: number;
  /** Negative when this would be a duplicate: the penalty, already signed. */
  penalty: number;
  /** The multiplier applied, for showing the working. */
  multiplier: number;
  /** Why it scores what it scores, shortest first — for a column in a list. */
  reasons: string[];
  /** The steal this score includes, when it does — so a list can mark it. */
  steal: { from: string; min: number; max: number } | null;
}

/**
 * Score one potential contact.
 *
 * A RANGE, NOT A NUMBER, and that is the honest shape. The First Contact +4 depends on what
 * every other player has done today, which this station cannot see — so the answer is
 * "between min and max", and a UI that wants one number should sort on `min` because that is
 * the part that is actually known.
 */
export function scoreContact(input: ScoreInput): Score {
  const band = input.band.toUpperCase();
  const mode = input.mode.toUpperCase();
  const reasons: string[] = [];

  const bandMult = BAND_BONUS.has(band) ? 1.5 : 1;
  const modeMult = MODE_BONUS.has(mode) ? 2 : 1;
  const happy = isHappyHour(input.at);
  const happyMult = happy ? 2 : 1;
  const multiplier = bandMult * modeMult * happyMult;

  const flat = BASE_POINTS + (input.pota ? POTA_BONUS : 0);

  // THEIR ORDER, not an equivalent one. The bonuses are summed BEFORE the multipliers are
  // applied, so First Contact on 10 m FT4 in Happy Hour is worth 4 x 1.5 x 2 x 2 = 24 and
  // not 4. Applying a multiplier to the base alone would understate a first contact by a
  // factor of six and send the operator after the wrong station.
  const own = Math.round(flat * multiplier);
  // CLAIMED MEANS NO CEILING. First Contact is per band per day, and a station the feed has
  // seen on this band today is somebody else's first contact. A holding implies it too.
  const claimed = Boolean(input.claimedOnBand || input.steal);
  let min = own;
  let max = claimed ? own : Math.round((flat + FIRST_CONTACT_BONUS) * multiplier);

  if (input.pota) reasons.push(`POTA +${POTA_BONUS}`);
  if (bandMult > 1) reasons.push(`${band} x1.5`);
  if (modeMult > 1) reasons.push(`${mode} x2`);
  if (happy) reasons.push("Happy Hour x2");
  if (claimed && !input.steal) reasons.push("claimed: no First Contact");

  // THE DUPLICATE PENALTY IS TWICE WHAT IT WOULD HAVE EARNED, and it is the reason this file
  // is worth having at all. The operator cannot see their own day's log on the waterfall, and
  // the cost of forgetting is not a wasted slot — it is points removed.
  //
  // Scored against `min` rather than `max`: a station already worked today cannot also be a
  // first contact, so the ceiling does not apply to the penalty.
  if (input.alreadyWorkedToday) {
    // A park contact at a DIFFERENT park is a separate event under their POTA exception, so
    // the caller must only set `alreadyWorkedToday` when the park matches too. Said here
    // because getting it wrong suppresses a legitimate contact rather than merely
    // mis-scoring one.
    reasons.unshift("DUPLICATE");
    return { min: 0, max: 0, penalty: -2 * min, multiplier, reasons, steal: null };
  }

  // A STEAL IS THEIR POINTS ON TOP OF OURS. "Last person to work the same station on the
  // same band and mode on the same day gets ALL the points" - what the holder earned, and a
  // chain's accumulated total. Added to both ends, so a known steal moves the floor and the
  // list ranks it where it belongs.
  if (input.steal) {
    min += input.steal.min;
    max += input.steal.max;
    reasons.unshift(
      `STEAL from ${input.steal.from} +${input.steal.min}` +
        (input.steal.max !== input.steal.min ? `–${input.steal.max}` : ""),
    );
  }

  return { min, max, penalty: 0, multiplier, reasons, steal: input.steal ?? null };
}

/**
 * Rank what is on the band by what it is worth, best first.
 *
 * Sorted on the KNOWN floor, with the unknown First Contact bonus breaking ties: of two
 * contacts worth the same for certain, the one that could also be a first contact is the
 * better bet. Duplicates sink to the bottom rather than being hidden — an operator should be
 * able to see that a station is on and why it is not worth calling.
 */
export function rankByPoints<T>(
  items: T[],
  score: (item: T) => Score,
): { item: T; score: Score }[] {
  return items
    .map((item) => ({ item, score: score(item) }))
    .sort((a, b) => {
      // PENALISED ITEMS SORT LAST, so this flag is 1 and not -1. The first version used -1,
      // which is the natural way to write "this one is worse" and is exactly backwards for a
      // comparator: a - b with a = -1 puts the duplicate at the TOP of the list, which is
      // the one place it must never be. Caught by the assertion rather than by reading it.
      const ap = a.score.penalty < 0 ? 1 : 0;
      const bp = b.score.penalty < 0 ? 1 : 0;
      if (ap !== bp) return ap - bp;
      if (b.score.min !== a.score.min) return b.score.min - a.score.min;
      return b.score.max - a.score.max;
    });
}
