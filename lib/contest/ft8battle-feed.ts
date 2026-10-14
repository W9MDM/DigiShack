
import { BASE_POINTS, FIRST_CONTACT_BONUS } from "@/lib/contest/ft8battle";

export type FeedEventType = "qso" | "steal" | "penalty";
export type FeedSource = "activity" | "predictor";

export interface FeedEvent {
  at: Date;
  type: FeedEventType;
  station: string;
  contact: string;
  band: string;
  mode: string;
  points: number | null;
  victim: string | null;
  stolen: number | null;
  first: boolean;
  source: FeedSource;
}

export interface FeedEventJson extends Omit<FeedEvent, "at"> {
  at: string;
}

export interface Claim {
  contact: string;
  band: string;
  mode: string;
  holder: string;
  points: number | null;
  at: Date;
}

export interface ClaimJson extends Omit<Claim, "at"> {
  at: string;
}

export interface Ft8brFeedResponse {
  activity: FeedEventJson[];
  claims: ClaimJson[];
  claimedBands: string[];
  updatedAt: string;
}

export function parseFeedTimestamp(raw: unknown): Date | null {
  if (typeof raw !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(raw.trim());
  if (!m) return null;
  const d = new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])),
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

export function normaliseBand(raw: unknown): string {
  return String(raw ?? "").trim().toUpperCase();
}

export function modeFromBreakdown(breakdown: unknown): string {
  if (!Array.isArray(breakdown)) return "FT8";
  for (const line of breakdown) {
    const m = /Mode multiplier \((FT\d)\)/i.exec(String(line));
    if (m) return m[1]!.toUpperCase();
  }
  return "FT8";
}

const callsign = (raw: unknown): string => String(raw ?? "").trim().toUpperCase();

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

export function sameUtcDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

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

function heldMultiplier(band: string, mode: string): number {
  const b = band.toUpperCase();
  const m = mode.toUpperCase();
  return (b === "6M" || b === "10M" ? 1.5 : 1) * (m === "FT4" || m === "FT2" ? 2 : 1);
}

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
