// The "do not contact again" list.
//
// Somebody who has asked not to be worked again has asked a PERSON, and honouring that is
// not an award-chasing preference — it is the one rule in the automatic operating path
// that exists for somebody else's benefit rather than this station's. So it is a table
// (see the DoNotCall model), it is never conditional on a setting, and the check that
// enforces it is synchronous: a station that must not be called must not have to wait on a
// query to discover that.
//
// Held as an upper-cased Set, refreshed on a short TTL and invalidated explicitly on every
// edit. The list is expected to hold tens of entries, not thousands.

import { prisma } from "@/lib/db/prisma";

/**
 * How much of a restriction an entry is.
 *
 *   NEVER     never call them at all
 *   NO_DUPES  call them only for a band+mode slot not already in the log
 *
 * Mirrors the Prisma enum, declared here so callers need not import from the client.
 */
export type DoNotCallKind = "NEVER" | "NO_DUPES";

/**
 * Long enough that a burst of decodes costs one query, short enough that adding somebody
 * takes effect within a cycle or two even if an explicit invalidation is missed.
 *
 * The explicit invalidation is the real mechanism; this is the backstop, and it is set on
 * the assumption that the failure to prefer is "we called somebody we should not have"
 * rather than "we waited a moment too long".
 */
const TTL_MS = 30_000;

let cache: { at: number; byCall: Map<string, DoNotCallKind> } | null = null;

/** Normalised form. One station, one entry — see the migration's note on case. */
export function normaliseCall(call: string): string {
  return call.trim().toUpperCase();
}

/** Drop the cache. Call after any add or remove. */
export function invalidateDoNotCall(): void {
  cache = null;
}

/**
 * The current list as a Set.
 *
 * On a database error this returns the LAST KNOWN GOOD set when there is one, and an empty
 * set otherwise. That asymmetry is deliberate and worth stating: an empty set means the
 * station will call people it should not, so a stale list is strictly better than no list.
 * The alternative — refusing to operate at all when the list cannot be read — would turn a
 * courtesy feature into a single point of failure for the whole station.
 */
export async function doNotCallMap(): Promise<Map<string, DoNotCallKind>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.byCall;
  try {
    const rows = await prisma.doNotCall.findMany({
      select: { callsign: true, kind: true },
    });
    const byCall = new Map<string, DoNotCallKind>(
      rows.map((r) => [normaliseCall(r.callsign), r.kind as DoNotCallKind]),
    );
    cache = { at: Date.now(), byCall };
    return byCall;
  } catch (err) {
    console.error(
      "[do-not-call] could not read the list:",
      err instanceof Error ? err.message : err,
    );
    return cache?.byCall ?? new Map<string, DoNotCallKind>();
  }
}

/** What restriction applies to this callsign, if any. */
export async function doNotCallKind(call: string): Promise<DoNotCallKind | null> {
  return (await doNotCallMap()).get(normaliseCall(call)) ?? null;
}

/** Add or update an entry. Idempotent on callsign. */
export async function addDoNotCall(
  call: string,
  reason: string | null,
  addedBy: string | null,
  kind: DoNotCallKind = "NEVER",
): Promise<void> {
  const callsign = normaliseCall(call);
  if (!callsign) throw new Error("A callsign is required");
  await prisma.doNotCall.upsert({
    where: { callsign },
    // A second request with a better reason should improve the entry, not fail on the
    // unique constraint and not silently keep the older, vaguer note.
    update: { reason, addedBy, kind },
    create: { callsign, reason, addedBy, kind },
  });
  invalidateDoNotCall();
}

/** Remove an entry. Returns whether one was there. */
export async function removeDoNotCall(call: string): Promise<boolean> {
  const callsign = normaliseCall(call);
  const r = await prisma.doNotCall.deleteMany({ where: { callsign } });
  invalidateDoNotCall();
  return r.count > 0;
}

export async function listDoNotCall(): Promise<
  {
    callsign: string;
    reason: string | null;
    addedBy: string | null;
    kind: DoNotCallKind;
    createdAt: Date;
  }[]
> {
  const rows = await prisma.doNotCall.findMany({
    orderBy: { callsign: "asc" },
    select: { callsign: true, reason: true, addedBy: true, kind: true, createdAt: true },
  });
  return rows.map((r) => ({ ...r, kind: r.kind as DoNotCallKind }));
}
