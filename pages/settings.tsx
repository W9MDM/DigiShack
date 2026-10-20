import { useCallback, useDeferredValue, useMemo, useState } from "react";

import { CategoryView } from "@/components/settings/CategoryView";
import { ConfirmSaveDialog } from "@/components/settings/ConfirmSaveDialog";
import { SaveBar } from "@/components/settings/SaveBar";
import { SettingsLayout } from "@/components/settings/SettingsLayout";
import { SearchResults, SettingsSearchBox } from "@/components/settings/SettingsSearch";
import { UnreadableBanner } from "@/components/settings/UnreadableBanner";
import { useSettingsLocation } from "@/components/settings/useSettingsLocation";
import { useSettingsState } from "@/components/settings/useSettingsState";
import { useUnsavedChangesGuard } from "@/components/settings/useUnsavedChangesGuard";
import { staysInView } from "@/components/settings/visibility";
import { ErrorBanner, PageHeader } from "@/components/ui/primitives";
import { withPageAuth } from "@/lib/auth/guard";
import { navGroups } from "@/lib/settings/presentation";
import { searchSettings, searchTerms } from "@/lib/settings/search";

const NAV_GROUPS = navGroups();

export default function SettingsPage() {
  const st = useSettingsState();
  const nav = useSettingsLocation({ ready: st.settings !== null });
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query);
  const terms = useMemo(() => searchTerms(deferred), [deferred]);
  const searching = terms.length > 0;

  const groupTitle = useCallback(
    (id: string) => st.groups.find((g) => g.id === id)?.title ?? id,
    [st.groups],
  );
  const settings = useMemo(() => st.settings ?? [], [st.settings]);
  const hits = useMemo(
    () => (searching ? searchSettings(settings, deferred, { groupTitle }) : []),
    [searching, settings, deferred, groupTitle],
  );

  const dirtyGroups = useMemo(() => {
    const out: string[] = [];
    for (const k of st.dirtyKeys) {
      const g = st.byKey.get(k)?.group;
      if (g && !out.includes(g)) out.push(g);
    }
    return out;
  }, [st.dirtyKeys, st.byKey]);

  // An advanced setting that is not at its default is shown, so it is not counted as hidden.
  const advancedCount = settings.filter((s) => s.advanced && !staysInView(s)).length;
  const summary =
    settings.length === 0
      ? undefined
      : advancedCount > 0
        ? `${settings.length - advancedCount} settings · ${advancedCount} advanced hidden`
        : `${settings.length} settings`;

  const problemGroups = useMemo(
    () => new Set(settings.filter((s) => s.unreadable || s.problem !== null).map((s) => s.group)),
    [settings],
  );
  // The sidebar's "More": advanced-only groups with every setting at its default. The same
  // rule as the page's (isQuietGroup), worked out per group from what is stored.
  const quietGroups = useMemo(
    () =>
      new Set(
        NAV_GROUPS.filter(
          (g) => g.advancedOnly && !settings.some((s) => s.group === g.id && staysInView(s)),
        ).map((g) => g.id),
      ),
    [settings],
  );

  const dirty = st.dirtyKeys.length;
  useUnsavedChangesGuard(
    dirty > 0,
    `You have ${dirty} unsaved ${dirty === 1 ? "change" : "changes"} in Settings. Leave without saving?`,
  );

  // Leaving search for a group or a setting: the draft is page state, so nothing typed is lost.
  const jump = (target: { group?: string; setting?: string }) => {
    setQuery("");
    nav.goTo(target);
  };
  const barVisible = dirty > 0 || st.report !== null || st.discarded !== null;

  return (
    <SettingsLayout
      bottomInset={barVisible}
      nav={{
        activeTab: nav.location.tab,
        activeGroup: nav.activeGroup,
        groups: NAV_GROUPS,
        dirtyGroups: new Set(dirtyGroups),
        problemGroups,
        quietGroups,
        onNavigate: (target) => {
          setQuery("");
          nav.followed(target.group);
        },
      }}
    >
      {/* The save bar is taller on a phone, where its buttons wrap onto their own line, so
          the room left under the last setting is too. */}
      <div className={barVisible ? "max-w-5xl pb-40 sm:pb-28" : "max-w-5xl"}>
        {/* Below sm the generic subtitle goes: three lines repeated above every category,
            each of which opens with its own description anyway. */}
        <div className="max-sm:[&_h1+p]:hidden">
          <PageHeader
            title="Settings"
            subtitle="How this station runs: radios, modes, automation, logbook services and email. Kept in the database, with passwords and keys encrypted."
          />
        </div>

        {st.loadError && <div className="mb-4"><ErrorBanner>{st.loadError.message}</ErrorBanner></div>}
        {st.keyProblem && (
          <div className="mb-4">
            <ErrorBanner>
              <strong>Secrets cannot be stored.</strong> {st.keyProblem}
            </ErrorBanner>
          </div>
        )}

        {/* Separate from the key problem above: that one says nothing NEW can be stored;
            this one names each value already stored that cannot be read. */}
        <UnreadableBanner settings={settings} groupTitle={groupTitle} onJump={(setting) => jump({ setting })} />

        <SettingsSearchBox value={query} onChange={setQuery} summary={summary} />

        {st.settings === null ? (
          !st.loadError && <p className="text-sm text-fg-subtle">Loading settings…</p>
        ) : (
          <>
            {searching && (
              <SearchResults
                query={deferred}
                terms={terms}
                hits={hits}
                byKey={st.byKey}
                groups={st.groups}
                editor={st.editor}
                onOpenGroup={(group) => jump({ group })}
                onClear={() => setQuery("")}
              />
            )}
            <CategoryView
              hidden={searching}
              tabId={nav.location.tab}
              groups={st.groups}
              settings={settings}
              byKey={st.byKey}
              ctx={{ editor: st.editor, envOnly: st.envOnly }}
              isAdvancedOpen={nav.isAdvancedOpen}
              toggleAdvanced={nav.toggleAdvanced}
              isExpanded={nav.isExpanded}
              toggleExpanded={nav.toggleExpanded}
              flashId={nav.flashId}
              onActiveGroup={nav.setActiveGroup}
              onJumpGroup={(group) => jump({ group })}
            />
          </>
        )}
      </div>

      <SaveBar
        dirtyCount={dirty}
        dirtyGroups={dirtyGroups}
        groupTitle={groupTitle}
        saving={st.saving}
        error={st.saveError}
        onSave={st.save}
        onDiscard={st.discard}
        report={st.report}
        onDismissReport={st.dismissReport}
        discarded={st.discarded}
        onUndoDiscard={st.undoDiscard}
        onDismissDiscarded={st.dismissDiscarded}
        onJumpToGroup={(group) => jump({ group })}
        onJumpToSetting={(setting) => jump({ setting })}
      />

      <ConfirmSaveDialog
        pending={st.confirming}
        saving={st.saving}
        groupTitle={groupTitle}
        onCancel={st.cancelConfirm}
        onConfirm={st.confirm}
      />
    </SettingsLayout>
  );
}

export const getServerSideProps = withPageAuth({ role: "ADMIN" });
