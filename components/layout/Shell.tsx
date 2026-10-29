import Link from "next/link";
import { InstallButton } from "@/components/layout/InstallButton";
import { Ft0Button } from "@/components/layout/Ft0Button";
import { OperatorButton } from "@/components/layout/OperatorButton";
import { TxArmButton } from "@/components/layout/TxArmButton";
import { UtcClock } from "@/components/layout/UtcClock";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { useRouter } from "next/router";
import type { UiFlags } from "@/lib/auth/guard";
import { useEffect, useState, type ReactNode } from "react";

import { CommandPalette } from "@/components/layout/CommandPalette";
import { destinationsFor, visibleNav } from "@/components/layout/NavConfig";
import { NavDrawer } from "@/components/layout/NavDrawer";
import { NavMenus } from "@/components/layout/NavMenus";
import { Badge } from "@/components/ui/primitives";
import { apiPost } from "@/lib/client/api";
import { useUser } from "@/lib/client/session";
import { cn } from "@/lib/utils";

// What the navigation contains, and who sees which part of it, is NavConfig.ts.

export function Shell({
  children,
  uiFlags,
}: {
  children: ReactNode;
  /** Absent on the bare routes, which render no navigation at all. */
  uiFlags?: UiFlags;
}) {
  const router = useRouter();
  const { pathname } = router;
  const user = useUser();
  const [signingOut, setSigningOut] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  // A drawer that survives the navigation it just triggered covers the page the
  // operator asked for. Closing on pathname rather than on click also covers the
  // links that redirect and the browser back button.
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  const visible = visibleNav(user, uiFlags);

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
      {/* Visible only when focused. Every header control stands between the top of
          every page and its content; without this a keyboard user tabs through all of
          them every time. */}
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
        {/* The phone header has no width to spare: menu, logo, TX pill, FT-0 and its
            marker, and Night fill 360px to within a few pixels. The tighter gaps and the
            smaller logo below `sm` are what buy the TX pill room to say ON AIR in full
            rather than a bare "AIR"; from `sm` up every value is what it was. */}
        <div className="mx-auto max-w-[1600px] flex items-center gap-2 sm:gap-3 md:gap-6 px-4 h-12">
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
              "md:hidden -ml-2 inline-flex h-10 items-center justify-center",
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
            <span className="font-display text-lg sm:text-xl uppercase tracking-wider">
              Digi
            </span>
            <span className="font-display text-lg sm:text-xl uppercase tracking-wider text-accent-bright">
              Shack
            </span>
          </Link>

          {/* Desktop only; below md the same groups are in the drawer. It takes whatever
              width the right-hand cluster leaves and changes shape to fit it. */}
          <NavMenus
            entries={visible}
            pathname={pathname}
            drawerOpen={menuOpen}
            onOpenDrawer={() => setMenuOpen(true)}
          />

          <div className="ml-auto flex items-center gap-1 sm:gap-2 md:gap-3">
            <UtcClock />
            <OperatorButton />
            <TxArmButton />
            <Ft0Button />
            <ThemeToggle />
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
                  // Not on a phone: at 375px it pushed the header 42px wider than the screen.
                  <span className="hidden sm:inline-flex">
                    <Badge tone={user.role === "ADMIN" ? "accent" : "neutral"}>
                      {user.role}
                    </Badge>
                  </span>
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

      {/* The drawer: the phone menu, and the desktop bar's fallback when it is too
          narrow. The account footer stays here with the rest of the account controls. */}
      <NavDrawer
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        entries={visible}
        pathname={pathname}
        footer={
          user && (
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
          )
        }
      />

      <CommandPalette
        destinations={destinationsFor(user, uiFlags)}
        pathname={pathname}
        onNavigate={(href) => void router.push(href)}
        onOpen={() => setMenuOpen(false)}
      />

      {/* 16px above and below the page on a phone rather than 24, matching the 16px side
          gutter; with PageHeader's smaller phone title this gives every page about 20px
          of its first screen back. 24px from `sm` up, as before. */}
      <main
        id="main"
        className="flex-1 mx-auto w-full max-w-[1600px] px-4 py-4 sm:py-6"
      >
        {children}
      </main>

      {/*
        The footer, which exists for one thing: somewhere to say the app can be installed.

        The PWA has been complete since 1.118.0 and nothing on any page mentioned it, so
        installing depended on the operator knowing their browser hides a menu item for
        it. `InstallButton` renders nothing at all when there is nothing useful to say —
        already installed, or the browser has not offered — so this row is usually empty
        and costs a few pixels.

        The safe-area padding moved here from `main`: on a phone it is the bottom of the
        page that must clear the home indicator, and that is now this.
      */}
      <footer className="mx-auto w-full max-w-[1600px] px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-2 flex items-center justify-center min-h-8">
        <InstallButton />
      </footer>
    </div>
  );
}
