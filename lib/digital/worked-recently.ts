// "Have I already worked this station today?" — for the decode list.
//
// THE BADGE AND THE GUARD HAVE TO AGREE, and they did not.
//
// The decodes page had a `worked` chip driven by page-local React state:
//
//     const [workedNow, setWorkedNow] = useState<Set<string>>(new Set());
//
// Empty on every page load, filled only by a `qso-logged` websocket message while that tab
// stayed open. So it showed for a contact finished thirty seconds ago and never again —
// after a refresh, after a bridge restart, or for anyone worked earlier in the day. The
// operator's report was simply "I've yet to see the worked chip".
//
// Meanwhile `auto.dupeWindowHours` refuses to call the same station on the same band and
// mode for 24 hours and once per UTC day. So the software knew perfectly well that a
// station was a duplicate and declined to call them, while the screen said nothing. That is
// the disagreement lib/digital/worth.ts already warns about in its own comments — the
// badges an operator reads and the choices Auto Hunt makes must not drift apart.
//
// This answers the SAME question the guard asks, from the same boundary function, so they
// cannot give different answers.

import { prisma } from "@/lib/db/prisma";
import { dupeBoundaryMs } from "@/lib/digital/qso";

/** Callsigns already worked inside the dupe boundary, on this band and mode. */
export type WorkedRecently = Set<string>;

/**
 * Which of these callsigns the dupe rule would refuse.
 *
 * Band AND mode, because that is the rule: a station worked on 20 m FT8 is not a duplicate
 * on 20 m FT4, and showing one as "worked" would talk an operator out of a contact they are
 * entitled to make.
 *
 * Returns an EMPTY set when the guard is disabled (`windowMs <= 0`, which `dupeBoundaryMs`
 * reports as null) rather than falling back to some other window. If the operator has
 * switched the protection off, nothing is a duplicate — the screen should say what the
 * software will actually do, not what it would have done under a different setting.
 */
export async function workedRecently(
  calls: string[],
  band: string | null,
  mode: string | null,
  windowMs: number,
  now: number = Date.now(),
): Promise<WorkedRecently> {
  const empty: WorkedRecently = new Set();
  // No band or mode means no rule to apply: the dupe guard is per band and mode, and
  // guessing one would produce a chip the guard disagrees with.
  if (!band || !mode || calls.length === 0) return empty;

  const since = dupeBoundaryMs(now, windowMs);
  if (since === null) return empty;

  try {
    const rows = await prisma.qso.findMany({
      where: {
        callsign: { in: calls },
        band,
        mode,
        startTime: { gte: new Date(since) },
      },
      select: { callsign: true },
      distinct: ["callsign"],
    });
    return new Set(rows.map((r: { callsign: string }) => r.callsign.toUpperCase()));
  } catch {
    // A failed lookup means no chips, not wrong chips. The decode list is useful without
    // them and the transmit guard is unaffected — it asks the database itself.
    return empty;
  }
}
