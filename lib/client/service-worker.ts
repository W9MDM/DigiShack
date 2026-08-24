/**
 * Service worker registration.
 *
 * Separate from _app so the conditions under which it does nothing are written down
 * once, in one place, and can be tested.
 */

/** Injected by next.config.ts from package.json. */
export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "dev";

export type SwOutcome =
  | "registered"
  | "unsupported"
  | "insecure-context"
  | "failed";

/**
 * Registers `/sw.js`, versioned by query string.
 *
 * The version in the URL is the whole cache-invalidation mechanism: the browser treats
 * a changed worker URL as a new worker, so `?v=1.118.0` installs fresh and its activate
 * handler drops every `digishack-*` cache that is not its own. Nothing inside sw.js has
 * to be edited per release.
 *
 * Returns why it did nothing, when it does nothing — a PWA that silently fails to
 * install is the hardest kind of thing to diagnose from a phone.
 */
export async function registerServiceWorker(): Promise<SwOutcome> {
  if (typeof window === "undefined") return "unsupported";
  if (!("serviceWorker" in navigator)) return "unsupported";

  /*
   * Service workers require a secure context, and for this app that is a real
   * limitation rather than a footnote: reaching the shack over HTTPS gets a working
   * PWA, and reaching it at http://192.0.2.1:3000 on the LAN does NOT — no
   * install prompt, no offline page, no standalone window. `localhost` is exempt by
   * spec, which is why it works in development and can mislead.
   *
   * Not worked around, because there is no legitimate way to: the check is the
   * browser's and it is there for good reasons. Documented in docs/pwa.md instead.
   */
  if (!window.isSecureContext) return "insecure-context";

  try {
    await navigator.serviceWorker.register(
      `/sw.js?v=${encodeURIComponent(APP_VERSION)}`,
      { scope: "/" },
    );
    return "registered";
  } catch {
    // A failed registration must never break the page. The app works fine without a
    // worker; it just is not installable or offline-capable.
    return "failed";
  }
}
