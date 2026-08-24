// Mark QSOs as already-QSLed from a legacy sent log, so the auto-emailer never
// re-sends what an earlier system (or an earlier install) already handled.
//
//   npx tsx scripts/import-qsl-sent-log.ts <sent_log.json>            # dry run
//   npx tsx scripts/import-qsl-sent-log.ts <sent_log.json> --apply    # write
//
// The file is a JSON array of "CALLSIGN-YYYYMMDD-HHMM" keys (a few carry seconds:
// -HHMMSS). Parsed from the RIGHT, because callsigns contain slashes and suffixes
// ("KH2/JI3CEY", "N3GTY/QRP") but never hyphens — the last two hyphen-separated
// fields are always date and time.
//
// A key matches a QSO by exact callsign plus a start time inside the key's MINUTE:
// the legacy keys truncate to the minute while the log keeps seconds, so equality
// would match almost nothing and a wide window could catch a genuinely different
// contact with the same station later the same hour.
//
// What it sets is `emailQslSent` (+`emailQslSentAt` from the key) — the exact flag
// lib/qsl/queue.ts sets after a real send and filters candidates by. Deliberately
// NOT `qslSent`, which means a paper/bureau card here.

import { readFileSync } from "node:fs";

import { prisma } from "@/lib/db/prisma";

async function main() {
  const [file, flag] = process.argv.slice(2);
  if (!file) {
    console.error("Usage: npx tsx scripts/import-qsl-sent-log.ts <sent_log.json> [--apply]");
    process.exit(2);
  }
  const apply = flag === "--apply";

  const keys = JSON.parse(readFileSync(file, "utf8")) as string[];
  if (!Array.isArray(keys)) throw new Error("The file is not a JSON array");

  let marked = 0;
  let alreadyMarked = 0;
  let noQso = 0;
  let unparseable = 0;
  const noQsoSamples: string[] = [];

  for (let i = 0; i < keys.length; i++) {
    const key = String(keys[i]).trim();
    const m = /^(.+)-(\d{8})-(\d{4}(?:\d{2})?)$/.exec(key);
    if (!m) {
      unparseable++;
      console.warn(`  unparseable: ${key}`);
      continue;
    }
    const callsign = m[1]!.toUpperCase();
    const d = m[2]!;
    const t = m[3]!;
    const sentAt = new Date(
      `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.length === 6 ? t.slice(4, 6) : "00"}Z`,
    );
    if (Number.isNaN(sentAt.getTime())) {
      unparseable++;
      console.warn(`  bad timestamp: ${key}`);
      continue;
    }

    const minute = new Date(Math.floor(sentAt.getTime() / 60_000) * 60_000);
    const where = {
      callsign,
      startTime: { gte: minute, lt: new Date(minute.getTime() + 60_000) },
    };

    if (apply) {
      const r = await prisma.qso.updateMany({
        where: { ...where, emailQslSent: false },
        data: { emailQslSent: true, emailQslSentAt: sentAt },
      });
      if (r.count > 0) {
        marked += r.count;
      } else if (await prisma.qso.findFirst({ where, select: { id: true } })) {
        alreadyMarked++;
      } else {
        noQso++;
        if (noQsoSamples.length < 15) noQsoSamples.push(key);
      }
    } else {
      const found = await prisma.qso.findFirst({
        where,
        select: { emailQslSent: true },
      });
      if (!found) {
        noQso++;
        if (noQsoSamples.length < 15) noQsoSamples.push(key);
      } else if (found.emailQslSent) {
        alreadyMarked++;
      } else {
        marked++;
      }
    }

    if ((i + 1) % 500 === 0) console.log(`  …${i + 1}/${keys.length}`);
  }

  console.log(`\n${apply ? "APPLIED" : "DRY RUN"} over ${keys.length} keys:`);
  console.log(`  ${apply ? "marked" : "would mark"}: ${marked}`);
  console.log(`  already marked:  ${alreadyMarked}`);
  console.log(`  no matching QSO: ${noQso}  (not in this log — nothing to protect)`);
  console.log(`  unparseable:     ${unparseable}`);
  if (noQsoSamples.length > 0) {
    console.log(`  e.g. no match: ${noQsoSamples.slice(0, 8).join(", ")}`);
  }
  if (!apply) console.log("\nRe-run with --apply to write.");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
