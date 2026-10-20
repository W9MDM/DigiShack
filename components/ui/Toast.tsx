import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { FOCUS_RING } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

// Toasts: a passing word about something that already happened — "Saved", "Copied",
// "Upload failed". Call from anywhere, component or not:
//
//     import { toast } from "@/components/ui/Toast";
//     toast.success("QSO logged");
//     toast.error("LoTW refused the upload", { title: "Upload failed" });
//     const id = toast.info("Rig reconnecting…", { duration: Infinity });
//     toast.dismiss(id);
//
// <Toaster /> is mounted once, in pages/_app.tsx. Calls made before it mounts are kept and
// shown when it does; calls made on the server do nothing.
//
// WHAT A TOAST IS NOT FOR. Anything the operator has to decide, anything they must not
// miss, and validation — that belongs next to the field (Field) or on the page
// (ErrorBanner). A toast disappears, and an operator looking at the radio rather than the
// screen will not see it. That is also why there is no action button: a control that
// times out is a control a keyboard or screen-reader user may not reach in time.
//
// ACCESSIBILITY. Two live regions — polite for info and success, assertive for errors —
// rendered empty from the first paint, because a live region created at the same moment
// as its content is not reliably announced. Each toast carries a visually hidden "Error:"
// / "Success:" prefix so severity is spoken, and a distinct icon shape so it is seen
// without colour (night mode puts all four tones on one red-to-amber curve). Timers pause
// while the pointer is over the stack, while focus is in it, and while the tab is hidden.
// F8 moves focus to the newest toast; Escape there dismisses it and focus returns to where
// it was. Entry animation only under `motion-safe:`.

export type ToastTone = "success" | "error" | "info";

export interface ToastOptions {
  /** A short bold heading above the message. */
  title?: string;
  /** Milliseconds before it goes. `Infinity` keeps it until dismissed. */
  duration?: number;
  /** Reuse an id to REPLACE that toast (and restart its timer) rather than stack another. */
  id?: string;
}

interface ToastItem {
  id: string;
  tone: ToastTone;
  message: ReactNode;
  title?: string;
  duration: number;
  /** Bumped when a toast is replaced or repeated, so its timer restarts. */
  version: number;
}

/* Longer than the usual 3–4s. These are read by operators who are often looking at a radio,
 * and the slowest reader in this application is the one it is tuned for. Errors longest. */
const DEFAULT_DURATION: Record<ToastTone, number> = {
  success: 5000,
  info: 6000,
  error: 10000,
};

/** Oldest goes first past this; a polling loop failing every second must not fill the screen. */
const MAX_TOASTS = 4;

// ---------------------------------------------------------------------------
// The store — module level, so `toast()` works without a hook or a context.
// ---------------------------------------------------------------------------

let items: ToastItem[] = [];
const listeners = new Set<() => void>();
let counter = 0;
const EMPTY: ToastItem[] = [];

function emit(): void {
  for (const l of listeners) l();
}

function show(tone: ToastTone, message: ReactNode, opts: ToastOptions = {}): string {
  if (typeof window === "undefined") return opts.id ?? "";
  const duration = opts.duration ?? DEFAULT_DURATION[tone];
  // The same text again (a retry loop, a double click) refreshes the toast already showing
  // instead of stacking a copy of it.
  const existing =
    (opts.id !== undefined && items.find((t) => t.id === opts.id)) ||
    (typeof message === "string" &&
      items.find((t) => t.tone === tone && t.message === message && t.title === opts.title));
  if (existing) {
    const next = { ...existing, tone, message, title: opts.title, duration, version: existing.version + 1 };
    items = items.map((t) => (t.id === existing.id ? next : t));
    emit();
    return existing.id;
  }
  const id = opts.id ?? `toast-${++counter}`;
  items = [...items, { id, tone, message, title: opts.title, duration, version: 0 }].slice(-MAX_TOASTS);
  emit();
  return id;
}

/** Remove one toast, or all of them with no id. */
function dismiss(id?: string): void {
  const next = id === undefined ? [] : items.filter((t) => t.id !== id);
  if (next.length === items.length) return;
  items = next;
  emit();
}

export const toast = {
  success: (message: ReactNode, opts?: ToastOptions) => show("success", message, opts),
  error: (message: ReactNode, opts?: ToastOptions) => show("error", message, opts),
  info: (message: ReactNode, opts?: ToastOptions) => show("info", message, opts),
  dismiss,
};

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const TONE: Record<ToastTone, { spoken: string; bar: string; icon: string }> = {
  success: { spoken: "Success: ", bar: "border-l-ok", icon: "text-ok" },
  error: { spoken: "Error: ", bar: "border-l-danger", icon: "text-danger" },
  info: { spoken: "", bar: "border-l-info", icon: "text-info" },
};

/** A different SHAPE per tone — tick, exclamation, "i" — so colour is never the only cue. */
function ToneIcon({ tone }: { tone: ToastTone }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("mt-0.5 size-4 shrink-0", TONE[tone].icon)}
    >
      <circle cx="8" cy="8" r="6.25" />
      {tone === "success" && <path d="M5.25 8.25l1.9 1.9 3.6-3.9" />}
      {tone === "error" && <path d="M8 4.75v4M8 11.25v.01" />}
      {tone === "info" && <path d="M8 7.25v4M8 4.75v.01" />}
    </svg>
  );
}

function Toast({
  item,
  paused,
  onDismiss,
}: {
  item: ToastItem;
  paused: boolean;
  onDismiss: (id: string) => void;
}) {
  // Time left, carried across pauses. Reset when the toast is replaced or repeated.
  const remaining = useRef(item.duration);
  const seenVersion = useRef(item.version);
  if (seenVersion.current !== item.version) {
    seenVersion.current = item.version;
    remaining.current = item.duration;
  }

  useEffect(() => {
    if (paused || !Number.isFinite(remaining.current)) return;
    const started = Date.now();
    const timer = window.setTimeout(() => onDismiss(item.id), Math.max(0, remaining.current));
    return () => {
      window.clearTimeout(timer);
      remaining.current -= Date.now() - started;
    };
  }, [paused, item.id, item.version, onDismiss]);

  const tone = TONE[item.tone];
  return (
    <li
      data-toast-id={item.id}
      className={cn(
        "flex w-full items-start gap-2.5 rounded-md border border-line-strong border-l-4 bg-surface-2 py-2.5 pl-3 pr-2 shadow-pop",
        "motion-safe:animate-toast-in",
        tone.bar,
      )}
    >
      <ToneIcon tone={item.tone} />
      <div className="min-w-0 flex-1 text-sm text-fg">
        <span className="sr-only">{tone.spoken}</span>
        {item.title && <p className="font-medium">{item.title}</p>}
        <div className={cn("break-words", item.title && "text-fg-muted")}>{item.message}</div>
      </div>
      <button
        type="button"
        onClick={() => onDismiss(item.id)}
        aria-label="Dismiss notification"
        className={cn(
          "-my-1 inline-flex size-7 shrink-0 items-center justify-center rounded-sm text-fg-subtle transition-colors hover:bg-surface-3 hover:text-fg",
          FOCUS_RING,
        )}
      >
        <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      </button>
    </li>
  );
}

/** Mount once, at the app root. */
export function Toaster() {
  const all = useSyncExternalStore(subscribe, () => items, () => EMPTY);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [hidden, setHidden] = useState(false);
  const regionRef = useRef<HTMLElement | null>(null);
  /** Where focus was before it came into the stack — where it goes back to. */
  const returnTo = useRef<HTMLElement | null>(null);

  // Removing the toast under the pointer fires no mouseleave, so an emptied stack would stay
  // "hovered" and every later toast would wait for a pointer that is no longer there.
  const empty = all.length === 0;
  useEffect(() => {
    if (!empty) return;
    setHovered(false);
    setFocused(false);
  }, [empty]);

  useEffect(() => {
    const onVisibility = () => setHidden(document.visibilityState === "hidden");
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // F8 jumps to the newest toast. Without it a keyboard user reaches the stack only by
  // tabbing past everything on the page, since it renders after the page content.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "F8" || e.altKey || e.ctrlKey || e.metaKey) return;
      const buttons = regionRef.current?.querySelectorAll<HTMLButtonElement>("li button");
      const last = buttons?.[buttons.length - 1];
      if (!last) return;
      e.preventDefault();
      last.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // A toast removed while it holds focus would drop focus to <body>; hand it on instead —
  // to the next toast if there is one, else back where it came from.
  const remove = useCallback((id: string) => {
    const region = regionRef.current;
    const active = document.activeElement;
    const holder = active instanceof HTMLElement ? active.closest<HTMLElement>("[data-toast-id]") : null;
    if (region && holder && holder.dataset.toastId === id) {
      const others = [...region.querySelectorAll<HTMLElement>("[data-toast-id]")].filter((el) => el !== holder);
      const next = others[others.length - 1]?.querySelector<HTMLButtonElement>("button");
      if (next) next.focus();
      else if (returnTo.current?.isConnected) returnTo.current.focus();
      else holder.blur();
    }
    dismiss(id);
  }, []);

  const onFocus = (e: FocusEvent<HTMLElement>) => {
    if (!focused && e.relatedTarget instanceof HTMLElement && !e.currentTarget.contains(e.relatedTarget)) {
      returnTo.current = e.relatedTarget;
    }
    setFocused(true);
  };
  const onBlur = (e: FocusEvent<HTMLElement>) => {
    if (!(e.relatedTarget instanceof Node) || !e.currentTarget.contains(e.relatedTarget)) setFocused(false);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "Escape") return;
    const holder = (e.target as HTMLElement).closest<HTMLElement>("[data-toast-id]");
    if (!holder?.dataset.toastId) return;
    e.preventDefault();
    e.stopPropagation();
    remove(holder.dataset.toastId);
  };

  const paused = hovered || focused || hidden;
  const polite = all.filter((t) => t.tone !== "error");
  const assertive = all.filter((t) => t.tone === "error");
  const list = (ts: ToastItem[]) =>
    ts.map((t) => <Toast key={t.id} item={t} paused={paused} onDismiss={remove} />);

  return (
    <section
      ref={regionRef}
      aria-label="Notifications (F8)"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={onFocus}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
      className={cn(
        "pointer-events-none fixed z-[60] flex flex-col gap-2",
        // Full width less the 16px gutters on a phone, clear of the home indicator; a
        // fixed column at the bottom right from `sm` up.
        "inset-x-4 bottom-[max(1rem,env(safe-area-inset-bottom))] sm:left-auto sm:right-4 sm:w-96",
      )}
    >
      {/* Never `hidden` or display:none, even when empty — a live region that is not in
          the accessibility tree announces nothing. Empty lists have no height. */}
      <ol aria-live="polite" aria-relevant="additions text" className="pointer-events-auto flex flex-col gap-2">
        {list(polite)}
      </ol>
      <ol aria-live="assertive" aria-relevant="additions text" className="pointer-events-auto flex flex-col gap-2">
        {list(assertive)}
      </ol>
    </section>
  );
}
