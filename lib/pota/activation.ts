// The ten-contact rule, as a pure function.
//
// POTA credits an ACTIVATION when the activator makes ten contacts from one reference
// inside one UTC day. Nine is an attempt; the difference between the two is the whole
// reason anybody counts during an activation, and /pota already renders that threshold
// for PAST activations (`a.total >= 10 ? "text-ok" : "text-warn"`) — but only from
// pota.app's data, which arrives days later and describes work already finished.
//
// THE FAULT THIS EXISTS FOR. The operator sitting in the park needs the number NOW, for
// the activation in progress, and there was nothing to compute it from: the log had no
// record of which reference they were activating at all.
//
// TWO SCOPES, AND BOTH ARE MANDATORY. A count is wrong unless it is scoped to the
// reference AND to the UTC day, and each failure is quiet in a different way:
//
//   * Wrong reference. An activator who moves from US-4567 to US-4568 in an afternoon
//     — an ordinary two-park day — would carry the first park's contacts into the
//     second and be told they had qualified when they had not. A counter that quietly
//     counts a different park is worse than no counter, because it is believed.
//   * Wrong day. POTA's day boundary is UTC midnight, not the operator's local
//     midnight. In the US that lands in the EVENING, mid-activation: 20:00 EDT is
//     00:00 UTC, so contacts made either side of it belong to different activations
//     and must not be added together. A counter using local dates would report ten at
//     20:05 EDT when the second day holds one.
//
// PURE, and in `lib/pota/` beside `ref-list.ts` rather than beside `refs.ts`, for the
// reason stated there: `refs.ts` imports Prisma, and this is used by the logging page in
// the browser. Nothing here touches a database — the caller supplies the contacts or the
// count, which is also what makes the rule testable without one.

/**
 * Contacts needed for POTA to count an activation.
 *
 * Ten, at one reference, in one UTC day. Not configurable: it is POTA's rule, and a
 * setting for it would be an invitation to disagree with the programme that awards it.
 */
export const ACTIVATION_MINIMUM = 10;

/** Trim and upper-case a reference, or null. The one place the comparison shape is set. */
export function normaliseRef(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  return v.trim().toUpperCase() || null;
}

/**
 * 00:00:00.000 UTC on the day `at` falls in.
 *
 * `Date.UTC` on the UTC parts, deliberately — `setHours` is local and would slide the
 * boundary by the machine's offset, which is the exact bug described above. A log that
 * runs on UTC has to compute its day boundary in UTC too.
 */
export function utcDayStart(at: Date): Date {
  return new Date(
    Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), 0, 0, 0, 0),
  );
}

/** `2026-08-30` — the UTC date, for labelling a count so it cannot be read as local. */
export function utcDayKey(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** The minimum a contact must carry to be counted. Structural, so a wire row fits too. */
export interface ActivationContact {
  mySigInfo: string | null;
  /** A Date, or the ISO-8601 string the API returns. */
  startTime: Date | string;
}

/**
 * How many of these contacts count toward the activation of `reference` on the UTC day
 * containing `at`.
 *
 * Both scopes applied here, in one place, so there is exactly one implementation of the
 * rule for the page, the API filter and the check script to agree with.
 *
 * `mySigInfo`, never `sigInfo`. They are one character apart and mean opposite things —
 * the park we were in versus the park they were in — and reading the wrong one would
 * count a day of park CHASING as an activation of a park never visited.
 */
export function countActivationQsos(
  rows: readonly ActivationContact[],
  reference: string | null | undefined,
  at: Date,
): number {
  const ref = normaliseRef(reference);
  if (!ref) return 0;

  const from = utcDayStart(at).getTime();
  // Exclusive upper bound at the next UTC midnight. 86,400,000 ms rather than a
  // calendar step: UTC has no daylight saving, so the day is always exactly that long,
  // and leap seconds are not represented in a JavaScript Date at all.
  const to = from + 86_400_000;

  let n = 0;
  for (const row of rows) {
    if (normaliseRef(row.mySigInfo) !== ref) continue;
    const t =
      row.startTime instanceof Date
        ? row.startTime.getTime()
        : new Date(row.startTime).getTime();
    // An unparseable timestamp is NaN, which fails both comparisons and is skipped.
    if (t >= from && t < to) n++;
  }
  return n;
}

export interface ActivationProgress {
  count: number;
  needed: number;
  /** Contacts still to make. Zero once qualified — never negative. */
  remaining: number;
  qualifies: boolean;
}

/** Turn a count into the three numbers the operator is actually asking about. */
export function activationProgress(count: number): ActivationProgress {
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  return {
    count: n,
    needed: ACTIVATION_MINIMUM,
    remaining: Math.max(0, ACTIVATION_MINIMUM - n),
    qualifies: n >= ACTIVATION_MINIMUM,
  };
}

/**
 * The query string that asks the log for this activation's contacts.
 *
 * Built here rather than at the call site so the page cannot drift from the rule: the
 * reference filter and the UTC day bounds come out of the same functions the pure
 * counter uses. `take=1` because only `total` is wanted — the list endpoint returns the
 * count alongside the rows, and fetching a page of contacts to length them would be work
 * done to throw away.
 *
 * BOTH ENDS ARE BOUNDED, and the far end is not decoration. The list endpoint's `from`
 * alone would count everything since midnight with no ceiling, so a page left open
 * across UTC midnight — an activation that runs into the evening, which in the US is
 * exactly where the boundary falls — would keep yesterday's `from` and add the new day's
 * contacts to the old day's total. With `to` present the query describes one day whether
 * or not the caller notices the rollover.
 *
 * `to` is one millisecond BEFORE the next midnight because the endpoint compares with
 * `lte` while the rule is exclusive at the top. The column is DATETIME(3), so a
 * millisecond is its resolution and the two bounds describe the same set.
 */
export function activationCountQuery(reference: string, at: Date): string {
  const from = utcDayStart(at);
  const to = new Date(from.getTime() + 86_400_000 - 1);
  const params = new URLSearchParams({
    mySigInfo: normaliseRef(reference) ?? "",
    from: from.toISOString(),
    to: to.toISOString(),
    take: "1",
  });
  return params.toString();
}
