import Link from "next/link";
import { useEffect, useRef, type KeyboardEvent } from "react";

import { cn } from "@/lib/utils";

// Navigation shared by the two QSL pages: which page you are on, and which slice of it.

const SECTIONS = [
  { id: "email", href: "/qsl", label: "Email queue" },
  { id: "cards", href: "/qsl/cards", label: "Paper cards" },
] as const;

/** The one way between the email queue and the paper cards, the same on both pages. */
export function QslSectionNav({ active }: { active: (typeof SECTIONS)[number]["id"] }) {
  return (
    <nav
      aria-label="QSL"
      className="inline-flex rounded-sm border border-line bg-surface p-0.5"
    >
      {SECTIONS.map((s) => {
        const on = s.id === active;
        return (
          <Link
            key={s.id}
            href={s.href}
            aria-current={on ? "page" : undefined}
            className={cn(
              // `nav-target` takes the 44px touch height from globals.css.
              "nav-target inline-flex items-center rounded-sm px-3 py-1 text-sm transition-colors",
              on ? "bg-surface-3 text-fg" : "text-fg-muted hover:bg-surface-2 hover:text-fg",
            )}
          >
            {s.label}
          </Link>
        );
      })}
    </nav>
  );
}

export interface StatusTab<T extends string> {
  id: T;
  label: string;
  /** Left out when it is not known. An unknown count is never drawn as 0. */
  count?: number | null;
  /** Colours the count while it is above zero. */
  tone?: "warn" | "danger";
}

export const tabId = (base: string, id: string) => `${base}-tab-${id}`;
export const tabPanelId = (base: string) => `${base}-panel`;

/**
 * An underline tab strip with counts — the settings page's tab bar, plus arrow keys.
 *
 * It scrolls sideways rather than wrapping: a wrapped strip on a phone pushes the list
 * it controls off the screen.
 */
export function StatusTabs<T extends string>({
  tabs,
  active,
  onSelect,
  label,
  idBase,
  className,
}: {
  tabs: StatusTab<T>[];
  active: T;
  onSelect: (id: T) => void;
  label: string;
  idBase: string;
  className?: string;
}) {
  const refs = useRef(new Map<string, HTMLButtonElement>());

  function onKey(e: KeyboardEvent<HTMLButtonElement>, i: number) {
    const last = tabs.length - 1;
    const next =
      e.key === "ArrowRight"
        ? i === last ? 0 : i + 1
        : e.key === "ArrowLeft"
          ? i === 0 ? last : i - 1
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? last
              : null;
    if (next === null) return;
    const t = tabs[next];
    if (!t) return;
    e.preventDefault();
    onSelect(t.id);
    refs.current.get(t.id)?.focus();
  }

  const strip = useRef<HTMLDivElement | null>(null);

  // The chosen tab is brought into view, so one picked by the URL (?tab=skipped) or by the
  // arrow keys is never selected off the edge of a phone's strip. The strip is scrolled by
  // hand rather than with scrollIntoView, which would also scroll the PAGE to the strip —
  // yanking a restored scroll position back up to the tabs on Back.
  useEffect(() => {
    const box = strip.current;
    const tab = refs.current.get(active);
    if (!box || !tab) return;
    const b = box.getBoundingClientRect();
    const t = tab.getBoundingClientRect();
    if (t.left < b.left) box.scrollLeft -= b.left - t.left;
    else if (t.right > b.right) box.scrollLeft += t.right - b.right;
  }, [active]);

  return (
    <div className={cn("border-b border-line", className)}>
      {/* No scrollbar below sm. Where a window draws one it took a 15px band under the tabs,
          on top of the underline, for a strip whose cut-off last tab already says there is
          more. From sm up all of a page's tabs fit, so nothing changes there. */}
      <div
        ref={strip}
        role="tablist"
        aria-label={label}
        className="flex gap-1 overflow-x-auto pb-px max-sm:[scrollbar-width:none]"
      >
        {tabs.map((t, i) => {
          const on = t.id === active;
          const loud = t.tone !== undefined && (t.count ?? 0) > 0;
          return (
            <button
              key={t.id}
              ref={(el) => {
                if (el) refs.current.set(t.id, el);
                else refs.current.delete(t.id);
              }}
              type="button"
              role="tab"
              id={tabId(idBase, t.id)}
              aria-selected={on}
              aria-controls={tabPanelId(idBase)}
              tabIndex={on ? 0 : -1}
              onClick={() => onSelect(t.id)}
              onKeyDown={(e) => onKey(e, i)}
              className={cn(
                "-mb-px inline-flex shrink-0 items-center gap-2 border-b-2 px-2.5 py-2 text-sm sm:px-3 transition-colors",
                on ? "border-accent text-fg" : "border-transparent text-fg-muted hover:text-fg",
              )}
            >
              {t.label}
              {t.count !== undefined && t.count !== null && (
                <span
                  className={cn(
                    "tnum rounded-sm px-1.5 text-xs",
                    loud
                      ? t.tone === "danger"
                        ? "bg-danger/12 text-danger"
                        : "bg-warn/12 text-warn"
                      : on
                        ? "bg-surface-3 text-fg"
                        : "bg-surface-2 text-fg-muted",
                  )}
                >
                  {t.count.toLocaleString("en-US")}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
