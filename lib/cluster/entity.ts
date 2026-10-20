// DXCC entity for a spotted call, through lib/dxcc/resolve.ts and a cache in front of it.
//
// The resolver is the one the log uses — exceptions, the KG4 rule, portable prefixes — so a
// spot and the contact made from it cannot land in different entities. It costs three or
// four queries a call, which is nothing for a QSO and too much for a feed that delivers
// several spots a second, so answers are kept: the same calls are spotted all day.

import { resolveDxcc } from "@/lib/dxcc/resolve";
import type { SpotEntity } from "@/lib/cluster/types";

const FOUND_MS = 12 * 3_600_000;
const NOT_FOUND_MS = 3_600_000;
/** Short, so importing cty data shows up on the page within minutes. */
const NO_DATA_MS = 5 * 60_000;
const ERROR_MS = 60_000;
const MAX_ENTRIES = 5_000;

const cache = new Map<string, { until: number; entity: SpotEntity | null }>();
let noData = false;

/** True when the last lookup said no cty data is loaded — the page says so instead of a column of dashes. */
export function dxccDataMissing(): boolean {
  return noData;
}

export async function entityForCall(call: string): Promise<SpotEntity | null> {
  const now = Date.now();
  const hit = cache.get(call);
  if (hit && hit.until > now) {
    // Re-inserted so the Map's insertion order works as least-recently-used.
    cache.delete(call);
    cache.set(call, hit);
    return hit.entity;
  }

  let entity: SpotEntity | null = null;
  let ttl = ERROR_MS;
  try {
    const r = await resolveDxcc(call);
    if (r.status === "found") {
      entity = {
        adif: r.match.adif,
        name: r.match.name,
        prefix: r.match.prefix,
        continent: r.match.continent,
        cqZone: r.match.cqZone,
      };
      ttl = FOUND_MS;
      noData = false;
    } else if (r.status === "no-data") {
      ttl = NO_DATA_MS;
      noData = true;
    } else {
      ttl = NOT_FOUND_MS;
      noData = false;
    }
  } catch {
    // The database is away. Not cached for long: the answer will exist when it is back.
  }

  cache.set(call, { until: now + ttl, entity });
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return entity;
}
