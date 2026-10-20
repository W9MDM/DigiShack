import Link from "next/link";
import { useRouter } from "next/router";
import { useEffect, useId, useState, type MouseEvent, type ReactNode } from "react";

import { Chevron } from "@/components/settings/Chevron";
import { confirmLeave } from "@/components/settings/useUnsavedChangesGuard";
import { Select } from "@/components/ui/primitives";
import { useUser } from "@/lib/client/session";
import type { NavGroup } from "@/lib/settings/presentation";
import {
  groupsInTab,
  isToolActive,
  SETTINGS_TABS,
  settingsHref,
  splitQuietGroups,
  toolsFor,
  type ToolTab,
} from "@/lib/settings/tabs";
import { cn } from "@/lib/utils";

// The admin area's one navigation.
//
// There used to be two tab bars stacked on /settings — seven settings tabs, and above them
// a second bar of tool pages — and only the second followed you onto the tool pages. "The
// menus are not consistent and change depending on what page I'm on." This is the same
// sidebar on the settings page and on every tool page, so where you are and where you can
// go never changes shape.
//
// Below md it is a single picker at the top of the page rather than a column of seventeen
// links pushing the content off a phone screen.

/** What the settings page tells the sidebar. Absent on the tool pages. */
export interface SettingsNav {
  activeTab: string;
  /** The group nearest the top of the viewport, or the one just jumped to. */
  activeGroup: string | null;
  groups: NavGroup[];
  dirtyGroups: ReadonlySet<string>;
  /** Groups holding a setting with a problem — a stored value that will not decrypt. */
  problemGroups: ReadonlySet<string>;
  /**
   * Groups listed under "More": advanced only, every setting at its default. Worked out
   * from the stored settings; without it (the tool pages) the registry's advanced-only flag
   * stands in.
   */
  quietGroups?: ReadonlySet<string>;
  /** A category or group link was used — the page scrolls even if the URL did not change. */
  onNavigate: (target: { tab: string; group?: string }) => void;
  /** "42 settings · 84 advanced hidden". */
  summary?: string;
}

function Dot({ label, tone = "info" }: { label: string; tone?: "info" | "warn" }) {
  return (
    <>
      <span
        aria-hidden="true"
        className={cn("size-1.5 shrink-0 rounded-full", tone === "warn" ? "bg-warn" : "bg-info")}
      />
      <span className="sr-only">{label}</span>
    </>
  );
}

/**
 * The tool pages have no settings data, so group titles come from the registry, loaded only
 * once someone opens a category there — most visits to /users never need them.
 */
function useLazyGroups(provided: NavGroup[] | undefined, want: boolean): NavGroup[] | null {
  const [loaded, setLoaded] = useState<NavGroup[] | null>(null);
  useEffect(() => {
    if (provided || !want || loaded) return;
    let alive = true;
    void import("@/lib/settings/presentation").then((m) => {
      if (alive) setLoaded(m.navGroups());
    });
    return () => {
      alive = false;
    };
  }, [provided, want, loaded]);
  return provided ?? loaded;
}

const ITEM =
  "nav-target flex min-w-0 flex-1 items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors";
const ITEM_ON = "bg-surface-2 font-medium text-fg shadow-[inset_2px_0_0_var(--color-accent)]";
const ITEM_OFF = "text-fg-muted hover:bg-surface-2 hover:text-fg";

function Sidebar({
  isAdmin,
  tools,
  pathname,
  nav,
}: {
  isAdmin: boolean;
  tools: ToolTab[];
  pathname: string;
  nav?: SettingsNav;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(nav ? [nav.activeTab] : []),
  );
  // Accordion: arriving in a category opens it and folds the rest away.
  const activeTab = nav?.activeTab;
  useEffect(() => {
    if (activeTab) setExpanded(new Set([activeTab]));
  }, [activeTab]);

  // Which categories have their "More" open, when someone has chosen; otherwise it opens by
  // itself when the group being read, or one with unsaved changes, is in it.
  const [moreChoice, setMoreChoice] = useState<Readonly<Record<string, boolean>>>({});

  const groups = useLazyGroups(nav?.groups, expanded.size > 0);
  const groupIds = groups?.map((g) => g.id) ?? [];
  const title = (id: string) => groups?.find((g) => g.id === id)?.title ?? id;
  const isQuiet = (id: string) =>
    nav?.quietGroups ? nav.quietGroups.has(id) : groups?.find((g) => g.id === id)?.advancedOnly === true;
  const onSettings = nav !== undefined;

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const groupLink = (tabId: string, g: string, active: boolean) => {
    const on = active && nav?.activeGroup === g;
    const quiet = isQuiet(g);
    return (
      <li key={g}>
        <Link
          href={settingsHref({ group: g })}
          replace={onSettings}
          shallow={onSettings}
          scroll={!onSettings}
          aria-current={on ? "location" : undefined}
          onClick={() => nav?.onNavigate({ tab: tabId, group: g })}
          className={cn(
            "nav-target flex items-center gap-2 rounded-sm px-2 py-1 text-sm transition-colors",
            on ? "bg-surface-2 text-fg" : "text-fg-muted hover:bg-surface-2 hover:text-fg",
          )}
        >
          <span className={cn("min-w-0 flex-1 truncate", quiet && !on && "text-fg-subtle")}>{title(g)}</span>
          {nav?.problemGroups.has(g) && <Dot tone="warn" label="has a setting that needs attention" />}
          {nav?.dirtyGroups.has(g) && <Dot label="has unsaved changes" />}
        </Link>
      </li>
    );
  };

  const guard = (href: string) => (e: MouseEvent<HTMLAnchorElement>) => {
    if (!confirmLeave(href)) e.preventDefault();
  };

  return (
    <nav aria-label="Settings and tools" className="flex flex-col gap-5 text-sm">
      {isAdmin && (
        <div>
          <div className="mb-1.5 flex items-baseline justify-between gap-2 px-2">
            <h2 className="text-sm font-semibold text-fg-muted">Settings</h2>
          </div>
          {nav?.summary && <p className="mb-2 px-2 text-xs text-fg-subtle">{nav.summary}</p>}
          <ul className="flex flex-col gap-0.5">
            {SETTINGS_TABS.map((tab) => {
              const active = nav?.activeTab === tab.id;
              const open = expanded.has(tab.id);
              const ids = groups ? groupsInTab(tab.id, groupIds) : [];
              const dirty = ids.some((g) => nav?.dirtyGroups.has(g));
              const problem = ids.some((g) => nav?.problemGroups.has(g));
              const { main, more } = splitQuietGroups(ids, isQuiet);
              const moreId = `settings-nav-${tab.id}-more`;
              const moreOpen =
                moreChoice[tab.id] ??
                more.some((g) => (active && nav?.activeGroup === g) || nav?.dirtyGroups.has(g));
              const href = settingsHref({ tab: tab.id });
              const listId = `settings-nav-${tab.id}`;
              return (
                <li key={tab.id}>
                  <div className="flex items-center gap-0.5">
                    <Link
                      href={href}
                      replace={onSettings}
                      shallow={onSettings}
                      scroll={!onSettings}
                      aria-current={active ? "page" : undefined}
                      onClick={() => nav?.onNavigate({ tab: tab.id })}
                      className={cn(ITEM, active ? ITEM_ON : ITEM_OFF)}
                    >
                      <span className="truncate">{tab.label}</span>
                      {problem && <Dot tone="warn" label="has a setting that needs attention" />}
                      {dirty && <Dot label="has unsaved changes" />}
                    </Link>
                    <button
                      type="button"
                      aria-expanded={open}
                      aria-controls={listId}
                      aria-label={`${open ? "Hide" : "Show"} the groups in ${tab.label}`}
                      onClick={() => toggle(tab.id)}
                      className="tap-inline inline-flex size-7 shrink-0 items-center justify-center rounded-sm text-fg-subtle hover:bg-surface-2 hover:text-fg"
                    >
                      <Chevron open={open} />
                    </button>
                  </div>
                  {open && (
                    <ul id={listId} className="my-1 ml-3 flex flex-col gap-px border-l border-line pl-2">
                      {!groups && <li className="px-2 py-1 text-xs text-fg-subtle">Loading…</li>}
                      {main.map((g) => groupLink(tab.id, g, active))}
                      {more.length > 0 && (
                        <li>
                          <button
                            type="button"
                            aria-expanded={moreOpen}
                            aria-controls={moreId}
                            onClick={() => setMoreChoice((p) => ({ ...p, [tab.id]: !moreOpen }))}
                            className="tap-inline flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-sm text-fg-subtle hover:bg-surface-2 hover:text-fg"
                          >
                            <Chevron open={moreOpen} />
                            <span className="min-w-0 flex-1 truncate">More</span>
                            {!moreOpen && more.some((g) => nav?.dirtyGroups.has(g)) && <Dot label="has unsaved changes" />}
                            <span className="tnum shrink-0 text-xs">{more.length}</span>
                          </button>
                          {moreOpen && (
                            <ul
                              id={moreId}
                              aria-label={`Advanced-only groups in ${tab.label}, all at their defaults`}
                              className="ml-3 flex flex-col gap-px border-l border-line pl-2"
                            >
                              {more.map((g) => groupLink(tab.id, g, active))}
                            </ul>
                          )}
                        </li>
                      )}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {tools.length > 0 && (
        <div>
          <h2 className="mb-1.5 px-2 text-sm font-semibold text-fg-muted">Tools</h2>
          <ul className="flex flex-col gap-0.5">
            {tools.map((t) => {
              const on = isToolActive(t, pathname);
              return (
                <li key={t.id} className="flex">
                  <Link
                    href={t.href}
                    title={t.hint}
                    aria-current={on ? "page" : undefined}
                    onClick={guard(t.href)}
                    className={cn(ITEM, on ? ITEM_ON : ITEM_OFF)}
                  >
                    <span className="truncate">{t.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </nav>
  );
}

/** What a category's entry in the phone picker adds after its name. */
function pickerNote(tabId: string, nav: SettingsNav | undefined): string {
  if (!nav) return "";
  const ids = groupsInTab(tabId, nav.groups.map((x) => x.id));
  const notes: string[] = [];
  if (ids.some((g) => nav.problemGroups.has(g))) notes.push("needs attention");
  if (ids.some((g) => nav.dirtyGroups.has(g))) notes.push("unsaved changes");
  return notes.length ? ` — ${notes.join(", ")}` : "";
}

/** Below md: one native picker. The OS draws a proper list, and it takes one row. */
function SectionPicker({
  isAdmin,
  tools,
  pathname,
  nav,
}: {
  isAdmin: boolean;
  tools: ToolTab[];
  pathname: string;
  nav?: SettingsNav;
}) {
  const router = useRouter();
  const id = useId();
  const currentTool = tools.find((t) => isToolActive(t, pathname));
  const value = currentTool ? `tool:${currentTool.id}` : nav ? `tab:${nav.activeTab}` : "";

  const go = (v: string) => {
    if (v.startsWith("tab:")) {
      const tab = v.slice(4);
      const href = settingsHref({ tab });
      if (nav) {
        nav.onNavigate({ tab });
        void router.replace(href, undefined, { shallow: true, scroll: false });
      } else void router.push(href);
      return;
    }
    const tool = tools.find((t) => `tool:${t.id}` === v);
    if (tool && confirmLeave(tool.href)) void router.push(tool.href);
  };

  return (
    <div className="mb-5 flex items-center gap-2">
      <label htmlFor={id} className="shrink-0 text-sm text-fg-muted">
        Section
      </label>
      <div className="relative min-w-0 flex-1">
        <Select id={id} value={value} onChange={(e) => go(e.target.value)}>
          {value === "" && <option value="">Choose a section…</option>}
          {isAdmin && (
            <optgroup label="Settings">
              {SETTINGS_TABS.map((t) => (
                <option key={t.id} value={`tab:${t.id}`}>
                  {t.label}
                  {pickerNote(t.id, nav)}
                </option>
              ))}
            </optgroup>
          )}
          {tools.length > 0 && (
            <optgroup label="Tools">
              {tools.map((t) => (
                <option key={t.id} value={`tool:${t.id}`}>
                  {t.label}
                </option>
              ))}
            </optgroup>
          )}
        </Select>
        {/* The Select primitive removes the native arrow; a picker with no arrow does not
            look like it opens. */}
        <Chevron
          open
          className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-fg-subtle"
        />
      </div>
    </div>
  );
}

/**
 * The settings page and every tool page render inside this.
 *
 * `bottomInset` is set while the save bar is showing, so the sidebar's own scroll stops
 * short of it rather than running underneath.
 */
export function SettingsLayout({
  nav,
  bottomInset = false,
  children,
}: {
  nav?: SettingsNav;
  bottomInset?: boolean;
  children: ReactNode;
}) {
  const { pathname } = useRouter();
  const user = useUser();
  const isAdmin = user?.role === "ADMIN";
  const tools = toolsFor(user?.role);

  // An operator who can reach a single tool has nothing to navigate between.
  if (!isAdmin && tools.length <= 1) return <>{children}</>;

  return (
    <div className="md:grid md:grid-cols-[12rem_minmax(0,1fr)] md:items-start md:gap-6 lg:grid-cols-[14rem_minmax(0,1fr)] lg:gap-8">
      <div className="md:hidden">
        <SectionPicker isAdmin={isAdmin} tools={tools} pathname={pathname} nav={nav} />
      </div>
      <aside
        className={cn(
          "hidden overflow-y-auto overscroll-contain pb-4 md:sticky md:block",
          "md:top-[calc(4rem_+_env(safe-area-inset-top))]",
          bottomInset
            ? "md:max-h-[calc(100dvh_-_10rem_-_env(safe-area-inset-top))]"
            : "md:max-h-[calc(100dvh_-_5rem_-_env(safe-area-inset-top))]",
        )}
      >
        <Sidebar isAdmin={isAdmin} tools={tools} pathname={pathname} nav={nav} />
      </aside>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
