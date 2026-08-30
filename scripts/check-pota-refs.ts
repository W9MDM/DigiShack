/* eslint-disable no-console */
// Consistency check between the two representations of a park reference, and a
// backfill for contacts that predate the second one.
//
// `QsoSigRef` is the authority on which references a contact carries; `Qso.sigInfo`
// mirrors the primary, because ADIF, LoTW and eQSL each need exactly one value per
// contact. Two representations of the same fact is a bug factory, so this asserts
// across the entire database that they agree — and it is in `npm run check`, which
// means the invariant is verified against real data on every run rather than trusted.
//
//   npx tsx scripts/check-pota-refs.ts            check only
//   npx tsx scripts/check-pota-refs.ts --backfill create missing rows from Qso.sigInfo

import { prisma } from "@/lib/db/prisma";
import { skipWithoutDatabase } from "./needs-db";

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

async function main(): Promise<void> {
  // A missing database is a skip, not a crash. See scripts/needs-db.ts.
  if (await skipWithoutDatabase("check:pota-refs")) return;
  const backfill = process.argv.includes("--backfill");

  // Contacts with a mirrored reference but no row for it. That is every contact that
  // was imported before `QsoSigRef` existed.
  const orphans = await prisma.$queryRawUnsafe<{ id: string; sig: string; sigInfo: string }[]>(
    `SELECT q.id, q.sig, q.sigInfo
       FROM Qso q
       LEFT JOIN QsoSigRef r
         ON r.qsoId = q.id AND r.sig = q.sig AND r.sigInfo = q.sigInfo
      WHERE q.sigInfo IS NOT NULL AND q.sig IS NOT NULL AND r.id IS NULL`,
  );

  if (backfill && orphans.length > 0) {
    console.log(`\nbackfilling ${orphans.length} contacts from Qso.sigInfo`);
    const CHUNK = 500;
    for (let i = 0; i < orphans.length; i += CHUNK) {
      await prisma.qsoSigRef.createMany({
        data: orphans.slice(i, i + CHUNK).map((o) => ({
          qsoId: o.id,
          sig: o.sig,
          sigInfo: o.sigInfo,
          // The mirrored value is by definition the primary.
          primary: true,
        })),
        skipDuplicates: true,
      });
    }
    console.log(`  created ${orphans.length} reference rows`);
  }

  console.log("\nconsistency");
  {
    const still = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT COUNT(*) n
         FROM Qso q
         LEFT JOIN QsoSigRef r
           ON r.qsoId = q.id AND r.sig = q.sig AND r.sigInfo = q.sigInfo
        WHERE q.sigInfo IS NOT NULL AND q.sig IS NOT NULL AND r.id IS NULL`,
    );
    const n = Number(still[0]?.n ?? 0);
    ok(n === 0, "every mirrored reference has a row", n ? `${n} without one` : "");
  }
  {
    // The other direction: a reference row whose QSO mirrors nothing at all. The
    // mirror is what ADIF exports, so this would silently drop a park from every
    // export while the page still showed it.
    const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT COUNT(*) n
         FROM QsoSigRef r
         JOIN Qso q ON q.id = r.qsoId
        WHERE q.sigInfo IS NULL`,
    );
    const n = Number(rows[0]?.n ?? 0);
    ok(n === 0, "no contact has references without a mirrored primary", n ? `${n} do` : "");
  }
  {
    // Exactly one primary per contact per programme. Two would make the exported
    // value depend on row order; none would make it undefined.
    const rows = await prisma.$queryRawUnsafe<{ qsoId: string; sig: string; n: bigint }[]>(
      `SELECT qsoId, sig, COUNT(*) n
         FROM QsoSigRef
        WHERE \`primary\` = 1
        GROUP BY qsoId, sig
       HAVING COUNT(*) > 1
        LIMIT 5`,
    );
    ok(rows.length === 0, "at most one primary per contact per programme", `${rows.length} with more`);
  }
  {
    const rows = await prisma.$queryRawUnsafe<{ qsoId: string; sig: string }[]>(
      `SELECT r.qsoId, r.sig
         FROM QsoSigRef r
        GROUP BY r.qsoId, r.sig
       HAVING SUM(r.\`primary\` = 1) = 0
        LIMIT 5`,
    );
    ok(rows.length === 0, "and never none", `${rows.length} programmes without a primary`);
  }
  {
    const bad = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT COUNT(*) n FROM QsoSigRef WHERE sigInfo <> UPPER(sigInfo) OR sig <> UPPER(sig)`,
    );
    const n = Number(bad[0]?.n ?? 0);
    // Case matters: "us-1689" and "US-1689" would be two parks to a Set and one to
    // the operator, so every writer upper-cases and this proves none forgot.
    ok(n === 0, "every reference is stored upper-case", n ? `${n} are not` : "");
  }

  console.log("\nwhat is in there");
  const total = await prisma.qsoSigRef.count();
  const contacts = await prisma.qso.count({ where: { sigRefs: { some: {} } } });
  const parks = await prisma.qsoSigRef.findMany({
    where: { sig: "POTA" },
    distinct: ["sigInfo"],
    select: { sigInfo: true },
  });
  const multi = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT COUNT(*) n FROM (
       SELECT qsoId FROM QsoSigRef WHERE sig = 'POTA' GROUP BY qsoId HAVING COUNT(*) > 1
     ) t`,
  );
  console.log(`  ${total} references across ${contacts} contacts`);
  console.log(`  ${parks.length} distinct parks`);
  console.log(`  ${Number(multi[0]?.n ?? 0)} contacts carry more than one park`);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await prisma.$disconnect();
  if (fail > 0) process.exit(1);
}

void main();
