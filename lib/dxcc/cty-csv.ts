// Parser for AD1C's cty.csv (the "Big CTY" country file).
//
// Why this exists alongside ./parse.ts, which reads Club Log's cty.xml: Club Log
// requires an API key issued on request, and until one arrives this installation
// had 9 DXCC entities in its reference table against 160 actually worked — so
// award denominators were nonsense and most entities had no name. AD1C's file is
// freely downloadable, needs no key, and carries the ADIF entity numbers, which
// is the one thing plain cty.dat lacks and the reason cty.csv is used here rather
// than cty.dat.
//
// Format — one record per line, ten comma-separated fields, the last terminated
// by a semicolon:
//
//   1A,Sov Mil Order of Malta,246,EU,15,28,41.90,-12.43,-1.0,1A;
//   |  |                      |   |  |  |  |     |      |    |
//   |  name                   |   |  |  ITU lat  lon    GMT  space-separated aliases
//   primary prefix            ADIF continent
//                                 CQ zone
//
// Verified against the real file: all 346 records split into exactly 10 fields,
// so no entity name contains a comma and naive splitting is safe.
//
// Two things in here will silently corrupt the data if missed, and both are
// asserted in scripts/check-dxcc.ts:
//
//   1. LONGITUDE IS WEST-POSITIVE. A contest-logger convention. The USA reads
//      +91.87 and Japan -138.38; both are the negation of the normal
//      east-positive value. Imported raw, every station lands on the opposite
//      side of the planet — which no test of entity names or counts would catch.
//   2. Six records have a primary prefix beginning with `*`. These are NOT
//      separate DXCC entities — they are regions that share their parent's ADIF
//      number (Sicily and African Italy are both 248, Shetland is Scotland's
//      279). `adif` is the primary key of DxccEntity, so emitting them as
//      entities would collide. Their aliases attach to the parent instead, with
//      their own zone and continent kept as per-prefix overrides — which matters,
//      because African Italy is CQ 33 / AF while mainland Italy is CQ 15 / EU.

import type { CtyEntity, CtyFile, CtyPrefix } from "@/lib/dxcc/parse";

/** Where the Big CTY file lives. No key, no auth. */
export const CTY_CSV_URL = "https://www.country-files.com/bigcty/cty.csv";

interface Overrides {
  cqZone: number | null;
  continent: string | null;
  latitude: number | null;
  longitude: number | null;
}

/**
 * Strip the override markers from an alias and return what they said.
 *
 * cty.csv annotates individual aliases where they differ from their entity:
 *
 *   (n)        CQ zone
 *   [n]        ITU zone — parsed and DISCARDED, see below
 *   <lat/lon>  coordinates
 *   {CC}       continent
 *   ~offset~   GMT offset — not modelled
 *
 * The ITU zone is dropped because `DxccPrefix` has no column for it, and adding
 * one is a schema change beyond the scope of getting entity data loaded. That
 * discards ~11,400 annotations in the current file. Entity-level ITU zone
 * (field 6) is dropped for the same reason. Worth adding later; recorded here so
 * it is a known omission rather than a silent one.
 */
export function parseAlias(
  raw: string,
  base: Overrides,
): { call: string; exact: boolean; overrides: Overrides } | null {
  let s = raw.trim();
  if (!s) return null;

  const out: Overrides = { ...base };

  const cq = /\((\d+)\)/.exec(s);
  if (cq) out.cqZone = Number(cq[1]);

  const cont = /\{([A-Za-z]{2})\}/.exec(s);
  if (cont) out.continent = cont[1]!.toUpperCase();

  const ll = /<([-\d.]+)\/([-\d.]+)>/.exec(s);
  if (ll) {
    const lat = Number(ll[1]);
    const lon = Number(ll[2]);
    if (Number.isFinite(lat)) out.latitude = lat;
    // Same west-positive convention as the entity columns.
    if (Number.isFinite(lon)) out.longitude = -lon;
  }

  // Remove every annotation, then the exact-match marker.
  s = s
    .replace(/\([^)]*\)/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/\{[^}]*\}/g, "")
    .replace(/~[^~]*~/g, "")
    .trim();

  const exact = s.startsWith("=");
  if (exact) s = s.slice(1);
  s = s.trim().toUpperCase();
  if (!s) return null;

  return { call: s, exact, overrides: out };
}

function num(s: string | undefined): number | null {
  if (s === undefined) return null;
  const t = s.trim();
  if (!t) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

/**
 * Parse cty.csv into the same shape `parseCtyXml` produces, so `importCty` and
 * everything downstream is unchanged.
 *
 * Deliberately tolerant: a malformed line is recorded in `problems` and skipped
 * rather than aborting the import. A country file that is 99 % readable is far
 * more useful than none, and the report surfaces what was dropped.
 */
export function parseCtyCsv(input: Buffer | string): CtyFile {
  const text = typeof input === "string" ? input : input.toString("utf8");
  const problems: string[] = [];
  const entities: CtyEntity[] = [];
  const prefixes: CtyPrefix[] = [];
  const exceptions: CtyPrefix[] = [];

  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return { fileDate: null, entities, prefixes, exceptions, problems: ["file is empty"] };
  }

  // Sub-entity records are held back: their parent must exist first, and they
  // must not become entities themselves.
  const deferred: { fields: string[]; primary: string }[] = [];
  const seenAdif = new Set<number>();

  const handleAliases = (
    aliasField: string,
    adif: number,
    entityName: string,
    base: Overrides,
    primaryPrefix: string,
  ): void => {
    const aliases = aliasField.replace(/;\s*$/, "").trim();
    if (!aliases) return;
    for (const tok of aliases.split(/\s+/)) {
      const a = parseAlias(tok, base);
      if (!a) continue;
      const row: CtyPrefix = {
        call: a.call,
        entity: entityName,
        adif,
        cqZone: a.overrides.cqZone,
        continent: a.overrides.continent,
        latitude: a.overrides.latitude,
        longitude: a.overrides.longitude,
        validFrom: null,
        validTo: null,
      };
      // cty.csv carries no validity dates. Club Log's cty.xml does, which is why
      // these are null rather than absent from the type.
      if (a.exact) exceptions.push(row);
      else prefixes.push(row);
    }
    void primaryPrefix;
  };

  for (const line of lines) {
    const fields = line.split(",");
    if (fields.length !== 10) {
      problems.push(`expected 10 fields, got ${fields.length}: ${line.slice(0, 60)}`);
      continue;
    }
    const primary = fields[0]!.trim();
    const adif = num(fields[2]);
    if (adif === null) {
      problems.push(`no ADIF number for ${primary}`);
      continue;
    }

    if (primary.startsWith("*")) {
      deferred.push({ fields, primary });
      continue;
    }

    const name = fields[1]!.trim();
    const base: Overrides = {
      cqZone: num(fields[4]),
      continent: fields[3]!.trim().toUpperCase() || null,
      latitude: num(fields[6]),
      // Negated: cty.csv is west-positive. See the note at the top of this file.
      longitude: (() => {
        const v = num(fields[7]);
        return v === null ? null : -v;
      })(),
    };

    // Aliases of a normal entity inherit from it: a null override means "same as
    // the entity", which is what `toMatch` resolves with `?? entity.x`. Copying
    // the entity's own values into every alias row would store 7,000 redundant
    // overrides and make a genuine override indistinguishable from an inherited
    // value.
    const aliasBase: Overrides = {
      cqZone: null,
      continent: null,
      latitude: null,
      longitude: null,
    };

    if (seenAdif.has(adif)) {
      problems.push(`duplicate ADIF ${adif} (${name}) — keeping the first`);
    } else {
      seenAdif.add(adif);
      entities.push({
        adif,
        name,
        prefix: primary,
        // cty.csv contains only current entities. Club Log's cty.xml also carries
        // DELETED ones, which still count for DXCC on a QSO made before deletion.
        // Nothing here can mark them, so a QSO with e.g. pre-1994 Walvis Bay will
        // not resolve. Recorded in the import report rather than pretended away.
        deleted: false,
        cqZone: base.cqZone,
        continent: base.continent,
        latitude: base.latitude,
        longitude: base.longitude,
        validFrom: null,
        validTo: null,
      });
      // The primary prefix is itself a match, and is not always repeated in the
      // alias list.
      prefixes.push({
        call: primary.toUpperCase(),
        entity: name,
        adif,
        cqZone: null,
        continent: null,
        latitude: null,
        longitude: null,
        validFrom: null,
        validTo: null,
      });
    }

    handleAliases(fields[9]!, adif, name, aliasBase, primary);
  }

  // Sub-entities: aliases only, carrying their own zone/continent as overrides.
  for (const { fields, primary } of deferred) {
    const adif = num(fields[2])!;
    const name = fields[1]!.trim();
    if (!seenAdif.has(adif)) {
      problems.push(`sub-entity ${primary} (${name}) has no parent entity ${adif} — skipped`);
      continue;
    }
    const base: Overrides = {
      cqZone: num(fields[4]),
      continent: fields[3]!.trim().toUpperCase() || null,
      latitude: num(fields[6]),
      longitude: (() => {
        const v = num(fields[7]);
        return v === null ? null : -v;
      })(),
    };
    const bare = primary.replace(/^\*/, "").toUpperCase();
    // A sub-entity prefix like "IT9" is a real prefix to match, but "GM/s" is a
    // notation for "Scottish islands" rather than a callsign prefix — skip
    // anything containing a slash or lower case, which is how that notation is
    // written.
    if (bare && !bare.includes("/")) {
      prefixes.push({
        call: bare,
        entity: name,
        adif,
        cqZone: base.cqZone,
        continent: base.continent,
        latitude: base.latitude,
        longitude: base.longitude,
        validFrom: null,
        validTo: null,
      });
    }
    handleAliases(fields[9]!, adif, name, base, primary);
  }

  // A prefix can arrive twice — a sub-entity's bare prefix is added explicitly
  // and usually also appears in its own alias list. Harmless for lookup, but 300
  // redundant rows, and if the two copies disagreed on overrides the resolver
  // would return whichever the database happened to hand back first.
  return {
    fileDate: null,
    entities,
    prefixes: dedupe(prefixes),
    exceptions: dedupe(exceptions),
    problems,
  };
}

/** Collapse duplicate (call, adif) rows, keeping the one carrying overrides. */
function dedupe(rows: CtyPrefix[]): CtyPrefix[] {
  const informative = (r: CtyPrefix): number =>
    (r.cqZone !== null ? 1 : 0) +
    (r.continent !== null ? 1 : 0) +
    (r.latitude !== null ? 1 : 0) +
    (r.longitude !== null ? 1 : 0);
  const best = new Map<string, CtyPrefix>();
  for (const r of rows) {
    const k = `${r.call}|${r.adif}`;
    const prev = best.get(k);
    if (!prev || informative(r) > informative(prev)) best.set(k, r);
  }
  return [...best.values()];
}

/**
 * Download the Big CTY file.
 *
 * The plain `.csv` is served directly, so no zip handling is needed — the
 * `bigcty.zip` bundle contains the identical file. `/bigcty/cty.csv` rather than
 * `/cty/cty.csv`: the Big variant carries exception callsigns back to 2000, which
 * is what a logbook wants, while the standard file is contest-season only and
 * about a third the size.
 */
export async function fetchCtyCsv(): Promise<Buffer> {
  const res = await fetch(CTY_CSV_URL, {
    headers: { "User-Agent": "DigiShack (amateur radio logbook)" },
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    throw new Error(`country-files.com returned HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  // The real file is ~300 kB. Anything tiny is an error page, not a country file.
  if (buf.length < 50_000) {
    throw new Error(
      `country-files.com returned only ${buf.length} bytes — that is not the country file`,
    );
  }
  return buf;
}
