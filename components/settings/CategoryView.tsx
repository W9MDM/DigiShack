import { Fragment, useEffect, useMemo } from "react";

import { displayItems, groupIdFor, rowFacts } from "@/components/settings/display";
import { CATEGORY_EXTRAS, GROUP_EXTRAS, type ExtraContext } from "@/components/settings/group-extras";
import { SettingGroupCard } from "@/components/settings/SettingGroupCard";
import type { ClientSetting, SettingGroup } from "@/components/settings/types";
import { isQuietGroup } from "@/components/settings/visibility";
import { groupsInTab, SETTINGS_TABS } from "@/lib/settings/tabs";

export const CATEGORY_HEADING_ID = "settings-category";

/**
 * One category: its heading, any panels that belong to the whole category, then its groups.
 *
 * Stays mounted (hidden) while a search is showing, so nothing typed into a panel in it —
 * a callsign half-entered in the do-not-call list, a certificate passphrase — is lost to
 * a search.
 */
export function CategoryView({
  tabId,
  groups,
  settings,
  byKey,
  ctx,
  isAdvancedOpen,
  toggleAdvanced,
  isExpanded,
  toggleExpanded,
  flashId,
  onActiveGroup,
  hidden,
}: {
  tabId: string;
  groups: SettingGroup[];
  settings: readonly ClientSetting[];
  byKey: ReadonlyMap<string, ClientSetting>;
  ctx: ExtraContext;
  isAdvancedOpen: (group: string) => boolean;
  toggleAdvanced: (group: string) => void;
  isExpanded: (group: string) => boolean;
  toggleExpanded: (group: string) => void;
  flashId: string | null;
  onActiveGroup: (group: string) => void;
  hidden: boolean;
}) {
  const tab = SETTINGS_TABS.find((t) => t.id === tabId) ?? SETTINGS_TABS[0]!;
  const ids = useMemo(() => groupsInTab(tab.id, groups.map((g) => g.id)), [tab.id, groups]);

  // In the category's own order, the same as the sidebar. Advanced-only groups fold to one
  // line in SettingGroupCard; they are not moved to a separate section.
  const { sections } = useMemo(() => {
    const all = ids
      .map((id) => {
        const group = groups.find((g) => g.id === id);
        const items = displayItems(
          settings.filter((s) => s.group === id),
          byKey,
        );
        const extra = GROUP_EXTRAS[id];
        if (!group) return null;
        return { group, items, extra, quiet: isQuietGroup(items.map((it) => rowFacts(it)), Boolean(extra)) };
      })
      .filter((x) => x !== null)
      .filter((x) => x.items.length > 0 || x.extra);
    return { sections: all };
  }, [ids, groups, settings, byKey]);

  // Which group is under the header, for the sidebar's highlight. A band across the top of
  // the viewport rather than "most visible": a tall group that fills the screen is the one
  // being read even while the next one's heading has scrolled into view below it.
  const key = sections.map((s) => s.group.id).join(",");
  useEffect(() => {
    if (hidden) return;
    const shown = new Set<string>();
    const order = key.split(",");
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const id = (e.target as HTMLElement).dataset.group;
          if (!id) continue;
          if (e.isIntersecting) shown.add(id);
          else shown.delete(id);
        }
        const top = order.find((id) => shown.has(id));
        if (top) onActiveGroup(top);
      },
      { rootMargin: "-72px 0px -55% 0px" },
    );
    for (const id of order) {
      const el = document.getElementById(groupIdFor(id));
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, [key, hidden, onActiveGroup]);

  const categoryExtra = CATEGORY_EXTRAS[tab.id];

  return (
    <section aria-labelledby={`${CATEGORY_HEADING_ID}-title`} hidden={hidden}>
      <div id={CATEGORY_HEADING_ID} className="mb-5 scroll-mt-20">
        <h2 id={`${CATEGORY_HEADING_ID}-title`} tabIndex={-1} className="font-display text-xl text-fg outline-none">
          {tab.label}
        </h2>
        <p className="mt-0.5 text-sm text-fg-muted">{tab.description}</p>
      </div>
      <div className="flex flex-col gap-6">
        {categoryExtra?.(ctx)}
        {sections.map(({ group, items, extra }) => (
          <Fragment key={group.id}>
            <SettingGroupCard
              group={group}
              items={items}
              editor={ctx.editor}
              extra={extra?.(ctx)}
              advancedOpen={isAdvancedOpen(group.id)}
              onToggleAdvanced={() => toggleAdvanced(group.id)}
              expanded={isExpanded(group.id)}
              onToggleExpanded={() => toggleExpanded(group.id)}
              flashId={flashId}
            />
          </Fragment>
        ))}
      </div>
    </section>
  );
}
