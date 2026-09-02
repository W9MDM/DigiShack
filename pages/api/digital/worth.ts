import type { NextApiRequest, NextApiResponse } from "next";

import { sendError, sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import { resolveDxcc } from "@/lib/dxcc/resolve";
import { buildWorkedIndex } from "@/lib/digital/worked-index";
import { workedRecently } from "@/lib/digital/worked-recently";
import { getNumberSetting } from "@/lib/settings";
import { scoreCandidate, type Candidate } from "@/lib/digital/worth";
import { cachedPotaSpots } from "@/lib/pota/spots";

// POST /api/digital/worth — which of these stations is worth calling?
//
// `lib/digital/worth.ts` has always produced "NEW DXCC: Japan", "new grid EN61",
// "new CQ zone 25" — and only the auto-operator ever read them. An operator watching
// the decode list saw thirty identical-looking rows and had no way to tell the one new
// entity from the twenty-nine locals, while a background process ranking the same
// decodes knew exactly.
//
// This is that scoring, exposed. Same function, so the badges an operator sees and the
// choices Auto Hunt makes cannot disagree.

/** A decode list is capped at 500 rows; scoring more than this is a client bug. */
const MAX_CALLS = 200;

/**
 * The state out of a POTA `locationDesc` — "US-TX" to "TX".
 *
 * Null unless there is exactly one, and only for US/CA. A park on a state line is
 * spotted as "US-TX,US-NM" and there is no way to say which side the activator is
 * sitting on; a wrong state badge on a row an operator is about to call is worse
 * than no badge. Anything outside US/CA is not a WAS state at all.
 */
function stateFromPotaLocation(location: string | null): string | null {
  if (!location) return null;
  const parts = location.split(",").map((p) => p.trim().toUpperCase()).filter(Boolean);
  if (parts.length !== 1) return null;
  const m = /^(US|CA)-([A-Z]{2})$/.exec(parts[0]!);
  return m ? m[2]! : null;
}

export interface WorthEntry {
  callsign: string;
  score: number;
  reasons: string[];
  /** Nothing new about this station — the common case, and worth saying plainly. */
  routine: boolean;
  /**
   * The dupe rule would refuse to call them: already worked on this band and mode inside
   * `auto.dupeWindowHours`, or already today.
   *
   * The SAME question the transmit guard asks, from the same boundary function, so the chip
   * on the screen and the refusal in the log cannot disagree. The old chip was page-local
   * session state and an operator reported never having seen it fire.
   */
  workedRecently: boolean;
}

async function post(req: NextApiRequest, res: NextApiResponse) {
  const body = (req.body ?? {}) as { band?: unknown; calls?: unknown; grids?: unknown };

  const band =
    typeof body.band === "string" && body.band.trim() ? body.band.trim().toUpperCase() : null;
  // MODE MATTERS AND WAS NOT ASKED FOR. The dupe rule is per band AND mode — a station
  // worked on 20 m FT8 is not a duplicate on 20 m FT4 — so a chip decided on band alone
  // would talk an operator out of contacts they are entitled to make.
  const mode =
    typeof (body as { mode?: unknown }).mode === "string" &&
    (body as { mode: string }).mode.trim()
      ? (body as { mode: string }).mode.trim().toUpperCase()
      : null;

  if (!Array.isArray(body.calls)) {
    sendError(res, 400, "calls must be an array of callsigns");
    return;
  }
  const calls = [
    ...new Set(
      body.calls
        .filter((c): c is string => typeof c === "string")
        .map((c) => c.trim().toUpperCase())
        .filter((c) => /^[A-Z0-9/]{3,16}$/.test(c)),
    ),
  ].slice(0, MAX_CALLS);

  if (calls.length === 0) {
    sendJson(res, 200, { band, entries: [] });
    return;
  }

  // Grids from the decode messages, where the client has them. A CQ carries one, and
  // it is the only way "new grid" can be judged before working the station.
  const grids = new Map<string, string>();
  if (body.grids && typeof body.grids === "object") {
    for (const [k, v] of Object.entries(body.grids as Record<string, unknown>)) {
      if (typeof v === "string" && v) grids.set(k.toUpperCase(), v.toUpperCase());
    }
  }

  const worked = await buildWorkedIndex(band);

  // Read from the setting rather than hardcoded, so turning the guard down (or off) changes
  // the chips in step with what the station will actually do.
  const dupeHours = await getNumberSetting("auto.dupeWindowHours", 24);
  const dupes = await workedRecently(calls, band, mode, dupeHours * 3_600_000);

  // Park reference and state for anyone currently spotted as an activator.
  //
  // Matched on callsign AND band, the same rule the auto-operator uses: a spot on
  // 20 m says nothing about the station being heard here on 40 m, and attaching its
  // reference would put a "new park" badge on a row that is not that activation.
  const spots = await cachedPotaSpots();
  const spotted = new Map<string, { reference: string; location: string | null }>();
  for (const s of spots) {
    if (band && s.band !== band) continue;
    if (!spotted.has(s.activator)) {
      spotted.set(s.activator, { reference: s.reference, location: s.location });
    }
  }

  const entries: WorthEntry[] = [];
  for (const call of calls) {
    let dxcc: Candidate["dxcc"] = null;
    try {
      const r = await resolveDxcc(call);
      if (r.status === "found") {
        dxcc = {
          adif: r.match.adif,
          name: r.match.name,
          cqZone: r.match.cqZone,
          continent: r.match.continent,
        };
      }
    } catch {
      // No cty data loaded: scoring degrades to grid and signal, which is still
      // better than nothing and is exactly what the auto-operator does.
    }

    const spot = spotted.get(call);
    const scored = scoreCandidate(
      // SNR is deliberately zero here. It is a tiebreaker in the ranking and it is
      // already the second column of the decode list; including it would make the
      // badge change every cycle for a station whose award value has not moved.
      {
        call,
        snr: 0,
        grid: grids.get(call) ?? null,
        dxcc,
        park: spot?.reference ?? null,
        state: stateFromPotaLocation(spot?.location ?? null),
      },
      worked,
    );
    entries.push({
      callsign: call,
      score: scored.score,
      reasons: scored.reasons,
      routine: scored.routine,
      workedRecently: dupes.has(call),
    });
  }

  sendJson(res, 200, { band, mode, entries });
}

export default authedRoute({ POST: { role: "VIEWER", handler: post } });
