import { useEffect, useState } from "react";

// "Install DigiShack" — and, when it cannot be installed, why not.
//
// The PWA has been complete since 1.118.0 and nothing on any page mentioned it. Installing
// depended on the operator knowing their browser has a hidden menu item for it, which is
// how a finished feature reaches nobody.
//
// THE HARD PART IS NOT THE BUTTON, IT IS THE FOUR REASONS IT MIGHT NOT WORK. Rendering a
// button that silently does nothing would be worse than rendering none, and each of these
// is invisible from the page unless it is checked for:
//
//   1. Already installed. The prompt never fires again, correctly.
//   2. Not a secure context — reached over plain http on the LAN rather than through the
//      domain. No service worker, so no install, and this is the browser's rule rather
//      than ours. `localhost` is exempt by spec, which is exactly why development hides it.
//   3. iOS. Safari supports installing and has NEVER implemented `beforeinstallprompt`;
//      it is done from the Share menu by hand. A button cannot trigger it, so the honest
//      thing is to say where the menu item is.
//   4. Chromium, secure, not yet eligible — the browser withholds the event until it is
//      satisfied (engagement heuristics, manifest checks). Nothing to do but wait.
//
// The same rule as the "Heard by" panel: an empty answer must not be reported as a fact
// about the world when it is a fact about the setup.

/** The Chromium-only event. Not in lib.dom, because it is not in any standard. */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

type Status =
  | { kind: "hidden" } //     already installed, or nothing useful to say yet
  | { kind: "ready" } //      the browser gave us a prompt to fire
  | { kind: "ios" } //        installable, but only by hand
  | { kind: "insecure" }; //  http, so the browser will not install it at all

export function InstallButton() {
  const [prompt, setPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "hidden" });
  const [done, setDone] = useState(false);

  useEffect(() => {
    // Already running as an installed app. `standalone` is the iOS spelling and it is not
    // in the type, hence the cast.
    const installed =
      window.matchMedia("(display-mode: standalone)").matches ||
      (window.navigator as { standalone?: boolean }).standalone === true;
    if (installed) return;

    // A service worker is required to install, and it requires a secure context. Said
    // rather than silently omitted: reaching the app by LAN address instead of through
    // the domain is the single likeliest reason an install never appears, and nothing
    // else on the page would ever mention it.
    if (!window.isSecureContext) {
      setStatus({ kind: "insecure" });
      return;
    }

    // iOS: installable, no event, no API. Detected by the touch-capable iPad UA too,
    // which reports itself as a Mac.
    const ua = window.navigator.userAgent;
    const isIos =
      /iPad|iPhone|iPod/.test(ua) ||
      (/Macintosh/.test(ua) && window.navigator.maxTouchPoints > 1);
    if (isIos) {
      setStatus({ kind: "ios" });
      return;
    }

    const onPrompt = (e: Event) => {
      // Keep the event: after preventDefault the browser will not raise its own bar, and
      // this object is the ONLY way to open the dialog later. Losing it means no install
      // until the page is reloaded.
      e.preventDefault();
      setPrompt(e as BeforeInstallPromptEvent);
      setStatus({ kind: "ready" });
    };
    const onInstalled = () => {
      setDone(true);
      setPrompt(null);
      setStatus({ kind: "hidden" });
    };

    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  async function install() {
    if (!prompt) return;
    await prompt.prompt();
    const choice = await prompt.userChoice;
    // Single-use. Firing a spent prompt throws, and the browser will send a fresh event if
    // the operator becomes eligible again — so dropping it is correct rather than tidy.
    setPrompt(null);
    setStatus({ kind: "hidden" });
    if (choice.outcome === "accepted") setDone(true);
  }

  if (done) {
    return <span className="text-xs text-ok">Installed — open it from your home screen.</span>;
  }

  if (status.kind === "hidden") return null;

  if (status.kind === "insecure") {
    return (
      <span className="text-xs text-fg-subtle">
        Open DigiShack over <strong>https</strong> to install it as an app. Browsers refuse
        to install over a plain <code className="font-mono">http://</code> address, so the
        LAN address cannot offer it.
      </span>
    );
  }

  if (status.kind === "ios") {
    return (
      <span className="text-xs text-fg-subtle">
        To install: <strong>Share</strong> → <strong>Add to Home Screen</strong>. iOS has no
        install button a page can offer.
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => void install()}
      className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-sm border border-line text-fg-muted hover:text-fg hover:border-fg-muted transition-colors"
    >
      {/* Down-arrow-into-tray, the conventional install glyph. */}
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        className="size-3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M8 2v7m0 0 2.5-2.5M8 9 5.5 6.5" />
        <path d="M2.5 11v1.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V11" />
      </svg>
      Install DigiShack
    </button>
  );
}
