import Link from "next/link";
import { useEffect, useRef, type ReactNode } from "react";

import {
  currentEntry,
  isGroup,
  type NavEntry,
  type NavGroup,
  type NavLink,
} from "@/components/layout/NavConfig";
import { CloseIcon } from "@/components/layout/NavIcons";
import { Badge } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

const FOCUSABLE =
  'a[href]:not([tabindex="-1"]), button:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])';

/**
 * The phone menu, also opened by the desktop bar's "Menu" button when the header is too
 * narrow for the full bar. The same groups as the desktop menus, as labelled sections.
 *
 * Kept mounted so the slide has something to animate, and hidden with `invisible` +
 * `pointer-events-none` rather than unmounted so an offscreen panel can never intercept
 * a tap. The links leave the tab order when it is closed, which `invisible` alone does
 * not do until its transition ends.
 *
 * While open it is modal: focus is trapped inside and goes back to whatever opened it.
 */
export function NavDrawer({
  open,
  onClose,
  entries,
  pathname,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  entries: NavEntry[];
  pathname: string;
  /** Account and sign-out, owned by the Shell. */
  footer?: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusables = () => Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
    focusables()[0]?.focus();

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        closeRef.current();
        return;
      }
      if (e.key !== "Tab" || !panel) return;
      const list = focusables();
      const first = list[0];
      const last = list[list.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      const outside = !panel.contains(active);
      if (e.shiftKey && (active === first || outside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || outside)) {
        e.preventDefault();
        first.focus();
      }
    }
    // Catches focus that leaves by any other route — a click on the page behind would
    // close the drawer anyway, but a screen reader can move focus without a Tab.
    function onFocusIn(e: FocusEvent) {
      if (panel && !panel.contains(e.target as Node)) focusables()[0]?.focus();
    }

    // Scrolling the page behind a full-height drawer loses your place in it.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocusIn);
      // Hand focus back only if it is still ours to give: the go-to palette may already
      // have taken it.
      const active = document.activeElement;
      if (
        opener?.isConnected &&
        (active === null || active === document.body || panel.contains(active))
      ) {
        opener.focus();
      }
    };
  }, [open]);

  const current = currentEntry(entries, pathname);
  const tab = open ? undefined : -1;

  // Consecutive top-level links share one list; each group is its own labelled list.
  const blocks: ({ kind: "links"; links: NavLink[] } | { kind: "group"; group: NavGroup })[] = [];
  for (const e of entries) {
    if (isGroup(e)) {
      blocks.push({ kind: "group", group: e });
    } else {
      const last = blocks[blocks.length - 1];
      if (last?.kind === "links") last.links.push(e);
      else blocks.push({ kind: "links", links: [e] });
    }
  }

  function item(link: NavLink) {
    const here = current?.href === link.href;
    return (
      <li key={link.href}>
        <Link
          href={link.href}
          aria-current={here ? "page" : undefined}
          tabIndex={tab}
          onClick={onClose}
          className={cn(
            "nav-target flex items-center gap-2 px-4 py-3 text-base border-l-2",
            here
              ? "text-fg border-accent bg-surface-2"
              : "text-fg-muted border-transparent hover:text-fg hover:bg-surface-2",
          )}
        >
          {link.label}
          {link.experimental && (
            <Badge size="sm" tone="warn">
              Experimental
            </Badge>
          )}
        </Link>
      </li>
    );
  }

  return (
    <>
      {/* Rendered only while open so it cannot swallow taps when closed. */}
      {open && (
        <div className="fixed inset-0 z-30 bg-black/60" onClick={onClose} aria-hidden="true" />
      )}
      <div
        id="mobile-nav"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Menu"
        aria-hidden={!open}
        inert={!open}
        className={cn(
          "fixed z-40 top-0 left-0 h-full w-72 max-w-[85vw]",
          "flex flex-col overflow-y-auto",
          "border-r border-line bg-surface shadow-pop",
          "pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]",
          // Visibility rides the transition so the panel slides out before it vanishes.
          "transition-[transform,visibility] duration-200 ease-out",
          open ? "translate-x-0" : "-translate-x-full pointer-events-none invisible",
        )}
      >
        <div className="flex items-center justify-between px-4 h-12 shrink-0 border-b border-line">
          <span className="font-display text-lg uppercase tracking-wider">Menu</span>
          <button
            type="button"
            onClick={onClose}
            tabIndex={tab}
            aria-label="Close menu"
            className="-mr-2 px-2 text-fg-muted hover:text-fg"
          >
            <CloseIcon size={20} />
          </button>
        </div>

        <nav aria-label="Main" className="flex flex-col py-2">
          {blocks.map((b, i) =>
            b.kind === "group" ? (
              <div key={b.group.id} className="pt-2">
                <h2
                  id={`drawer-${b.group.id}`}
                  className={cn(
                    "px-4 pb-1 font-display text-sm uppercase tracking-wider",
                    current?.key === b.group.id ? "text-fg-muted" : "text-fg-subtle",
                  )}
                >
                  {b.group.label}
                </h2>
                <ul aria-labelledby={`drawer-${b.group.id}`}>{b.group.items.map(item)}</ul>
              </div>
            ) : (
              <ul
                key={`links-${i}`}
                className={cn(i > 0 && "mt-2 border-t border-line pt-2")}
              >
                {b.links.map(item)}
              </ul>
            ),
          )}
        </nav>

        {footer}
      </div>
    </>
  );
}
