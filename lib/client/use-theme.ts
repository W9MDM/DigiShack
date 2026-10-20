import { useSyncExternalStore } from "react";

// The active theme, for code that cannot take a CSS variable — canvases, WebGL, anything
// that paints pixels itself.
//
// The theme is an attribute on <html> (`data-theme="night"`). Token-based markup follows it
// with no help; a canvas does not, because its colours are numbers chosen in JavaScript.
// This is the one place those components learn which palette to draw with, and the one
// place the theme is read and written — components/ui/ThemeToggle.tsx is the button, and
// re-exports from here.
//
// The store watches the attribute itself (a MutationObserver), not just the toggle's own
// event, so anything that flips it — the toggle, another tab via `storage`, the pre-paint
// script, a test harness, devtools — reaches every canvas the same way.
//
// SSR: the server and the hydration pass both see "dark" (getServerSnapshot), so markup
// never mismatches; the real value arrives on the first client render after hydration.
// A canvas drawn in that one frame is drawn in the dark palette and recoloured at once.

export type Theme = "dark" | "night";

/** The localStorage key. Read before first paint by THEME_INIT_SCRIPT, so keep them together. */
export const THEME_STORAGE_KEY = "digishack:theme";

/** Dispatched on window by setTheme. The MutationObserver would catch it anyway; this is cheaper. */
export const THEME_CHANGE_EVENT = "digishack:theme";

/**
 * Runs in <head> before the body is parsed (pages/_document.tsx), so a night-mode operator
 * never gets a frame of the bright palette. Wrapped because localStorage throws in a
 * private window or with site data blocked — and an exception here would be the first
 * thing on the page.
 */
export const THEME_INIT_SCRIPT =
  `(function(){try{if(localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)})==="night")` +
  `document.documentElement.setAttribute("data-theme","night")}catch(e){}})();`;

/** The theme <html> carries right now. "dark" anywhere without a document. */
export function readTheme(): Theme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.getAttribute("data-theme") === "night" ? "night" : "dark";
}

function applyAttribute(theme: Theme): void {
  if (theme === "night") document.documentElement.setAttribute("data-theme", "night");
  else document.documentElement.removeAttribute("data-theme");
}

/** Set the theme for this device, persist it, and tell every subscriber. */
export function setTheme(theme: Theme): void {
  applyAttribute(theme);
  try {
    if (theme === "night") localStorage.setItem(THEME_STORAGE_KEY, "night");
    else localStorage.removeItem(THEME_STORAGE_KEY);
  } catch {
    /* in-memory for this page only */
  }
  window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
}

/** Subscribe to theme changes from any source. Returns the unsubscribe. */
export function subscribeTheme(notify: () => void): () => void {
  if (typeof window === "undefined") return () => {};
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
  window.addEventListener(THEME_CHANGE_EVENT, notify);
  window.addEventListener("storage", onStorage);
  // The attribute itself, whoever set it. useSyncExternalStore compares snapshots, so the
  // event and the observer both firing for one change renders once.
  const observer =
    typeof MutationObserver === "undefined"
      ? null
      : new MutationObserver(() => notify());
  observer?.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => {
    window.removeEventListener(THEME_CHANGE_EVENT, notify);
    window.removeEventListener("storage", onStorage);
    observer?.disconnect();
  };
}

const serverTheme = (): Theme => "dark";

/** The active theme. "dark" on the server and during hydration; live on the client after. */
export function useActiveTheme(): Theme {
  return useSyncExternalStore(subscribeTheme, readTheme, serverTheme);
}

/** True in the night theme — the question every canvas actually asks. */
export function useNightMode(): boolean {
  return useActiveTheme() === "night";
}
