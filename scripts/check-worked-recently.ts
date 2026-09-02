/* eslint-disable no-console */
// Checks the "worked today" lookup behind the decode list's `worked` chip.
// Run: npm run check:worked-recently
//
// THE REPORT: "ive yet to see the worked chip".
//
// It existed, and it was unobservable. `pages/decodes.tsx` drove it from page-local state:
//
//     const [workedNow, setWorkedNow] = useState<Set<string>>(new Set());
//
// Empty on every page load, filled only by a `qso-logged` websocket message while that tab
// stayed open. So it showed for a contact finished seconds ago and never again — not after
// a refresh, not after a bridge restart, not for anyone worked earlier the same day.
//
// Meanwhile `auto.dupeWindowHours` refuses to call the same station on the same band and
// mode for 24 hours and once per UTC day. The software knew a station was a duplicate and
// declined to call them while the screen said nothing.
//
// THE BADGE AND THE GUARD MUST AGREE, and the only way to be sure is to derive both from
// one boundary function. That is what these assertions pin — including the ways the lookup
// must decline to answer, which are the paths that would put a WRONG chip on a row and talk
// an operator out of a contact they are entitled to make.
//
// The database path needs a database and is skipped without one, which is the same
// convention check:transmit-gate uses. The short-circuits below never reach the database
// and always run.

import { dupeBoundaryMs } from "../lib/digital/qso";
import { workedRecently } from "../lib/digital/worked-recently";

let failed = 0;
function ok(cond: boolean, what: string, extra?: unknown): void {
  if (cond) {
    console.log(`  ok    ${what}`);
  } else {
    failed++;
    console.log(`  FAIL  ${what}`, extra ?? "");
  }
}
function eq(a: unknown, b: unknown, what: string): void {
  ok(Object.is(a, b), what, `expected ${String(b)}, got ${String(a)}`);
}

const H = 3_600_000;
const NOW = Date.UTC(2026, 8, 2, 14, 30, 0);
const CALLS = ["W0VG", "KB1EJQ"];

async function main(): Promise<void> {
  console.log("it declines to answer rather than answering wrongly");
  {
    // EVERY ONE OF THESE SHORT-CIRCUITS BEFORE THE DATABASE. They are the cases where a
    // chip would be a guess, and a wrong "worked" chip is worse than no chip: it tells the
    // operator not to bother with a station the guard would happily let them call.
    eq(
      (await workedRecently(CALLS, null, "FT8", 24 * H, NOW)).size,
      0,
      "no band means no rule to apply, so no chips",
    );
    eq(
      (await workedRecently(CALLS, "20M", null, 24 * H, NOW)).size,
      0,
      "no mode either — the rule is per band AND mode",
    );
    eq((await workedRecently([], "20M", "FT8", 24 * H, NOW)).size, 0, "no callsigns, no work");

    // THE GUARD SWITCHED OFF. `dupeBoundaryMs` reports null, and the honest answer is that
    // nothing is a duplicate — the screen must say what the software will actually do, not
    // what it would have done under a different setting.
    eq(dupeBoundaryMs(NOW, 0), null, "a zero window removes the boundary entirely");
    eq(
      (await workedRecently(CALLS, "20M", "FT8", 0, NOW)).size,
      0,
      "so a zero window marks nothing as worked",
    );
    eq(
      (await workedRecently(CALLS, "20M", "FT8", -1, NOW)).size,
      0,
      "and a negative one does not wrap into something enormous",
    );
  }

  console.log("");
  console.log("the boundary is the guard's own, not a second opinion");
  {
    // If these two ever diverge, the chip and the refusal disagree — which is the whole
    // fault this file exists to prevent. Asserted against dupeBoundaryMs directly, because
    // that is the function services/radio consults.
    const b = dupeBoundaryMs(NOW, 24 * H);
    ok(b !== null, "a 24 h window has a boundary");
    eq(b, Math.min(NOW - 24 * H, Date.UTC(2026, 8, 2)), "and it is the earlier of window and UTC midnight");

    // SHORTENING THE WINDOW MUST NOT BRING SAME-DAY DUPLICATES BACK. Two hours still
    // reaches back to midnight, which is the property the UTC-day half buys.
    const short = dupeBoundaryMs(NOW, 2 * H);
    eq(short, Date.UTC(2026, 8, 2), "a 2 h window still reaches back to midnight today");
    ok(
      short !== null && short < NOW - 2 * H,
      "which is earlier than the window alone would give",
      { short, windowOnly: NOW - 2 * H },
    );

    // And just after midnight, the window is the wider of the two.
    const justAfterMidnight = Date.UTC(2026, 8, 2, 0, 5, 0);
    eq(
      dupeBoundaryMs(justAfterMidnight, 24 * H),
      justAfterMidnight - 24 * H,
      "five minutes into a new UTC day, the 24 h window is what reaches further",
    );
  }

  console.log("");
  console.log("the database path");
  {
    // REACHABILITY IS PROBED, not inferred from DATABASE_URL being set.
    //
    // The first version of this block only checked the variable. The variable is set on the
    // development machine while the database is not running, so the query below failed,
    // `workedRecently` caught it and returned an empty Set exactly as designed — and all
    // three assertions passed on that empty Set. Three "ok" lines printed directly beneath
    // a `Can't reach database server` error.
    //
    // A vacuous pass is the failure mode this project keeps paying for, and a check that
    // reports success because the thing it tests could not run is the purest form of it.
    // So the probe is separate, and it does NOT go through `workedRecently`, whose whole
    // job is to swallow this error.
    let reachable = false;
    if (process.env.DATABASE_URL) {
      try {
        const { prisma } = await import("../lib/db/prisma");
        await prisma.qso.count({ where: { id: "__probe_that_matches_nothing__" } });
        reachable = true;
      } catch {
        reachable = false;
      }
    }

    if (!reachable) {
      console.log(
        "  skip  no reachable database — " +
          (process.env.DATABASE_URL
            ? "DATABASE_URL is set but the server did not answer"
            : "DATABASE_URL is not set") +
          ". Not a failure: nothing was checked.",
      );
    } else {
      // Not asserted against fixture rows, because writing QSOs into the operator's log to
      // test a chip is not a trade this check is willing to make. What IS asserted is that
      // a real query returns a set of upper-cased strings and does not throw — the failure
      // mode being guarded against is an exception reaching the API and costing the whole
      // decode list its scoring.
      const got = await workedRecently(CALLS, "20M", "FT8", 24 * H, Date.now());
      ok(got instanceof Set, "a live lookup returns a Set");
      ok(
        [...got].every((c) => c === c.toUpperCase()),
        "and every callsign in it is upper-cased, as the log stores them",
        [...got],
      );
      ok([...got].every((c) => CALLS.includes(c)), "and it never invents a callsign", [...got]);
    }
  }

  console.log("");
  if (failed > 0) {
    console.log(`${failed} FAILED`);
    process.exit(1);
  }
  console.log("all worked-recently assertions passed");
  process.exit(0);
}

void main();
