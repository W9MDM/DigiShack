// Clocks for the Tools page: UTC, the browser's own zone, and a few named ones.
//
// lib/time.ts is the only place that formats a time for the LOG, and it formats UTC only,
// so UTC here goes through it. What this adds is wall-clock time in an explicitly NAMED
// zone — "what time is it in Tokyo" — which is never written to a contact and is always
// shown beside the zone's name. Nothing here reads a local getter: the zone is always
// passed in, so the output does not depend on the machine it runs on.

import { formatUtcDate, formatUtcTime } from "@/lib/time";

/** Where the DX is, more or less, for a station in North America. Editable on the page. */
export const DEFAULT_ZONES: readonly string[] = [
  "America/New_York",
  "America/Los_Angeles",
  "Europe/London",
  "Asia/Tokyo",
  "Australia/Sydney",
];

const DAY_MS = 86_400_000;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Day of the UTC year: 1 January is day 1. */
export function dayOfYear(d: Date): number {
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.round((today - start) / DAY_MS) + 1;
}

export function daysInYear(year: number): number {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 366 : 365;
}

export interface UtcNow {
  /** "18:42:15Z" */
  time: string;
  /** ISO date, "2026-10-19". */
  date: string;
  dayOfYear: number;
  daysInYear: number;
  weekday: string;
}

export function utcNow(d: Date): UtcNow {
  return {
    time: formatUtcTime(d),
    date: formatUtcDate(d),
    dayOfYear: dayOfYear(d),
    daysInYear: daysInYear(d.getUTCFullYear()),
    weekday: WEEKDAYS[d.getUTCDay()] ?? "",
  };
}

export interface ZoneTime {
  zone: string;
  /** "New York" — the last part of the zone name. */
  place: string;
  /** "08:42:15" */
  time: string;
  /** "2026-08-01" */
  date: string;
  /** Minutes east of UTC at this instant, daylight saving included. */
  offsetMinutes: number;
  /** "UTC+9", "UTC−5", "UTC+5:30" */
  offsetLabel: string;
  /** "CDT" where the zone has a common abbreviation in English, else null. */
  abbreviation: string | null;
  /** The zone's calendar date against UTC's: -1, 0 or +1. */
  dayShift: number;
}

const FORMATTERS = new Map<string, Intl.DateTimeFormat | null>();

function formatterFor(zone: string): Intl.DateTimeFormat | null {
  const cached = FORMATTERS.get(zone);
  if (cached !== undefined) return cached;
  let f: Intl.DateTimeFormat | null;
  try {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "short",
    });
  } catch {
    // RangeError: not a zone this browser knows.
    f = null;
  }
  FORMATTERS.set(zone, f);
  return f;
}

export function isValidZone(zone: string): boolean {
  const z = zone.trim();
  return z !== "" && formatterFor(z) !== null;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

export function offsetLabel(minutes: number): string {
  if (minutes === 0) return "UTC";
  const sign = minutes > 0 ? "+" : "−";
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${sign}${h}${m ? `:${pad2(m)}` : ""}`;
}

export function placeName(zone: string): string {
  return (zone.split("/").pop() ?? zone).replace(/_/g, " ");
}

/** The time in a named IANA zone, or null if the zone is not one. */
export function zoneTime(d: Date, zone: string): ZoneTime | null {
  const f = formatterFor(zone);
  if (!f || !Number.isFinite(d.getTime())) return null;
  const parts = f.formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value ?? Number.NaN);
  // Through Date.UTC rather than read straight off the parts: an engine that ignores
  // hourCycle says "24" at midnight, and Date.UTC rolls that into the next day correctly.
  const wallMs = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  if (!Number.isFinite(wallMs)) return null;
  const wall = new Date(wallMs);
  const offsetMinutes = Math.round((wallMs - Math.floor(d.getTime() / 1000) * 1000) / 60_000);
  const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  const zoneDay = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate());
  const utcDay = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return {
    zone,
    place: placeName(zone),
    time: `${pad2(wall.getUTCHours())}:${pad2(wall.getUTCMinutes())}:${pad2(wall.getUTCSeconds())}`,
    date: formatUtcDate(wall),
    offsetMinutes,
    offsetLabel: offsetLabel(offsetMinutes),
    // "GMT+9" is the locale admitting it has no name for the zone; the offset says it better.
    abbreviation: /^[A-Z]{2,5}$/.test(name) ? name : null,
    dayShift: Math.round((zoneDay - utcDay) / DAY_MS),
  };
}

/** The zone this browser is set to, or UTC if it will not say. */
export function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Every zone this browser knows, for a picker. Empty where the API is missing. */
export function knownZones(): string[] {
  try {
    return typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  } catch {
    return [];
  }
}
