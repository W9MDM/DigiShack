import Router from "next/router";
import { useEffect } from "react";

// Asking before unsaved settings are thrown away.
//
// Three ways to leave a page, three hooks: `beforeunload` for a reload, a closed tab or a
// typed URL; `routeChangeStart` for a client-side link; `beforePopState` for Back and
// Forward, where the browser has already moved the history before anything is asked.
//
// Navigation WITHIN the settings page — changing category, following a group link — is not
// leaving: the draft is page state and survives it.

let active: { message: string; pathname: string } | null = null;
/** Set once the operator has agreed to leave, so the next hook in the chain does not ask again. */
let leaving = false;

function pathOf(url: string): string {
  return url.split(/[?#]/)[0] ?? url;
}

/**
 * For links that can ask before they navigate: true when the navigation may go ahead.
 * Asking here, rather than refusing inside the router, avoids an aborted-route error.
 */
export function confirmLeave(href: string): boolean {
  if (!active || leaving || pathOf(href) === active.pathname) return true;
  if (window.confirm(active.message)) {
    leaving = true;
    return true;
  }
  return false;
}

export function useUnsavedChangesGuard(dirty: boolean, message: string, pathname = "/settings") {
  useEffect(() => {
    if (!dirty) return;
    active = { message, pathname };
    leaving = false;

    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Still required by some browsers; the text itself is never shown.
      e.returnValue = "";
    };

    const onRouteStart = (url: string) => {
      if (confirmLeave(url)) return;
      // The only way the pages router offers to cancel a navigation is for a listener to
      // throw. Next logs the rejection; nothing else happens and the page stays put.
      throw new Error("Navigation cancelled to keep unsaved settings");
    };
    const onRouteDone = () => {
      leaving = false;
    };

    Router.beforePopState(({ as }) => {
      if (confirmLeave(as)) return true;
      // The browser has already stepped back; step forward again to stay on this entry.
      window.history.forward();
      return false;
    });
    window.addEventListener("beforeunload", onBeforeUnload);
    Router.events.on("routeChangeStart", onRouteStart);
    Router.events.on("routeChangeComplete", onRouteDone);
    Router.events.on("routeChangeError", onRouteDone);

    return () => {
      active = null;
      Router.beforePopState(() => true);
      window.removeEventListener("beforeunload", onBeforeUnload);
      Router.events.off("routeChangeStart", onRouteStart);
      Router.events.off("routeChangeComplete", onRouteDone);
      Router.events.off("routeChangeError", onRouteDone);
    };
  }, [dirty, message, pathname]);
}
