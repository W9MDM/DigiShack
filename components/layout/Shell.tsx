import Link from "next/link";
import { Ft0Button } from "@/components/layout/Ft0Button";
import { UtcClock } from "@/components/layout/UtcClock";
import { useRouter } from "next/router";
import type { UiFlags } from "@/lib/auth/guard";
import { useState, type ReactNode } from "react";

import { Badge } from "@/components/ui/primitives";
import { apiPost } from "@/lib/client/api";
import { useUser } from "@/lib/client/session";
import { cn } from "@/lib/utils";

interface NavItem {
  href: string;
  label: string;
  /** Hidden below this role. Server-side enforcement is independent. */
  minRole?: "OPERATOR" | "ADMIN";
  /**
   * Hidden AT or above this role, because that role reaches it another way.
   *
   * Exactly one use: Stations and ADIF now live as tabs on the settings page, which is
   * admin-only. Dropping them from the nav outright would take them away from the
   * operators who use them most, so admins get the tidier menu and everyone else keeps
   * the link. A nav that differs by role is a small oddity; an operator who can no
   * longer reach the ADIF importer is a broken install.
   */
  hiddenAtRole?: "ADMIN";
  /**
   * Hidden until an operator switches it on in Settings.
   *
   * For surfaces honest enough to admit they are unfinished. A fresh install should not
   * meet the most experimental page in the product first, and hiding it is kinder than a
   * banner alone — a link that is there invites a click.
   */
  experimental?: keyof UiFlags;
}

// Sixteen entries did not fit a phone and did not read well on a desktop either. The
// configuration tools — Stations, ADIF, DXCC data, API keys, Backup, Updates and Users —
// are tabs in the settings section, which is where someone looks for them anyway.
//
// Users was the last of those still holding a top-level slot: "users should live in
// settings". Settings itself stays in the nav, because the tab bar has to be reachable
// from somewhere.
const NAV: NavItem[] = [
  { href: "/", label: "Dashboard" },
  { href: "/qsos", label: "Log" },
  { href: "/qsos/new", label: "New QSO", minRole: "OPERATOR" },
  { href: "/decodes", label: "Digital" },
  { href: "/rig", label: "Rig", minRole: "OPERATOR", experimental: "rig" },
  { href: "/gridmap", label: "Map" },
  { href: "/map", label: "Coverage" },
  { href: "/awards", label: "Awards" },
  { href: "/stats", label: "Stats" },
  { href: "/pota", label: "POTA" },
  { href: "/qsl", label: "QSL", minRole: "OPERATOR" },
  // Kept for operators and viewers, who have no settings page to find them on.
  { href: "/stations", label: "Stations", hiddenAtRole: "ADMIN" },
  { href: "/adif", label: "ADIF", hiddenAtRole: "ADMIN" },
  { href: "/settings", label: "Settings", minRole: "ADMIN" },
  // Last on purpose. Help that sits first in a menu implies the product needs explaining
  // before it can be used; help that sits last is where people look once something has
  // surprised them, which is when they actually read it.
  { href: "/help", label: "Help" },
];

const RANK = { VIEWER: 0, OPERATOR: 1, ADMIN: 2 } as const;

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  if (href === "/qsos") {
    if (pathname === "/qsos") return true;
    // A QSO detail page counts as "Log"; the dedicated /qsos/new page does not.
    return pathname !== "/qsos/new" && /^\/qsos\/[^/]+$/.test(pathname);
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function Shell({
  children,
  uiFlags,
}: {
  children: ReactNode;
  /** Absent on the bare routes, which render no navigation at all. */
  uiFlags?: UiFlags;
}) {
  const { pathname } = useRouter();
  const user = useUser();
  const [signingOut, setSigningOut] = useState(false);

  const visible = NAV.filter(
    (item) =>
      // An experimental entry appears only when its flag is on. Defaults to hidden when
      // the flags have not arrived, so a page that forgets to pass them fails closed.
      (!item.experimental || uiFlags?.[item.experimental] === true) &&
      (!item.minRole || (user && RANK[user.role] >= RANK[item.minRole])) &&
      // hiddenAtRole is the inverse test: hide from this role and above, because they
      // reach it via the settings tabs instead.
      !(item.hiddenAtRole && user && RANK[user.role] >= RANK[item.hiddenAtRole]),
  );

  async function signOut() {
    setSigningOut(true);
    try {
      await apiPost("/api/auth/logout", {});
    } catch {
      // Even if the request fails the cookie may be gone; go to /login anyway.
    }
    // Full navigation, not router.push — it discards all client state, which is
    // what signing out should do.
    window.location.href = "/login";
  }

  return (
    <div className="min-h-screen flex flex-col bg-bg text-fg">
      {/* Visible only when focused. Sixteen nav links stand between the top of every
          page and its content; without this a keyboard user tabs through all of them
          every time. */}
      <a
        href="#main"
        className={cn(
          "sr-only focus:not-sr-only",
          "focus:absolute focus:z-50 focus:top-2 focus:left-2",
          "focus:rounded-sm focus:border focus:border-accent-bright",
          "focus:bg-surface focus:px-3 focus:py-2 focus:text-sm focus:text-fg",
        )}
      >
        Skip to content
      </a>
      <header className="border-b border-line bg-surface sticky top-0 z-20">
        <div className="mx-auto max-w-[1600px] flex items-center gap-6 px-4 h-12">
          <Link href="/" className="flex items-baseline gap-1.5 shrink-0">
            <span className="font-display text-xl uppercase tracking-wider">
              Digi
            </span>
            <span className="font-display text-xl uppercase tracking-wider text-accent-bright">
              Shack
            </span>
          </Link>

          {/* Scrolls rather than overflowing. Below md the nav was wider than the
              viewport and the items past the edge were simply unreachable — no wrap,
              no menu, no scroll. */}
          <nav
            aria-label="Main"
            className="flex items-center gap-0.5 overflow-x-auto no-scrollbar min-w-0"
          >
            {visible.map((item) => {
              const active = isActive(pathname, item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "nav-target inline-flex items-center",
                    "px-3 py-1.5 text-sm rounded-sm transition-colors border-b-2",
                    active
                      ? "text-fg border-accent"
                      : "text-fg-muted border-transparent hover:text-fg hover:bg-surface-2",
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <UtcClock />
            <Ft0Button />
            {user && (
              <>
                {/* The identity is the door to the account page — where any role,
                    including the operators and viewers who have no Users page,
                    changes their own password. */}
                <Link
                  href="/account"
                  title="Account — change password"
                  className="text-sm text-fg-muted hidden sm:inline hover:text-accent-bright"
                >
                  {user.callsign ? (
                    <span className="font-display tracking-wide">
                      {user.callsign}
                    </span>
                  ) : (
                    user.name
                  )}
                </Link>
                {user.role !== "OPERATOR" && (
                  <Badge tone={user.role === "ADMIN" ? "accent" : "neutral"}>
                    {user.role}
                  </Badge>
                )}
                <button
                  type="button"
                  onClick={() => void signOut()}
                  disabled={signingOut}
                  className="text-xs text-fg-subtle hover:text-accent-bright disabled:opacity-50"
                >
                  {signingOut ? "Signing out…" : "Sign out"}
                </button>
              </>
            )}
          </div>
        </div>
      </header>

      <main id="main" className="flex-1 mx-auto w-full max-w-[1600px] px-4 py-6">
        {children}
      </main>
    </div>
  );
}
