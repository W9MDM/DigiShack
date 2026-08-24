// Special-activity references on a contact — the only place that writes them.
//
// There are two representations and they must never disagree: `QsoSigRef` holds the
// full set (the authority), and `Qso.sig`/`Qso.sigInfo` hold the primary, because
// ADIF, LoTW and eQSL all need exactly one value per contact. Two representations
// is a bug factory unless exactly one function maintains both, so this is it.
// `scripts/check-pota-refs.ts` asserts across the whole database that they agree.
//
// Why a set at all: parks nest and overlap. Working an activator at Indiana Dunes is
// US-0765 and US-2258 at the same time — the national park and the state park inside
// it — and both are true. Measured against POTA's record of this station, 126 of 863
// park contacts carry more than one reference and four carry five.

import { prisma } from "@/lib/db/prisma";
import { normaliseRefs } from "@/lib/pota/ref-list";

/** A minimal Prisma client surface, so this works inside a transaction too. */
type Db = Pick<typeof prisma, "qso" | "qsoSigRef">;

export interface SetRefsResult {
  added: string[];
  removed: string[];
  primary: string | null;
}


/**
 * Replace the references for one programme on one contact.
 *
 * Order is significant: the first reference becomes the primary and is what ADIF
 * exports. An empty list clears the programme entirely.
 *
 * Scoped to a single `sig` so that setting POTA parks cannot disturb a SOTA summit on
 * the same contact — an activator on a hilltop in a park is both, and they are
 * separate programmes with separate awards.
 */
export async function setSigRefs(
  db: Db,
  qsoId: string,
  sig: string,
  refs: readonly string[],
): Promise<SetRefsResult> {
  const programme = sig.trim().toUpperCase();
  const wanted = normaliseRefs(refs);

  const existing = await db.qsoSigRef.findMany({
    where: { qsoId, sig: programme },
    select: { sigInfo: true },
  });
  const have = new Set(existing.map((e) => e.sigInfo));

  const toAdd = wanted.filter((r) => !have.has(r));
  const toRemove = [...have].filter((r) => !wanted.includes(r));

  if (toRemove.length > 0) {
    await db.qsoSigRef.deleteMany({
      where: { qsoId, sig: programme, sigInfo: { in: toRemove } },
    });
  }
  if (toAdd.length > 0) {
    await db.qsoSigRef.createMany({
      data: toAdd.map((sigInfo) => ({ qsoId, sig: programme, sigInfo, primary: false })),
      skipDuplicates: true,
    });
  }

  // Exactly one primary per programme, and it is the first of the list given.
  const primary = wanted[0] ?? null;
  await db.qsoSigRef.updateMany({
    where: { qsoId, sig: programme },
    data: { primary: false },
  });
  if (primary) {
    await db.qsoSigRef.updateMany({
      where: { qsoId, sig: programme, sigInfo: primary },
      data: { primary: true },
    });
  }

  // Mirror onto the QSO. When several programmes are present the mirror can only
  // hold one, so the programme just written wins — it is the one the operator or the
  // importer was working on. Clearing this programme falls back to whatever else the
  // contact still carries rather than blanking a SOTA summit by accident.
  if (primary) {
    await db.qso.update({
      where: { id: qsoId },
      data: { sig: programme, sigInfo: primary },
    });
  } else {
    const other = await db.qsoSigRef.findFirst({
      where: { qsoId },
      orderBy: [{ primary: "desc" }, { sigInfo: "asc" }],
      select: { sig: true, sigInfo: true },
    });
    await db.qso.update({
      where: { id: qsoId },
      data: { sig: other?.sig ?? null, sigInfo: other?.sigInfo ?? null },
    });
  }

  return { added: toAdd, removed: toRemove, primary };
}

/**
 * Add references without removing any.
 *
 * What an import wants. POTA reporting US-2258 for a contact already carrying
 * US-0765 is not a correction — they are two parks in the same place, and both
 * belong on the record.
 */
export async function addSigRefs(
  db: Db,
  qsoId: string,
  sig: string,
  refs: readonly string[],
): Promise<SetRefsResult> {
  const programme = sig.trim().toUpperCase();
  const existing = await db.qsoSigRef.findMany({
    where: { qsoId, sig: programme },
    orderBy: [{ primary: "desc" }, { createdAt: "asc" }],
    select: { sigInfo: true },
  });
  // Existing order first, so an established primary stays the primary.
  return setSigRefs(db, qsoId, programme, [...existing.map((e) => e.sigInfo), ...normaliseRefs(refs)]);
}

/** Every reference on a contact, primary first. */
export async function getSigRefs(
  db: Db,
  qsoId: string,
): Promise<{ sig: string; sigInfo: string; primary: boolean }[]> {
  return db.qsoSigRef.findMany({
    where: { qsoId },
    orderBy: [{ primary: "desc" }, { sigInfo: "asc" }],
    select: { sig: true, sigInfo: true, primary: true },
  });
}
