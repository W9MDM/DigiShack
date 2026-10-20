import { useEffect, useMemo, useRef, useState } from "react";

import { rankDestinations, type Destination } from "@/components/layout/NavConfig";
import { SearchIcon } from "@/components/layout/NavIcons";
import { cn } from "@/lib/utils";

/**
 * Ctrl+K (⌘K on a Mac): type a few letters of any page you can open, Enter to go.
 *
 * Lists pages the menus deliberately leave out too — Users, Backup, QSL cards — because
 * hiding something from a menu is about tidiness, and someone typing its name has already
 * said where they want to be.
 */
export function CommandPalette({
  destinations,
  pathname,
  onNavigate,
  onOpen,
}: {
  destinations: Destination[];
  pathname: string;
  onNavigate: (href: string) => void;
  /** Called as it opens, so the Shell can close the drawer it would otherwise fight. */
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const onOpenRef = useRef(onOpen);
  const openRef = useRef(false);
  useEffect(() => {
    onOpenRef.current = onOpen;
    openRef.current = open;
  });

  const results = useMemo(() => rankDestinations(destinations, query), [destinations, query]);

  useEffect(() => {
    // Mac: ⌘ only — Ctrl+K in a Mac text field deletes to the end of the line.
    const mac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
    function onKey(e: KeyboardEvent) {
      if (e.key.toLowerCase() !== "k" || e.altKey || e.shiftKey) return;
      if (mac ? !(e.metaKey && !e.ctrlKey) : !(e.ctrlKey && !e.metaKey)) return;
      e.preventDefault();
      // Closing the drawer in the SAME update as opening this matters: React runs the
      // drawer's cleanup (which releases its focus trap) before this mounts and takes
      // focus. Done one render later, the trap would pull focus back out of the input.
      if (!openRef.current) onOpenRef.current?.();
      setOpen((v) => !v);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
    return () => {
      const now = document.activeElement;
      if (opener?.isConnected && (now === null || now === document.body)) opener.focus();
    };
  }, [open]);

  useEffect(() => {
    if (open) document.getElementById(`palette-opt-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  if (!open) return null;

  const close = () => setOpen(false);
  const go = (d: Destination | undefined) => {
    if (!d) return;
    close();
    if (d.href !== pathname) onNavigate(d.href);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]">
      <div className="absolute inset-0 bg-black/60" aria-hidden="true" onMouseDown={close} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Go to a page"
        className="relative flex w-full max-w-lg flex-col overflow-hidden rounded-md border border-line-strong bg-surface shadow-pop"
      >
        <div className="flex items-center gap-2 border-b border-line px-3">
          <SearchIcon size={16} className="shrink-0 text-fg-subtle" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-autocomplete="list"
            aria-activedescendant={results.length > 0 ? `palette-opt-${active}` : undefined}
            aria-label="Go to a page"
            placeholder="Go to a page…"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              const n = results.length;
              if (e.key === "ArrowDown" && n > 0) {
                e.preventDefault();
                setActive((a) => (a + 1) % n);
              } else if (e.key === "ArrowUp" && n > 0) {
                e.preventDefault();
                setActive((a) => (a - 1 + n) % n);
              } else if (e.key === "Enter") {
                e.preventDefault();
                go(results[active]);
              } else if (e.key === "Escape") {
                // Not stopped: /decodes reads Escape too, and from a text field it only blurs.
                close();
              } else if (e.key === "Tab") {
                // The input is the only stop; Tab staying put is the focus trap.
                e.preventDefault();
              }
            }}
            className="w-full bg-transparent py-3 text-base text-fg placeholder:text-fg-subtle focus:outline-none"
          />
        </div>

        <ul
          id="palette-list"
          role="listbox"
          aria-label="Pages"
          className="max-h-[min(60vh,24rem)] overflow-y-auto p-1"
        >
          {results.map((d, i) => (
            <li
              key={d.href}
              id={`palette-opt-${i}`}
              role="option"
              aria-selected={i === active}
              // Keeps focus in the input, which owns the keyboard.
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => setActive(i)}
              onClick={() => go(d)}
              className={cn(
                "flex cursor-pointer items-baseline gap-3 rounded-sm px-3 py-2",
                i === active ? "bg-surface-3" : "",
              )}
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm font-medium text-fg">{d.label}</span>
                {d.description && (
                  <span className="truncate text-xs text-fg-muted">{d.description}</span>
                )}
              </span>
              {d.section && <span className="shrink-0 text-xs text-fg-subtle">{d.section}</span>}
            </li>
          ))}
        </ul>
        {results.length === 0 && (
          <p className="px-4 pb-4 pt-2 text-sm text-fg-muted">No page matches “{query}”.</p>
        )}
        <p role="status" className="sr-only">
          {query ? `${results.length} ${results.length === 1 ? "page" : "pages"}` : ""}
        </p>
        <div className="hidden sm:flex gap-4 border-t border-line px-3 py-2 text-xs text-fg-subtle">
          <span>↑ ↓ to move</span>
          <span>Enter to open</span>
          <span>Esc to close</span>
        </div>
      </div>
    </div>
  );
}
