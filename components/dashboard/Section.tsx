import Link from "next/link";
import { useId, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * A titled group of things that are NOT in a card — a row of figures, usually.
 *
 * The dashboard labelled its two rows of figures with 11px uppercase captions, Statistics
 * used a Card per number, and POTA nested figure tiles inside Cards. One heading treatment
 * now: a step above a Card title (text-lg against text-base), so a section reads as the
 * parent of the cards inside it.
 */
export function Section({
  title,
  description,
  actions,
  className,
  children,
}: {
  title: string;
  description?: ReactNode;
  /** Right-aligned beside the title: a link onward, a filter. */
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className={cn("flex flex-col gap-3", className)}>
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <h2 id={headingId} className="font-display text-lg text-fg">
            {title}
          </h2>
          {/* `text-pretty` on a phone: a description that wraps does not end on one
              orphaned word. Phone only, so the desktop wraps exactly as it did. */}
          {description && <p className="text-sm text-fg-subtle max-sm:text-pretty">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-3 text-sm">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/** The "on to the full view" link for a section's or a card's actions slot. */
export function MoreLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="text-sm text-accent-bright underline-offset-2 hover:underline whitespace-nowrap"
    >
      {children}
      <span aria-hidden="true"> →</span>
    </Link>
  );
}
