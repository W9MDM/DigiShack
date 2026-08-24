// Rebuild the exchange for contacts logged before anything recorded it.
//
// The `transcript` column and the decode-to-contact link both arrived after this log had
// tens of thousands of contacts in it. The raw decodes are still in the database for as
// long as retention keeps them, so for any contact inside that window the exchange can be
// reassembled from what was actually received off the air.
//
// WHAT THIS CANNOT DO, and it is most of the log. `DigitalDecode` rows are pruned on a
// retention cutoff, so there are no decodes at all from before the window — and for those
// contacts the exchange was never recorded anywhere. This is not a partial import that
// could be improved later; the data does not exist. Run with no arguments to see how far
// back it can reach on this install.
//
// Usage:
//   tsx scripts/backfill-transcripts.ts            # report only, changes nothing
//   tsx scripts/backfill-transcripts.ts --write    # link decodes and write transcripts
//   tsx scripts/backfill-transcripts.ts --write --force   # also redo contacts that have one

import { prisma } from "@/lib/db/prisma";
import { linkWindow, sentByEither } from "@/lib/digital/decode-link";
import { parseMessage } from "@/lib/digital/qso";
import { formatTranscript, type TranscriptEntry } from "@/lib/digital/transcript";

const DIGITAL_MODES = ["FT8", "FT4", "FT2"];

/** Who sent a message, or null when it cannot be read from it. */
function senderOf(message: string): string | null {
  const p = parseMessage(message);
  return p.kind === "cq" || p.kind === "directed" ? p.from : null;
}

const write = process.argv.includes("--write");
const force = process.argv.includes("--force");

async function main(): Promise<void> {
  const span = await prisma.digitalDecode.aggregate({
    _count: true,
    _min: { timestamp: true },
    _max: { timestamp: true },
  });

  if (!span._min.timestamp || span._count === 0) {
    console.log("No decodes are stored, so there is nothing to rebuild from.");
    return;
  }

  console.log(
    `${span._count.toLocaleString()} decode(s) stored, ` +
      `${span._min.timestamp.toISOString()} to ${span._max.timestamp?.toISOString()}`,
  );

  const station = await prisma.station.findFirst({
    orderBy: { createdAt: "asc" },
    select: { callsign: true },
  });
  const myCall = station?.callsign?.toUpperCase() ?? "";
  if (!myCall) {
    console.log("No station callsign is set, so our own transmissions cannot be identified.");
    return;
  }

  // Only contacts the decodes could possibly cover. Everything earlier is unreachable,
  // and counted separately so the report says so rather than quietly ignoring it.
  const reachable = {
    mode: { in: DIGITAL_MODES },
    startTime: { gte: new Date(span._min.timestamp.getTime() - 60_000) },
  };
  const unreachable = await prisma.qso.count({
    where: {
      mode: { in: DIGITAL_MODES },
      startTime: { lt: new Date(span._min.timestamp.getTime() - 60_000) },
      transcript: null,
    },
  });

  const candidates = await prisma.qso.findMany({
    where: force ? reachable : { ...reachable, transcript: null },
    select: {
      id: true,
      callsign: true,
      band: true,
      mode: true,
      startTime: true,
      endTime: true,
      transcript: true,
    },
    orderBy: { startTime: "asc" },
  });

  console.log(
    `${candidates.length.toLocaleString()} contact(s) inside that window ` +
      `${force ? "(including ones that already have a transcript)" : "with no transcript"}; ` +
      `${unreachable.toLocaleString()} older one(s) can never be rebuilt — no decodes survive from then.\n`,
  );

  let rebuilt = 0;
  let nothingFound = 0;
  let linked = 0;
  let ourOwn = 0;

  for (const qso of candidates) {
    const window = linkWindow(qso);
    const rows = await prisma.digitalDecode.findMany({
      where: {
        timestamp: { gte: window.from, lte: window.to },
        band: qso.band,
        mode: qso.mode,
      },
      select: { id: true, timestamp: true, message: true, snr: true, freqOffset: true },
      orderBy: { timestamp: "asc" },
    });

    // What the two stations SENT, not every message that names them — a third station
    // calling ours is a different conversation. See sentByEither.
    const mine = rows.filter((r) => sentByEither(r.message, senderOf, qso.callsign, myCall));
    if (mine.length === 0) {
      nothingFound++;
      continue;
    }

    const entries: TranscriptEntry[] = mine.map((r) => {
      // Direction comes from the message's OWN sender field, not from a guess.
      //
      // Almost everything here is receive: our transmissions were never decoded, because
      // a radio cannot hear itself. The exception is real and useful — the Icom streams
      // receive audio straight through a transmission, so until that was fixed in 1.27.0
      // our own transmissions came back as decodes. For contacts made on the Icom in that
      // period this reconstructs BOTH sides of the exchange, off the air, as sent.
      const from = senderOf(r.message);
      const isOurs = from !== null && from.toUpperCase() === myCall;
      if (isOurs) ourOwn++;
      return {
        at: r.timestamp.getTime(),
        dir: isOurs ? "tx" : "rx",
        message: r.message,
        // A signal report on our own transmission is what the receiver heard of it, which
        // is not a report anybody sent — dropped rather than presented as one.
        snr: isOurs ? null : r.snr,
        offsetHz: r.freqOffset,
      };
    });

    const body = formatTranscript(entries);
    if (!body) {
      nothingFound++;
      continue;
    }

    // Labelled, because it is not the same artefact as a transcript written live. A live
    // one has every transmission, including the ones that were refused and why. This has
    // only what was decoded, so an absent message means "not recorded", not "not sent".
    const transcript =
      `[reconstructed from stored decodes — receive side unless marked TX]\n${body}`;

    if (write) {
      await prisma.qso.update({ where: { id: qso.id }, data: { transcript } });
      const r = await prisma.digitalDecode.updateMany({
        where: { id: { in: mine.map((d) => d.id) } },
        data: { qsoId: qso.id },
      });
      linked += r.count;
    } else {
      linked += mine.length;
    }
    rebuilt++;

    if (rebuilt <= 3) {
      console.log(`${qso.startTime.toISOString()} ${qso.callsign} ${qso.band} ${qso.mode}`);
      for (const line of body.split("\n").slice(0, 8)) console.log(`  ${line}`);
      console.log("");
    }
  }

  console.log(
    `${write ? "Rebuilt" : "Would rebuild"} ${rebuilt.toLocaleString()} transcript(s) from ` +
      `${linked.toLocaleString()} decode(s), of which ${ourOwn.toLocaleString()} were our own ` +
      `transmissions heard back.`,
  );
  console.log(
    `${nothingFound.toLocaleString()} contact(s) had no matching decode — worked on a band or ` +
      `at a time nothing was stored for, or logged by an external decoder.`,
  );
  if (!write) console.log("\nNothing was changed. Pass --write to apply.");
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
