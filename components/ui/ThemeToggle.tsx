import { useCallback, useSyncExternalStore } from "react";

import { FOCUS_RING } from "@/components/ui/primitives";
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
// NOT COVERED by the theme: canvases (waterfall, spectrum, SSTV) draw with their own
// palettes, and a few components hardcode hex or white. They stay as they are at night.

export type Theme = "dark" | "night";

/** The localStorage key. Read before first paint by THEME_INIT_SCRIPT, so keep them together. */
export const THEME_STORAGE_KEY = "digishack:theme";

const CHANGE_EVENT = "digishack:theme";

/**
 * Runs in <head> before the body is parsed (pages/_document.tsx), so a night-mode operator
 * never gets a frame of the bright palette. Wrapped because localStorage throws in a
 * private window or with site data blocked — and an exception here would be the first
 * thing on the page.
 */
export const THEME_INIT_SCRIPT =
  `(function(){try{if(localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)})==="night")` +
  `document.documentElement.setAttribute("data-theme","night")}catch(e){}})();`;

function readTheme(): Theme {
  return document.documentElement.getAttribute("data-theme") === "night" ? "night" : "dark";
}

function applyAttribute(theme: Theme): void {
  if (theme === "night") document.documentElement.setAttribute("data-theme", "night");
  else document.documentElement.removeAttribute("data-theme");
}

/** Set the theme for this device, persist it, and tell every mounted toggle. */
export function setTheme(theme: Theme): void {
  applyAttribute(theme);
  try {
    if (theme === "night") localStorage.setItem(THEME_STORAGE_KEY, "night");
    else localStorage.removeItem(THEME_STORAGE_KEY);
  } catch {
    /* in-memory for this page only */
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(notify: () => void): () => void {
  // Another tab changed it: follow, so two windows on one desk do not disagree.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== THEME_STORAGE_KEY && e.key !== null) return;
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(THEME_STORAGE_KEY);
    } catch {
      return;
    }
    applyAttribute(stored === "night" ? "night" : "dark");
    notify();
  };
  window.addEventListener(CHANGE_EVENT, notify);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, notify);
    window.removeEventListener("storage", onStorage);
  };
}

/** The current theme and a setter. Server render and hydration see "dark"; the real value
 *  follows on the client without a hydration mismatch. */
export function useTheme(): [Theme, (t: Theme) => void] {
  const theme = useSyncExternalStore(subscribe, readTheme, () => "dark" as const);
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
      <span>
        Night<span className="sr-only"> mode</span>
      </span>
    </button>
  );
}
