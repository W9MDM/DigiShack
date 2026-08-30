// End-to-end: back up, restore into a scratch database, compare.
//
// The unit tests cover the pieces. This proves the whole thing, because a backup that
// has never been restored is a hypothesis rather than a backup.
//
// Restores into a SEPARATE database so the live log is never at risk.

import { readFile, mkdtemp, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { PrismaClient } from "@prisma/client";

import { BACKUP_DIR, splitStatements } from "@/lib/db/backup";
import { backupBundle } from "@/lib/db/bundle";
import { tarUnpack } from "@/lib/db/tar";
import { prisma } from "@/lib/db/prisma";
import { skipWithoutDatabase } from "./needs-db";

const SCRATCH = "digishack_restore_test";

async function main() {
  // This one restores a real backup into a scratch database, so it is meaningless without
  // a server. A skip, not a crash. See scripts/needs-db.ts.
  if (await skipWithoutDatabase("check:restore")) return;

  console.log("1. make a bundle");
  const result = await backupBundle(false);
  const raw = await readFile(path.join(BACKUP_DIR, result.file));
  const entries = tarUnpack(gunzipSync(raw));
  console.log(`   ${result.file}, ${(result.bytes / 1024 / 1024).toFixed(2)} MB`);

  console.log("2. counts in the live database");
  const before = {
    qso: await prisma.qso.count(),
    sigRefs: await prisma.qsoSigRef.count(),
    settings: await prisma.setting.count(),
    dxcc: await prisma.dxccEntity.count(),
    decodes: await prisma.digitalDecode.count(),
    users: await prisma.user.count(),
  };
  console.log(`   ${JSON.stringify(before)}`);

  console.log(`3. create a scratch database (${SCRATCH})`);
  await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS \`${SCRATCH}\``);
  await prisma.$executeRawUnsafe(
    `CREATE DATABASE \`${SCRATCH}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  );

  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${SCRATCH}`;
  const scratch = new PrismaClient({ datasources: { db: { url: url.toString() } } });

  console.log("4. apply the dump");
  const sql = entries.find((e) => e.name === "database.sql")!.data.toString("utf8");
  const statements = splitStatements(sql);
  let ran = 0;
  for (const s of statements) {
    await scratch.$executeRawUnsafe(s);
    ran++;
  }
  console.log(`   ${ran} statements`);

  console.log("5. counts in the restored database");
  const after = {
    qso: await scratch.qso.count(),
    sigRefs: await scratch.qsoSigRef.count(),
    settings: await scratch.setting.count(),
    dxcc: await scratch.dxccEntity.count(),
    decodes: await scratch.digitalDecode.count(),
    users: await scratch.user.count(),
  };
  console.log(`   ${JSON.stringify(after)}`);

  let ok = true;
  for (const k of Object.keys(before) as (keyof typeof before)[]) {
    // Live tables are moving under us — decodes arrive every 15 s while the radio is
    // running. The dump can only be BEHIND, never ahead.
    const drifty = k === "decodes" || k === "qso" || k === "sigRefs";
    const good = drifty ? after[k] <= before[k] && after[k] > 0 : after[k] === before[k];
    console.log(`   ${good ? "ok  " : "FAIL"} ${k}: ${before[k]} -> ${after[k]}`);
    if (!good) ok = false;
  }

  console.log("6. spot-check real content");
  const s1 = await scratch.qso.findFirst({
    where: { sigRefs: { some: {} } },
    include: { sigRefs: true, station: true },
    orderBy: { startTime: "desc" },
  });
  console.log(
    `   ${s1?.callsign} ${s1?.band} ${s1?.mode} refs=[${s1?.sigRefs.map((r) => r.sigInfo).join(",")}] station=${s1?.station.callsign}`,
  );
  const nfer = await scratch.$queryRawUnsafe<{ n: bigint }[]>(
    "SELECT COUNT(*) n FROM (SELECT qsoId FROM QsoSigRef GROUP BY qsoId HAVING COUNT(*) > 1) t",
  );
  console.log(`   contacts with several parks: ${Number(nfer[0]?.n ?? 0)}`);

  // An encrypted setting must come back byte-identical, or credentials are lost.
  const secret = await prisma.setting.findFirst({ where: { key: { contains: "token" } } });
  if (secret) {
    const copy = await scratch.setting.findUnique({ where: { key: secret.key } });
    const same = copy?.value === secret.value;
    console.log(`   ${same ? "ok  " : "FAIL"} encrypted setting '${secret.key}' identical`);
    if (!same) ok = false;
  }

  // And the em-dash / unicode path, which is where a naive dump corrupts silently.
  const uni = await scratch.$queryRawUnsafe<{ n: bigint }[]>(
    "SELECT COUNT(*) n FROM Qso WHERE notes LIKE '%—%'",
  );
  const uniLive = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    "SELECT COUNT(*) n FROM Qso WHERE notes LIKE '%—%'",
  );
  console.log(
    `   em-dash in notes: live ${Number(uniLive[0]?.n ?? 0)}, restored ${Number(uni[0]?.n ?? 0)}`,
  );

  console.log("7. files restore to the right place");
  const tmp = await mkdtemp(path.join(tmpdir(), "digishack-restore-"));
  for (const e of entries.filter((x) => x.name.startsWith("files/"))) {
    const rel = e.name.slice("files/".length);
    const dest = path.join(tmp, rel);
    await cp(Buffer.from(e.data) as never, dest as never).catch(async () => {
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, e.data);
    });
  }
  const art = await readFile(path.join(tmp, "data", "qsl", "card-base.png")).catch(() => null);
  const orig = await readFile(path.join(process.cwd(), "data", "qsl", "card-base.png"));
  console.log(
    `   ${art && art.equals(orig) ? "ok  " : "FAIL"} artwork restored identical (${art?.length ?? 0} bytes)`,
  );
  if (!art || !art.equals(orig)) ok = false;
  await rm(tmp, { recursive: true, force: true });

  console.log("8. clean up");
  await scratch.$disconnect();
  await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS \`${SCRATCH}\``);
  await prisma.$disconnect();

  console.log(`\n${ok ? "ROUND TRIP OK" : "ROUND TRIP FAILED"}\n`);
  if (!ok) process.exit(1);
}
void main();
