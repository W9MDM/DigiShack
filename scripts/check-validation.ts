// Assertions for query-parameter validation helpers.
// Run: npm run check:validation
//
// boolQuery exists because z.coerce.boolean() silently inverted a destructive
// flag: it applies JavaScript Boolean() semantics, so "?dryRun=0" evaluated to
// TRUE and a real import quietly did nothing while reporting success. These
// assertions exist so that never comes back.

import { z } from "zod";

import { boolQuery } from "../lib/validation/query";
import { setupSchema } from "../lib/validation/auth";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}`, extra ?? "");
  }
}

const schema = z.object({
  offByDefault: boolQuery(false),
  onByDefault: boolQuery(true),
});

const parse = (q: Record<string, string | undefined>) =>
  schema.parse(q as Record<string, string>);

console.log("\n1. falsey spellings must be FALSE");
for (const v of ["0", "false", "FALSE", "no", "off", "  0  "]) {
  const r = parse({ offByDefault: v, onByDefault: v });
  check(`"${v}" -> false`, r.offByDefault === false && r.onByDefault === false, r);
}

console.log("\n2. truthy spellings must be TRUE");
for (const v of ["1", "true", "TRUE", "yes", "on", " 1 "]) {
  const r = parse({ offByDefault: v, onByDefault: v });
  check(`"${v}" -> true`, r.offByDefault === true && r.onByDefault === true, r);
}

console.log("\n3. absent and empty fall back to the declared default");
{
  const r = parse({});
  check("absent honours default", r.offByDefault === false && r.onByDefault === true, r);
}
{
  const r = parse({ offByDefault: "", onByDefault: "" });
  check("empty honours default", r.offByDefault === false && r.onByDefault === true, r);
}

console.log("\n4. garbage is rejected rather than guessed at");
{
  const r = schema.safeParse({ offByDefault: "maybe", onByDefault: "1" });
  check("\"maybe\" is a validation error", r.success === false, r);
}

console.log("\n5. the regression itself: z.coerce.boolean() gets these wrong");
{
  const bad = z.object({ dryRun: z.coerce.boolean().default(false) });
  const coerced = bad.parse({ dryRun: "0" } as Record<string, unknown>).dryRun;
  // Documents WHY boolQuery exists. If this ever stops being true, zod changed
  // its semantics and the comment in lib/validation/query.ts should be revisited.
  check(
    'z.coerce.boolean() turns "0" into true (the bug being guarded against)',
    coerced === true,
    coerced,
  );
  check(
    'boolQuery turns "0" into false',
    parse({ offByDefault: "0" }).offByDefault === false,
  );
}


// ---------------------------------------------------------------------------
// The station identity asked for at first-run setup
// ---------------------------------------------------------------------------
//
// This is the field that goes on the air, and the reason it is validated at all is that it
// used to be hardcoded in `prisma/seed.ts`: anybody who ran the optional sample data
// inherited a real operator's callsign, and the transmit path reads that record — so the
// radio would have called CQ under it. Unidentified operation, not a bad default.
// This file's assertion helper is check(name, cond); these wrappers let the block below
// read the way the other check scripts do.
const ok = (cond: boolean, name: string) => check(name, cond);
const eq = <T,>(actual: T, expected: T, name: string) =>
  check(name, Object.is(actual, expected), `got ${String(actual)}, want ${String(expected)}`);

console.log("\nfirst-run station identity");
{
  const base = {
    email: "op@example.com",
    name: "Op",
    password: "correct horse battery staple",
  };
  const good = setupSchema.safeParse({
    ...base,
    stationCallsign: "N0CALL",
    stationGrid: "FN31pr",
  });
  ok(good.success, "a callsign and 6-character grid are accepted");
  if (good.success) {
    eq(good.data!.stationGrid, "FN31pr", "  and the grid keeps its conventional casing");
  }
  ok(
    setupSchema.safeParse({ ...base, stationCallsign: "N0CALL", stationGrid: "FN31" }).success,
    "a 4-character grid is enough",
  );
  // BOTH ARE REQUIRED. Setup cannot complete without them, which is what makes the
  // hardcoded default unnecessary rather than merely discouraged.
  ok(
    !setupSchema.safeParse({ ...base, stationGrid: "FN31" }).success,
    "a missing station callsign is refused",
  );
  ok(
    !setupSchema.safeParse({ ...base, stationCallsign: "N0CALL" }).success,
    "and so is a missing grid",
  );
  ok(
    !setupSchema.safeParse({ ...base, stationCallsign: "N0CALL", stationGrid: "" }).success,
    "an empty grid is not a grid",
  );
  // Grid shape: letters A-R for the field, digits for the square.
  for (const bad of ["ZZ99", "F1", "FN3", "31FN", "FN31prxx"]) {
    ok(
      !setupSchema.safeParse({ ...base, stationCallsign: "N0CALL", stationGrid: bad }).success,
      `"${bad}" is not a Maidenhead grid`,
    );
  }
}

console.log(
  failures === 0
    ? "\nAll validation checks passed.\n"
    : `\n${failures} VALIDATION CHECK(S) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
