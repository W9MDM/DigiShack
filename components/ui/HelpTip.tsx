import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";

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
  /** Which edge the panel is anchored to. Use "right" near the right of the viewport. */
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const panelId = useId();

  // Close on Escape and on a click outside. Both are registered only while open, so a page
  // with thirty of these adds no listeners until one is actually used.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  return (
    <span ref={wrapRef} className={cn("relative inline-flex align-middle", className)}>
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex h-4 w-4 items-center justify-center rounded-full border text-[10px] leading-none",
          "transition-colors focus-visible:outline-2 focus-visible:outline-accent-bright",
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
          id={panelId}
          role="note"
          className={cn(
            "absolute top-5 z-30 w-64 rounded-sm border border-line-strong bg-bg-raised",
            "px-2.5 py-2 text-xs leading-relaxed text-fg-muted shadow-lg",
            // Normal weight and left-aligned: this is prose, and the surrounding label is
            // often uppercase tracking-wide, which is unreadable for a sentence.
            "normal-case tracking-normal font-normal text-left",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          {children}
        </span>
      )}
    </span>
  );
}
