import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  ClientSetting,
  PatchResponse,
  SettingsEditor,
  SettingsResponse,
  SettingUpdate,
  SettingView,
} from "@/components/settings/types";
import { ApiError, apiPatch, useApi } from "@/lib/client/api";
import {
  isAdvancedSetting,
  isCustomised,
  isWideSetting,
  safetyKind,
  settingDefault,
} from "@/lib/settings/presentation";

export function toClientSetting(v: SettingView): ClientSetting {
  return {
    ...v,
    advanced: isAdvancedSetting(v.key),
    wide: isWideSetting(v.key, v.type),
    safety: safetyKind(v.key),
    defaultValue: settingDefault(v.key),
    customised: isCustomised(v),
  };
}

function isDirtyFor(
  s: Pick<SettingView, "key" | "type" | "value">,
  edits: Readonly<Record<string, string>>,
  cleared: ReadonlySet<string>,
): boolean {
  if (cleared.has(s.key)) return true;
  const e = edits[s.key];
  if (e === undefined) return false;
  // A blank secret means "not retyped", never "set it to nothing" — the browser is never
  // sent the stored value, so there is nothing for a blank to be compared with.
  if (s.type === "secret") return e !== "";
  return e !== (s.value ?? "");
}

export interface NamedSetting {
  key: string;
  label: string;
  group: string;
}

export interface SaveReport {
  saved: NamedSetting[];
  cleared: NamedSetting[];
  rejected: (NamedSetting & { reason: string })[];
}

/**
 * A save the server refused until the operator agrees to the consequence.
 *
 * Holds the exact updates that were refused, so accepting re-sends THOSE rather than
 * whatever the form contains by then.
 */
export interface PendingConfirmation {
  updates: SettingUpdate[];
  items: (NamedSetting & { message: string })[];
}

/**
 * Everything the settings page knows: the stored settings, the unsaved draft, and saving.
 *
 * THE DRAFT IS SPARSE — only what the operator has typed, never a copy of every stored
 * value. The old page seeded a full copy and re-seeded it whenever the data reloaded, so
 * anything typed while a save was in flight was silently thrown away when it landed. Here
 * a save removes exactly the edits it wrote, and an edit made meanwhile survives it.
 */
export function useSettingsState() {
  const { data, error, reload } = useApi<SettingsResponse>("/api/settings");

  // The PATCH answers with freshly described settings, so a save needs no second GET.
  // A GET that lands later is newer still, and replaces it.
  const [fresh, setFresh] = useState<{ settings: SettingView[]; keyProblem: string | null } | null>(null);
  useEffect(() => setFresh(null), [data]);

  const views = fresh?.settings ?? data?.settings ?? null;
  const keyProblem = fresh ? fresh.keyProblem : (data?.keyProblem ?? null);

  const settings = useMemo(() => views?.map(toClientSetting) ?? null, [views]);
  const byKey = useMemo(
    () => new Map<string, ClientSetting>((settings ?? []).map((s) => [s.key, s])),
    [settings],
  );

  const [edits, setEdits] = useState<Record<string, string>>({});
  const [cleared, setCleared] = useState<ReadonlySet<string>>(() => new Set());
  const [report, setReport] = useState<SaveReport | null>(null);
  const [discarded, setDiscarded] = useState<{
    edits: Record<string, string>;
    cleared: ReadonlySet<string>;
    count: number;
  } | null>(null);

  const dirtyKeys = useMemo(
    () => (settings ?? []).filter((s) => isDirtyFor(s, edits, cleared)).map((s) => s.key),
    [settings, edits, cleared],
  );
  const dirtySet = useMemo(() => new Set(dirtyKeys), [dirtyKeys]);

  const values = useMemo(() => {
    const out: Record<string, string> = {};
    for (const s of settings ?? []) {
      if (s.type !== "secret") out[s.key] = edits[s.key] ?? s.value ?? "";
    }
    return out;
  }, [settings, edits]);

  // Any new edit supersedes the last save's report and the chance to undo a discard.
  const touched = useCallback(() => {
    setReport(null);
    setDiscarded(null);
  }, []);

  const editor: SettingsEditor = useMemo(
    () => ({
      value: (key) => {
        const e = edits[key];
        if (e !== undefined) return e;
        const s = byKey.get(key);
        return s && s.type !== "secret" ? (s.value ?? "") : "";
      },
      isDirty: (key) => dirtySet.has(key),
      isCleared: (key) => cleared.has(key),
      setValue: (key, value) => {
        setEdits((prev) => ({ ...prev, [key]: value }));
        touched();
      },
      toggleClear: (key) => {
        setCleared((prev) => {
          const next = new Set(prev);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
        touched();
      },
      values,
    }),
    [edits, byKey, dirtySet, cleared, values, touched],
  );

  const name = useCallback(
    (key: string): NamedSetting => {
      const s = byKey.get(key);
      return { key, label: s?.label ?? key, group: s?.group ?? "" };
    },
    [byKey],
  );

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<PendingConfirmation | null>(null);

  function buildUpdates(): SettingUpdate[] {
    const updates: SettingUpdate[] = [];
    for (const s of settings ?? []) {
      if (cleared.has(s.key)) {
        updates.push({ key: s.key, value: null });
        continue;
      }
      const e = edits[s.key];
      if (e === undefined) continue;
      // Blank means "not retyped" — skip it rather than blanking the stored credential.
      if (s.type === "secret") {
        if (e !== "") updates.push({ key: s.key, value: e });
      } else if (e !== (s.value ?? "")) {
        updates.push({ key: s.key, value: e });
      }
    }
    return updates;
  }

  function applySaved(updates: SettingUpdate[], res: PatchResponse) {
    const rejected = new Set(res.rejected.map((r) => r.key));
    const after = res.settings ? new Map(res.settings.map((s) => [s.key, s])) : null;
    setEdits((prev) => {
      const next = { ...prev };
      for (const u of updates) {
        // A rejected value stays in the field, so it can be corrected rather than retyped.
        if (rejected.has(u.key)) continue;
        if (u.value === null || next[u.key] === u.value) delete next[u.key];
      }
      // And whatever now matches what is stored is no longer an edit at all.
      if (after) {
        for (const [key, e] of Object.entries(next)) {
          const s = after.get(key);
          if (s && !isDirtyFor(s, { [key]: e }, new Set())) delete next[key];
        }
      }
      return next;
    });
    setCleared((prev) => {
      const next = new Set(prev);
      for (const u of updates) if (u.value === null && !rejected.has(u.key)) next.delete(u.key);
      return next;
    });
    if (res.settings) setFresh({ settings: res.settings, keyProblem: res.keyProblem ?? null });
    else void reload();
    setReport({
      saved: res.updated.map(name),
      cleared: res.cleared.map(name),
      rejected: res.rejected.map((r) => ({ ...name(r.key), reason: r.reason })),
    });
  }

  /**
   * The PATCH itself, shared by the ordinary save and the confirmed one.
   *
   * `acknowledge` names the keys whose consequence has been accepted — per key, so agreeing
   * to one dangerous setting cannot carry consent to another in the same save.
   */
  async function send(updates: SettingUpdate[], acknowledge?: string[]): Promise<void> {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await apiPatch<PatchResponse>("/api/settings", {
        updates,
        ...(acknowledge ? { acknowledge } : {}),
      });
      setConfirming(null);
      applySaved(updates, res);
    } catch (err) {
      // 409 with per-key details is the server asking rather than refusing. Nothing was
      // written — see the route — so there is no half-applied save to reconcile.
      if (err instanceof ApiError && err.status === 409 && err.details) {
        setConfirming({
          updates,
          items: Object.entries(err.details).map(([key, msgs]) => ({
            ...name(key),
            message: msgs.join(" "),
          })),
        });
        return;
      }
      setSaveError(err instanceof ApiError ? err.message : "Could not save settings");
    } finally {
      setSaving(false);
    }
  }

  function save() {
    const updates = buildUpdates();
    if (updates.length === 0 || saving) return;
    setReport(null);
    void send(updates);
  }

  function confirm() {
    if (!confirming) return;
    void send(
      confirming.updates,
      confirming.items.map((c) => c.key),
    );
  }

  function discard() {
    if (dirtyKeys.length === 0) return;
    setDiscarded({ edits, cleared, count: dirtyKeys.length });
    setEdits({});
    setCleared(new Set());
    setReport(null);
    setSaveError(null);
  }

  function undoDiscard() {
    if (!discarded) return;
    setEdits(discarded.edits);
    setCleared(discarded.cleared);
    setDiscarded(null);
  }

  // The undo is an offer, not a permanent fixture.
  useEffect(() => {
    if (!discarded) return;
    const id = setTimeout(() => setDiscarded(null), 15_000);
    return () => clearTimeout(id);
  }, [discarded]);

  return {
    loadError: error,
    loaded: data !== null,
    groups: data?.groups ?? [],
    envOnly: data?.envOnly ?? [],
    keyProblem,
    settings,
    byKey,
    editor,
    dirtyKeys,
    saving,
    saveError,
    save,
    confirming,
    confirm,
    cancelConfirm: () => setConfirming(null),
    report,
    dismissReport: () => setReport(null),
    discarded,
    discard,
    undoDiscard,
    dismissDiscarded: () => setDiscarded(null),
  };
}

export type SettingsState = ReturnType<typeof useSettingsState>;
