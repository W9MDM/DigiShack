import { compositeFor, type CompositeField } from "@/components/settings/group-extras";
import type { ClientSetting, SettingsEditor } from "@/components/settings/types";
import { staysInView, type RowFacts } from "@/components/settings/visibility";

/** One row on the page: a setting, or several settings drawn as one control. */
export type DisplayItem =
  | { kind: "setting"; id: string; setting: ClientSetting; advanced: boolean }
  | {
      kind: "composite";
      id: string;
      composite: CompositeField;
      settings: ClientSetting[];
      advanced: boolean;
    };

/** The DOM id of the row that shows a setting — a composite's rows share its first key's. */
export function rowIdFor(key: string): string {
  const c = compositeFor(key);
  return `setting-${c ? c.keys[0] : key}`;
}

export function groupIdFor(group: string): string {
  return `group-${group}`;
}

/**
 * Rows for a list of settings, in order. A composite takes the place of the first of its
 * settings that appears, and carries ALL of its settings — a search that matched only
 * "PA cooldown rest" still has to show the control that edits it.
 */
export function displayItems(
  settings: readonly ClientSetting[],
  byKey: ReadonlyMap<string, ClientSetting>,
): DisplayItem[] {
  const out: DisplayItem[] = [];
  const emitted = new Set<string>();
  for (const s of settings) {
    const c = compositeFor(s.key);
    if (!c) {
      out.push({ kind: "setting", id: rowIdFor(s.key), setting: s, advanced: s.advanced });
      continue;
    }
    if (emitted.has(c.id)) continue;
    emitted.add(c.id);
    const parts = c.keys
      .map((k) => byKey.get(k))
      .filter((x): x is ClientSetting => x !== undefined);
    out.push({
      kind: "composite",
      id: rowIdFor(s.key),
      composite: c,
      settings: parts,
      // Behind the disclosure only when every half is: half a control hidden is a trap.
      advanced: parts.length > 0 && parts.every((p) => p.advanced),
    });
  }
  return out;
}

/** The settings a row stands for. */
export function itemSettings(item: DisplayItem): ClientSetting[] {
  return item.kind === "setting" ? [item.setting] : item.settings;
}

/** What `layoutGroup` needs to know about a row. `editor` is omitted for the stored state alone. */
export function rowFacts(item: DisplayItem, editor?: Pick<SettingsEditor, "isDirty">): RowFacts {
  const parts = itemSettings(item);
  return {
    id: item.id,
    advanced: item.advanced,
    kept: parts.some(staysInView),
    dirty: editor ? parts.some((s) => editor.isDirty(s.key)) : false,
  };
}
