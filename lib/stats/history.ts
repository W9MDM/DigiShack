import { prisma } from "@/lib/db/prisma";

// Statistics beyond the dashboard counters.
//
// `lib/stats/summary.ts` answers "what is happening now" — today, yesterday, this week, and
// what was new. This answers "what has this station done", which is a different question and
// the one an operator opens on a quiet evening: how many contacts a year, who have I worked
// most, which continents.
//
// WHY RAW SQL HERE, when nothing else in the application uses it for reads. Grouping by YEAR
// or by month is a date truncation, and Prisma's `groupBy` cannot express one — the
// alternative is fetching 28,000 rows per request and reducing them in JavaScript, which is
// both slower and a habit that gets worse as the log grows. These are aggregate reads with no
// user input interpolated into them, which is the case where raw SQL costs least.

/** A year of operating. */
export interface YearRow {
  year: number;
  qsos: number;
  confirmed: number;
  /** Distinct stations worked that year, however many times each. */
  callsigns: number;
  /** Distinct DXCC entities that year. */
  entities: number;
}

export interface WorkedRow {
  callsign: string;
  qsos: number;
  firstWorked: Date;
  lastWorked: Date;
  /** Bands they have been worked on. */
  bands: number;
}

export interface CountRow {
  label: string;
  qsos: number;
}

export interface HistoryReport {
  years: YearRow[];
  mostWorked: WorkedRow[];
  continents: CountRow[];
  modes: CountRow[];
  bands: CountRow[];
  /** The whole log, for context under the per-year table. */
  totals: {
    qsos: number;
    confirmed: number;
    callsigns: number;
    entities: number;
    firstQso: Date | null;
    lastQso: Date | null;
  };
}

/**
 * "Confirmed" means the same thing everywhere it appears.
 *
 * A paper card, LoTW or eQSL. Written once as SQL and once as a Prisma filter in
 * `summary.ts`, which is a duplication worth noticing but not worth abstracting across a raw
 * and a typed query — what matters is that the DEFINITION matches, so it is spelled out here
 * next to the one it has to agree with.
 */
const CONFIRMED_SQL = `(qslRcvd = 'CONFIRMED' OR lotwRcvd = 1 OR eqslRcvd = 1)`;

/**
 * MySQL returns COUNT() as BigInt through Prisma, and JSON cannot serialise one.
 *
 * Left unconverted this throws "Do not know how to serialize a BigInt" at the API boundary —
 * after the query has succeeded, so the failure looks like a broken endpoint rather than a
 * type problem.
 */
function num(v: unknown): number {
  return typeof v === "bigint" ? Number(v) : Number(v ?? 0);
}

/**
 * Insert an empty row for every year between the first and last with no contacts.
 *
 * `GROUP BY YEAR(...)` returns only years that HAVE rows, so this log came back as 2026, 2025,
 * 2022, 2017 — four rows implying four years of operating, when the truth is a nine-year span
 * with six silent years in it. The gap is the information: a table that quietly omits it reads
 * as continuous activity, and the shape of a station's history is most of what a per-year view
 * is for.
 *
 * Bounded by the log's own extent, so a station with one contact gets one row rather than a
 * column of zeroes back to whenever.
 */
function fillYearGaps(rows: YearRow[]): YearRow[] {
  if (rows.length === 0) return rows;
  const years = rows.map((r) => r.year);
  const lo = Math.min(...years);
  const hi = Math.max(...years);
  const byYear = new Map(rows.map((r) => [r.year, r]));
  const out: YearRow[] = [];
  for (let y = hi; y >= lo; y--) {
    out.push(byYear.get(y) ?? { year: y, qsos: 0, confirmed: 0, callsigns: 0, entities: 0 });
  }
  return out;
}

export async function computeHistory(opts: { topCalls?: number } = {}): Promise<HistoryReport> {
  const topCalls = Math.min(100, Math.max(1, opts.topCalls ?? 25));

  const [yearRows, workedRows, contRows, modeRows, bandRows, totalRow] = await Promise.all([
    prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT YEAR(startTime) AS y,
              COUNT(*) AS qsos,
              SUM(${CONFIRMED_SQL}) AS confirmed,
              COUNT(DISTINCT callsign) AS callsigns,
              COUNT(DISTINCT dxcc) AS entities
         FROM Qso
        GROUP BY YEAR(startTime)
        ORDER BY y DESC`,
    ),
    prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      // Ordered by count, then by callsign so the order is stable when counts tie —
      // otherwise the table reshuffles between refreshes for no visible reason.
      `SELECT callsign,
              COUNT(*) AS qsos,
              MIN(startTime) AS firstWorked,
              MAX(startTime) AS lastWorked,
              COUNT(DISTINCT band) AS bands
         FROM Qso
        GROUP BY callsign
        ORDER BY qsos DESC, callsign ASC
        LIMIT ${topCalls}`,
    ),
    prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      // NULL continent is a real category, not a gap to hide: it is contacts whose entity was
      // never resolved, and knowing how many there are is the point of showing it.
      `SELECT COALESCE(continent, '—') AS label, COUNT(*) AS qsos
         FROM Qso GROUP BY continent ORDER BY qsos DESC`,
    ),
    prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT mode AS label, COUNT(*) AS qsos FROM Qso GROUP BY mode ORDER BY qsos DESC`,
    ),
    prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT band AS label, COUNT(*) AS qsos FROM Qso GROUP BY band ORDER BY qsos DESC`,
    ),
    prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT COUNT(*) AS qsos,
              SUM(${CONFIRMED_SQL}) AS confirmed,
              COUNT(DISTINCT callsign) AS callsigns,
              COUNT(DISTINCT dxcc) AS entities,
              MIN(startTime) AS firstQso,
              MAX(startTime) AS lastQso
         FROM Qso`,
    ),
  ]);

  const t = totalRow[0] ?? {};
  return {
    years: fillYearGaps(
      yearRows.map((r) => ({
        year: num(r.y),
        qsos: num(r.qsos),
        confirmed: num(r.confirmed),
        callsigns: num(r.callsigns),
        entities: num(r.entities),
      })),
    ),
    mostWorked: workedRows.map((r) => ({
      callsign: String(r.callsign),
      qsos: num(r.qsos),
      firstWorked: new Date(r.firstWorked as string),
      lastWorked: new Date(r.lastWorked as string),
      bands: num(r.bands),
    })),
    continents: contRows.map((r) => ({ label: String(r.label), qsos: num(r.qsos) })),
    modes: modeRows.map((r) => ({ label: String(r.label), qsos: num(r.qsos) })),
    bands: bandRows.map((r) => ({ label: String(r.label), qsos: num(r.qsos) })),
    totals: {
      qsos: num(t.qsos),
      confirmed: num(t.confirmed),
      callsigns: num(t.callsigns),
      entities: num(t.entities),
      firstQso: t.firstQso ? new Date(t.firstQso as string) : null,
      lastQso: t.lastQso ? new Date(t.lastQso as string) : null,
    },
  };
}
