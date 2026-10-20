// The spot list: lines in, deduped and enriched spots out, the last few hundred kept.
//
// The database lookups are handed in rather than imported, so the check drives the real
// pipeline with a fake log and a fake cty table instead of a copy of it.

import { freqToBand } from "@/lib/ham/bands";
import { SpotDeduper, spotKey } from "@/lib/cluster/dedupe";
import { inferSpotMode } from "@/lib/cluster/mode";
import { parseSpotLine, spotTime } from "@/lib/cluster/parse";
import { neededFor, type WorkedSlots } from "@/lib/cluster/slots";
import type { ClusterSpot, SpotEntity } from "@/lib/cluster/types";

export const MAX_SPOTS = 500;

export interface SpotBookDeps {
  entityFor: (call: string) => Promise<SpotEntity | null>;
  slots: () => Promise<WorkedSlots | null>;
  now?: () => number;
  deduper?: SpotDeduper;
}

export class SpotBook {
  /** Oldest first; at most one entry per call and band. */
  private spots: ClusterSpot[] = [];
  private readonly deduper: SpotDeduper;
  private seq = 0;
  readonly counts = { lines: 0, spots: 0, dupes: 0, ignored: 0 };

  constructor(
    private readonly deps: SpotBookDeps,
    private readonly max = MAX_SPOTS,
  ) {
    this.deduper = deps.deduper ?? new SpotDeduper();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /**
   * One line from the node. Returns the spot when it is a new one, null for everything else
   * — not a spot, out of band, or a repeat (which is counted on the spot it repeats).
   *
   * `enrich: false` skips the entity lookup, for when lookups have fallen behind.
   */
  async ingest(line: string, opts: { enrich?: boolean } = {}): Promise<ClusterSpot | null> {
    this.counts.lines++;
    const p = parseSpotLine(line);
    if (!p) return null;

    const band = freqToBand(p.freqHz);
    if (!band) {
      // Broadcast and utility stations get spotted too; nothing here can work them.
      this.counts.ignored++;
      return null;
    }

    const receivedAt = this.now();
    const at = spotTime(p.minuteOfDay, receivedAt);
    const key = spotKey(p.dx, band);

    if (this.deduper.isDupe(key, p.freqHz, receivedAt)) {
      this.counts.dupes++;
      const existing = this.spots.find((s) => s.key === key);
      if (existing) {
        existing.count++;
        existing.lastSeenAt = Math.max(existing.lastSeenAt, at);
      }
      return null;
    }

    const mode = inferSpotMode(p.freqHz, p.comment, p.skim?.mode ?? null);
    let entity: SpotEntity | null = null;
    if (opts.enrich !== false) {
      try {
        entity = await this.deps.entityFor(p.dx);
      } catch {
        entity = null;
      }
    }

    const spot: ClusterSpot = {
      id: `${receivedAt.toString(36)}-${(this.seq++).toString(36)}`,
      key,
      dx: p.dx,
      freqHz: p.freqHz,
      band,
      spotter: p.spotter,
      skimmer: p.skimmer,
      comment: p.comment,
      at,
      receivedAt,
      lastSeenAt: at,
      count: 1,
      spotterGrid: p.spotterGrid,
      snrDb: p.skim?.snrDb ?? null,
      wpm: p.skim?.speedUnit === "WPM" ? p.skim.speed : null,
      mode: mode.mode,
      modeCategory: mode.category,
      modeSource: mode.source,
      entity,
      needed: null,
    };
    if (entity) {
      const slots = await this.deps.slots().catch(() => null);
      if (slots) spot.needed = neededFor(slots, entity.adif, band, spot.modeCategory);
    }

    // A new spot for a call already listed on this band replaces it: after the window, or
    // after a QSY, the old entry describes where the station was.
    this.spots = this.spots.filter((s) => s.key !== key);
    this.spots.push(spot);
    if (this.spots.length > this.max) this.spots.splice(0, this.spots.length - this.max);
    this.counts.spots++;
    return spot;
  }

  /** Newest first. Copies, so a caller cannot reach into the list. */
  list(): ClusterSpot[] {
    return this.spots
      .slice()
      .reverse()
      .map((s) => ({ ...s, needed: s.needed ? { ...s.needed } : null }));
  }

  /** Re-judge every listed spot against the log as it is now — a contact logged since changes the answer. */
  async refreshNeeded(): Promise<void> {
    if (!this.spots.some((s) => s.entity)) return;
    const slots = await this.deps.slots().catch(() => null);
    if (!slots) return;
    for (const s of this.spots) {
      if (s.entity) s.needed = neededFor(slots, s.entity.adif, s.band, s.modeCategory);
    }
  }
}
