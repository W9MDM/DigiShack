// The pure half of "needed": what a set of worked slots says about one spot.
// Separate from needed.ts so the check can exercise it without a database client.

import { modeCategory } from "@/lib/cluster/mode";
import type { ModeCategory, SpotNeeded } from "@/lib/cluster/types";

export interface WorkedSlots {
  entities: Set<number>;
  /** `adif|BAND` */
  entityBand: Set<string>;
  /** `adif|CATEGORY` */
  entityMode: Set<string>;
}

export function slotsFromRows(
  bandRows: { dxcc: number | null; band: string }[],
  modeRows: { dxcc: number | null; mode: string }[],
): WorkedSlots {
  const slots: WorkedSlots = { entities: new Set(), entityBand: new Set(), entityMode: new Set() };
  for (const r of bandRows) {
    if (r.dxcc === null) continue;
    slots.entities.add(r.dxcc);
    slots.entityBand.add(`${r.dxcc}|${r.band.toUpperCase()}`);
  }
  for (const r of modeRows) {
    if (r.dxcc === null) continue;
    slots.entities.add(r.dxcc);
    const cat = modeCategory(r.mode);
    if (cat) slots.entityMode.add(`${r.dxcc}|${cat}`);
  }
  return slots;
}

export function neededFor(
  slots: WorkedSlots,
  adif: number,
  band: string,
  category: ModeCategory | null,
): SpotNeeded {
  return {
    entity: !slots.entities.has(adif),
    band: !slots.entityBand.has(`${adif}|${band.toUpperCase()}`),
    mode: category !== null && !slots.entityMode.has(`${adif}|${category}`),
  };
}
