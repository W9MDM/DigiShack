// Parsing and formatting a reference list — pure, and deliberately in its own file.
//
// `lib/pota/refs.ts` imports Prisma, and the QSO form needs these two functions. A
// client component importing from there would pull the database client into the
// browser bundle, so the pure half lives here where anything can use it.

/** Upper-case, trimmed, de-duplicated, order preserved. */
export function normaliseRefs(refs: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of refs) {
    const u = r.trim().toUpperCase();
    if (u && !seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  }
  return out;
}

/**
 * Parse a reference list as an operator would type it.
 *
 * Commas, spaces and semicolons all separate, because a two-fer gets written down
 * with whichever of those the operator reaches for first.
 */
export function parseRefList(input: string | null | undefined): string[] {
  if (!input) return [];
  return normaliseRefs(input.split(/[,;\s]+/));
}

/** Render a reference list back for an input field. */
export function formatRefList(refs: readonly string[]): string {
  return refs.join(", ");
}
