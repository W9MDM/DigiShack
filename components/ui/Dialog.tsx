import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";

// A modal dialog.
//
// The settings confirmation was a hand-rolled div with role="dialog" and nothing behind
// it: Tab walked straight out into the page underneath, Escape did nothing, the page kept
// scrolling under the backdrop, and focus was left wherever it had been — so a keyboard
// or screen-reader user could be "in" the dialog and operating the form behind it. This
// is the one place those behaviours live:
//
//   - focus moves in on open and goes back to whatever opened it on close
//   - Tab and Shift+Tab cycle inside the panel
//   - the rest of the app is `inert` while it is open, so nothing behind it can be
//     clicked, focused or read out — a stronger guarantee than trapping Tab alone
//   - Escape and a click on the backdrop close it, unless `dismissible` is false
//   - the page behind does not scroll
//   - it is labelled by its title and described by its description
//
// Portalled to <body> so no ancestor's overflow or stacking context can clip it.

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.getClientRects().length > 0,
  );
}

/** How many dialogs are open, so a nested one does not un-inert the app under its parent. */
let openCount = 0;

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** A lead paragraph, announced with the title when the dialog opens. */
  description?: ReactNode;
  children?: ReactNode;
  /** The action row, right-aligned under the body. */
  footer?: ReactNode;
  /** Focused on open. Defaults to the first focusable control in the panel. */
  initialFocus?: RefObject<HTMLElement | null>;
  /** False while something is in flight: Escape and the backdrop stop closing it. */
  dismissible?: boolean;
  /** `alertdialog` for a confirmation that interrupts what the operator was doing. */
  role?: "dialog" | "alertdialog";
  size?: "sm" | "md" | "lg";
}

const SIZES = { sm: "max-w-sm", md: "max-w-lg", lg: "max-w-2xl" } as const;

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  initialFocus,
  dismissible = true,
  role = "dialog",
  size = "md",
}: DialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Closes on a click that both starts and ends on the backdrop, so dragging a text
  // selection out of the panel does not dismiss it.
  const downOnBackdrop = useRef(false);
  // Only after mount: there is no document.body to portal into during server rendering.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Latest values for the listeners below, without re-running the open/close effect —
  // that effect owns focus restoration, and re-running it would steal focus mid-dialog.
  const onCloseRef = useRef(onClose);
  const dismissibleRef = useRef(dismissible);
  useEffect(() => {
    onCloseRef.current = onClose;
    dismissibleRef.current = dismissible;
  }, [onClose, dismissible]);

  useEffect(() => {
    if (!open || !mounted) return;
    const panel = panelRef.current;
    if (!panel) return;

    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    // Scroll lock, padding the body by the scrollbar it removes so the page does not shift.
    const body = document.body;
    const prevOverflow = body.style.overflow;
    const prevPadding = body.style.paddingRight;
    const scrollbar = window.innerWidth - document.documentElement.clientWidth;
    body.style.overflow = "hidden";
    if (scrollbar > 0) body.style.paddingRight = `${scrollbar}px`;

    const app = document.getElementById("__next");
    openCount++;
    if (app && !app.contains(panel)) app.setAttribute("inert", "");

    const target = initialFocus?.current ?? focusables(panel)[0] ?? panel;
    target.focus({ preventScroll: true });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // An inner popover (HelpTip) already handled this press: close only that.
        if (e.defaultPrevented) return;
        if (dismissibleRef.current) {
          e.stopPropagation();
          onCloseRef.current();
        }
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables(panel);
      if (items.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const firstItem = items[0]!;
      const lastItem = items[items.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === firstItem || !panel.contains(active))) {
        e.preventDefault();
        lastItem.focus();
      } else if (!e.shiftKey && (active === lastItem || !panel.contains(active))) {
        e.preventDefault();
        firstItem.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);

    return () => {
      document.removeEventListener("keydown", onKey, true);
      openCount = Math.max(0, openCount - 1);
      if (app && openCount === 0) app.removeAttribute("inert");
      body.style.overflow = prevOverflow;
      body.style.paddingRight = prevPadding;
      if (opener && opener.isConnected) opener.focus({ preventScroll: true });
    };
    // initialFocus is read once, on open, on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mounted]);

  if (!open || !mounted) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg/80 p-4"
      onMouseDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget;
      }}
      onMouseUp={(e) => {
        if (downOnBackdrop.current && e.target === e.currentTarget && dismissible) onClose();
        downOnBackdrop.current = false;
      }}
    >
      <div
        ref={panelRef}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={cn(
          "w-full max-h-[calc(100dvh_-_2rem)] overflow-y-auto",
          // 16px inside on a phone, like a Card: inside the backdrop's own 16px, 20 more
          // left a 375px screen's dialog with under 300px for its text. 20px from `sm`.
          "rounded-md border border-line-strong bg-surface p-4 sm:p-5 shadow-pop",
          "focus:outline-none",
          SIZES[size],
        )}
      >
        <h2 id={titleId} className="font-display text-lg text-fg">
          {title}
        </h2>
        {description && (
          <div id={descriptionId} className="mt-2 text-sm leading-relaxed text-fg-muted">
            {description}
          </div>
        )}
        {children && <div className="mt-4">{children}</div>}
        {footer && <div className="mt-5 flex flex-wrap items-center justify-end gap-2">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
