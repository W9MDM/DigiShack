// What this station has already worked, for award-aware ranking.
//
// Lifted out of the radio bridge so the web tier can use it too. It was private to
// `services/radio/index.ts`, which is why the decode list showed nothing about which
// station is worth calling while the auto-operator had the whole picture — the
// scoring in `worth.ts` produces "NEW DXCC: Japan" and "new grid EN61" and only a
// background process ever read them.
//
// Six distinct-value queries over 26,000 QSOs. Cheap individually and not something to
// run per decode, so the result is cached: it only changes when a contact is logged,
// and it is invalidated explicitly when one is.

import { prisma } from "@/lib/db/prisma";
import { emptyWorkedIndex, type WorkedIndex } from "@/lib/digital/worth";

/** Long enough to cover a burst of decodes, short enough to feel live. */
const TTL_MS = 60_000;

const cache = new Map<string, { at: number; index: WorkedIndex }>();

/** Called after logging a contact, so the next ranking sees it. */
export function invalidateWorkedIndex(): void {
  cache.clear();
}

export async function buildWorkedIndex(band: string | null): Promise<WorkedIndex> {
  const key = band ?? "*";
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.index;

  const index = emptyWorkedIndex();
  try {
    const [
      entities,
      states,
      grids,
      zones,
      continents,
      thisBand,
      statesThisBand,
      gridsThisBand,
      calls,
      parks,
    ] = await Promise.all([
      prisma.qso.findMany({
        where: { dxcc: { not: null } },
        distinct: ["dxcc"],
        select: { dxcc: true },
      }),
      prisma.qso.findMany({
        where: { state: { not: null } },
        distinct: ["state"],
        select: { state: true },
      }),
      prisma.qso.findMany({
        where: { gridSquare: { not: null } },
        distinct: ["gridSquare"],
        select: { gridSquare: true },
      }),
      prisma.qso.findMany({
        where: { cqZone: { not: null } },
        distinct: ["cqZone"],
        select: { cqZone: true },
      }),
      prisma.qso.findMany({
        where: { continent: { not: null } },
        distinct: ["continent"],
        select: { continent: true },
      }),
      band
        ? prisma.qso.findMany({
            where: { band, dxcc: { not: null } },
            distinct: ["dxcc"],
            select: { dxcc: true },
          })
        : Promise.resolve([]),
      band
        ? prisma.qso.findMany({
            where: { band, state: { not: null } },
            distinct: ["state"],
            select: { state: true },
          })
        : Promise.resolve([]),
      band
        ? prisma.qso.findMany({
            where: { band, gridSquare: { not: null } },
            distinct: ["gridSquare"],
            select: { gridSquare: true },
          })
        : Promise.resolve([]),
      // Every callsign worked. `distinct` over 26,000 rows returns ~14,000 strings,
      // which is why this is cached with everything else rather than asked per decode.
      prisma.qso.findMany({ distinct: ["callsign"], select: { callsign: true } }),
      prisma.qso.findMany({
        where: { sig: "POTA", sigInfo: { not: null } },
        distinct: ["sigInfo"],
        select: { sigInfo: true },
      }),
    ]);
    for (const r of entities) if (r.dxcc !== null) index.dxcc.add(r.dxcc);
    for (const r of thisBand) if (r.dxcc !== null) index.dxccThisBand.add(r.dxcc);
    for (const r of states) if (r.state) index.states.add(r.state.toUpperCase());
    for (const r of statesThisBand) if (r.state) index.statesThisBand.add(r.state.toUpperCase());
    for (const r of grids) if (r.gridSquare) index.grids.add(r.gridSquare.slice(0, 4).toUpperCase());
    for (const r of gridsThisBand) {
      if (r.gridSquare) index.gridsThisBand.add(r.gridSquare.slice(0, 4).toUpperCase());
    }
    for (const r of zones) if (r.cqZone !== null) index.cqZones.add(r.cqZone);
    for (const r of continents) if (r.continent) index.continents.add(r.continent.toUpperCase());
    for (const r of calls) if (r.callsign) index.calls.add(r.callsign.toUpperCase());
    for (const r of parks) if (r.sigInfo) index.parks.add(r.sigInfo.toUpperCase());
    cache.set(key, { at: Date.now(), index });
  } catch (err) {
    // An index that fails to build must not stop the operator working people — it
    // degrades to signal-strength ranking. Deliberately not cached, so a transient
    // database problem does not pin an empty index for a minute.
    console.error("[worked-index] failed:", err instanceof Error ? err.message : err);
  }
  return index;
}
