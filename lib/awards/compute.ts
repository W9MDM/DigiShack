import { prisma } from "@/lib/db/prisma";
import {
  CONTINENTS,
  CONTINENT_CODES,
  CQ_ZONES,
  WAS_STATES,
  WAS_STATE_CODES,
  gridSquare4,
} from "@/lib/awards/reference";

// Award progress.
//
// "Confirmed" means confirmed by ANY method — a card, LoTW or eQSL — which is the
// same definition the log filters use (lib/db/qso.ts). Keeping one definition
// matters: an award page that disagreed with the log's own "confirmed" filter
// would be worse than having neither.

export interface AwardSlice {
  worked: number;
  confirmed: number;
}

export interface AwardProgress {
  id: string;
  label: string;
  /** Unit being counted, for the UI. */
  unit: string;
  /**
   * Size of the full target set, or null where no fixed denominator exists —
   * grid squares and IOTA groups have no meaningful "out of N", and inventing
   * one would be worse than omitting it.
   */
  total: number | null;
  worked: number;
  confirmed: number;
  /** Present only when `total` is known. */
  /**
   * What is still needed, named.
   *
   * Was a bare string[], so the DXCC list rendered as a wall of ADIF integers —
   * "15, 27, 33, 49…" — which is the one screen whose entire job is telling you
   * what to chase next. `nameFor` was already being applied to the WORKED entries
   * a few lines away.
   */
  missing: { code: string; name?: string }[] | null;
  /**
   * True when more has been worked than the target set contains — which can only
   * mean the reference data is incomplete or stale (e.g. a partial cty.xml, or
   * one older than a QSO's entity). Reported rather than hidden: a percentage
   * over 100 is a data problem, not an achievement.
   */
  totalUnreliable: boolean;
  /** Every value worked, with whether it is confirmed. */
  entries: { code: string; label?: string; confirmed: boolean; count: number }[];
  byBand: Record<string, AwardSlice>;
  byMode: Record<string, AwardSlice>;
}

export interface AwardsResult {
  qsoCount: number;
  confirmedQsoCount: number;
  /** Current (non-deleted) DXCC entities, the denominator for the DXCC award. */
  dxccTotal: number | null;
  awards: AwardProgress[];
  generatedAt: string;
}

interface Row {
  band: string;
  mode: string;
  dxcc: number | null;
  state: string | null;
  cqZone: number | null;
  continent: string | null;
  gridSquare: string | null;
  iota: string | null;
  qslRcvd: string;
  lotwRcvd: boolean;
  eqslRcvd: boolean;
}

/** One dimension of an award: how to get its key out of a QSO row. */
interface Dimension {
  id: string;
  label: string;
  unit: string;
  key: (row: Row) => string | null;
  /** Full target set, or null when there is no fixed denominator. */
  universe: readonly string[] | null;
  /** Human label for a code, for the missing-list and entry display. */
  nameFor?: (code: string) => string | undefined;
}

export interface AwardsFilter {
  stationId?: string;
  band?: string;
  mode?: string;
}

export async function computeAwards(
  filter: AwardsFilter = {},
): Promise<AwardsResult> {
  const where = {
    ...(filter.stationId ? { stationId: filter.stationId } : {}),
    ...(filter.band ? { band: filter.band } : {}),
    ...(filter.mode ? { mode: filter.mode } : {}),
  };

  // One pass over the minimal column set, aggregated in JS.
  //
  // Deliberate: every award needs a different grouping AND a per-band and
  // per-mode matrix, and "confirmed" is an OR across three columns that Prisma
  // cannot group by. Doing it in SQL would mean a dozen-plus round trips. At
  // club-log scale (tens of thousands of rows, ~10 columns) this is a few MB.
  // Revisit with materialised counters if a log reaches the millions.
  const rows = (await prisma.qso.findMany({
    where,
    select: {
      band: true,
      mode: true,
      dxcc: true,
      state: true,
      cqZone: true,
      continent: true,
      gridSquare: true,
      iota: true,
      qslRcvd: true,
      lotwRcvd: true,
      eqslRcvd: true,
    },
  })) as Row[];

  const entityNames = new Map<number, string>();
  let dxccTotal: number | null = null;

  const entities = await prisma.dxccEntity.findMany({
    select: { adif: true, name: true, deleted: true },
  });
  if (entities.length > 0) {
    for (const e of entities) entityNames.set(e.adif, e.name);
    // Only current entities count toward the DXCC award; deleted ones still
    // credit a QSO made while they existed, but they are not a target.
    dxccTotal = entities.filter((e) => !e.deleted).length;
  }

  const dimensions: Dimension[] = [
    {
      id: "dxcc",
      label: "DXCC",
      unit: "entities",
      key: (r) => (r.dxcc === null ? null : String(r.dxcc)),
      // Without cty.xml loaded there is no denominator, so progress is reported
      // as a count rather than a fraction.
      universe:
        dxccTotal === null
          ? null
          : entities.filter((e) => !e.deleted).map((e) => String(e.adif)),
      nameFor: (code) => entityNames.get(Number(code)),
    },
    {
      id: "was",
      label: "Worked All States",
      unit: "states",
      key: (r) => {
        const s = r.state?.trim().toUpperCase();
        // Only US states count for WAS; other subdivisions live in the same ADIF
        // field, so they are filtered out rather than inflating the count.
        return s && WAS_STATE_CODES.includes(s) ? s : null;
      },
      universe: WAS_STATE_CODES,
      nameFor: (code) => WAS_STATES.find((s) => s.code === code)?.name,
    },
    {
      id: "waz",
      label: "Worked All Zones",
      unit: "CQ zones",
      key: (r) =>
        r.cqZone !== null && r.cqZone >= 1 && r.cqZone <= 40
          ? String(r.cqZone)
          : null,
      universe: CQ_ZONES.map(String),
      nameFor: (code) => `Zone ${code}`,
    },
    {
      id: "wac",
      label: "Worked All Continents",
      unit: "continents",
      key: (r) => {
        const c = r.continent?.trim().toUpperCase();
        return c && CONTINENT_CODES.includes(c) ? c : null;
      },
      universe: CONTINENT_CODES,
      nameFor: (code) => CONTINENTS.find((c) => c.code === code)?.name,
    },
    {
      id: "grid",
      label: "Grid squares",
      unit: "squares",
      key: (r) => (r.gridSquare ? gridSquare4(r.gridSquare) : null),
      universe: null,
    },
    {
      id: "iota",
      label: "IOTA",
      unit: "island groups",
      key: (r) => r.iota?.trim().toUpperCase() || null,
      // No denominator: the IOTA reference is ~1,200 groups maintained by the
      // RSGB programme and is not bundled here.
      universe: null,
    },
  ];

  /**
   * Does this QSO count as confirmed for AWARD purposes?
   *
   * eQSL is deliberately NOT included. It is a fine confirmation and worth
   * tracking, but the ARRL does not accept it for DXCC, WAS or VUCC, and CQ does
   * not accept it for WAZ or WPX. Counting it here inflated every award total
   * against what could actually be submitted — the one failure mode a DXer will
   * never forgive, because you only discover it when the application comes back.
   *
   * `qslRcvd === "CONFIRMED"` covers a paper card, which IS accepted.
   */
  const isConfirmed = (r: Row) => r.qslRcvd === "CONFIRMED" || r.lotwRcvd;

  /** Confirmed by anything at all, including eQSL — for display, not for awards. */
  const isConfirmedAnywhere = (r: Row) =>
    r.qslRcvd === "CONFIRMED" || r.lotwRcvd || r.eqslRcvd;

  const confirmedQsoCount = rows.filter(isConfirmed).length;

  const awards: AwardProgress[] = dimensions.map((dim) => {
    // code -> { confirmed, count }, plus per-band/per-mode code sets.
    const seen = new Map<string, { confirmed: boolean; count: number }>();
    const bandSets = new Map<string, { worked: Set<string>; confirmed: Set<string> }>();
    const modeSets = new Map<string, { worked: Set<string>; confirmed: Set<string> }>();

    for (const row of rows) {
      const code = dim.key(row);
      if (code === null) continue;

      const confirmed = isConfirmed(row);

      const existing = seen.get(code);
      if (existing) {
        existing.count++;
        // Once confirmed by any QSO, the award credit stands.
        if (confirmed) existing.confirmed = true;
      } else {
        seen.set(code, { confirmed, count: 1 });
      }

      const band = bandSets.get(row.band) ?? {
        worked: new Set<string>(),
        confirmed: new Set<string>(),
      };
      band.worked.add(code);
      if (confirmed) band.confirmed.add(code);
      bandSets.set(row.band, band);

      const mode = modeSets.get(row.mode) ?? {
        worked: new Set<string>(),
        confirmed: new Set<string>(),
      };
      mode.worked.add(code);
      if (confirmed) mode.confirmed.add(code);
      modeSets.set(row.mode, mode);
    }

    const entries = [...seen.entries()]
      .map(([code, v]) => ({
        code,
        label: dim.nameFor?.(code),
        confirmed: v.confirmed,
        count: v.count,
      }))
      .sort((a, b) => {
        // Numeric codes sort numerically; the rest alphabetically.
        const an = Number(a.code);
        const bn = Number(b.code);
        if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
        return a.code.localeCompare(b.code);
      });

    const missing =
      dim.universe === null
        ? null
        : dim.universe
            .filter((code) => !seen.has(code))
            .map((code) => ({ code, name: dim.nameFor?.(code) }))
            // By name where there is one, so the list reads alphabetically rather
            // than by an internal numbering nobody has memorised.
            .sort((a, b) => (a.name ?? a.code).localeCompare(b.name ?? b.code));

    const toSlices = (
      m: Map<string, { worked: Set<string>; confirmed: Set<string> }>,
    ): Record<string, AwardSlice> => {
      const out: Record<string, AwardSlice> = {};
      for (const [k, v] of m) {
        out[k] = { worked: v.worked.size, confirmed: v.confirmed.size };
      }
      return out;
    };

    const total = dim.universe === null ? null : dim.universe.length;

    return {
      id: dim.id,
      label: dim.label,
      unit: dim.unit,
      total,
      worked: seen.size,
      confirmed: entries.filter((e) => e.confirmed).length,
      missing,
      totalUnreliable: total !== null && seen.size > total,
      entries,
      byBand: toSlices(bandSets),
      byMode: toSlices(modeSets),
    };
  });

  return {
    qsoCount: rows.length,
    confirmedQsoCount,
    dxccTotal,
    awards,
    generatedAt: new Date().toISOString(),
  };
}
