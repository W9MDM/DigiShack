// Deciding which station is worth working.
//
// Auto Hunt without this simply calls the loudest CQ, which on a busy band means
// working the same nearby stations over and over. With it, a new DXCC entity two
// S-units down beats another contact with the state next door.
//
// Pure scoring: the caller supplies what has already been worked, this ranks
// candidates. That keeps it testable and keeps database policy out of it.

export interface WorkedIndex {
  /** DXCC entity codes already worked (any band/mode). */
  dxcc: Set<number>;
  /** DXCC codes worked on the CURRENT band — band-slot chasing. */
  dxccThisBand: Set<number>;
  /** US/Canadian states worked (WAS). */
  states: Set<string>;
  /** States worked on the CURRENT band — WAS band slots. */
  statesThisBand: Set<string>;
  /** Grid squares worked, 4-character (VUCC / general grid chasing). */
  grids: Set<string>;
  /**
   * Grids worked on the CURRENT band.
   *
   * The entity axis has had a band-slot form since the beginning and the grid axis
   * did not, which is why a mature station saw no badges at all on a domestic band:
   * this log has 1,259 grids worked overall but only 811 of them on 40 m, so 448
   * genuinely open slots were being scored as routine.
   */
  gridsThisBand: Set<string>;
  /** CQ zones worked (WAZ). */
  cqZones: Set<number>;
  /** Continents worked (WAC). */
  continents: Set<string>;
  /** Every callsign ever worked, for "never worked before". */
  calls: Set<string>;
  /** POTA references worked (SIG_INFO where SIG is POTA). */
  parks: Set<string>;
}

export function emptyWorkedIndex(): WorkedIndex {
  return {
    dxcc: new Set(),
    dxccThisBand: new Set(),
    states: new Set(),
    statesThisBand: new Set(),
    grids: new Set(),
    gridsThisBand: new Set(),
    cqZones: new Set(),
    continents: new Set(),
    calls: new Set(),
    parks: new Set(),
  };
}

export interface Candidate {
  call: string;
  snr: number;
  /** Grid from the CQ message, when it carried one. */
  grid: string | null;
  /** Resolved entity, when DXCC data is loaded. */
  dxcc?: { adif: number; name: string; cqZone: number | null; continent: string | null } | null;
  /**
   * US/Canadian state, when it is actually knowable.
   *
   * An FT8 message carries a 4-character grid and nothing else, so for most decodes
   * this is null and the state axis simply does not score — which is honest. It is
   * populated for POTA activators, whose spot carries an authoritative location
   * ("US-TX"). Deriving it from the grid would need a grid-to-state table, and
   * guessing at a state on a grid that straddles a line would put a wrong badge on a
   * row an operator is deciding to call.
   */
  state?: string | null;
  /** POTA reference, for a station currently spotted as an activator. */
  park?: string | null;
  /**
   * They are calling "CQ POTA" — an activation, whether or not we know which park.
   *
   * Separate from `park` because the two answer different questions: `park` is
   * "which reference", which only the spot feed knows, and this is "is this an
   * activator at all", which the message itself says.
   */
  potaCq?: boolean;
}

export interface Scored extends Candidate {
  score: number;
  /** Why this one scored well, for the operator and the log line. */
  reasons: string[];
  /**
   * True when nothing AWARD-worthy is new.
   *
   * Deliberately not `reasons.length === 0`. "Never worked before" is worth showing
   * an operator but is not an award, and it fires for most of a busy band — folding
   * it in here would make `rankCandidates({newOnly})` keep everything and silently
   * turn `auto.huntNewOnly` into a no-op.
   */
  routine: boolean;
}

/**
 * Points per kind of newness.
 *
 * A new entity is worth far more than a new grid because there are 340 of the
 * former and effectively unlimited of the latter. SNR is a tiebreaker worth at
 * most a few points — a weak new one still beats a strong dupe-adjacent one, but
 * among equals the stronger signal is likelier to complete.
 */
/**
 * Points per kind of newness, in four deliberate tiers.
 *
 *   20–100  a real award slot: entity, continent, zone, state, a new park
 *   12–15   someone this station has never worked, and POTA activators
 *    3–12   band slots on things already worked somewhere
 *    0–6    signal strength, a tiebreaker between equals
 *
 * `neverWorked` used to be 2, which put it BELOW the signal tiebreaker's ceiling of
 * 6 — so a loud station worked fifty times outranked a weak one never worked at all,
 * which is the opposite of how anyone operates. At 12 a new station beats any dupe
 * of equal award value however loud it is, while still yielding to every genuine
 * award.
 */
const POINTS = {
  newDxcc: 100,
  newContinent: 40,
  newPark: 35,
  newDxccThisBand: 30,
  newState: 25,
  newCqZone: 20,
  /**
   * Calling CQ POTA with no reference we can match.
   *
   * The park is not in the message — there is no room for it — so it only arrives
   * from the spot feed, and only when that agrees on callsign AND band. An activator
   * the feed has not caught up with was therefore scored as an ordinary station.
   * With 546 references worked out of roughly 60,000, an unidentified activation is
   * far likelier to be new than not, and in plain Hunt this is what puts a park
   * ahead of the locals.
   */
  potaActivator: 15,
  neverWorked: 12,
  newStateThisBand: 12,
  newGrid: 5,
  newGridThisBand: 3,
} as const;

/**
 * Score one candidate against what has been worked.
 *
 * Reasons are pushed most-significant first: the decode row shows only the FIRST
 * one and puts the rest in its tooltip, so a station that is both a new entity and
 * a new grid must lead with the entity.
 */
export function scoreCandidate(c: Candidate, worked: WorkedIndex): Scored {
  const reasons: string[] = [];
  let score = 0;
  // Counted separately from `reasons` — see the note on Scored.routine.
  let awardReasons = 0;
  const award = (points: number, why: string) => {
    score += points;
    reasons.push(why);
    awardReasons++;
  };

  if (c.dxcc) {
    if (!worked.dxcc.has(c.dxcc.adif)) {
      award(POINTS.newDxcc, `NEW DXCC: ${c.dxcc.name}`);
    } else if (!worked.dxccThisBand.has(c.dxcc.adif)) {
      award(POINTS.newDxccThisBand, `${c.dxcc.name} new on this band`);
    }
    if (c.dxcc.continent && !worked.continents.has(c.dxcc.continent)) {
      award(POINTS.newContinent, `new continent ${c.dxcc.continent}`);
    }
    if (c.dxcc.cqZone !== null && !worked.cqZones.has(c.dxcc.cqZone)) {
      award(POINTS.newCqZone, `new CQ zone ${c.dxcc.cqZone}`);
    }
  }

  // A park is scored above the entity band-slot: for an operator running the POTA
  // modes it is the reason they are listening at all, and with 546 of ~60,000
  // references worked almost every activator heard is a new one.
  if (c.park) {
    const p = c.park.toUpperCase();
    if (!worked.parks.has(p)) award(POINTS.newPark, `new park ${p}`);
    // A known park already in the log gets nothing: we can see it is not new.
  } else if (c.potaCq) {
    // An activator whose reference we could not match. Likely new on the numbers,
    // and worth putting ahead of the locals in plain Hunt — but scored well below a
    // park we have actually confirmed is new.
    award(POINTS.potaActivator, "POTA activator");
  }

  if (c.state) {
    const s = c.state.toUpperCase();
    if (!worked.states.has(s)) award(POINTS.newState, `new state ${s}`);
    else if (!worked.statesThisBand.has(s)) {
      award(POINTS.newStateThisBand, `${s} new on this band`);
    }
  }

  if (c.grid) {
    const g = c.grid.slice(0, 4).toUpperCase();
    if (!worked.grids.has(g)) award(POINTS.newGrid, `new grid ${g}`);
    else if (!worked.gridsThisBand.has(g)) {
      award(POINTS.newGridThisBand, `${g} new on this band`);
    }
  }

  // Informational, and deliberately NOT an award reason: it fires across most of a
  // busy band, and counting it would make `newOnly` filtering keep everything.
  if (!worked.calls.has(c.call.toUpperCase())) {
    score += POINTS.neverWorked;
    reasons.push("never worked");
  }

  // Signal strength as a tiebreaker only: -20..+10 dB maps to roughly 0..6.
  score += Math.max(0, Math.min(6, (c.snr + 24) / 5));

  return { ...c, score, reasons, routine: awardReasons === 0 };
}

export interface RankOptions {
  /**
   * Skip stations that offer nothing new. Off by default: an operator running
   * Auto Hunt on a quiet band usually wants contacts, not only new ones.
   */
  newOnly?: boolean;
  /** Below this SNR a contact is unlikely to complete; not worth the cycles. */
  minSnr?: number;
}

/** Rank candidates best-first. */
export function rankCandidates(
  candidates: Candidate[],
  worked: WorkedIndex,
  opts: RankOptions = {},
): Scored[] {
  const minSnr = opts.minSnr ?? -24;
  return candidates
    .filter((c) => c.snr >= minSnr)
    .map((c) => scoreCandidate(c, worked))
    .filter((s) => !opts.newOnly || !s.routine)
    .sort((a, b) => b.score - a.score);
}
