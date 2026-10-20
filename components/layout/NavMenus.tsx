import Link from "next/link";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import {
  barEntries,
  currentEntry,
  isGroup,
  type NavEntry,
  type NavGroup,
  type NavLink,
} from "@/components/layout/NavConfig";
import {
  ChevronDownIcon,
  HelpIcon,
  MenuIcon,
  SettingsIcon,
} from "@/components/layout/NavIcons";
import { Badge } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

/*
 * The desktop navigation: a few top-level entries, most of them menus.
 *
 * Its shape follows the space it is GIVEN, through a container query on the nav, rather
 * than the viewport — the right-hand cluster changes width with role, radio state and the
 * FT-0 confirm, and the nav is the thing that yields:
 *
 *   ≥ 36rem  everything, labelled
 *   ≥ 26rem  Dashboard dropped (the logo goes home), Settings and Help as glyphs
 *   < 26rem  one "Menu" button that opens the same drawer a phone uses
 *
 * The thresholds are BAR_COMPACT_REM / BAR_FULL_REM in NavConfig; check-nav holds the
 * literal classes below to them.
 *
 * No overflow scrolling, as the old flat row had: a scrolling row clips its own dropdowns,
 * and a menu you have to swipe to find is a menu you have to already know.
 */

const FULL_ONLY = "hidden @min-[36rem]:inline";
const COMPACT_ONLY = "@min-[36rem]:hidden";

const TOP =
  "nav-target inline-flex items-center gap-1 whitespace-nowrap rounded-sm border-b-2 px-2.5 py-1.5 text-sm transition-colors";

function tone(current: boolean, open = false): string {
  if (open) return cn("bg-surface-2 text-fg", current ? "border-accent" : "border-transparent");
  return current
    ? "text-fg border-accent"
    : "text-fg-muted border-transparent hover:text-fg hover:bg-surface-2";
}

const menuId = (id: string) => `nav-menu-${id}`;
const triggerId = (id: string) => `nav-trigger-${id}`;

function menuItems(id: string): HTMLElement[] {
  const menu = document.getElementById(menuId(id));
  return menu ? Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]')) : [];
}

export function NavMenus({
  entries,
  pathname,
  drawerOpen,
  onOpenDrawer,
}: {
  entries: NavEntry[];
  pathname: string;
  drawerOpen: boolean;
  onOpenDrawer: () => void;
}) {
  const bar = barEntries(entries);
  const current = currentEntry(bar, pathname);
  const [openId, setOpenId] = useState<string | null>(null);
  const rootRef = useRef<HTMLElement | null>(null);
  // Where focus goes once a menu opened from the keyboard has rendered.
  const pendingFocus = useRef<"first" | "last" | null>(null);

  // Closing on pathname also covers redirects and the back button.
  useEffect(() => {
    setOpenId(null);
  }, [pathname]);

  useEffect(() => {
    if (!openId || !pendingFocus.current) return;
    const items = menuItems(openId);
    (pendingFocus.current === "first" ? items[0] : items[items.length - 1])?.focus();
    pendingFocus.current = null;
  }, [openId]);

  useEffect(() => {
    if (!openId) return;
    const id = openId;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpenId(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Never stopPropagation here: on /decodes Escape is also the transmit halt, and
      // dismissing a menu must not swallow it.
      const hadFocus = document.getElementById(menuId(id))?.contains(document.activeElement);
      setOpenId(null);
      if (hadFocus) document.getElementById(triggerId(id))?.focus();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [openId]);

  function openMenu(id: string, focus: "first" | "last" | null) {
    if (openId === id) {
      if (focus) {
        const items = menuItems(id);
        (focus === "first" ? items[0] : items[items.length - 1])?.focus();
      }
      return;
    }
    pendingFocus.current = focus;
    setOpenId(id);
  }

  /** Left/Right across the top level, skipping whatever the container query has hidden. */
  function moveTop(from: HTMLElement, dir: 1 | -1, openTarget: boolean) {
    const tops = Array.from(
      rootRef.current?.querySelectorAll<HTMLElement>("[data-nav-top]") ?? [],
    ).filter((el) => el.getClientRects().length > 0);
    if (tops.length === 0) return;
    const next = tops[(tops.indexOf(from) + dir + tops.length) % tops.length];
    if (!next) return;
    const group = next.dataset.navGroup;
    if (openTarget && group) {
      openMenu(group, "first");
    } else {
      setOpenId(null);
      next.focus();
    }
  }

  /*
   * Navigation keys stop here. /rig tunes the radio on bare arrow keys from a window
   * listener, so an arrow that walks a menu must not also reach the page — that is a
   * frequency change nobody asked for.
   */
  function consume(e: ReactKeyboardEvent) {
    e.preventDefault();
    e.stopPropagation();
  }

  function onTopKeyDown(e: ReactKeyboardEvent<HTMLElement>) {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      consume(e);
      moveTop(e.currentTarget, e.key === "ArrowRight" ? 1 : -1, false);
    }
  }

  function onTriggerKeyDown(e: ReactKeyboardEvent<HTMLButtonElement>, id: string) {
    if (e.key === "ArrowDown") {
      consume(e);
      openMenu(id, "first");
    } else if (e.key === "ArrowUp") {
      consume(e);
      openMenu(id, "last");
    } else {
      onTopKeyDown(e);
    }
  }

  function onMenuKeyDown(e: ReactKeyboardEvent<HTMLDivElement>, id: string) {
    const items = menuItems(id);
    const at = items.indexOf(document.activeElement as HTMLElement);
    const focusAt = (i: number) => items[(i + items.length) % items.length]?.focus();
    switch (e.key) {
      case "ArrowDown":
        consume(e);
        focusAt(at + 1);
        break;
      case "ArrowUp":
        consume(e);
        focusAt(at < 0 ? -1 : at - 1);
        break;
      case "Home":
        consume(e);
        focusAt(0);
        break;
      case "End":
        consume(e);
        focusAt(-1);
        break;
      case "ArrowRight":
      case "ArrowLeft": {
        consume(e);
        const trigger = document.getElementById(triggerId(id));
        if (trigger) moveTop(trigger, e.key === "ArrowRight" ? 1 : -1, true);
        break;
      }
      case " ":
        // Space does not follow a link natively; in a menu it should.
        consume(e);
        items[at]?.click();
        break;
    }
  }

  function renderGroup(g: NavGroup) {
    const open = openId === g.id;
    const here = current?.key === g.id;
    return (
      <li
        key={g.id}
        className="relative"
        onBlur={(e) => {
          if (openId === g.id && !e.currentTarget.contains(e.relatedTarget as Node | null)) {
            setOpenId(null);
          }
        }}
      >
        <button
          type="button"
          id={triggerId(g.id)}
          data-nav-top=""
          data-nav-group={g.id}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={menuId(g.id)}
          onClick={(e) => {
            // detail 0 is Enter or Space: open and put focus in the menu. A pointer
            // toggles and leaves focus alone.
            if (e.detail === 0) openMenu(g.id, "first");
            else setOpenId((v) => (v === g.id ? null : g.id));
          }}
          onPointerEnter={(e) => {
            // Once one menu is open, sliding along the bar switches it — the menubar habit.
            if (e.pointerType === "mouse" && openId !== null && openId !== g.id) setOpenId(g.id);
          }}
          onKeyDown={(e) => onTriggerKeyDown(e, g.id)}
          className={cn(TOP, tone(here, open))}
        >
          {g.label}
          {here && <span className="sr-only">, current section</span>}
          <ChevronDownIcon
            size={12}
            className={cn("transition-transform", open && "rotate-180")}
          />
        </button>
        <div
          id={menuId(g.id)}
          role="menu"
          aria-labelledby={triggerId(g.id)}
          hidden={!open}
          onKeyDown={(e) => onMenuKeyDown(e, g.id)}
          // Keeps focus where it is when the panel's padding is clicked, so a stray click
          // inside the menu does not read as leaving it.
          onMouseDown={(e) => e.preventDefault()}
          className={cn(
            open ? "flex" : "hidden",
            "absolute left-0 top-full z-30 mt-2 w-72 max-w-[calc(100vw-2rem)] flex-col gap-0.5",
            "rounded-md border border-line bg-surface-2 p-1 shadow-raised",
          )}
        >
          {g.items.map((item) => (
            <MenuItem
              key={item.href}
              link={item}
              current={current?.href === item.href}
              onPick={() => setOpenId(null)}
            />
          ))}
        </div>
      </li>
    );
  }

  function renderLink(link: NavLink) {
    const here = current?.key === link.href ? current.kind : null;
    const Glyph = link.icon === "settings" ? SettingsIcon : link.icon === "help" ? HelpIcon : null;
    return (
      <li key={link.href} className={cn("flex", link.compactHide && "hidden @min-[36rem]:flex")}>
        <Link
          href={link.href}
          data-nav-top=""
          aria-current={here === "page" ? "page" : undefined}
          // The glyph needs a name a mouse can find; the description is worth having
          // either way, so it is the tooltip in both shapes.
          title={Glyph ? link.description : undefined}
          onKeyDown={onTopKeyDown}
          className={cn(TOP, tone(here !== null))}
        >
          {Glyph ? (
            <>
              <span className={FULL_ONLY}>{link.label}</span>
              <Glyph size={18} className={COMPACT_ONLY} />
              <span className={cn("sr-only", COMPACT_ONLY)}>{link.label}</span>
            </>
          ) : (
            link.label
          )}
          {here === "section" && <span className="sr-only">, current section</span>}
        </Link>
      </li>
    );
  }

  return (
    <nav
      ref={rootRef}
      aria-label="Main"
      // `relative z-10` keeps an open menu above the right-hand cluster's own positioned
      // pieces, which come later in the header and would otherwise paint over it.
      className="@container relative z-10 hidden md:flex flex-1 min-w-0 items-center"
    >
      <button
        type="button"
        onClick={onOpenDrawer}
        aria-expanded={drawerOpen}
        aria-controls="mobile-nav"
        aria-haspopup="dialog"
        className={cn(TOP, tone(false), "@min-[26rem]:hidden")}
      >
        <MenuIcon size={16} />
        Menu
      </button>
      <ul className="hidden @min-[26rem]:flex items-center gap-1">
        {bar.map((e) => (isGroup(e) ? renderGroup(e) : renderLink(e)))}
      </ul>
    </nav>
  );
}

function MenuItem({
  link,
  current,
  onPick,
}: {
  link: NavLink;
  current: boolean;
  onPick: () => void;
}) {
  const id = useId();
  return (
    <Link
      href={link.href}
      role="menuitem"
      tabIndex={-1}
      aria-current={current ? "page" : undefined}
      // Named by the label alone, with the line under it as the description — otherwise a
      // screen reader reads both as one long name.
      aria-labelledby={`${id}-label`}
      aria-describedby={link.description ? `${id}-desc` : undefined}
      onClick={onPick}
      className={cn(
        "nav-target flex flex-col gap-0.5 rounded-sm border-l-2 px-3 py-2",
        current
          ? "border-accent bg-surface-3"
          : "border-transparent hover:bg-surface-3 focus-visible:bg-surface-3",
      )}
    >
      <span id={`${id}-label`} className="flex items-center gap-2 text-sm font-medium text-fg">
        {link.label}
        {link.experimental && (
          <Badge size="sm" tone="warn">
            Experimental
          </Badge>
        )}
      </span>
      {link.description && (
        <span id={`${id}-desc`} className="text-xs text-fg-muted">
          {link.description}
        </span>
      )}
    </Link>
  );
}
