/* eslint-disable no-console */
// Checks the "best day" record — most contacts in one UTC day.
// Run: npm run check:best-day
//
// WHY THIS IS A STAT AND NOT AN EYEBALL. Amateur radio counts days in UTC — every award,
// every contest, and the duplicate rule in this application all do. This station is at
// UTC-5, so 00:00 UTC is 19:00 local: a local-day count splits one evening's operating
// across two days and under-reports the best of them. Getting that wrong would produce a
// record that is quietly too small, on a page nobody can check by hand.
//
// The pure half is asserted here. The SQL half is cross-checked against an independent
// count when a database is reachable, and skipped honestly when it is not — the
// development machine has no database.

import { utcDayOf } from "../lib/stats/history";
import { skipWithoutDatabase } from "./needs-db";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}`, extra ?? "");
  }
}

async function main(): Promise<void> {
  console.log("1. the UTC day a DATE() result names");
  {
    // Prisma hands MySQL DATE() back as a Date at midnight UTC.
    check(
      "a midnight-UTC Date reads as its own day",
      utcDayOf(new Date("2025-11-17T00:00:00.000Z")) === "2025-11-17",
      utcDayOf(new Date("2025-11-17T00:00:00.000Z")),
    );
    // THE OFF-BY-ONE THIS EXISTS TO PREVENT. `getFullYear()`/`getMonth()`/`getDate()` on a
    // midnight-UTC Date answer in LOCAL time, which for every station west of Greenwich is
    // the previous day. The record would be reported one day early, for ever, and look
    // entirely plausible.
    const midnight = new Date("2025-11-17T00:00:00.000Z");
    check(
      "and NOT the local-time day, which would be a day early here",
      utcDayOf(midnight) !== `${midnight.getFullYear()}-11-16`,
      `local getters would say ${midnight.getFullYear()}-${String(midnight.getMonth() + 1).padStart(2, "0")}-${String(midnight.getDate()).padStart(2, "0")}`,
    );
    // Late in a UTC day is still that day, however early it is locally.
    check(
      "23:59 UTC belongs to the UTC day, not tomorrow",
      utcDayOf(new Date("2025-11-17T23:59:59.000Z")) === "2025-11-17",
    );
    // And the reverse: 00:30 UTC is the evening before, locally, and must NOT be counted
    // with it. This is the half of the boundary a local-day count gets wrong.
    check(
      "00:30 UTC belongs to the new UTC day",
      utcDayOf(new Date("2025-11-18T00:30:00.000Z")) === "2025-11-18",
    );
  }

  console.log("");
  console.log("2. the string form, because the driver may send either");
  {
    check("a plain date string passes through", utcDayOf("2025-11-17") === "2025-11-17");
    check(
      "a datetime string is truncated to the day",
      utcDayOf("2025-11-17 00:00:00") === "2025-11-17",
    );
    check("surrounding whitespace is tolerated", utcDayOf("  2025-11-17  ") === "2025-11-17");
  }

  console.log("");
  console.log("3. nothing invents a date it does not have");
  {
    // The failure this replaces would render "Invalid Date" on the Statistics page, which
    // reads as a broken log rather than a broken reader.
    check("null is null", utcDayOf(null) === null);
    check("undefined is null", utcDayOf(undefined) === null);
    check("a number is null", utcDayOf(1763337600000) === null);
    check("an unparseable string is null", utcDayOf("not a date") === null);
    check("an Invalid Date is null", utcDayOf(new Date("nonsense")) === null);
  }

  console.log("");
  console.log("4. against the real log, if there is one");
  if (await skipWithoutDatabase("check:best-day")) {
    console.log("");
    if (failures > 0) {
      console.log(`${failures} failed`);
      process.exit(1);
    }
    console.log("all passed (database section skipped)");
    return;
  }

  const { computeHistory } = await import("../lib/stats/history");
  const { prisma } = await import("../lib/db/prisma");

  const report = await computeHistory();
  const qsos = await prisma.qso.findMany({ select: { startTime: true } });

  if (qsos.length === 0) {
    check("an empty log reports no best day rather than a zero", report.bestDay === null);
  } else {
    // INDEPENDENTLY COUNTED, in JS, from every row — not the same GROUP BY worded twice.
    // A test that re-issues the query it is checking only proves the query is stable.
    const by = new Map<string, number>();
    for (const q of qsos) {
      const k = q.startTime.toISOString().slice(0, 10);
      by.set(k, (by.get(k) ?? 0) + 1);
    }
    let bestDate = "";
    let bestN = -1;
    for (const [d, n] of [...by.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (n > bestN) {
        bestN = n;
        bestDate = d;
      }
    }

    check("a non-empty log reports a best day", report.bestDay !== null);
    check(
      `the count matches an independent tally (${bestN})`,
      report.bestDay?.qsos === bestN,
      `SQL said ${report.bestDay?.qsos}, counting rows says ${bestN}`,
    );
    check(
      `the date matches (${bestDate})`,
      report.bestDay?.date === bestDate,
      `SQL said ${report.bestDay?.date}, counting rows says ${bestDate}`,
    );
    check(
      "the record is not larger than the whole log",
      (report.bestDay?.qsos ?? 0) <= report.totals.qsos,
    );
    // Ties break on the EARLIER date: the first time a record was set is when it was set.
    const tied = [...by.entries()].filter(([, n]) => n === bestN).map(([d]) => d);
    if (tied.length > 1) {
      check(
        `with ${tied.length} days tied, the earliest wins`,
        report.bestDay?.date === tied.sort()[0],
        tied.join(", "),
      );
    }
    console.log(`       (log holds ${report.totals.qsos} contacts across ${by.size} active days)`);
  }

  console.log("");
  if (failures > 0) {
    console.log(`${failures} failed`);
    process.exit(1);
  }
  console.log("all passed");
}

void main();
