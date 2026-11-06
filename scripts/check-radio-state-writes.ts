/* eslint-disable no-console */
// The bridge writes its runtime state only through writeRadioState.
// Run: npm run check:radio-state-writes
//
// Radio runtime state (auto mode, schedule, no-power restart) will be per radio once an install
// runs several. A direct prisma.setting write under services/radio would put one radio's state
// where another reads it - "auto was CQ" resuming automation on the wrong transmitter. So any
// such write outside lib/radio/state.ts fails this check.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { makeReporter } from "./fake-prisma";

const { ok, finish } = makeReporter();

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(n) ? [p] : [];
  });
}

const offenders: string[] = [];
for (const f of files("services/radio")) {
  const src = readFileSync(f, "utf8");
  const re = /prisma\s*\.\s*setting\s*\.\s*(upsert|update|updateMany|create|createMany|delete|deleteMany)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) offenders.push(`${f}:${src.slice(0, m.index).split("\n").length} ${m[1]}`);
}
ok(offenders.length === 0, "no direct prisma.setting writes under services/radio", offenders.join(", "));
finish();
