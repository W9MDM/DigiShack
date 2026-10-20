// Searching the settings, and the text helpers the settings page uses to show the result.
//
// Pure functions over plain objects, so `scripts/check-settings-tabs.ts` can exercise them
// without a browser and the page can call them on every keystroke: 220-odd settings is
// small enough that a linear scan per keystroke is not worth indexing.

import { groupsInTab, SETTINGS_TABS, settingsTabFor } from "@/lib/settings/tabs";

/** The parts of a setting a search looks at. */
export interface SearchableSetting {
  key: string;
  label: string;
  help?: string;
  group: string;
  options?: { value: string; label: string }[];
  /** What is wrong with it, when something is — a stored value that will not decrypt. */
  problem?: string | null;
}

/** Lower-cased words of a query, de-duplicated. Empty for a blank query. */
export function searchTerms(query: string): string[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return [...new Set(words)];
}

/** Every term appears somewhere in the haystacks — terms AND together, fields OR. */
export function matchesAllTerms(haystacks: readonly string[], terms: readonly string[]): boolean {
  if (terms.length === 0) return false;
  const lower = haystacks.map((h) => h.toLowerCase());
  return terms.every((t) => lower.some((h) => h.includes(t)));
}

export interface SearchContext {
  groupTitle: (groupId: string) => string;
}

/**
 * The settings matching a query, in registry order.
 *
 * Looks at the label, the key, the help, the group's title and the category's label — so
 * "qrz.logbookApiKey" from an error message, "FlexRadio" from a "Settings → FlexRadio"
 * hint and "automation" all find something — and at a picker's choice labels, so a font
 * name finds the font setting. A setting with a problem (see SettingView) also matches the
 * word "problem" and the problem's own text.
 */
export function searchSettings<T extends SearchableSetting>(
  items: readonly T[],
  query: string,
  ctx: SearchContext,
): T[] {
  const terms = searchTerms(query);
  if (terms.length === 0) return [];
  return items.filter((s) =>
    matchesAllTerms(
      [
        s.label,
        s.key,
        s.help ?? "",
        ctx.groupTitle(s.group),
        settingsTabFor(s.group).label,
        ...(s.options ?? []).map((o) => o.label),
        // "problem" lists every setting that has one, whatever its wording.
        s.problem ? `problem ${s.problem}` : "",
      ],
      terms,
    ),
  );
}

export interface ResultGroup<T> {
  group: string;
  items: T[];
}

export interface ResultTab<T> {
  tab: string;
  groups: ResultGroup<T>[];
}

/**
 * Search hits arranged the way the page is: category order, then each category's group
 * order, then registry order within a group. Categories and groups with no hits are left out.
 */
export function groupResults<T extends { group: string }>(
  hits: readonly T[],
  registeredGroupIds: readonly string[],
): ResultTab<T>[] {
  const byGroup = new Map<string, T[]>();
  for (const h of hits) {
    const list = byGroup.get(h.group);
    if (list) list.push(h);
    else byGroup.set(h.group, [h]);
  }
  const out: ResultTab<T>[] = [];
  for (const tab of SETTINGS_TABS) {
    const groups: ResultGroup<T>[] = [];
    for (const g of groupsInTab(tab.id, registeredGroupIds)) {
      const items = byGroup.get(g);
      if (items?.length) groups.push({ group: g, items });
    }
    if (groups.length) out.push({ tab: tab.id, groups });
  }
  return out;
}

export interface TextSegment {
  text: string;
  hit: boolean;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Split text into runs that do and do not match any term, case-insensitively.
 *
 * Overlapping and adjacent matches merge into one run, and the runs always concatenate
 * back to the original text — the page renders them in order and must not lose a letter.
 */
export function highlightSegments(text: string, terms: readonly string[]): TextSegment[] {
  if (!text) return [];
  const ranges: [number, number][] = [];
  for (const t of terms) {
    if (!t) continue;
    for (const m of text.matchAll(new RegExp(escapeRegExp(t), "gi"))) {
      const at = m.index ?? 0;
      if (m[0].length > 0) ranges.push([at, at + m[0].length]);
    }
  }
  if (ranges.length === 0) return [{ text, hit: false }];

  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }

  const out: TextSegment[] = [];
  let pos = 0;
  for (const [a, b] of merged) {
    if (a > pos) out.push({ text: text.slice(pos, a), hit: false });
    out.push({ text: text.slice(a, b), hit: true });
    pos = b;
  }
  if (pos < text.length) out.push({ text: text.slice(pos), hit: false });
  return out;
}

/** Help longer than this shows its first sentence and a "More" toggle. */
export const HELP_PREVIEW_CHARS = 160;

// "e.g." and "i.e." end in a full stop without ending the sentence, and so does an initial
// ("J. Smith"). "WSJT-X." does end one, which is why an initial needs whitespace before it.
const NOT_A_SENTENCE_END = /(?:\b(?:[Ee]\.g|[Ii]\.e|vs|approx|incl|cf)|(?:^|\s)[A-Z])\.$/;

/** Index just past the first sentence, or null when there is no usable break. */
function firstSentenceEnd(text: string): number | null {
  // A terminator, any closing quote or bracket, then whitespace and something that can
  // start a sentence. A decimal such as "0.5" never matches: no whitespace follows the dot.
  const re = /[.!?]["'”’)\]]*(?=\s+["'“‘(`]?[A-Z0-9])/g;
  for (const m of text.matchAll(re)) {
    const end = (m.index ?? 0) + m[0].length;
    if (end < 24) continue;
    if (NOT_A_SENTENCE_END.test(text.slice(Math.max(0, end - 8), end))) continue;
    return end;
  }
  return null;
}

/**
 * The part of a long help text shown before "More".
 *
 * The first sentence where there is a sensible one. When the first sentence is itself most
 * of the text, or there is no break at all, the cut falls on a word boundary instead — and
 * text only slightly over the limit is left whole, because a toggle that reveals six more
 * words costs more than it saves.
 */
export function helpPreview(
  help: string,
  limit = HELP_PREVIEW_CHARS,
): { preview: string; truncated: boolean } {
  const text = help.trim();
  if (text.length <= limit) return { preview: text, truncated: false };

  const end = firstSentenceEnd(text);
  if (end !== null && end <= limit * 1.6 && text.length - end >= 24) {
    return { preview: text.slice(0, end).trim(), truncated: true };
  }
  if (text.length <= limit + 80) return { preview: text, truncated: false };

  const space = text.lastIndexOf(" ", limit);
  const cut = space > limit * 0.5 ? space : limit;
  return { preview: `${text.slice(0, cut).replace(/[\s,;:—-]+$/, "")}…`, truncated: true };
}
