// Pruning the decode log.
//
// A busy band produces roughly 42,000 decodes a day — measured, not estimated — which
// is about 10 MB a day, 3.7 GB a year, and it was growing without limit. Nothing was
// ever deleted. That fills a disk eventually, and long before that it dominates every
// backup: the dump is already the largest thing in a bundle and most of it would
// become decode history nobody will read.
//
// Two things are never pruned, whatever the retention:
//
//   * Decodes attached to a logged QSO. Those are the evidence of the contact — what
//     was actually heard, at what SNR, in which window — and the QSO detail page
//     shows them. They are a handful of rows per contact and they are worth keeping
//     forever.
//   * Anything at all when retention is 0, which means "keep everything" for an
//     operator who wants the full history and has the disk for it.

import { prisma } from "@/lib/db/prisma";

/** Rows per DELETE. Large enough to be quick, small enough not to hold a long lock. */
const BATCH = 5_000;

export interface PruneResult {
  deleted: number;
  /** Rows kept because they belong to a logged contact. */
  keptLinked: number;
  olderThan: Date | null;
}

/**
 * Delete unattached decodes older than `days`.
 *
 * Batched rather than one statement: a single DELETE over a million rows takes a lock
 * long enough that the bridge's own inserts start timing out, which turns tidying up
 * into dropped decodes.
 */
export async function pruneDecodes(days: number): Promise<PruneResult> {
  if (!Number.isFinite(days) || days <= 0) {
    return { deleted: 0, keptLinked: 0, olderThan: null };
  }

  const cutoff = new Date(Date.now() - days * 86_400_000);
  let deleted = 0;

  for (;;) {
    // `qsoId: null` is the whole safety property here. Everything attached to a
    // contact survives regardless of age.
    const batch = await prisma.digitalDecode.findMany({
      where: { timestamp: { lt: cutoff }, qsoId: null },
      select: { id: true },
      take: BATCH,
    });
    if (batch.length === 0) break;

    const { count } = await prisma.digitalDecode.deleteMany({
      where: { id: { in: batch.map((r) => r.id) } },
    });
    deleted += count;
    if (batch.length < BATCH) break;
  }

  const keptLinked = await prisma.digitalDecode.count({
    where: { timestamp: { lt: cutoff }, NOT: { qsoId: null } },
  });

  return { deleted, keptLinked, olderThan: cutoff };
}
