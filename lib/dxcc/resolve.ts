import { prisma } from "@/lib/db/prisma";

// Callsign -> DXCC entity resolution.
//
// This is deliberately not a plain prefix table lookup, because that gets real
// callsigns wrong:
//
//   * K/W/N/AA-AL are the USA (291), but KH6 is Hawaii (110), KL7 Alaska (6) and
//     KP4 Puerto Rico (202) — distinct entities with their own award credit.
//   * A portable indicator overrides the base call: VP2E/K9XYZ is Anguilla, and
//     K9XYZ/KH6 is Hawaii.
//   * cty.xml carries whole-callsign exceptions that exist precisely to
//     contradict the prefix they appear to have.
//   * Entities are added and deleted over time, so a 1993 QSO resolves against
//     what was valid then, not what is valid now.
//
// Order of precedence: whole-callsign exception, then longest prefix match,
// each filtered by validity at the QSO date.

export interface DxccMatch {
  adif: number;
  name: string;
  prefix: string;
  deleted: boolean;
  cqZone: number | null;
  continent: string | null;
  latitude: number | null;
  longitude: number | null;
  /** Which rule matched, and on which token. */
  matchedOn: string;
  source: "exception" | "prefix";
}

export type DxccResult =
  | { status: "found"; match: DxccMatch }
  | { status: "not-found"; reason: string }
  | { status: "no-entity"; reason: string }
  | { status: "no-data"; reason: string };

/**
 * Suffixes that do not change the DXCC entity. `/P`ortable, `/M`obile, QRP and
 * the like are operating notes, not locations.
 *
 * MM (maritime mobile) and AM (aeronautical mobile) are handled separately: they
 * mean the operator is outside every DXCC entity, which is a different answer
 * from "unknown".
 */
const NEUTRAL_MODIFIERS = new Set([
  "P",
  "M",
  "QRP",
  "A",
  "LH",
  "LGT",
  "J",
  "B",
  "N",
  "E",
  "R",
  "T",
]);

const NO_ENTITY_MODIFIERS = new Set(["MM", "AM"]);

export function isCallsignShaped(token: string): boolean {
  return /^[A-Z0-9]+$/.test(token);
}

/**
 * Candidate location tokens from a callsign, best-first.
 *
 * "Best" cannot be decided here — it depends on what the prefix table actually
 * contains — so all plausible tokens are returned and the caller scores them by
 * matched-prefix length.
 */
export function candidateTokens(callsign: string): {
  tokens: string[];
  noEntity: boolean;
} {
  const upper = callsign.trim().toUpperCase();
  const parts = upper.split("/").filter((p) => p.length > 0);

  if (parts.length === 0) return { tokens: [], noEntity: false };

  // /MM and /AM put the operator outside every entity — but only as a SUFFIX.
  //
  // The check used to be position-blind, and MM is also Scotland's prefix, so
  // MM/DL1ABC was reported as "maritime mobile, outside every DXCC entity" when it
  // is a German operator in Scotland. Maritime and aeronautical mobile are always
  // written after the callsign (DL1ABC/MM), so index 0 is never one of them.
  if (parts.slice(1).some((p) => NO_ENTITY_MODIFIERS.has(p))) {
    return { tokens: [], noEntity: true };
  }

  // Neutral modifiers are stripped only where they can BE modifiers: after the
  // callsign.
  //
  // Eight of them are single letters that are also entity prefixes — M and A are
  // England, J is Japan, B is China, N and W are the USA, E is Spain, R is Russia,
  // T is Turkey. Stripping them position-blind meant M/DL1ABC lost its "M" and
  // resolved to GERMANY, when the prefix is the entire reason the operator wrote
  // it. Position matters and the convention is unambiguous: DL1ABC/M is mobile,
  // M/DL1ABC is a German in England.
  const meaningful = parts.filter(
    (p, i) =>
      (i === 0 || !NEUTRAL_MODIFIERS.has(p)) &&
      // A bare digit is a region indicator within an entity, not a location.
      !/^\d$/.test(p) &&
      isCallsignShaped(p),
  );

  // Everything was a modifier — fall back to the parts as given.
  return {
    tokens: meaningful.length > 0 ? meaningful : parts.filter(isCallsignShaped),
    noEntity: false,
  };
}

function validAt(
  row: { validFrom: Date | null; validTo: Date | null },
  when: Date,
): boolean {
  if (row.validFrom && when < row.validFrom) return false;
  if (row.validTo && when > row.validTo) return false;
  return true;
}

/** Longest-first prefixes of a token, so the DB scan is bounded and ordered. */
function prefixesOf(token: string): string[] {
  const out: string[] = [];
  for (let len = token.length; len >= 1; len--) {
    out.push(token.slice(0, len));
  }
  return out;
}

export async function isDxccDataLoaded(): Promise<boolean> {
  const row = await prisma.setting.findUnique({
    where: { key: "dxcc.importedAt" },
    select: { value: true },
  });
  if (!row?.value) return false;
  return (await prisma.dxccEntity.count()) > 0;
}

/**
 * Resolve a callsign. `when` is the QSO date — pass it so historical contacts
 * resolve against the entity that existed at the time.
 */
/**
 * Pick the best prefix match for a set of candidate tokens.
 *
 * Pure, and exported so the tests exercise the real thing rather than a copy.
 *
 * Tokens are tried SHORTEST FIRST and the first that matches anything wins. In a
 * portable callsign the location is the bare prefix, and a bare prefix is shorter
 * than the full home callsign attached to it:
 *
 *   F/K9XYZ      -> F     (1) not K9XYZ  -> France, not the USA
 *   P4/W9DEF      -> P4    (2) not W9DEF   -> Aruba, not the USA
 *   VP2E/K9XYZ   -> VP2E  (4) not K9XYZ  -> Anguilla
 *   K9XYZ/VP2E   -> VP2E  (4) not K9XYZ  -> Anguilla, whichever side it sits on
 *
 * An earlier version scored purely by MATCHED PREFIX length, with token length
 * only as a tie-break. Its comment claimed that resolved F/K9XYZ to France, but it
 * never did: "W9" matches two characters and "F" only one, so it was not a tie and
 * the home call won. Checked against this log's stored ADIF values it put
 * FG/HB9JAB and P4/W9DEF in the wrong entity. The length of the matched prefix is
 * the wrong signal; which PART of the callsign states the location is the right
 * one.
 */
export function choosePrefixMatch<
  R extends { call: string; validFrom: Date | null; validTo: Date | null },
>(
  tokens: string[],
  rows: R[],
  when: Date,
): { row: R; matched: string; token: string } | null {
  const ordered = [...tokens].sort((a, b) => a.length - b.length);

  for (const token of ordered) {
    const wanted = new Set(prefixesOf(token));
    // Within one token the longest matching prefix is the most specific.
    let inToken: R | null = null;
    for (const row of rows) {
      if (!wanted.has(row.call)) continue;
      if (!validAt(row, when)) continue;
      if (inToken === null || row.call.length > inToken.call.length) inToken = row;
    }
    if (inToken) return { row: inToken, matched: inToken.call, token };
  }
  return null;
}

export async function resolveDxcc(
  callsign: string,
  when: Date = new Date(),
): Promise<DxccResult> {
  if (!(await isDxccDataLoaded())) {
    return {
      status: "no-data",
      reason:
        "No DXCC data loaded. An admin can fetch or upload Club Log's cty.xml from the DXCC page.",
    };
  }

  const { tokens, noEntity } = candidateTokens(callsign);

  if (noEntity) {
    return {
      status: "no-entity",
      reason:
        "Maritime or aeronautical mobile — outside every DXCC entity, so no entity applies.",
    };
  }

  if (tokens.length === 0) {
    return { status: "not-found", reason: "Not a usable callsign" };
  }

  const whole = callsign.trim().toUpperCase();

  // 1. Whole-callsign exceptions. Checked against the full callsign and each
  //    token, because cty.xml lists both bare calls and portable forms.
  const exceptionCandidates = [whole, ...tokens];
  const exceptions = await prisma.dxccPrefix.findMany({
    where: { exact: true, call: { in: exceptionCandidates } },
    include: { entity: true },
  });

  const exception = exceptions
    .filter((e) => validAt(e, when))
    // Prefer a match on the complete callsign over one on a token.
    .sort((a, b) => {
      const aWhole = a.call === whole ? 1 : 0;
      const bWhole = b.call === whole ? 1 : 0;
      if (aWhole !== bWhole) return bWhole - aWhole;
      return b.call.length - a.call.length;
    })[0];

  if (exception) {
    return { status: "found", match: toMatch(exception, "exception") };
  }

  // 1b. The KG4 rule — a special case no country file can express.
  //
  // cty.csv lists bare `KG4` as a Guantanamo Bay prefix and enumerates the US
  // KG4 calls it happens to know as whole-callsign exceptions. It cannot state
  // the actual rule, which is about LENGTH: KG4 plus exactly TWO characters is
  // Guantanamo Bay; KG4 plus any other number of characters is an ordinary United
  // States call.
  //
  // Every KG4 entry in the file agrees. Guantanamo's exceptions are KG4AC,
  // KG4AS, KG4AW, KG4AY, KG4BP, KG4DY; the USA's are KG1ABC, KG4GYO, KG4MLB,
  // KG4NEX, KG4NIY, KG4WAH.
  //
  // Without this, any six-character KG4 call absent from the file resolves to
  // Guantanamo Bay. Measured on this log that was 14 QSOs — KG4OJT, KG4TRI,
  // KG4GSY, KG4IXS, KG4VUK, KG4F and others — each wrongly credited a rare entity
  // that would then show as worked on the DXCC page. Checked after the exception
  // table so a call the file names explicitly still wins.
  //
  // Tested against every candidate TOKEN, not the raw callsign.
  //
  // The first version matched /^KG4([A-Z0-9]+)$/ against `whole`, and the class
  // excludes "/" — so KG4OJT/P failed the test entirely, fell through to the prefix
  // table and resolved to Guantanamo Bay. Any modifier at all defeated the rule the
  // whole thing exists for.
  const kg4Token = tokens.find((t) => /^KG4[A-Z0-9]+$/.test(t));
  const kg4 = kg4Token ? /^KG4([A-Z0-9]+)$/.exec(kg4Token) : null;
  if (kg4 && kg4[1]!.length !== 2) {
    const usa = await prisma.dxccPrefix.findFirst({
      where: { exact: false, adif: 291 },
      include: { entity: true },
    });
    if (usa) {
      return {
        status: "found",
        match: toMatch(usa, "prefix", `KG4+${kg4[1]!.length} (KG4 rule)`),
      };
    }
  }

  // 2. Longest prefix match across every candidate token.
  //
  // One query for every candidate prefix of every token, then the scoring runs in
  // memory via `choosePrefixMatch` — the SAME function scripts/check-dxcc.ts
  // calls. That matters: the test used to reimplement this scoring, so it happily
  // asserted "F/K9XYZ -> France" while the resolver returned the USA. A test that
  // reimplements what it tests only ever validates its own copy.
  const allCandidates = [...new Set(tokens.flatMap((t) => prefixesOf(t)))];
  const rows = await prisma.dxccPrefix.findMany({
    where: { exact: false, call: { in: allCandidates } },
    include: { entity: true },
  });

  const best = choosePrefixMatch(tokens, rows, when);

  if (!best) {
    return {
      status: "not-found",
      reason: `No DXCC entity matches ${whole}`,
    };
  }

  return {
    status: "found",
    match: toMatch(best.row, "prefix", best.matched),
  };
}

type PrefixRow = {
  call: string;
  cqZone: number | null;
  continent: string | null;
  latitude: number | null;
  longitude: number | null;
  adif: number;
  entity: {
    adif: number;
    name: string;
    prefix: string;
    deleted: boolean;
    cqZone: number | null;
    continent: string | null;
    latitude: number | null;
    longitude: number | null;
  };
};

function toMatch(
  row: PrefixRow,
  source: "exception" | "prefix",
  matchedOn = row.call,
): DxccMatch {
  return {
    adif: row.entity.adif,
    name: row.entity.name,
    prefix: row.entity.prefix,
    deleted: row.entity.deleted,
    // A prefix record may override the entity's zone/continent.
    cqZone: row.cqZone ?? row.entity.cqZone,
    continent: row.continent ?? row.entity.continent,
    latitude: row.latitude ?? row.entity.latitude,
    longitude: row.longitude ?? row.entity.longitude,
    matchedOn,
    source,
  };
}
