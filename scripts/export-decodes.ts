/* eslint-disable no-console */
// Everything in DigitalDecode, out to the same per-UTC-day CSVs the bridge writes.
//
//   npm run export:decodes                 -- into digital.decodeCsvDir
//   npm run export:decodes -- --dir path   -- somewhere else
//   npm run export:decodes -- --overwrite  -- replace files that already exist
//
// For turning on the CSV log after the fact: the bridge only writes decodes it hears
// from the moment it starts, and the database already holds however many days of
// history the retention setting has kept. Without this the files would begin abruptly
// at whatever moment the setting was switched on.
//
// REFUSES to touch a file that already exists, unless --overwrite. The whole value of
// these files is that they are a faithful record, and appending a second copy of a day
// on top of the first is the fastest way to make them untrustworthy. Combined with the
// bridge appending live decodes to today's file, a careless re-run would otherwise
// duplicate every row of today.
//
// Two columns are empty on exported rows and cannot be otherwise: DT, which the table
// has never stored, and the radio, which was not recorded before 1.6.0. Both are left
// blank rather than guessed.

import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { prisma } from "@/lib/db/prisma";
import { DecodeCsvLog, fileNameFor, type DecodeRow } from "@/lib/radio/decode-log";
import { getSetting } from "@/lib/settings";
import { callsignFromMessage } from "@/lib/wsjtx/protocol";

/** Rows per query. Big enough that 112k rows is a handful of round trips, small enough
 * that the process never holds a meaningful fraction of the table. */
const BATCH = 5_000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const overwrite = process.argv.includes("--overwrite");
  const dir = arg("dir") ?? (await getSetting("digital.decodeCsvDir"))?.trim();
  if (!dir) {
    console.error(
      "No output directory. Set digital.decodeCsvDir in Settings, or pass --dir <path>.",
    );
    process.exit(1);
  }

  const total = await prisma.digitalDecode.count();
  if (total === 0) {
    console.log("Nothing to export — DigitalDecode is empty.");
    return;
  }

  const first = await prisma.digitalDecode.findFirst({
    orderBy: { timestamp: "asc" },
    select: { timestamp: true },
  });
  const last = await prisma.digitalDecode.findFirst({
    orderBy: { timestamp: "desc" },
    select: { timestamp: true },
  });
  console.log(
    `${total.toLocaleString()} decodes, ${first?.timestamp.toISOString()} .. ${last?.timestamp.toISOString()}`,
  );
  console.log(`writing to ${dir}`);

  const log = new DecodeCsvLog(dir, (m) => console.error(`  write failed: ${m}`));
  await log.open();

  // Which day files this export will touch, so a collision is reported before a single
  // row is written rather than half way through.
  const days = new Set<string>();
  for (let d = new Date(first!.timestamp); d <= last!.timestamp; d.setUTCDate(d.getUTCDate() + 1)) {
    days.add(fileNameFor(d));
  }
  days.add(fileNameFor(last!.timestamp));

  const existing = new Set(await readdir(dir).catch(() => []));
  const clashes = [...days].filter((f) => existing.has(f));
  if (clashes.length > 0 && !overwrite) {
    console.error(
      `\nRefusing to write: ${clashes.length} file(s) already exist —\n  ${clashes.join("\n  ")}\n\n` +
        "Appending a second copy of a day on top of the first is how these files stop being\n" +
        "trustworthy. Re-run with --overwrite to replace them, or point --dir somewhere else.",
    );
    process.exit(1);
  }
  for (const f of clashes) await rm(join(dir, f));

  let done = 0;
  let cursor: string | undefined;
  const perDay = new Map<string, number>();

  for (;;) {
    const rows = await prisma.digitalDecode.findMany({
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      // By id, not timestamp: a cursor needs a unique ordering, and thirty decodes share
      // a timestamp to the second on every FT8 window.
      orderBy: { id: "asc" },
      select: {
        id: true,
        timestamp: true,
        band: true,
        mode: true,
        snr: true,
        freqOffset: true,
        message: true,
      },
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1]!.id;

    const out: DecodeRow[] = rows.map((r) => ({
      at: r.timestamp,
      band: r.band,
      mode: r.mode,
      snr: r.snr,
      // Never stored, and not worth inventing: a zero would read as perfect timing.
      dt: null,
      offsetHz: r.freqOffset,
      // The table keeps the offset within the passband but not the dial it sat on, so
      // the absolute frequency of a historical decode is not recoverable.
      dialHz: null,
      message: r.message,
      callsign: callsignFromMessage(r.message),
      // Only recorded from 1.6.0, and not on this table at all.
      radio: null,
    }));

    await log.append(out);
    for (const r of out) {
      const f = fileNameFor(r.at);
      perDay.set(f, (perDay.get(f) ?? 0) + 1);
    }

    done += rows.length;
    process.stdout.write(`\r  ${done.toLocaleString()} / ${total.toLocaleString()}`);
  }
  process.stdout.write("\n\n");

  for (const [file, n] of [...perDay].sort()) {
    console.log(`  ${file}  ${n.toLocaleString()} decodes`);
  }
  console.log(`\n${done.toLocaleString()} exported.`);

  await prisma.$disconnect();
}

void main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
