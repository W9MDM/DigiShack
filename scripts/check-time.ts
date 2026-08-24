/* eslint-disable no-console */
// Every time in DigiShack is UTC. This proves it two ways.
//
// 1. Fixed instants formatted against expected strings. A local-time getter creeping
//    back in fails these on any machine not already set to UTC.
// 2. THE WHOLE SCRIPT RE-RUNS ITSELF under TZ=Pacific/Kiritimati (+14) and compares
//    the output. That is the assertion that does not depend on where it is run: if a
//    formatter ever reads a local getter, +14 moves it across a date boundary and the
//    two runs disagree.
//
// The second one matters because this project is developed on a machine in US
// Central and deployed anywhere. A bug that only appears in one zone is exactly the
// bug that ships.

import { spawnSync } from "node:child_process";

import { assessClock } from "@/lib/digital/clock-offset";

import {
  formatAgo,
  formatDuration,
  formatMinutesAgo,
  formatUtc,
  formatUtcDate,
  formatUtcSeconds,
  formatUtcTime,
  fromUtcInputValue,
  toUtcInputValue,
} from "@/lib/time";

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail = ""): void {
  if (cond) {
    pass++;
    console.log(`  ok    ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
function eq(actual: string, expected: string, label: string): void {
  ok(actual === expected, label, `got "${actual}", want "${expected}"`);
}

// A deliberately awkward instant: late enough in the UTC day that any zone west of
// Greenwich lands on the previous date, and any zone east lands on the next.
const LATE = new Date("2026-07-31T23:42:15.500Z");
const EARLY = new Date("2026-01-01T00:05:00.000Z");

console.log("\nformatting");
{
  eq(formatUtc(LATE), "2026-07-31 23:42Z", "formatUtc");
  eq(formatUtcDate(LATE), "2026-07-31", "formatUtcDate");
  eq(formatUtcTime(LATE), "23:42:15Z", "formatUtcTime");
  eq(formatUtcSeconds(LATE), "2026-07-31 23:42:15Z", "formatUtcSeconds");
  eq(toUtcInputValue(LATE), "2026-07-31T23:42", "toUtcInputValue");

  // Midnight and new year, the other boundary a local getter falls off.
  eq(formatUtc(EARLY), "2026-01-01 00:05Z", "formatUtc across new year");
  eq(formatUtcDate(EARLY), "2026-01-01", "formatUtcDate across new year");
}

console.log("\nevery displayed time is marked as UTC");
{
  // An unmarked timestamp gets read as local by whoever is looking at it. That is the
  // same failure as being local, just slower to notice.
  ok(formatUtc(LATE).endsWith("Z"), "formatUtc carries a Z");
  ok(formatUtcTime(LATE).endsWith("Z"), "formatUtcTime carries a Z");
  ok(formatUtcSeconds(LATE).endsWith("Z"), "formatUtcSeconds carries a Z");
  // The date-only form deliberately does not: "2026-07-31Z" is not a thing, and a
  // date has no time of day to be wrong about.
  ok(!formatUtcDate(LATE).endsWith("Z"), "formatUtcDate does not, correctly");
}

console.log("\naccepts what callers actually hold");
{
  eq(formatUtcTime(LATE.getTime()), "23:42:15Z", "epoch milliseconds");
  eq(formatUtcTime(LATE.toISOString()), "23:42:15Z", "an ISO string");
  eq(formatUtc(null), "—", "null");
  eq(formatUtc(undefined), "—", "undefined");
  eq(formatUtc(""), "—", "empty string");
  eq(formatUtc("not a date"), "—", "junk");
  eq(toUtcInputValue(null), "", "toUtcInputValue(null) is empty, not a dash");
}

console.log("\nthe form round trip");
{
  // The bug this guards: a QSO typed as 19:30 becoming 19:30 LOCAL, which is four
  // hours out and breaks LoTW matching outright.
  const typed = "2026-07-31T19:30";
  const parsed = fromUtcInputValue(typed);
  eq(parsed?.toISOString() ?? "", "2026-07-31T19:30:00.000Z", "typed time is read as UTC");
  eq(toUtcInputValue(parsed), typed, "and comes back unchanged");
  ok(fromUtcInputValue("") === null, "empty input is null");
  ok(fromUtcInputValue("rubbish") === null, "junk is null");
}

console.log("\nelapsed time, one scale everywhere");
{
  const m = 60_000;
  eq(formatDuration(0), "now", "0");
  eq(formatDuration(59_000), "now", "under a minute");
  eq(formatDuration(m), "1m", "one minute");
  eq(formatDuration(59 * m), "59m", "59 minutes");
  eq(formatDuration(60 * m), "1h", "exactly an hour has no stray 0m");
  eq(formatDuration(135 * m), "2h 15m", "hours and minutes");
  eq(formatDuration(24 * 60 * m), "1d", "a day");
  eq(formatDuration(6 * 24 * 60 * m), "6d", "six days");
  eq(formatDuration(14 * 24 * 60 * m), "2w", "two weeks");
  // Clocks between this machine and the services it polls differ by seconds, and
  // "-1m ago" helps nobody.
  eq(formatDuration(-5 * m), "now", "a future instant is not negative");
  eq(formatMinutesAgo(90), "1h 30m", "formatMinutesAgo agrees with formatDuration");
  eq(formatMinutesAgo(null), "—", "formatMinutesAgo(null)");
  eq(formatAgo(Date.now() - 3 * m), "3m", "formatAgo");
  eq(formatAgo(null), "—", "formatAgo(null)");
}

console.log("\nclock offset, judged from other stations");
{
  // A batch of decodes whose DT clusters around zero: our clock agrees with the band.
  const good = [0.1, -0.2, 0.3, 0.0, -0.1, 0.2, 0.1, -0.3, 0.15, 0.05];
  eq(assessClock(good).verdict, "ok", "a clock that agrees with everyone");
  ok(assessClock(good).message === null, "says nothing when there is nothing to say");
}
{
  // Everyone appearing 2.4 s late means we are late, not that the whole band is.
  const late = [2.3, 2.5, 2.4, 2.2, 2.6, 2.4, 2.35, 2.45, 2.5, 2.3];
  const a = assessClock(late);
  eq(a.verdict, "bad", "a clock two seconds out is called bad");
  ok(a.message?.includes("behind") === true, "and says which way to adjust", a.message ?? "");
  ok(
    a.message?.includes("not a band or antenna problem") === true,
    "and rules out what the operator would otherwise spend an hour checking",
  );
}
{
  const early = [-2.3, -2.5, -2.4, -2.2, -2.6, -2.4, -2.35, -2.45, -2.5, -2.3];
  ok(assessClock(early).message?.includes("ahead of") === true, "the other direction too");
}
{
  const drifting = [1.0, 1.1, 0.9, 1.2, 1.0, 1.1, 0.95, 1.05, 1.15, 1.0];
  eq(assessClock(drifting).verdict, "drifting", "a second out is a warning, not a failure");
}
{
  // Two stations agreeing proves nothing — one of them may be the only thing audible
  // and running on a phone.
  eq(assessClock([2.4, 2.5]).verdict, "unknown", "too few decodes is not a measurement");
  eq(assessClock([]).verdict, "unknown", "no decodes at all");
}
{
  // One station with a badly wrong clock must not drag the estimate. This is why it
  // is a median and not a mean: the mean here is 1.5 s and the median is 0.1 s.
  const oneOutlier = [0.1, 0.0, 0.2, -0.1, 0.1, 0.15, -0.05, 0.1, 0.05, 14];
  const a = assessClock(oneOutlier);
  eq(a.verdict, "ok", "one wildly wrong station does not move the verdict");
  eq(String(a.samples), "9", "and the impossible value is dropped from the sample");
}
// ---------------------------------------------------------------------------
// The assertion that does not depend on where this runs.
// ---------------------------------------------------------------------------
if (!process.env.DIGISHACK_TZ_CHILD) {
  console.log("\nindependence from the machine's timezone");

  const run = (tz: string) =>
    spawnSync(process.execPath, [...process.execArgv, process.argv[1]!], {
      env: { ...process.env, TZ: tz, DIGISHACK_TZ_CHILD: "1" },
      encoding: "utf8",
    });

  // +14 and -11: the widest pair in use, 25 hours apart. Any local getter moves a
  // late-evening UTC instant across a date boundary in at least one of them.
  const east = run("Pacific/Kiritimati");
  const west = run("Pacific/Niue");

  if (east.error || west.error) {
    ok(false, "could not re-run under another timezone", String(east.error ?? west.error));
  } else {
    // The `formatAgo` line is relative to now and can legitimately differ; everything
    // else must be byte-identical.
    const strip = (s: string) => s.replace(/^.*formatAgo.*$/gm, "").trim();
    ok(
      strip(east.stdout) === strip(west.stdout),
      "+14 and -11 produce identical output",
      "the formatters are reading a local getter",
    );
    ok(east.status === 0 && west.status === 0, "and both runs pass their own assertions");
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
