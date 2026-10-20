import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { FOCUS_RING } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

// An inline "what is this?" marker.
//
// A native `title` attribute was the alternative and is not good enough here. It never
// appears on touch, it cannot be reached from the keyboard, its delay is set by the
// browser, and it will not hold two sentences legibly — and most of what needs explaining
// in this application needs two sentences, because the interesting part is usually WHY a
// control behaves the way it does rather than what it is called.
//
// So: a real button with real content. Click or Enter to open, Escape or a click elsewhere
// to close. Deliberately click-to-open rather than hover — a hover panel that covers the
// thing you were reading is worse than no panel, and on a touch screen hover does not
// exist at all.
//
// The panel stays in DOM order straight after its button rather than being portalled to
// the end of <body>, so Tab goes from the marker into any link the explanation holds.

/** Keep the panel this far inside the viewport edge. */
const EDGE = 8;

export function HelpTip({
  children,
  label = "What is this?",
  className,
  align = "left",
}: {
  /** The explanation. Keep it to a sentence or three; link out for anything longer. */
  children: ReactNode;
  /** Accessible name, when the default is not specific enough to be useful in a list. */
  label?: string;
  className?: string;
  /**
   * Which edge the panel is anchored to before it is kept on screen. "right" near the
   * right of the viewport saves a shift; either way the panel is moved back inside the
   * viewport if it would cross an edge, and opens upward if there is no room below.
   */
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const [shift, setShift] = useState(0);
  const [above, setAbove] = useState(false);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLSpanElement | null>(null);
  /** The shift currently applied, so a re-measure can recover the unshifted position. */
  const shiftRef = useRef(0);
  const panelId = useId();

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  }, []);

  // Close on Escape, on a press outside, and when focus moves outside. All registered only
  // while open, so a page with thirty of these adds no listeners until one is used.
  useEffect(() => {
    if (!open) return;
    const inside = (t: EventTarget | null) => t instanceof Node && Boolean(wrapRef.current?.contains(t));
    // NOT stopped from propagating: on /decodes Escape is HALT TX, and an open tip beside the
    // HALT button used to swallow the first press. preventDefault still marks it handled, so a
    // native <dialog> (and our Dialog, which checks defaultPrevented) won't also close on it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      // Focus goes back to the marker only if it was in the tip — Escape pressed while
      // typing elsewhere should not yank the caret out of the field.
      close(inside(document.activeElement));
    };
    // `pointerdown`, not `mousedown`: iOS Safari sends mouse events only for elements it
    // considers clickable, so a tap on plain text left the panel open.
    const onDown = (e: PointerEvent) => {
      if (!inside(e.target)) close(false);
    };
    const onFocus = (e: FocusEvent) => {
      if (!inside(e.target)) close(false);
    };
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("focusin", onFocus);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("focusin", onFocus);
    };
  }, [open, close]);

  // Keep the panel on screen. Measured before paint, from where `align` alone would put it:
  // a 256px panel anchored to a marker near the left or right edge of a 375px phone ran off
  // it, and the `align` prop only helped where the author had guessed the edge in advance.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const panel = panelRef.current;
      const button = buttonRef.current;
      if (!panel || !button) return;
      const vw = document.documentElement.clientWidth;
      const vh = window.innerHeight;
      const rect = panel.getBoundingClientRect();
      // Undo the current shift to get the natural position, then clamp that.
      const left = rect.left - shiftRef.current;
      const right = left + rect.width;
      let dx = 0;
      if (right > vw - EDGE) dx = vw - EDGE - right;
      if (left + dx < EDGE) dx = EDGE - left;
      shiftRef.current = dx;
      setShift(dx);
      const b = button.getBoundingClientRect();
      const roomBelow = vh - b.bottom;
      setAbove(roomBelow < rect.height + EDGE && b.top > roomBelow);
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

  return (
    <span ref={wrapRef} className={cn("relative inline-flex align-middle", className)}>
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        aria-expanded={open}
        // Only while open: aria-controls naming an element that is not in the document is
        // an error a screen reader reports, not a hint.
        aria-controls={open ? panelId : undefined}
        onClick={() => {
          shiftRef.current = 0;
          setShift(0);
          setOpen((v) => !v);
        }}
        className={cn(
          "inline-flex h-4 w-4 items-center justify-center rounded-full border text-3xs leading-none",
          "transition-colors",
          FOCUS_RING,
          open
            ? "border-accent text-accent-bright"
            : "border-line-strong text-fg-subtle hover:border-fg-subtle hover:text-fg-muted",
        )}
      >
        {/* A question mark rather than an "i": this answers "why is this here", and an
            information glyph reads as a footnote nobody opens. */}
        ?
      </button>
      {open && (
        <span
          ref={panelRef}
          id={panelId}
          role="note"
          style={shift ? { transform: `translateX(${shift}px)` } : undefined}
          className={cn(
            "absolute z-30 w-64 max-w-[calc(100vw-1rem)] rounded-sm border border-line-strong bg-bg-raised",
            "px-2.5 py-2 text-xs leading-relaxed text-fg-muted shadow-raised",
            // Normal weight and left-aligned: this is prose, and the surrounding label is
            // often uppercase tracking-wide, which is unreadable for a sentence.
            "normal-case tracking-normal font-normal text-left",
            above ? "bottom-5" : "top-5",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          {children}
        </span>
      )}
    </span>
  );
}
