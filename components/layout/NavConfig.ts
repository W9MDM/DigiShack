// The main navigation as data: what exists, who sees it, and where the current page sits.
//
// Kept free of React so scripts/check-nav.ts can run it for every role without a browser.

import type { UiFlags } from "@/lib/auth/guard";
import type { Role } from "@/lib/types";

export interface NavLink {
  href: string;
  label: string;
  /** One line under the label in a menu and in the go-to palette. */
  description?: string;
  /** Extra words the palette matches — what someone might type instead of the label. */
  keywords?: string;
  /** Hidden below this role. Server-side enforcement is independent. */
  minRole?: "OPERATOR" | "ADMIN";
  /**
   * Hidden from the MENUS at or above this role, because that role reaches it another way.
   *
   * Stations and ADIF live as tabs in the admin-only settings section. Dropping them from
   * the nav outright would take them from the operators who use them most, so admins get
   * the tidier menu and everyone else keeps the link. The palette ignores this: it is
   * about tidiness, not access.
   */
  hiddenAtRole?: "ADMIN";
  /**
   * Hidden until an operator switches it on in Settings — for surfaces honest enough to
   * admit they are unfinished. A link that is there invites a click.
   */
  experimental?: keyof UiFlags;
  /**
   * Pages reached THROUGH this one. Being on one highlights this entry's group without
   * claiming it is the current page.
   */
  also?: string[];
  /** Top-level links: dropped from the desktop bar when it is short of room. */
  compactHide?: boolean;
  /** Top-level links: shown as this glyph alone when the desktop bar is short of room. */
  icon?: "settings" | "help";
}

export interface NavGroup {
  id: string;
  label: string;
  items: NavLink[];
}

export type NavEntry = NavLink | NavGroup;

export function isGroup(e: NavEntry): e is NavGroup {
  return "items" in e;
}

export function entryKey(e: NavEntry): string {
  return isGroup(e) ? e.id : e.href;
}

// Fifteen flat links did not read on a desktop and did not fit a phone. Grouped by what
// the operator is doing: on the air, keeping the log, looking back at it, and utilities.
// The configuration tools (Users, DXCC data, API keys, Backup, Updates) stay tabs of the
// settings section, where someone looks for them anyway.
export const NAV: NavEntry[] = [
  {
    href: "/",
    label: "Dashboard",
    description: "Logbook overview",
    keywords: "home overview today",
    // The logo is also the way home, so this is the first thing to give up its space.
    compactHide: true,
  },
  {
    id: "operate",
    label: "Operate",
    items: [
      {
        href: "/decodes",
        label: "Digital",
        description: "Decode, call and log on the digital modes",
        keywords: "ft8 ft4 ft2 js8 wspr rtty cw psk31 olivia decodes",
      },
      {
        // Live decodes with clickable CQs: an operating view, not a report.
        href: "/gridmap",
        label: "Grid map",
        description: "Live decodes and your contacts on a world map",
        keywords: "map gridtracker live world",
      },
      {
        href: "/spectrum",
        label: "Spectrum",
        description: "The band as a spectrum and waterfall",
        keywords: "waterfall panadapter scope band",
      },
      {
        href: "/cluster",
        label: "DX cluster",
        description: "Spots from the DX cluster",
        keywords: "spots dx cluster telnet",
      },
      {
        href: "/rig",
        label: "Rig control",
        description: "Tune and control the radio",
        keywords: "rig cat radio tune frequency flex icom",
        minRole: "OPERATOR",
        experimental: "rig",
      },
    ],
  },
  {
    id: "log",
    label: "Log",
    items: [
      {
        href: "/qsos",
        label: "Logbook",
        description: "Every contact, searchable and editable",
        keywords: "log qsos contacts search",
        also: ["/calls"],
      },
      {
        href: "/qsos/new",
        label: "New QSO",
        description: "Log a contact by hand",
        keywords: "add contact manual entry",
        minRole: "OPERATOR",
      },
      {
        href: "/qsl",
        label: "QSL",
        description: "QSL email and paper cards",
        keywords: "qsl email cards confirm",
        minRole: "OPERATOR",
      },
      {
        href: "/pota",
        label: "POTA",
        description: "Parks on the Air: activations and progress",
        keywords: "parks activation hunt",
      },
    ],
  },
  {
    id: "analyze",
    label: "Analyze",
    items: [
      {
        href: "/stats",
        label: "Statistics",
        description: "Contacts by year, band, mode and continent",
        keywords: "stats charts totals",
      },
      {
        href: "/awards",
        label: "Awards",
        description: "DXCC, WAS, WAZ, grids: worked and confirmed",
        keywords: "dxcc was waz wac iota grids",
      },
      {
        href: "/map",
        label: "Coverage",
        description: "Every contact by bearing and distance",
        keywords: "map bearing distance antenna",
      },
    ],
  },
  {
    id: "tools",
    label: "Tools",
    items: [
      {
        href: "/tools",
        label: "Ham toolkit",
        description: "Calculators and reference",
        keywords: "tools calculator reference",
      },
      // Kept for operators and viewers, who have no settings page to find them on.
      {
        href: "/stations",
        label: "Stations",
        description: "Callsigns you operate as",
        keywords: "callsign operator station",
        // The page's own guard is OPERATOR; a viewer was shown a link that bounced them.
        minRole: "OPERATOR",
        hiddenAtRole: "ADMIN",
        // The rest of the settings tool bar, which operators reach from here.
        also: ["/incomplete", "/integrations"],
      },
      {
        href: "/adif",
        label: "ADIF",
        description: "Import and export the log",
        keywords: "import export file",
        hiddenAtRole: "ADMIN",
      },
    ],
  },
  {
    href: "/settings",
    label: "Settings",
    description: "Station, radio, logbook services and system",
    keywords: "preferences configuration config",
    minRole: "ADMIN",
    icon: "settings",
    // Every page the settings tool bar links to, so an admin on one can see where they are.
    also: [
      "/stations",
      "/adif",
      "/users",
      "/incomplete",
      "/dxcc",
      "/api-keys",
      "/integrations",
      "/backup",
      "/update",
    ],
  },
  // Last on purpose. Help that sits first implies the product needs explaining before it
  // can be used; help that sits last is where people look once something has surprised
  // them, which is when they actually read it.
  {
    href: "/help",
    label: "Help",
    description: "Why things behave as they do, and what to check",
    keywords: "docs faq troubleshooting",
    icon: "help",
  },
];

/** Pages with no menu entry that the go-to palette still offers. */
export const ELSEWHERE: NavLink[] = [
  { href: "/account", label: "Account", description: "Change your password", keywords: "password profile" },
  { href: "/qsl/cards", label: "QSL cards", description: "Paper cards owed, sent and received", minRole: "OPERATOR" },
  {
    href: "/incomplete",
    label: "Incomplete exchanges",
    description: "Exchanges with no acknowledgement",
    keywords: "unconfirmed qrz requests",
    minRole: "OPERATOR",
  },
  {
    href: "/integrations",
    label: "Integrations",
    description: "LoTW, QRZ, eQSL and Club Log",
    keywords: "lotw qrz eqsl clublog uploads",
    minRole: "OPERATOR",
  },
  { href: "/users", label: "Users", description: "Login accounts and roles", minRole: "ADMIN" },
  { href: "/dxcc", label: "DXCC data", description: "Entity and prefix tables", minRole: "ADMIN" },
  { href: "/api-keys", label: "API keys", description: "Programmatic access", minRole: "ADMIN" },
  { href: "/backup", label: "Backup", description: "Bundles and restore", minRole: "ADMIN" },
  { href: "/update", label: "Updates", description: "Deploy a new version", keywords: "upgrade version", minRole: "ADMIN" },
];

const RANK: Record<Role, number> = { VIEWER: 0, OPERATOR: 1, ADMIN: 2 };

type Viewer = { role: Role } | null;

/** Whether this user can open the page at all. */
export function canReach(link: NavLink, user: Viewer, flags: UiFlags | undefined): boolean {
  return (
    // Defaults to hidden when the flags have not arrived, so a page that forgets to pass
    // them fails closed.
    (!link.experimental || flags?.[link.experimental] === true) &&
    (!link.minRole || (user !== null && RANK[user.role] >= RANK[link.minRole]))
  );
}

/** Whether the menus list it — `canReach` minus the links this role finds elsewhere. */
export function showInMenu(link: NavLink, user: Viewer, flags: UiFlags | undefined): boolean {
  return (
    canReach(link, user, flags) &&
    !(link.hiddenAtRole && user && RANK[user.role] >= RANK[link.hiddenAtRole])
  );
}

/** The menu as this user sees it. A group with nothing left in it is dropped. */
export function visibleNav(user: Viewer, flags: UiFlags | undefined): NavEntry[] {
  const out: NavEntry[] = [];
  for (const e of NAV) {
    if (isGroup(e)) {
      const items = e.items.filter((i) => showInMenu(i, user, flags));
      if (items.length > 0) out.push({ ...e, items });
    } else if (showInMenu(e, user, flags)) {
      out.push(e);
    }
  }
  return out;
}

/** The desktop bar's entries: a group with a single item is a link, not a one-item menu. */
export function barEntries(entries: NavEntry[]): NavEntry[] {
  return entries.map((e) => {
    if (!isGroup(e) || e.items.length !== 1) return e;
    const only = e.items[0] as NavLink;
    return { ...only, label: e.label };
  });
}

export function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  if (href === "/qsos") {
    if (pathname === "/qsos") return true;
    // A QSO detail page counts as the logbook; the dedicated /qsos/new page does not.
    return pathname !== "/qsos/new" && /^\/qsos\/[^/]+$/.test(pathname);
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

export type MatchKind = "page" | "section";

export function linkMatch(link: NavLink, pathname: string): MatchKind | null {
  if (isActive(pathname, link.href)) return "page";
  if (link.also?.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return "section";
  return null;
}

/** The ONE top-level entry to highlight. An exact page beats a section claim. */
export function currentEntry(
  entries: NavEntry[],
  pathname: string,
): { key: string; kind: MatchKind; href: string | null } | null {
  let section: { key: string; kind: MatchKind; href: string | null } | null = null;
  for (const e of entries) {
    for (const l of isGroup(e) ? e.items : [e]) {
      const m = linkMatch(l, pathname);
      if (m === "page") return { key: entryKey(e), kind: "page", href: l.href };
      if (m === "section" && !section) section = { key: entryKey(e), kind: "section", href: null };
    }
  }
  return section;
}

// ---------------------------------------------------------------------------
// Desktop bar width
// ---------------------------------------------------------------------------

/**
 * Container widths (rem) at which the desktop bar changes shape. NavMenus writes these as
 * literal `@min-[…rem]` classes — Tailwind only generates what it can read — and
 * check-nav holds the two in step.
 *
 * Measured against the space the bar actually gets (a container query on the nav), not the
 * viewport, because the right-hand cluster changes width with role and radio state.
 */
export const BAR_COMPACT_REM = 26;
export const BAR_FULL_REM = 36;

// Deliberately generous: 8px a character covers the wider Linux UI faces at 14px.
const CHAR_PX = 8;
const PAD_PX = 20; // px-2.5
const CHEVRON_PX = 16; // glyph + gap
const ICON_ONLY_PX = 36;
const GAP_PX = 4; // gap-1

/** Rough rendered width of the bar's entries, for check-nav to hold against the thresholds. */
export function barWidthPx(entries: NavEntry[], mode: "full" | "compact"): number {
  const shown = barEntries(entries).filter(
    (e) => mode === "full" || isGroup(e) || !e.compactHide,
  );
  const widths = shown.map((e) => {
    if (isGroup(e)) return e.label.length * CHAR_PX + PAD_PX + CHEVRON_PX;
    if (mode === "compact" && e.icon) return ICON_ONLY_PX;
    return e.label.length * CHAR_PX + PAD_PX;
  });
  return widths.reduce((a, b) => a + b, 0) + GAP_PX * Math.max(0, widths.length - 1);
}

// ---------------------------------------------------------------------------
// The go-to palette
// ---------------------------------------------------------------------------

export interface Destination {
  href: string;
  label: string;
  description?: string;
  keywords?: string;
  /** The menu entry this page sits under, for the palette to show beside it. */
  section: string | null;
}

/** Every page this user can open, labelled with where the menu puts it. */
export function destinationsFor(user: Viewer, flags: UiFlags | undefined): Destination[] {
  const menu = visibleNav(user, flags);
  const out: Destination[] = [];
  const add = (link: NavLink) => {
    const cur = currentEntry(menu, link.href);
    const owner = cur ? menu.find((e) => entryKey(e) === cur.key) : undefined;
    // A top-level link is its own section; saying "Settings · Settings" helps nobody.
    const section = owner && (isGroup(owner) || owner.href !== link.href) ? owner.label : null;
    out.push({
      href: link.href,
      label: link.label,
      description: link.description,
      keywords: link.keywords,
      section,
    });
  };
  for (const e of NAV) {
    for (const l of isGroup(e) ? e.items : [e]) if (canReach(l, user, flags)) add(l);
  }
  for (const l of ELSEWHERE) if (canReach(l, user, flags)) add(l);
  return out;
}

function isSubsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (const ch of hay) if (ch === needle[i]) i++;
  return i === needle.length;
}

function scoreToken(d: Destination, t: string): number {
  const label = d.label.toLowerCase();
  const words = label.split(/[\s/-]+/).filter(Boolean);
  if (label === t) return 100;
  if (label.startsWith(t)) return 80;
  if (words.some((w) => w.startsWith(t))) return 60;
  if (words.map((w) => w[0]).join("").startsWith(t)) return 55; // "nq" → New QSO
  if (label.includes(t)) return 45;
  const extra = `${d.keywords ?? ""} ${d.section ?? ""}`.toLowerCase().split(/\s+/);
  if (extra.some((w) => w.startsWith(t))) return 35;
  if ((d.description ?? "").toLowerCase().includes(t)) return 20;
  if (isSubsequence(t, label.replace(/\s+/g, ""))) return 10;
  return 0;
}

/** Filter and order by how well each destination matches. Every word typed must match. */
export function rankDestinations(list: Destination[], query: string): Destination[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return list;
  const scored: { d: Destination; i: number; s: number }[] = [];
  list.forEach((d, i) => {
    let s = 0;
    for (const t of tokens) {
      const one = scoreToken(d, t);
      if (one === 0) return;
      s += one;
    }
    scored.push({ d, i, s });
  });
  return scored.sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.d);
}
