// Every time in this application, everywhere, is UTC.
//
// Amateur radio runs on UTC and nothing else. A log with a local timestamp does not
// match LoTW, does not match the other operator's log, and cannot be compared with
// anything. `<input type="datetime-local">` works in the browser's local zone, so
// every conversion between the two has to be explicit — otherwise a QSO logged at
// 19:30 EDT silently becomes 19:30Z and the log is four hours wrong.
//
// THIS FILE IS THE ONLY PLACE THAT FORMATS A TIME. Not a style preference: the
// application had grown ten different ways of showing one, three of them duplicates
// of each other with different rounding, and one `toLocaleString()` that rendered in
// whatever zone the browser happened to be in. On a machine already set to UTC that
// last bug is completely invisible.
//
// Two rules follow, both enforced by scripts/check-time.ts:
//
//   1. Every function here reads `getUTC*` and never a local getter, so output never
//      depends on the machine. The check re-runs itself under a +14 zone and compares,
//      because "we were careful" is not a test.
//   2. Every rendered time carries a UTC marker — a trailing Z, or the word. An
//      unmarked timestamp gets read as local by whoever is looking at it, which is the
//      same failure as actually being local, only slower to discover.

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Anything that identifies an instant, as a Date — or null if it does not.
 *
 * Epoch milliseconds are accepted because that is what the decode grouping and the
 * window scheduler carry, and making every caller wrap them by hand is how a stray
 * `new Date()` ends up somewhere it should not be.
 */
function asDate(v: Date | string | number | null | undefined): Date | null {
  if (v === null || v === undefined || v === "") return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Date -> "YYYY-MM-DDTHH:mm" using the date's UTC parts. */
export function toUtcInputValue(date: Date | string | number | null | undefined): string {
  const d = asDate(date);
  if (!d) return "";
  return (
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}` +
    `T${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`
  );
}

/** "YYYY-MM-DDTHH:mm" typed by the operator, interpreted as UTC. */
export function fromUtcInputValue(value: string): Date | null {
  if (!value) return null;
  // Appending Z is what forces UTC interpretation instead of local.
  const withSeconds = value.length === 16 ? `${value}:00` : value;
  const d = new Date(`${withSeconds}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function utcNowInputValue(): string {
  return toUtcInputValue(new Date());
}

/** Compact log display: "2026-07-31 19:42Z". */
export function formatUtc(date: Date | string | number | null | undefined): string {
  const d = asDate(date);
  if (!d) return "—";
  return `${toUtcInputValue(d).replace("T", " ")}Z`;
}

/** Date only, for grouping rows: "2026-07-31". */
export function formatUtcDate(date: Date | string | number | null | undefined): string {
  const d = asDate(date);
  if (!d) return "—";
  return toUtcInputValue(d).slice(0, 10);
}

/**
 * Time of day to the second: "19:42:15Z".
 *
 * For decode lists and anywhere the date is already established by context. The Z is
 * not decoration — an unmarked "19:42:15" is read as local by everyone who sees it.
 */
export function formatUtcTime(date: Date | string | number | null | undefined): string {
  const d = asDate(date);
  if (!d) return "—";
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}Z`;
}

/** Full timestamp to the second: "2026-07-31 19:42:15Z". */
export function formatUtcSeconds(date: Date | string | number | null | undefined): string {
  const d = asDate(date);
  if (!d) return "—";
  return `${formatUtcDate(d)} ${formatUtcTime(d)}`;
}

/**
 * How long ago, compactly: "now", "3m", "2h 15m", "4d", "3w".
 *
 * Elapsed time needs no zone — it is a difference between two instants — but it was
 * being computed three separate times with three different rounding rules, so the same
 * five-minute-old spot read as "5m" on one page and "now" on another.
 */
export function formatAgo(date: Date | string | number | null | undefined): string {
  const d = asDate(date);
  if (!d) return "—";
  return formatDuration(Date.now() - d.getTime());
}

/**
 * The same scale as `formatAgo`, for a duration already in milliseconds.
 *
 * A negative duration reads as "now" rather than as a negative: this machine's clock
 * and the services it talks to differ by seconds, and "-1m ago" helps nobody.
 */
export function formatDuration(elapsedMs: number): string {
  const mins = Math.floor(Math.max(0, elapsedMs) / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    const rem = mins % 60;
    return rem === 0 ? `${hours}h` : `${hours}h ${rem}m`;
  }
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days}d` : `${Math.floor(days / 7)}w`;
}

/** `formatDuration` for a value already counted in minutes. */
export function formatMinutesAgo(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return "—";
  return formatDuration(minutes * 60_000);
}
