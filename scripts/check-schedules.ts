/* eslint-disable no-console */
// The schedules page must describe the timers that actually exist.
//
// `lib/schedule/jobs.ts` is a DESCRIPTION of work scheduled elsewhere — the timers stay in
// the bridge, where they are used. That buys a settings page without rewriting the bridge,
// and it buys a way to be wrong: a timer added or an interval renamed leaves the page stating
// a cadence nothing runs at. A schedules page that quietly lies is worse than none, because
// the reason to look at one is to stop reading the source.
//
// So: every `setInterval` in the bridge is either listed or explicitly excluded by name, and
// every setting the list names is really in the registry with the default the list claims.

import { readFileSync } from "node:fs";

import { JOBS, cronish, resolveJob, resolveJobs } from "@/lib/schedule/jobs";
import { SETTINGS } from "@/lib/settings/registry";

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string): void {
  if (cond) {
    pass++;
    console.log(`  ok    ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}`);
  }
}
function eq(got: unknown, want: unknown, label: string): void {
  const good = got === want;
  if (!good) console.log(`        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);
  ok(good, label);
}

/**
 * The interval argument of every `setInterval` in a file.
 *
 * A balanced-paren scan to the LAST top-level comma, not a regex. A regex was tried and
 * reported `intervalMinutes`, `autoQslMinutes`, `lotwMinutes` and `mins` as unaccounted-for
 * timers — it was matching fragments from inside `Math.max(1, intervalMinutes) * 60_000`,
 * because a character class excluding parens and commas cannot span a nested call. Which is
 * the useful failure: the check reported five phantom timers rather than missing a real one.
 */
function intervalArgs(src: string): string[] {
  const out: string[] = [];
  const NEEDLE = "setInterval(";
  for (let at = src.indexOf(NEEDLE); at >= 0; at = src.indexOf(NEEDLE, at + 1)) {
    let depth = 0;
    let lastComma = -1;
    let i = at + NEEDLE.length - 1;
    for (; i < src.length; i++) {
      const c = src[i]!;
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") {
        depth--;
        if (depth === 0) break;
      } else if (c === "," && depth === 1) lastComma = i;
    }
    if (lastComma < 0 || i >= src.length) continue;
    out.push(src.slice(lastComma + 1, i).trim());
  }
  return out;
}

console.log("every setting the list names really exists");
{
  const known = new Map(SETTINGS.map((s) => [s.key, s]));
  for (const j of JOBS) {
    for (const key of [j.intervalSetting, j.enabledSetting].filter(Boolean) as string[]) {
      const s = known.get(key);
      ok(Boolean(s), `${j.id}: ${key} is a registered setting`);
      if (!s) continue;
      if (key === j.intervalSetting) {
        eq(s.type, "number", `${key} is a number`);
        // The page prints an interval when the setting is unset, so the default it prints
        // has to be the default the bridge falls back to.
        eq(
          Number(s.default ?? NaN),
          j.defaultValue,
          `${key} default matches the one the schedules page shows`,
        );
      } else {
        eq(s.type, "boolean", `${key} is a boolean`);
        eq(
          (s.default ?? "false") === "true",
          j.enabledDefault ?? false,
          `${key} default matches`,
        );
      }
    }
  }
}

console.log("\nno timer in the bridge is unaccounted for");
{
  // Timers that are deliberately not on the page, each with the reason. They are parts of a
  // running connection or a reaction to one, not scheduled work with an operator-visible
  // cadence — listing them would bury the nine that matter under a dozen that do not.
  const EXCLUDED: Record<string, string> = {
    // TWO TIMERS SHARE THIS ARGUMENT, which the exclusion list keys on. Named here rather
    // than left to the first reason that happened to be written, because an exclusion that
    // describes one timer while silently covering another is the check lying about its own
    // coverage.
    "1_000":
      "PA duty poll and the stream overlay rewrite — both sample a running thing, neither is a scheduled job",
    "Math.round(1000 / STREAM_FPS)":
      "YouTube frame timer — part of a running stream, and it only exists while one is live",
    "500": "frequency publish — part of the Icom source's live state",
    "30_000": "listed as operating-schedule",
    "10_000": "listed as transmit-gate",
    "60 * 60_000": "listed as decode-prune",
    "MIN_QUERY_INTERVAL_MS": "listed as pskreporter",
    "5_000": "WSJT-X heartbeat watch — reacts to a connection going quiet, not scheduled work",
  };

  const src = readFileSync("services/radio/index.ts", "utf8");
  const found = intervalArgs(src);

  ok(found.length >= 6, `found ${found.length} setInterval call(s) to account for`);

  // Timers whose interval is computed from a minutes setting. The variable names are local
  // to the bridge, so the SHAPE is what identifies them: `Math.max(15, lotwMinutes) * 60_000`
  // or a bare `eqslMinutes * 60_000` when the clamp was applied earlier.
  const derived = found.filter(
    (a) => /\*\s*(?:60_000|3_600_000)\s*$/.test(a) && !(a in EXCLUDED),
  );
  const unrecognised = found.filter(
    (a) => !(a in EXCLUDED) && !derived.includes(a),
  );
  ok(
    unrecognised.length === 0,
    unrecognised.length === 0
      ? "every one is either listed on the page or excluded by name"
      : `unaccounted for: ${unrecognised.join(" | ")} — add it to lib/schedule/jobs.ts or to EXCLUDED here`,
  );

  // AND THE COUNTS MUST AGREE. Matching the shape alone would accept a brand-new
  // settings-driven timer that nobody listed — which is exactly the drift this check exists
  // to catch, since the page would then be describing eight jobs while nine run. Adding a
  // timer now fails here until it is added to the registry too.
  const listedTimerJobs = JOBS.filter(
    (j) => j.intervalSetting !== undefined && j.ownTimer !== false,
  );
  eq(
    derived.length,
    listedTimerJobs.length,
    `${derived.length} settings-driven timer(s) in the bridge, ${listedTimerJobs.length} listed on the page`,
  );
}

console.log("\nthe cron column says only what cron can say");
{
  eq(cronish(60_000), "*/1 * * * *", "every minute");
  eq(cronish(10 * 60_000), "*/10 * * * *", "every ten minutes");
  eq(cronish(30 * 60_000), "*/30 * * * *", "every half hour");
  eq(cronish(60 * 60_000), "0 * * * *", "hourly is on the hour, not */60");
  eq(cronish(12 * 3_600_000), "0 */12 * * *", "twelve-hourly");
  // The point of `cronish`. `*/7 * * * *` does NOT mean every seven minutes — it fires at
  // 0,7,14,...,56 and then again at 0, a one-minute gap across the hour. Printing it would
  // be wrong in a format people trust, so anything that does not divide evenly is written
  // out in words instead.
  eq(cronish(7 * 60_000), "every 7m", "seven minutes does not divide the hour, so no expression");
  eq(cronish(90 * 60_000), "every 1h 30m", "and neither does ninety");
  eq(cronish(5 * 3_600_000), "every 5h", "nor five hours into a day");
  // Cron has no sub-minute field at all.
  eq(cronish(10_000), "every 10s", "ten seconds is not expressible as cron");
  eq(cronish(30_000), "every 30s", "nor thirty");
}

console.log("\nthe floor is reported, not hidden");
{
  const lotw = JOBS.find((j) => j.id === "lotw-sync")!;
  const set = (v: Record<string, string>) => (k: string) => v[k] ?? null;

  // THE CASE THIS PAGE EXISTS FOR. `lotw.syncMinutes` is clamped to 15, so an operator who
  // types 5 gets 15 with nothing anywhere saying so — from the outside the setting looks
  // broken. The page has to show the effective value AND that it was overridden.
  const clamped = resolveJob(lotw, set({ "lotw.syncMinutes": "5", "lotw.autoSync": "true" }));
  eq(clamped.effectiveMs, 15 * 60_000, "5 minutes becomes 15, because the code clamps it");
  eq(clamped.configured, 5, "what was actually set is still reported");
  eq(clamped.clampedFrom, 5, "and it is flagged as overridden");

  const fine = resolveJob(lotw, set({ "lotw.syncMinutes": "90", "lotw.autoSync": "true" }));
  eq(fine.effectiveMs, 90 * 60_000, "a value above the floor is left alone");
  eq(fine.clampedFrom, null, "and not flagged");

  const unset = resolveJob(lotw, set({ "lotw.autoSync": "true" }));
  eq(unset.effectiveMs, 60 * 60_000, "unset falls back to the registered default");
  eq(unset.clampedFrom, null, "which is above the floor, so nothing is flagged");
}

console.log("\noff is reported as off");
{
  const set = (v: Record<string, string>) => (k: string) => v[k] ?? null;
  const uploads = JOBS.find((j) => j.id === "uploads")!;

  eq(resolveJob(uploads, set({})).enabled, false, "uploads default to off");
  eq(
    resolveJob(uploads, set({ "uploads.enabled": "true" })).enabled,
    true,
    "and on when switched on",
  );
  // `uploadTick` reads `if (mins <= 0) return`, so zero is a way of switching it off. The
  // page must not print "every 0 min" for it.
  eq(
    resolveJob(uploads, set({ "uploads.enabled": "true", "uploads.intervalMinutes": "0" })).enabled,
    false,
    "an interval of zero is off, which is what the bridge does with it",
  );

  const gate = JOBS.find((j) => j.id === "transmit-gate")!;
  eq(resolveJob(gate, set({})).enabled, true, "a job with no switch is always on");
}

console.log("\nthe list itself");
{
  const ids = JOBS.map((j) => j.id);
  eq(new Set(ids).size, ids.length, `no duplicate ids (${ids.length} jobs)`);
  ok(
    JOBS.every((j) => j.fixedMs !== undefined || j.intervalSetting !== undefined),
    "every job either has a setting or states a fixed interval",
  );
  ok(
    JOBS.every((j) => j.fixedMs === undefined || Boolean(j.fixedReason)),
    "and a fixed interval always says why it is not adjustable",
  );
  ok(
    JOBS.every((j) => j.intervalSetting === undefined || j.defaultValue !== undefined),
    "and an adjustable one always states its default",
  );
  ok(resolveJobs(() => null).length === JOBS.length, "all of them resolve with no settings set");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
