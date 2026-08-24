// Matching POTA logbook rows to QSOs already in the log.
//
// This is the part that can do damage. A wrong park reference written onto a
// thousand contacts is indistinguishable from a right one afterwards, and it would
// poison every "have I worked this park?" answer from then on. So the rules here are
// deliberately conservative, the function is pure and tested, and anything it is not
// sure about is reported rather than guessed:
//
//   * one candidate in the time window          -> matched
//   * several, one clearly nearest in time      -> matched
//   * several, equally close                    -> ambiguous, untouched
//   * none                                      -> missing (POTA has a contact we do not)
//   * carries references POTA does not know of  -> conflict ONLY if they are disjoint
//
// Time rather than mode is the discriminator. POTA's mode comes from the activator's
// ADIF and may say DATA where we say FT8, or MFSK where we say FT4 — mode agreement
// is evidence, not a requirement. The timestamp comes from their log and ours from
// our own clock, so it is close but never exact.
//
// The first version of this got the central case wrong, and it is worth recording why:
// it assumed one contact meant one park, so a second POTA row for the same QSO was
// treated as a problem in the activator's log. It is not. Parks nest and overlap —
// working an activator at Indiana Dunes is US-0765 and US-2258 simultaneously, the
// national park and the state park inside it — and 126 of this station's 863 park
// contacts carry more than one reference, four of them five. So POTA's rows are
// grouped into CONTACTS before matching, each contact carrying a set of references,
// and merging is additive: POTA naming a park the log does not have is new
// information, not a correction.

/** A QSO already in the log, as much of it as matching needs. */
export interface LocalQso {
  id: string;
  callsign: string;
  band: string;
  mode: string;
  startTimeMs: number;
  /** Every POTA reference already on this contact. */
  refs: string[];
}

/**
 * One contact as POTA describes it, with every reference claimed for it.
 *
 * `references` is a set rather than a single value because that is what a park
 * contact is. See the note at the top of the file.
 */
export interface RemoteQso {
  /** The other station — the activator. */
  callsign: string;
  band: string | null;
  mode: string | null;
  timeMs: number | null;
  references: string[];
}

/** A single POTA logbook row, before rows are grouped into contacts. */
export interface RemoteRow {
  callsign: string;
  band: string | null;
  mode: string | null;
  timeMs: number | null;
  reference: string;
}

/**
 * Collapse POTA's rows into contacts.
 *
 * POTA returns one row per (contact, reference), so a three-fer arrives as three
 * rows that differ only in the reference. Grouping on callsign, band and timestamp
 * puts them back together; anything that disagrees on those is a different contact.
 *
 * Mode is deliberately not part of the key. The rows for one contact come from one
 * ADIF record and always agree, so including it would only add a way for a stray
 * difference to split a genuine n-fer into two contacts that then fight over the
 * same QSO.
 */
export function groupRows(rows: readonly RemoteRow[]): RemoteQso[] {
  const byKey = new Map<string, RemoteQso>();
  for (const r of rows) {
    const key = `${r.callsign.toUpperCase()}|${r.band ?? ""}|${r.timeMs ?? "?"}`;
    const hit = byKey.get(key);
    if (hit) {
      const ref = r.reference.trim().toUpperCase();
      if (ref && !hit.references.includes(ref)) hit.references.push(ref);
      continue;
    }
    byKey.set(key, {
      callsign: r.callsign.toUpperCase(),
      band: r.band,
      mode: r.mode,
      timeMs: r.timeMs,
      references: r.reference.trim() ? [r.reference.trim().toUpperCase()] : [],
    });
  }
  // References sorted so the primary chosen from a set is stable across runs.
  for (const c of byKey.values()) c.references.sort();
  return [...byKey.values()];
}

export type MergeOutcome =
  | "matched"
  | "already-set"
  | "conflict"
  | "ambiguous"
  | "missing"
  | "unusable";

export interface MergeDecision {
  remote: RemoteQso;
  outcome: MergeOutcome;
  /** The QSO to update, when there is one. */
  qsoId?: string;
  /** References that would be ADDED — never the ones already present. */
  adding?: string[];
  /** Set on `conflict` and `already-set`: what the log already holds. */
  existing?: string[];
  /** Every candidate considered, for `ambiguous`. */
  candidateIds?: string[];
  detail?: string;
}

export interface MergeOptions {
  /**
   * How far apart the two timestamps may be.
   *
   * Ten minutes by default. The activator's clock, our clock and the moment each
   * side considers the QSO to have started all differ; an FT8 exchange alone spans
   * a minute or two. Tighter than this starts losing real matches, and much looser
   * starts matching the wrong contact on a busy band.
   */
  windowMs?: number;
  /**
   * Add POTA's references even when the log's existing ones are completely
   * different. Off by default.
   *
   * Not "replace": references are only ever added, because a park the log has and
   * POTA does not is still a park that was worked — POTA's hunter record only covers
   * activators who uploaded a log, so it is incomplete by construction.
   */
  overwrite?: boolean;
}

const DEFAULT_WINDOW_MS = 10 * 60_000;

/** POTA's mode names for the digital modes we might have logged differently. */
const MODE_ALIASES: Record<string, string> = {
  DATA: "FT8",
  MFSK: "FT4",
  JS8CALL: "JS8",
};

function normMode(m: string | null): string | null {
  if (!m) return null;
  const u = m.trim().toUpperCase();
  return MODE_ALIASES[u] ?? u;
}

/**
 * Decide what to do about one POTA row.
 *
 * `candidates` must already be narrowed to the same callsign — the caller does that
 * with one query, not one per row.
 */
export function decide(
  remote: RemoteQso,
  candidates: LocalQso[],
  opts: MergeOptions = {},
): MergeDecision {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;

  if (remote.references.length === 0) {
    return { remote, outcome: "unusable", detail: "no park reference" };
  }
  if (remote.timeMs === null) {
    return { remote, outcome: "unusable", detail: "no usable timestamp" };
  }

  const at = remote.timeMs;
  let inWindow = candidates.filter(
    (c) =>
      c.callsign.toUpperCase() === remote.callsign.toUpperCase() &&
      Math.abs(c.startTimeMs - at) <= windowMs,
  );

  // Band is a hard filter when POTA gives one: the same operator on two bands
  // minutes apart is ordinary at a park, and taking the wrong one would attach a
  // correct reference to the wrong contact — which still corrupts the band-slot
  // answers even though the park is right.
  if (remote.band) {
    const sameBand = inWindow.filter((c) => c.band.toUpperCase() === remote.band!.toUpperCase());
    if (sameBand.length > 0) inWindow = sameBand;
    else if (inWindow.length > 0) {
      return {
        remote,
        outcome: "ambiguous",
        candidateIds: inWindow.map((c) => c.id),
        detail: `nothing on ${remote.band} within the window`,
      };
    }
  }

  if (inWindow.length === 0) return { remote, outcome: "missing" };

  // Mode narrows further only when it helps. If it eliminates everything, the
  // difference is a naming difference and mode is not what should decide.
  const mode = normMode(remote.mode);
  if (mode && inWindow.length > 1) {
    const sameMode = inWindow.filter((c) => normMode(c.mode) === mode);
    if (sameMode.length > 0) inWindow = sameMode;
  }

  let pick: LocalQso;
  if (inWindow.length === 1) {
    pick = inWindow[0]!;
  } else {
    const sorted = [...inWindow].sort(
      (a, b) => Math.abs(a.startTimeMs - at) - Math.abs(b.startTimeMs - at),
    );
    const best = sorted[0]!;
    const next = sorted[1]!;
    // Equally close, and no other signal to separate them. Refusing here is the
    // whole point: one of the two is the wrong contact and there is no way to know
    // which.
    if (Math.abs(best.startTimeMs - at) === Math.abs(next.startTimeMs - at)) {
      return {
        remote,
        outcome: "ambiguous",
        candidateIds: sorted.map((c) => c.id),
        detail: "two contacts equally close in time",
      };
    }
    pick = best;
  }

  // Merging is a set union, not a replacement. Every rule below follows from that.
  const existing = pick.refs.map((r) => r.toUpperCase());
  const incoming = remote.references.map((r) => r.toUpperCase());
  const adding = incoming.filter((r) => !existing.includes(r));

  if (adding.length === 0) {
    return { remote, outcome: "already-set", qsoId: pick.id, existing };
  }
  if (existing.length === 0) {
    return { remote, outcome: "matched", qsoId: pick.id, adding, existing };
  }

  // The contact already carries references. Overlapping means we knew part of an
  // n-fer and POTA is filling in the rest — ordinary, and additive. Completely
  // disjoint is the suspicious case: either the match is wrong, or one of the two
  // records is. That gets reported rather than merged, because quietly adding a
  // park to the wrong contact is exactly the failure this module exists to prevent.
  const overlaps = incoming.some((r) => existing.includes(r));
  if (overlaps || opts.overwrite) {
    return { remote, outcome: "matched", qsoId: pick.id, adding, existing };
  }
  return { remote, outcome: "conflict", qsoId: pick.id, adding, existing };
}

export interface MergePlan {
  decisions: MergeDecision[];
  counts: Record<MergeOutcome, number>;
  /** Updates to apply: the references to add to each contact. */
  updates: { qsoId: string; references: string[] }[];
  /** How many individual references would be added, across all contacts. */
  referencesAdded: number;
}

/**
 * Build the whole plan.
 *
 * `byCall` is the local log indexed by callsign, and `remotes` should already be
 * grouped with `groupRows` so each entry is one contact carrying all its references.
 *
 * Two POTA contacts landing on the same QSO are merged when their references
 * overlap and refused when they are disjoint.
 *
 * Overlapping means the activator's logging software wrote one contact twice —
 * observed live: a four-fer recorded at both 20:53:48 and 20:53:49, eight rows for
 * one contact. Grouping cannot join those because the timestamps genuinely differ,
 * so the reference sets are what identify them as the same thing.
 *
 * Disjoint means two different contacts, and then one of the matches is wrong. That
 * was observed too: an activator at two parks a minute apart, and only one QSO in
 * this log to attribute. No rule can tell which, so it is reported.
 */
export function planMerge(
  remotes: readonly RemoteQso[],
  byCall: Map<string, LocalQso[]>,
  opts: MergeOptions = {},
): MergePlan {
  const decisions: MergeDecision[] = [];
  const claimed = new Map<string, { references: string[]; seen: Set<string> }>();

  for (const r of remotes) {
    const d = decide(r, byCall.get(r.callsign.toUpperCase()) ?? [], opts);
    if (d.outcome === "matched" && d.qsoId && d.adding?.length) {
      const already = claimed.get(d.qsoId);
      // `seen` is every reference the claiming contacts named, not just the ones
      // being added — a duplicate POTA contact adds nothing new the second time, so
      // comparing against `adding` alone would find no overlap and call it a clash.
      if (already && !r.references.some((ref) => already.seen.has(ref.toUpperCase()))) {
        decisions.push({
          ...d,
          outcome: "ambiguous",
          detail: `a different POTA contact already matched this QSO for ${already.references.join(", ")}`,
        });
        continue;
      }
      claimed.set(d.qsoId, {
        references: [...new Set([...(already?.references ?? []), ...d.adding])],
        seen: new Set([
          ...(already?.seen ?? []),
          ...r.references.map((ref) => ref.toUpperCase()),
        ]),
      });
    }
    decisions.push(d);
  }

  const counts: Record<MergeOutcome, number> = {
    matched: 0,
    "already-set": 0,
    conflict: 0,
    ambiguous: 0,
    missing: 0,
    unusable: 0,
  };
  for (const d of decisions) counts[d.outcome]++;

  const updates = [...claimed].map(([qsoId, v]) => ({
    qsoId,
    references: v.references,
  }));

  return {
    decisions,
    counts,
    updates,
    referencesAdded: updates.reduce((n, u) => n + u.references.length, 0),
  };
}

/**
 * Work out which callsign in a POTA row is the other station.
 *
 * A hunter row comes from the activator's uploaded log, so *they* are the station
 * and we are the worked callsign; an activator row is the other way round. Rather
 * than encode that and be wrong when POTA normalises one of them, this picks
 * whichever callsign is not ours. Undocumented endpoint, so the robust reading wins.
 */
export function otherStation(
  entry: { stationCallsign: string | null; operatorCallsign: string | null; workedCallsign: string | null },
  ourCallsigns: Set<string>,
): string | null {
  const ours = new Set([...ourCallsigns].map((c) => c.toUpperCase()));
  for (const c of [entry.stationCallsign, entry.operatorCallsign, entry.workedCallsign]) {
    if (c && !ours.has(c.toUpperCase())) return c.toUpperCase();
  }
  return null;
}
