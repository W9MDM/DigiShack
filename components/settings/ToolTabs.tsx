import Link from "next/link";
import { useRouter } from "next/router";

import { useUser } from "@/lib/client/session";
import { TOOL_TABS } from "@/lib/settings/tabs";

const RANK = { VIEWER: 0, OPERATOR: 1, ADMIN: 2 } as const;

/**
 * The configuration tools, as a bar the tool pages themselves render.
 *
 * WHY THIS EXISTS. Seven pages — Stations, ADIF, DXCC data, API keys, Integrations, Backup,
 * Updates — are deliberately kept out of the main navigation for an administrator, on the
 * reasoning that sixteen nav entries did not fit a phone and these are things you configure
 * rather than things you use. They were reachable from a tab bar on /settings.
 *
 * But the bar was rendered BY the settings page, so it disappeared the moment you followed
 * one of its links. An admin who clicked "DXCC data" arrived somewhere with no tabs, no nav
 * entry for where they were, and no way sideways — reported as "the menus are not consistent
 * and change depending on what page I'm on", which is exactly what was happening.
 *
 * So the bar belongs to the SECTION rather than to one page in it. Every tool page renders
 * it, including /settings, and the current page is marked so you can see where you are.
 */
export function ToolTabs() {
  const { pathname } = useRouter();
  const user = useUser();

  const visible = TOOL_TABS.filter(
    (t) => !t.minRole || (user && RANK[user.role] >= RANK[t.minRole]),
  );
  if (visible.length === 0) return null;

  return (
    <div className="mb-5 border-b border-line">
      {/* Scrolls rather than wraps, for the same reason the settings tab bar does: a
          wrapping bar on a phone pushes the page content off the screen. */}
      <div className="flex gap-1 overflow-x-auto pb-px">
        <Link
          href="/settings"
          className={tabClass(pathname === "/settings")}
          title="All settings"
        >
          Settings
        </Link>
        <span className="shrink-0 self-center mx-1 text-fg-subtle select-none">|</span>
        {visible.map((t) => (
          <Link
            key={t.id}
            href={t.href}
            title={t.hint}
            // startsWith, not equality: /stations has detail routes under it, and a tab
            // that unhighlights when you open a row reads as having navigated away.
            className={tabClass(pathname === t.href || pathname.startsWith(`${t.href}/`))}
          >
            {t.label}
          </Link>
        ))}
      </div>
    </div>
  );
}

function tabClass(on: boolean): string {
  return (
    "shrink-0 px-3 py-2 text-sm border-b-2 -mb-px transition-colors " +
    (on ? "border-accent text-fg" : "border-transparent text-fg-muted hover:text-fg")
  );
}
