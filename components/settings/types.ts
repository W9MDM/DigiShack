// The settings API as the page sees it, and the page's own view of a setting.
//
// Type-only imports from the server modules, so the page cannot drift from what the
// route sends and none of the server code reaches the browser.

import type { SettingView, WriteResult } from "@/lib/settings";
import type { SettingGroup } from "@/lib/settings/registry";
import type { SafetyKind } from "@/lib/settings/presentation";

export type { SettingView, SettingGroup };

/** GET /api/settings. */
export interface SettingsResponse {
  groups: SettingGroup[];
  settings: SettingView[];
  keyProblem: string | null;
  envOnly: string[];
}

/** PATCH /api/settings, when it wrote (200) or wrote some (207). */
export interface PatchResponse extends WriteResult {
  settings?: SettingView[];
  keyProblem?: string | null;
}

/** One change in a PATCH. `null` clears the stored value. */
export interface SettingUpdate {
  key: string;
  value: string | null;
}

/** A setting plus what the page derives about it from the registry. */
export interface ClientSetting extends SettingView {
  advanced: boolean;
  /** Control laid out under the text rather than beside it. */
  wide: boolean;
  safety: SafetyKind | null;
  defaultValue: string | undefined;
  /** Stored value differs from a fresh install's. */
  customised: boolean;
}

/** What a field reads and writes. One instance for the whole page, so every view shares the draft. */
export interface SettingsEditor {
  /** What the control shows: the unsaved edit if there is one, else the stored value. */
  value: (key: string) => string;
  isDirty: (key: string) => boolean;
  isCleared: (key: string) => boolean;
  setValue: (key: string, value: string) => void;
  toggleClear: (key: string) => void;
  /** Every non-secret setting's current value, for previews that read several at once. */
  values: Readonly<Record<string, string>>;
}
