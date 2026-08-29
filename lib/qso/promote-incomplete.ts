import { prisma } from "@/lib/db/prisma";
import { resolveDxcc } from "@/lib/dxcc/resolve";

// Promoting an incomplete exchange to a contact, in ONE place.
//
// Extracted from `pages/api/incomplete/[id].ts` so that a bulk reconciliation can use the
// same code rather than a second copy of it. The copy is the thing worth avoiding: this
// writes a QSO that the upload sweeps then send to LoTW, QRZ and eQSL as a claim against
// somebody else's log, and two implementations of that would eventually disagree about
// the DXCC entity, the provenance note, or which fields carry over.
//
// PROMOTION REMAINS A DELIBERATE ACT. Nothing here promotes anything on its own — the
// endpoint requires an ADMIN, and the reconciliation script requires the evidence to be
// passed in and recorded. What is removed is the duplication, not the deliberation.

export interface PromoteResult {
  qsoId: string;
  /** True when it was already a contact; promoting twice must not create a second. */
  alreadyPromoted: boolean;
}

/**
 * Turn one incomplete exchange into a logged contact.
 *
 * `because` is the evidence, and it is not decoration: it lands in the QSO's notes so a
 * reader in a year knows this was promoted rather than logged live, and on what grounds.
 * `by` identifies who decided.
 */
export async function promoteIncomplete(
  id: string,
  opts: { because?: string; by: string },
): Promise<PromoteResult | null> {
  const x = await prisma.incompleteExchange.findUnique({ where: { id } });
  if (!x) return null;

  // Idempotent rather than an error: a double-click, or a re-run of a reconciliation,
  // must not produce a second contact with the same station at the same minute.
  if (x.promotedQsoId) return { qsoId: x.promotedQsoId, alreadyPromoted: true };

  // The entity is resolved HERE, not left for a backfill. Every contact this station
  // logged itself was once missing dxcc, cqZone and continent, and none of them counted
  // toward an award — see the note in services/radio/operating.ts.
  let entity: { adif: number; cqZone: number | null; continent: string | null } | null = null;
  try {
    const r = await resolveDxcc(x.callsign, x.startedAt);
    if (r.status === "found") {
      entity = { adif: r.match.adif, cqZone: r.match.cqZone, continent: r.match.continent };
    }
  } catch {
    /* no cty data loaded — the contact is still worth having */
  }

  const why = opts.because?.trim();
  const created = await prisma.qso.create({
    data: {
      callsign: x.callsign,
      band: x.band,
      mode: x.mode,
      freqHz: x.freqHz ?? BigInt(0),
      startTime: x.startedAt,
      endTime: x.endedAt,
      rstSent: x.reportSent,
      rstRcvd: x.reportRcvd,
      gridSquare: x.gridSquare,
      dxcc: entity?.adif ?? null,
      cqZone: entity?.cqZone ?? null,
      continent: entity?.continent ?? null,
      stationId: x.stationId,
      // The provenance travels WITH the contact, not only on the row it came from.
      notes:
        `Promoted from an incomplete exchange: reports exchanged both ways, no acknowledgement ` +
        `decoded (${x.stage}). Promoted by ${opts.by}` +
        (why ? ` — ${why}` : "") +
        (x.transcript ? `\n\n${x.transcript}` : ""),
    },
    select: { id: true },
  });

  await prisma.incompleteExchange.update({
    where: { id },
    data: { promotedQsoId: created.id },
  });

  return { qsoId: created.id, alreadyPromoted: false };
}
