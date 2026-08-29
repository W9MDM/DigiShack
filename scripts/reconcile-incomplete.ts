/* eslint-disable no-console */
// Promote incomplete exchanges that OTHER EVIDENCE says were real contacts.
//
// An incomplete exchange is one where reports crossed both ways and no acknowledgement was
// decoded. That fits two very different situations — a contact the far station kept, and one
// they gave up on — which is why `pages/api/incomplete/[id].ts` refuses to promote anything
// on its own and says so in its header.
//
// This does not change that. It finds the ones where something OUTSIDE the failed exchange
// says the contact happened, prints the evidence, and writes only with `--write`. Two
// sources, both independent of the sequencer that failed:
//
//   1. A CARD REQUEST from that callsign for that date, with no logged QSO to satisfy it.
//      The strongest evidence there is — the other operator logged the contact and is asking
//      you to confirm it. This is the reconciliation CLAUDE.md already describes ("13
//      requests for August 2026 had no QSO here") done as a query rather than by eye.
//
//      Card requests are NOT in this database; they live on QRZ or eQSL. So they are passed
//      in rather than invented from a table that does not exist:
//
//          --requests=cards.txt        CALLSIGN and YYYY-MM-DD somewhere on each line
//
//      Anything after a `#` is ignored and the parser takes the first callsign-shaped token
//      and the first date on a line, so a block pasted straight out of a web page works
//      without being reformatted by hand.
//
//   2. AN ACKNOWLEDGEMENT WE DECODED. A message from them, addressed to us, carrying RR73,
//      RRR or 73, sitting in the decode log. We heard them close the contact and the
//      sequencer did not act on it. Bounded by how long decodes are kept.
//
// Run it with no `--write` first: it writes nothing and prints exactly what it would do.
//
//     npx tsx scripts/reconcile-incomplete.ts --requests=cards.txt
//     npx tsx scripts/reconcile-incomplete.ts --requests=cards.txt --write --by=you@example.com

import { readFileSync } from "node:fs";

import { prisma } from "@/lib/db/prisma";
import { promoteIncomplete } from "@/lib/qso/promote-incomplete";

const WRITE = process.argv.includes("--write");
const BY =
  process.argv.find((a) => a.startsWith("--by="))?.slice("--by=".length) ??
  "reconcile-incomplete";

/** How long after the exchange an acknowledgement still counts as belonging to it. */
const ACK_WINDOW_MS = 20 * 60_000;

/** Callsign -> the QSO dates that station has requested a card for. */
function loadRequests(): Map<string, string[]> {
  const arg = process.argv.find((a) => a.startsWith("--requests="));
  const out = new Map<string, string[]>();
  if (!arg) return out;

  const text = readFileSync(arg.slice("--requests=".length), "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split("#")[0]!.trim();
    if (!line) continue;
    const call = /\b([A-Z0-9]{1,3}[0-9][A-Z0-9]*[A-Z])\b/i.exec(line)?.[1];
    const date = /\b(\d{4}-\d{2}-\d{2})\b/.exec(line)?.[1];
    if (!call || !date) continue;
    const key = call.toUpperCase();
    out.set(key, [...(out.get(key) ?? []), date]);
  }
  return out;
}

interface Candidate {
  id: string;
  callsign: string;
  band: string;
  startedAt: Date;
  evidence: string;
}

async function main(): Promise<void> {
  const station = await prisma.station.findFirst({ select: { callsign: true } });
  const myCall = station?.callsign?.toUpperCase();
  if (!myCall) {
    console.error("No station callsign — cannot tell which messages were addressed to us.");
    process.exit(1);
  }

  const requests = loadRequests();
  console.log(`card requests supplied    : ${requests.size} callsign(s)`);

  const open = await prisma.incompleteExchange.findMany({
    where: { promotedQsoId: null, dismissedAt: null },
    orderBy: { startedAt: "desc" },
  });
  console.log(`open incomplete exchanges : ${open.length}`);

  const found: Candidate[] = [];

  for (const x of open) {
    const day = new Date(
      Date.UTC(x.startedAt.getUTCFullYear(), x.startedAt.getUTCMonth(), x.startedAt.getUTCDate()),
    );
    const nextDay = new Date(day.getTime() + 24 * 3600_000);
    const dayStr = day.toISOString().slice(0, 10);

    // --- 1. A card request for that callsign on that date, with nothing logged to match ---
    const claimed = requests.get(x.callsign.toUpperCase()) ?? [];
    if (claimed.includes(dayStr)) {
      // Only when nothing already logged satisfies it. A station worked twice may have a
      // request for the contact that DID complete, and that request says nothing about
      // this exchange.
      const logged = await prisma.qso.count({
        where: { callsign: x.callsign, startTime: { gte: day, lt: nextDay } },
      });
      if (logged === 0) {
        found.push({
          id: x.id,
          callsign: x.callsign,
          band: x.band,
          startedAt: x.startedAt,
          evidence:
            `${x.callsign} requested a QSL card for ${dayStr} and no contact was logged ` +
            `on that date — they hold this QSO`,
        });
        continue;
      }
    }

    // --- 2. An acknowledgement we decoded but never acted on ---
    const rows = await prisma.digitalDecode.findMany({
      where: {
        timestamp: { gte: x.startedAt, lte: new Date(x.startedAt.getTime() + ACK_WINDOW_MS) },
        message: { startsWith: `${myCall} ` },
      },
      orderBy: { timestamp: "asc" },
      select: { timestamp: true, message: true },
    });
    const ack = rows.find(
      (d) =>
        new RegExp(`^${myCall}\\s+${x.callsign}\\b`, "i").test(d.message.trim()) &&
        /\b(RR73|RRR|73)\b/i.test(d.message),
    );
    if (ack) {
      found.push({
        id: x.id,
        callsign: x.callsign,
        band: x.band,
        startedAt: x.startedAt,
        evidence:
          `decoded "${ack.message.trim()}" at ${ack.timestamp.toISOString().slice(11, 19)}Z ` +
          `— they acknowledged and the sequencer did not act on it`,
      });
    }
  }

  console.log(`with independent evidence : ${found.length}`);
  console.log("");
  for (const c of found) {
    console.log(
      `  ${c.callsign.padEnd(8)} ${c.band.padEnd(4)} ${c.startedAt.toISOString().slice(0, 16)}Z`,
    );
    console.log(`      ${c.evidence}`);
  }

  if (!WRITE) {
    console.log("");
    console.log("Nothing written. Re-run with --write --by=<who> to promote these.");
    await prisma.$disconnect();
    return;
  }

  console.log("");
  let made = 0;
  for (const c of found) {
    const r = await promoteIncomplete(c.id, { because: c.evidence, by: BY });
    if (!r) {
      console.log(`  ${c.callsign}: vanished before it could be promoted`);
      continue;
    }
    if (r.alreadyPromoted) {
      console.log(`  ${c.callsign}: already a contact (${r.qsoId})`);
      continue;
    }
    made++;
    console.log(`  ${c.callsign}: logged as ${r.qsoId}`);
  }
  console.log("");
  console.log(`Promoted ${made} contact(s).`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
