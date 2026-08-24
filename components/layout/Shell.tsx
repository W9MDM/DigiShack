import Link from "next/link";
import { Ft0Button } from "@/components/layout/Ft0Button";
import { UtcClock } from "@/components/layout/UtcClock";
import { useRouter } from "next/router";
import type { UiFlags } from "@/lib/auth/guard";
import { useEffect, useState, type ReactNode } from "react";

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
  const [menuOpen, setMenuOpen] = useState(false);

  // A drawer that survives the navigation it just triggered covers the page the
  // operator asked for. Closing on pathname rather than on click also covers the
  // links that redirect and the browser back button.
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!menuOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    // Scrolling the page behind a full-height drawer loses your place in it.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

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
      <header className="border-b border-line bg-surface sticky top-0 z-20 pt-[env(safe-area-inset-top)]">
        <div className="mx-auto max-w-[1600px] flex items-center gap-3 md:gap-6 px-4 h-12">
          {/*
           * The menu button, and the whole reason this file was rewritten.
           *
           * The nav below was a single scrolling row sharing one flex line with the
           * clock, the FT-0 button, the callsign and Sign out — and it carried
           * `min-w-0`, which permits a flex item to shrink to nothing. On a phone the
           * right-hand cluster is not compressible, so it took the width and the nav
           * got whatever was left: a few pixels. `no-scrollbar` then removed the one
           * remaining hint that anything was there to scroll at all. The links were
           * not merely awkward to reach, they were INVISIBLE.
           *
           * Horizontal scrolling was the wrong shape for this regardless. Fifteen
           * destinations behind a swipe with no scrollbar is a menu you have to
           * already know the contents of.
           */}
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-expanded={menuOpen}
            aria-controls="mobile-nav"
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            className={cn(
              "md:hidden -ml-2 inline-flex items-center justify-center",
              "rounded-sm px-2 text-fg-muted hover:text-fg hover:bg-surface-2",
            )}
          >
            {/* Drawn rather than imported: two glyphs are not worth an icon set, and
                this install may have no outbound internet at all. */}
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              {menuOpen ? (
                <>
                  <path d="M6 6l12 12" />
                  <path d="M18 6L6 18" />
                </>
              ) : (
                <>
                  <path d="M3 6h18" />
                  <path d="M3 12h18" />
                  <path d="M3 18h18" />
                </>
              )}
            </svg>
          </button>

          <Link href="/" className="flex items-baseline gap-1.5 shrink-0">
            <span className="font-display text-xl uppercase tracking-wider">
              Digi
            </span>
            <span className="font-display text-xl uppercase tracking-wider text-accent-bright">
              Shack
            </span>
          </Link>

          {/* Desktop only. Below md the same links are in the drawer, so this row no
              longer has to survive a 360px viewport — which is why it can go on being
              this dense. */}
          <nav
            aria-label="Main"
            className="hidden md:flex items-center gap-0.5 overflow-x-auto no-scrollbar min-w-0"
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

          <div className="ml-auto flex items-center gap-2 md:gap-3">
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
                {/* Sign out lives in the drawer on a phone. Kept here on desktop,
                    where there is room and where it has always been. */}
                <button
                  type="button"
                  onClick={() => void signOut()}
                  disabled={signingOut}
                  className="hidden md:inline text-xs text-fg-subtle hover:text-accent-bright disabled:opacity-50"
                >
                  {signingOut ? "Signing out…" : "Sign out"}
                </button>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Backdrop. Rendered only while open so it cannot swallow taps when closed. */}
      {menuOpen && (
        <div
          className="md:hidden fixed inset-0 z-30 bg-black/60"
          onClick={() => setMenuOpen(false)}
          aria-hidden="true"
        />
      )}

      {/*
       * The drawer.
       *
       * Kept mounted so the slide has something to animate, and hidden with
       * `invisible` + `pointer-events-none` rather than unmounted so an offscreen
       * panel can never intercept a tap. The links drop out of the tab order when it
       * is closed, which `invisible` alone does not do.
       */}
      <nav
        id="mobile-nav"
        aria-label="Main"
        aria-hidden={!menuOpen}
        className={cn(
          "md:hidden fixed z-40 top-0 left-0 h-full w-72 max-w-[85vw]",
          "flex flex-col overflow-y-auto",
          "border-r border-line bg-surface",
          "pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]",
          "transition-transform duration-200 ease-out",
          menuOpen
            ? "translate-x-0"
            : "-translate-x-full pointer-events-none invisible",
        )}
      >
        <div className="flex items-center justify-between px-4 h-12 border-b border-line">
          <span className="font-display text-lg uppercase tracking-wider">
            Menu
          </span>
          <button
            type="button"
            onClick={() => setMenuOpen(false)}
            aria-label="Close menu"
            className="-mr-2 px-2 text-fg-muted hover:text-fg"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M6 6l12 12" />
              <path d="M18 6L6 18" />
            </svg>
          </button>
        </div>

        <div className="flex flex-col py-2">
          {visible.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                tabIndex={menuOpen ? undefined : -1}
                className={cn(
                  "nav-target flex items-center px-4 py-3 text-base border-l-2",
                  active
                    ? "text-fg border-accent bg-surface-2"
                    : "text-fg-muted border-transparent hover:text-fg hover:bg-surface-2",
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </div>

        {user && (
          <div className="mt-auto border-t border-line px-4 py-3 flex flex-col gap-2">
            <Link
              href="/account"
              tabIndex={menuOpen ? undefined : -1}
              className="text-sm text-fg-muted hover:text-accent-bright"
            >
              {user.callsign ? (
                <span className="font-display tracking-wide">
                  {user.callsign}
                </span>
              ) : (
                user.name
              )}
              <span className="text-fg-subtle"> — account</span>
            </Link>
            <button
              type="button"
              onClick={() => void signOut()}
              disabled={signingOut}
              tabIndex={menuOpen ? undefined : -1}
              className="self-start text-sm text-fg-subtle hover:text-accent-bright disabled:opacity-50"
            >
              {signingOut ? "Signing out…" : "Sign out"}
            </button>
          </div>
        )}
      </nav>

      <main
        id="main"
        className="flex-1 mx-auto w-full max-w-[1600px] px-4 py-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]"
      >
        {children}
      </main>
    </div>
  );
}
