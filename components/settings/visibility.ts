// What a settings group shows by default, and what it may fold away.
//
// THE RULE: an Advanced disclosure only ever hides settings that are exactly as a fresh
// install has them. A setting that differs from its default, holds an unsaved edit, or has
// a stored value that cannot be decrypted is drawn outside the disclosure — the settings
// diet (1.221.0) folded away the rarely-changed knobs, and a knob turned months ago that
// is now behind a closed "Advanced (6)" is how a station ends up behaving in a way nobody
// can find the reason for.
//
// Pure, with no React and no imports, so `scripts/check-settings-tabs.ts` can exercise the
// rule without a browser.

/** The facts about a setting that decide whether it may be folded away. */
export interface FoldFacts {
  customised: boolean;
  unreadable: boolean;
  problem: string | null;
}

/** Never behind a disclosure: differs from the default as stored, or cannot be read. */
export function staysInView(s: FoldFacts): boolean {
  return s.customised || s.unreadable || s.problem !== null;
}

/** One row of a group, reduced to what layout needs. */
export interface RowFacts {
  id: string;
  advanced: boolean;
  /** Stored non-default or unreadable — see `staysInView`. Changes only when a save lands. */
  kept: boolean;
  /** Holds an unsaved edit. */
  dirty: boolean;
}

export interface GroupLayout {
  /** Rows drawn in the group's body, in order. */
  visible: string[];
  /** Rows behind the Advanced disclosure (or the whole of a quiet group), in order. */
  folded: string[];
  /**
   * Nothing to show until asked: every row is advanced and at its default, and the group
   * has no panel of its own. Drawn as one line rather than as an empty card.
   */
  quiet: boolean;
  /** The ids to remember as `held` for the next render. */
  held: string[];
}

/**
 * Split a group's rows into the ones shown and the ones folded away.
 *
 * `open` is whether the disclosure is open. An unsaved edit to an advanced row is shown
 * outside it while it is closed — typed into from a search, or the disclosure closed on it
 * — and stays out (`held`) until the disclosure is next opened, so that undoing the edit
 * while it is outside does not snatch the field away from under the cursor.
 */
export function layoutGroup(
  rows: readonly RowFacts[],
  o: { open: boolean; held: ReadonlySet<string>; hasExtra: boolean },
): GroupLayout {
  const visible: string[] = [];
  const folded: string[] = [];
  const held: string[] = [];
  for (const r of rows) {
    const out =
      !r.advanced || r.kept || (!o.open && (r.dirty || o.held.has(r.id)));
    (out ? visible : folded).push(r.id);
    if (!o.open && r.advanced && !r.kept && (r.dirty || o.held.has(r.id))) held.push(r.id);
  }
  return {
    visible,
    folded,
    quiet: !o.hasExtra && rows.length > 0 && visible.length === 0,
    held,
  };
}

/**
 * Whether a group belongs under "More" — in the sidebar and at the foot of its category.
 *
 * Decided from what is STORED, not from the draft, so a group does not jump to a new place
 * on the page at the first keystroke; it moves when a save lands.
 */
export function isQuietGroup(rows: readonly Pick<RowFacts, "advanced" | "kept">[], hasExtra: boolean): boolean {
  return !hasExtra && rows.length > 0 && rows.every((r) => r.advanced && !r.kept);
}

/** In a field whose stored value will not decrypt, in place of the usual placeholder. */
export const UNREADABLE_PLACEHOLDER = "Stored value can't be decrypted — re-enter it";

/** The warning under such a field: the server's explanation when it sent one. */
export function unreadableNotice(s: { unreadable: boolean; problem: string | null }): string | null {
  if (!s.unreadable && s.problem === null) return null;
  return s.problem ?? `${UNREADABLE_PLACEHOLDER}.`;
}

/** One line of a group's blurb, for a folded group's row: its first sentence, plain text. */
export function blurbLine(blurb: string | undefined, limit = 140): string {
  if (!blurb) return "";
  const text = blurb.replace(/`/g, "").replace(/\s+/g, " ").trim();
  const m = /^(.{24,}?[.!?])\s+[A-Z0-9("'“]/.exec(text);
  const first = m?.[1] ?? text;
  if (first.length <= limit) return first;
  const cut = first.lastIndexOf(" ", limit);
  return `${first.slice(0, cut > limit / 2 ? cut : limit).replace(/[\s,;:—-]+$/, "")}…`;
}
