// Where Hell is on the air in North America: the calling frequencies for each mode, and the
// weekly nets, from hellschreiber.com's frequencies page (November 2026).
//
// Frequencies are the SIGNAL, as published. The Tune buttons put the dial a carrier below
// it, so the receiver and transmitter sit on the published frequency.
//
// The North American nets all run FM Hell-105, fldigi's FSK-Hell-105. Their times are
// published in Eastern time, so they are kept in Eastern time and turned into UTC for the
// week they fall in: a net at 21:00 ET is 01:00 UTC the next day in winter and 02:00 in
// summer, and a fixed UTC time would be wrong for half the year.
//
// The 40 m net's 7.0695 is outside the Region 2 narrow-band segment (7.040-7.047). It is
// listed because it is where the net meets.

import type { HellVariant } from "@/lib/digital/hell";

export interface HellSpot {
  /** Signal frequency, Hz. */
  hz: number;
  band: string;
  variant: HellVariant;
  label: string;
}

export interface HellNet extends HellSpot {
  /** 0 Sunday .. 6 Saturday, in `zone`. */
  weekday: number;
  /** Start, "HH:MM", in `zone`. */
  time: string;
  zone: string;
  /** Who runs it, as published. */
  coordinator: string;
  /** Where it moves when the frequency is busy. */
  altHz?: number;
}

/** Feld Hell's calling frequencies, from the Feld Hell Club. */
export const HELL_CALLING: readonly HellSpot[] = [
  { hz: 3_585_000, band: "80M", variant: "feld", label: "Feld Hell calling" },
  { hz: 7_084_000, band: "40M", variant: "feld", label: "Feld Hell calling" },
  { hz: 10_144_000, band: "30M", variant: "feld", label: "Feld Hell calling" },
  { hz: 14_063_000, band: "20M", variant: "feld", label: "Feld Hell Club calling frequency" },
  { hz: 18_105_000, band: "17M", variant: "feld", label: "Feld Hell calling" },
  { hz: 21_063_000, band: "15M", variant: "feld", label: "Feld Hell calling" },
  { hz: 28_063_000, band: "10M", variant: "feld", label: "Feld Hell calling" },
  { hz: 50_286_000, band: "6M", variant: "feld", label: "Feld Hell calling" },
];

/** The weekly North American nets. */
export const HELL_NETS: readonly HellNet[] = [
  {
    hz: 10_142_500,
    altHz: 10_134_500,
    band: "30M",
    variant: "fm105",
    label: "Wednesday net",
    weekday: 3,
    time: "20:00",
    zone: "America/New_York",
    coordinator: "VA3PC",
  },
  {
    hz: 7_069_500,
    band: "40M",
    variant: "fm105",
    label: "Thursday net",
    weekday: 4,
    time: "21:00",
    zone: "America/New_York",
    coordinator: "VA3PC",
  },
  {
    hz: 3_585_000,
    band: "80M",
    variant: "fm105",
    label: "Friday net",
    weekday: 5,
    time: "21:45",
    zone: "America/New_York",
    coordinator: "KD8WCK",
  },
];

/** The offset of `zone` from UTC at `utcMs`, ms (Eastern in winter: -5 h). */
function zoneOffsetMs(utcMs: number, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** A wall-clock time in `zone` as UTC ms. */
function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, zone: string): number {
  const guess = Date.UTC(y, mo, d, h, mi);
  const first = guess - zoneOffsetMs(guess, zone);
  // Again from the first answer, in case it crossed a daylight-saving change.
  return guess - zoneOffsetMs(first, zone);
}

/**
 * When the net next starts, UTC ms: this week's if it has not started more than an hour ago
 * (so a net in progress still shows as now), otherwise next week's.
 */
export function nextNetStart(net: Pick<HellNet, "weekday" | "time" | "zone">, nowMs: number): number {
  const [h, mi] = net.time.split(":").map(Number) as [number, number];
  // Today's date in the net's zone.
  const local = new Date(nowMs + zoneOffsetMs(nowMs, net.zone));
  for (let add = -1; add <= 7; add++) {
    const day = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + add));
    if (day.getUTCDay() !== net.weekday) continue;
    const at = zonedToUtc(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h, mi, net.zone);
    if (at > nowMs - 3_600_000) return at;
  }
  return NaN;
}

/** The dial for a signal at `hz` with the carrier `centreHz` above the dial. */
export function hellDialFor(hz: number, centreHz: number): number {
  return hz - centreHz;
}
