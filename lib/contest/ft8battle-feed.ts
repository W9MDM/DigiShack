// Reading what FT8 Battle Royale publishes, and what it tells BR mode.
//
// WHAT THE SITE PUBLISHES. Its front end is fed by plain JSON files, the same ones the
// "QSO Activity Ticker" overlay polls every ten seconds:
//
//   data/activity.json      the last FIFTY events - a qso, a steal, or a duplicate penalty -
//                           with the player, the station worked, the band, the points and a
//                           breakdown of how they were arrived at. About an hour at today's
//                           rate, and no mode field: the mode is only in the breakdown text.
//   steal-predictor.php     embeds `recentContacts`, the last couple of hours of contacts
//                           WITH the mode and the player who currently holds each one, but
//                           without the points. Rendered server-side as a JS literal.
//
// Neither goes further back, so the bridge polls the first, seeds from the second at start,
// and keeps the result in the database (Ft8brActivity) - see ft8battle-tracker.ts. This
// file is the pure part: parsing, and turning events into what the score needs to know.
//
// THE RULES THAT MAKE THE FEED WORTH READING, from ft8battle.com/rules.php:
//
//   * First Contact (+4) goes to the FIRST player to work a station on a BAND today. So a
//     station already in the feed on our band cannot be a first contact for us: the range
//     the scorer reports collapses to its floor.
//   * "Last person to work the same station on the same band AND mode on the same day gets
//     ALL the points!" A steal takes what the holder earned - base, bonuses, multipliers -
//     and chain steals pay out the accumulated total. The feed shows the holder's points,
//     so a steal is worth exactly that plus our own base.
//   * Working a station WE already hold again is a duplicate (minus twice), not a steal.
//     Our own log answers that; this file only names the holder.
//   * A duplicate penalty does not move a holding: the station is still held by whoever
//     held it before the offender worked them twice.
//
// WHAT IT STILL CANNOT KNOW. Events older than the window, and contacts the predictor list
// shows without points (seeded rows): for those the held value is a range from "base only"
// to "base plus First Contact" at that band and mode, Happy Hour unknown. Said as a range,
// not guessed.
//
// READ-ONLY, and the same data every visitor's browser already pulls. Nothing here calls
// anybody: BR mode ranks the screen and the operator decides, which is the only arrangement
// inside their rules - automated operation is a permanent ban.

import { BASE_POINTS, FIRST_CONTACT_BONUS } from "@/lib/contest/ft8battle";

export type FeedEventType = "qso" | "steal" | "penalty";
export type FeedSource = "activity" | "predictor";

export interface FeedEvent {
  /** When FT8BR recorded it. Their timestamps are UTC. */
  at: Date;
  type: FeedEventType;
  /** The player who made the contact. */
  station: string;
  /** The station they worked. */
  contact: string;
  /** DigiShack spelling: "20M". */
  band: string;
  /** FT8 | FT4 | FT2. */
  mode: string;
  /** What the player earned, stolen points included. Null when the source did not say. */
  points: number | null;
  /** On a steal, who lost the points. */
  victim: string | null;
  /** On a steal, how much of `points` came from the victim. */
  stolen: number | null;
  /** FT8BR awarded the First Contact bonus for it. */
  first: boolean;
  source: FeedSource;
}

/** The feed as the page receives it: dates as ISO strings. */
export interface FeedEventJson extends Omit<FeedEvent, "at"> {
  at: string;
}

/** Who holds a station on a band and mode today, and what they hold. */
export interface Claim {
  contact: string;
  band: string;
  mode: string;
  holder: string;
  /** Points the holder has for it, or null when only the holder is known. */
  points: number | null;
  at: Date;
}

export interface ClaimJson extends Omit<Claim, "at"> {
  at: string;
}

/** What /api/contest/ft8battle answers. */
export interface Ft8brFeedResponse {
  activity: FeedEventJson[];
  claims: ClaimJson[];
  /** "CONTACT|BAND" for every station somebody worked on that band today. */
  claimedBands: string[];
  updatedAt: string;
}

/** "2026-10-14 15:25:08" is UTC. Null for anything that is not that shape. */
export function parseFeedTimestamp(raw: unknown): Date | null {
  if (typeof raw !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(raw.trim());
  if (!m) return null;
  const d = new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])),
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "20m" -> "20M", which is how every band in this project is spelled. */
export function normaliseBand(raw: unknown): string {
  return String(raw ?? "").trim().toUpperCase();
}

/**
 * The mode, from the breakdown text - the feed carries no mode field.
 *
 * FT4 and FT2 earn a line ("Mode multiplier (FT4): x2"); FT8 is the 1x baseline and earns
 * nothing, so its absence is the signal. A breakdown with no multiplier line is FT8.
 */
export function modeFromBreakdown(breakdown: unknown): string {
  if (!Array.isArray(breakdown)) return "FT8";
  for (const line of breakdown) {
    const m = /Mode multiplier \((FT\d)\)/i.exec(String(line));
    if (m) return m[1]!.toUpperCase();
  }
  return "FT8";
}

const callsign = (raw: unknown): string => String(raw ?? "").trim().toUpperCase();

/**
 * The activity feed, as events. Anything malformed is skipped rather than thrown: the feed
 * is somebody else's file and a bad entry in it must not stop the good ones.
 */
export function parseActivityJson(text: string): FeedEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const list = (parsed as { activities?: unknown })?.activities;
  if (!Array.isArray(list)) return [];

  const out: FeedEvent[] = [];
  for (const a of list as Record<string, unknown>[]) {
    const at = parseFeedTimestamp(a.timestamp);
    const station = callsign(a.station);
    const contact = callsign(a.contact);
    const band = normaliseBand(a.band);
    if (!at || !station || !contact || !band) continue;
    const points = typeof a.points === "number" && Number.isFinite(a.points) ? a.points : null;
    const breakdown = Array.isArray(a.breakdown) ? a.breakdown.map(String) : [];
    const type: FeedEventType =
      a.activity_type === "steal" ? "steal" : points !== null && points < 0 ? "penalty" : "qso";
    out.push({
      at,
      type,
      station,
      contact,
      band,
      mode: modeFromBreakdown(breakdown),
      points,
      victim: type === "steal" ? callsign(a.victim) || null : null,
      stolen:
        type === "steal" && typeof a.stolen_points === "number" ? a.stolen_points : null,
      first:
        a.reason === "first_contact" || breakdown.some((l) => /first contact bonus/i.test(l)),
      source: "activity",
    });
  }
  return out;
}

/**
 * The JSON literal assigned to `const <name> = ` in a page, or null.
 *
 * A real scanner rather than a regex to the next `];`: the literal is JSON, and a string
 * inside it could contain a bracket. Tracks string state and escapes so it cannot be fooled.
 */
export function extractJsLiteral(html: string, name: string): unknown {
  const marker = `const ${name} = `;
  const start = html.indexOf(marker);
  if (start < 0) return null;
  let i = start + marker.length;
  while (i < html.length && /\s/.test(html[i]!)) i++;
  const open = html[i];
  if (open !== "[" && open !== "{") return null;
  let depth = 0;
  let inString = false;
  for (let j = i; j < html.length; j++) {
    const c = html[j]!;
    if (inString) {
      if (c === "\\") j++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(i, j + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * The steal predictor's embedded `recentContacts`, as events without points.
 *
 * Each entry is the LATEST contact with a station on a band and mode and who made it -
 * exactly a holding - so it becomes a qso event by that player at that time. Points are
 * unknown here, which `stealEstimate` turns into a range.
 */
export function parsePredictorHtml(html: string): FeedEvent[] {
  const list = extractJsLiteral(html, "recentContacts");
  if (!Array.isArray(list)) return [];
  const out: FeedEvent[] = [];
  for (const r of list as Record<string, unknown>[]) {
    const at = parseFeedTimestamp(r.last_worked);
    const station = callsign(r.worked_by);
    const contact = callsign(r.contact);
    const band = normaliseBand(r.band);
    const mode = String(r.mode ?? "FT8").trim().toUpperCase() || "FT8";
    if (!at || !station || !contact || !band) continue;
    out.push({
      at,
      type: "qso",
      station,
      contact,
      band,
      mode,
      points: null,
      victim: null,
      stolen: null,
      first: false,
      source: "predictor",
    });
  }
  return out;
}

export function claimKey(contact: string, band: string, mode: string): string {
  return `${contact.toUpperCase()}|${band.toUpperCase()}|${mode.toUpperCase()}`;
}

export function bandKey(contact: string, band: string): string {
  return `${contact.toUpperCase()}|${band.toUpperCase()}`;
}

/** The UTC day FT8BR scores by: points reset at midnight UTC. */
export function sameUtcDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

/**
 * Who holds what today.
 *
 * Replayed oldest first, so the LAST worker on a band and mode is the holder - their rule,
 * verbatim. A duplicate penalty marks the band as claimed (somebody worked them) but moves
 * nothing: the holding stays with whoever had it. When two sources describe the same
 * moment, the one with points wins, because the predictor never has them and the feed
 * always does.
 */
export function deriveClaims(
  events: FeedEvent[],
  day: Date,
): { claims: Map<string, Claim>; claimedBands: Set<string> } {
  const claims = new Map<string, Claim>();
  const claimedBands = new Set<string>();
  const today = events.filter((e) => sameUtcDay(e.at, day)).sort((a, b) => a.at.getTime() - b.at.getTime());
  for (const e of today) {
    claimedBands.add(bandKey(e.contact, e.band));
    if (e.type === "penalty") continue;
    const key = claimKey(e.contact, e.band, e.mode);
    const prev = claims.get(key);
    if (prev && prev.at.getTime() === e.at.getTime() && prev.points !== null && e.points === null) {
      continue;
    }
    claims.set(key, {
      contact: e.contact,
      band: e.band,
      mode: e.mode,
      holder: e.station,
      points: e.points,
      at: e.at,
    });
  }
  return { claims, claimedBands };
}

/** The multipliers their rules attach to a band and mode, Happy Hour excluded. */
function heldMultiplier(band: string, mode: string): number {
  const b = band.toUpperCase();
  const m = mode.toUpperCase();
  return (b === "6M" || b === "10M" ? 1.5 : 1) * (m === "FT4" || m === "FT2" ? 2 : 1);
}

/**
 * What a steal of this holding is worth to us, on top of our own base.
 *
 * Known points are exact: their rule hands over what the holder earned, and the feed says
 * what that was. A holding seeded from the predictor has no points, so it is a range from
 * base alone to base plus First Contact at that band and mode - Happy Hour at the time they
 * worked it is unknown and left out, so the top of the range can be low, never high.
 */
export function stealEstimate(claim: Pick<Claim, "band" | "mode" | "points">): {
  min: number;
  max: number;
} {
  if (claim.points !== null && claim.points > 0) return { min: claim.points, max: claim.points };
  const mult = heldMultiplier(claim.band, claim.mode);
  return {
    min: Math.round(BASE_POINTS * mult),
    max: Math.round((BASE_POINTS + FIRST_CONTACT_BONUS) * mult),
  };
}

export function serializeEvent(e: FeedEvent): FeedEventJson {
  return { ...e, at: e.at.toISOString() };
}

export function serializeClaim(c: Claim): ClaimJson {
  return { ...c, at: c.at.toISOString() };
}
