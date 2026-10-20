// The one normalisation every stored or compared callsign goes through.
//
// Trimmed and upper-cased, nothing more: no prefix or suffix stripping, no portable
// designators removed. `K9XYZ/P` and `K9XYZ` are different keys on purpose, and anything
// that wants them equal has to say so where it compares them.

/** A callsign as it is stored and looked up: trimmed, upper-cased. */
export function normaliseCall(call: string): string {
  return call.trim().toUpperCase();
}
