// What the settings page needs to know about a setting beyond what GET /api/settings sends.
//
// Read from the registry in the browser rather than added to the API: the registry is
// already client-safe (see lib/qsl/font-list.ts), it is the same build as the server, and
// it keeps the settings API exactly as it was. The cost is the registry in the settings
// page's bundle — about 30 KB gzipped, nearly all of it help text.

import { SETTING_GROUPS, SETTINGS, type SettingDef } from "@/lib/settings/registry";

const DEFS: ReadonlyMap<string, SettingDef> = new Map(SETTINGS.map((d) => [d.key, d]));

export function settingDef(key: string): SettingDef | undefined {
  return DEFS.get(key);
}

export function groupOfSetting(key: string): string | undefined {
  return DEFS.get(key)?.group;
}

/** Every group the registry declares, for the sidebar. */
export interface NavGroup {
  id: string;
  title: string;
  /** Every setting in it is advanced, so the page shows it as one folded line. */
  advancedOnly: boolean;
}

export function navGroups(): NavGroup[] {
  return SETTING_GROUPS.map((g) => {
    const defs = SETTINGS.filter((d) => d.group === g.id);
    return {
      id: g.id,
      title: g.title,
      advancedOnly: defs.length > 0 && defs.every((d) => d.advanced === true),
    };
  });
}

/** What `resolveSettingsLocation` needs to know about the registry. */
export const SETTINGS_LOOKUP = {
  groupIds: SETTING_GROUPS.map((g) => g.id) as readonly string[],
  groupOfSetting,
};

/**
 * Why a setting gets the safety treatment on the page.
 *
 * `transmit` — a master transmit gate: on means the station can key a radio by itself.
 * `confirm` — the server refuses some of its values until the operator acknowledges what
 * they remove (see `confirm` in the registry and the PATCH route).
 */
export type SafetyKind = "transmit" | "confirm";

export function safetyKind(key: string): SafetyKind | null {
  if (key.endsWith(".allowTransmit")) return "transmit";
  if (DEFS.get(key)?.confirm) return "confirm";
  return null;
}

export function isAdvancedSetting(key: string): boolean {
  return DEFS.get(key)?.advanced === true;
}

/** Laid out with the control under the text rather than beside it. */
export function isWideSetting(key: string, type: string): boolean {
  return DEFS.get(key)?.wide === true || type === "text";
}

export function settingDefault(key: string): string | undefined {
  return DEFS.get(key)?.default;
}

/**
 * Whether the stored value differs from what a fresh install would use.
 *
 * A row saved with the default value is NOT customised — it behaves exactly like no row.
 * A secret counts whenever one is configured: there is no default to compare it with.
 */
export function isCustomised(v: {
  key: string;
  type: string;
  source: string;
  value: string | null;
  configured: boolean;
}): boolean {
  if (v.source !== "database" && v.source !== "env") return false;
  if (v.type === "secret") return v.configured;
  return (v.value ?? "") !== (settingDefault(v.key) ?? "");
}

/** Split into the everyday settings and the ones behind a group's "Advanced" disclosure. */
export function partitionAdvanced<T extends { advanced: boolean }>(
  items: readonly T[],
): { basic: T[]; advanced: T[] } {
  const basic: T[] = [];
  const advanced: T[] = [];
  for (const it of items) (it.advanced ? advanced : basic).push(it);
  return { basic, advanced };
}
