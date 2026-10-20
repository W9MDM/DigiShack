/* eslint-disable no-console */
// A stand-in Prisma client, for checks that must prove database behaviour without a database.
//
// lib/db/prisma.ts reuses `globalThis.prisma` when one is already there, so installing this
// BEFORE any application module is evaluated routes every `prisma.model.method()` in the code
// under test here instead of to a connection pool. That ordering is the whole trick, and it is
// easy to break: a check must import THIS module statically and the application DYNAMICALLY
// (`await import("@/lib/...")`) after calling `installFakePrisma()`. A static import of
// application code is hoisted above the call and would build a real client first.
//
// Anything a check did not stub throws "Unexpected DB call". A check must never pass because
// a query it did not anticipate quietly resolved to `undefined`.
//
// The approach is the one the 2026-10-14 code review's offline harness used
// (code-review/reproduce.mts): fake delegates installed before the imports, application
// functions exercised for real.

/** One model's methods, e.g. `fake.qso.findMany`. Unstubbed methods throw when called. */
export type FakeDelegate = Record<string, (...args: any[]) => any>;

/** The fake client: model delegates plus whatever `$`-methods a check assigns. */
export type FakePrisma = Record<string, any>;

export function installFakePrisma(models: string[]): FakePrisma {
  const fake: FakePrisma = {};
  for (const name of models) {
    fake[name] = new Proxy({} as FakeDelegate, {
      get(target, key) {
        if (typeof key === "symbol") return undefined;
        return (
          target[key] ??
          (async () => {
            throw new Error(`Unexpected DB call: ${name}.${key}`);
          })
        );
      },
    });
  }
  for (const method of ["$queryRawUnsafe", "$executeRawUnsafe", "$transaction"]) {
    fake[method] = async () => {
      throw new Error(`Unexpected DB call: ${method}`);
    };
  }
  (globalThis as unknown as { prisma?: unknown }).prisma = fake;
  return fake;
}

/** Pass/fail bookkeeping shared by the offline checks, in the suite's usual output format. */
export function makeReporter(): {
  ok: (cond: boolean, label: string, detail?: string) => void;
  eq: (got: unknown, want: unknown, label: string) => void;
  section: (title: string) => void;
  finish: () => void;
} {
  let pass = 0;
  let fail = 0;
  const ok = (cond: boolean, label: string, detail = ""): void => {
    if (cond) {
      pass++;
      console.log(`  ok    ${label}`);
    } else {
      fail++;
      console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
    }
  };
  const show = (v: unknown): string =>
    JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? `${x}n` : x));
  return {
    ok,
    eq: (got, want, label) => ok(got === want, label, `got ${show(got)}, want ${show(want)}`),
    section: (title) => console.log(`\n${title}`),
    finish: () => {
      console.log(`\n${pass} passed, ${fail} failed\n`);
      if (fail > 0) process.exitCode = 1;
    },
  };
}
