import { useCallback } from "react";

import { FOCUS_RING } from "@/components/ui/primitives";
import { setTheme, useActiveTheme, type Theme } from "@/lib/client/use-theme";
import { cn } from "@/lib/utils";

// Dark ⇄ Night.
//
// Night is a red-on-black palette for operating in the dark without losing dark
// adaptation — see the night block in styles/globals.css for what it is and what it costs.
// The theme is an attribute on <html> (`data-theme="night"`), the palette is CSS variables,
// and nothing here re-renders the page: flipping the attribute re-colours every token-based
// element at once.
//
// Per device, in localStorage, like the other display preferences: night mode is about the
// room the screen is in, and the shack PC and the phone in the field want different answers.
//
// Canvases read the same theme through lib/client/use-theme.ts and switch palettes with it.

// The store lives in lib/client/use-theme.ts so canvases can read it without importing a
// component; re-exported here for the existing callers (pages/_document.tsx).
export { THEME_INIT_SCRIPT, THEME_STORAGE_KEY, setTheme, type Theme } from "@/lib/client/use-theme";

/** The current theme and a setter. Server render and hydration see "dark"; the real value
 *  follows on the client without a hydration mismatch. */
export function useTheme(): [Theme, (t: Theme) => void] {
  const theme = useActiveTheme();
  return [theme, useCallback((t: Theme) => setTheme(t), [])];
}

/**
 * A compact toggle button for the header.
 *
 * One button with `aria-pressed`, not a button whose label flips between "Dark" and
 * "Night": a toggle whose name changes as well as its state is announced as a different
 * control each time. The name stays "Night mode"; pressed means on.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const [theme, set] = useTheme();
  const night = theme === "night";
  return (
    <button
      type="button"
      aria-pressed={night}
      onClick={() => set(night ? "dark" : "night")}
      title={night ? "Night mode is on — switch back to the dark theme" : "Night mode — red on black, for operating in the dark"}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-sm border px-2 py-1 text-xs tracking-wide transition-colors",
        FOCUS_RING,
        night
          ? "border-accent bg-accent/15 text-accent-bright"
          : "border-line text-fg-muted hover:border-line-strong hover:text-fg",
        className,
      )}
    >
      {/* A crescent moon: the conventional night glyph, and filled when on so the state
          reads without colour. */}
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        className="size-3.5 shrink-0"
        fill={night ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      >
        <path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7Z" />
      </svg>
      {/* Icon only on a phone: the header has no room for the word beside TX and FT-0. */}
      <span className="sr-only sm:not-sr-only">
        Night<span className="sr-only"> mode</span>
      </span>
    </button>
  );
}
