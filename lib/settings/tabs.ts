// How the settings are grouped into categories, and the tool pages that sit beside them.
//
// A category is what the settings sidebar lists and what `?tab=` in a link names. The ids
// are URLs — bookmarks, support answers and links in other pages carry them — so an id is
// never renamed: when "Logbooks" was split, its id stayed with the half that kept the
// logbook services and the other half got a new one.
//
// Grouping introduces a failure a flat list could not have: a group that belongs to no
// category simply disappears, and a setting nobody can find is worse than one buried at the
// bottom of a long page. So the last category is a catch-all and `settingsTabFor` never
// returns undefined. Adding a group to the registry without touching this file puts it
// under "System" — visible, slightly untidy, and impossible to lose.
// `scripts/check-settings-tabs.ts` asserts every registered group lands somewhere.
//
// Client-safe on purpose: the sidebar on every admin page imports this.

export interface SettingsTab {
  id: string;
  label: string;
  /** One line under the category heading, saying what lives here. */
  description: string;
  /** Setting group ids shown under this category, in order. */
  groups: string[];
  /** Everything not claimed by another category. Exactly one may set this. */
  catchAll?: boolean;
}

export const SETTINGS_TABS: SettingsTab[] = [
  {
    id: "station",
    label: "Station",
    description: "Your licence class, and how this installation behaves.",
    groups: ["general"],
  },
  {
    // How DigiShack reaches a radio: the hardware backends and the decode plumbing. This
    // is where someone sets up a new rig, so it holds the connection groups only — the
    // per-mode decode settings are under "Modes". Reported as "all the mode settings
    // should be in their own modes tab, not the radio setup tab".
    id: "radio",
    label: "Radio",
    description:
      "How DigiShack reaches the radio — FlexRadio, Icom or an external decoder — and the bridge service that owns it.",
    groups: ["flex", "icom", "wsjtx", "bridge"],
  },
  {
    // "digital" carries FT8/FT4/FT2 (and the decode-source selector and clock settings that
    // live in the same group); the rest are one group per mode.
    id: "modes",
    label: "Modes",
    description: "Decoding and sending, mode by mode: FT8 and the clock, RTTY, CW, PSK31, Olivia and JS8.",
    groups: ["digital", "rtty", "cw", "psk31", "olivia", "js8"],
  },
  {
    id: "automation",
    label: "Automation",
    description: "The brakes on automatic operating, the schedule, the bridge watchdog and POTA chasing.",
    groups: ["auto", "schedule", "watchdog", "pota"],
  },
  {
    // Twelve groups under one "Logbooks" tab mixed two different jobs: putting the log
    // somewhere (credentials and uploads) and telling the world what the station hears or
    // does (spots, broadcasts, a live stream). Split along that line. The id stays
    // "logbooks" so every existing ?tab=logbooks link still lands on the logbook services.
    id: "logbooks",
    label: "Logbook sync",
    description: "Credentials for the log-hosting services, and what is uploaded to them automatically.",
    groups: ["uploads", "qrz", "lotw", "eqsl", "clublog", "cloudlog", "n3fjp"],
  },
  {
    id: "spotting",
    label: "Spotting & broadcast",
    description:
      "What the station reports and sends out: PSKReporter and WSPR spots, the Battle Royale and UDP broadcasts, YouTube Live.",
    groups: ["pskreporter", "wspr", "ft8battle", "udplog", "youtube"],
  },
  {
    id: "qsl",
    label: "QSL & email",
    description: "QSL cards and emails, and the mail server everything is sent through.",
    groups: ["qsl", "smtp"],
  },
  {
    id: "system",
    label: "System",
    description: "Issue alerts, DXCC reference data, self-update, the scheduled jobs, and what stays in .env.",
    groups: ["alerts", "dxcc", "update"],
    catchAll: true,
  },
];

/** Which category a setting group belongs to. Never undefined — see the note above. */
export function settingsTabFor(groupId: string): SettingsTab {
  for (const t of SETTINGS_TABS) {
    if (t.groups.includes(groupId)) return t;
  }
  const fallback = SETTINGS_TABS.find((t) => t.catchAll);
  // The registry check guarantees a catch-all exists; this keeps the type honest.
  return fallback ?? (SETTINGS_TABS[SETTINGS_TABS.length - 1] as SettingsTab);
}

/**
 * The groups a category shows, in display order: its own list first, then — for the
 * catch-all — every registered group no category claims, in registry order.
 *
 * Takes the registered ids rather than importing the registry, so this module stays small
 * enough for every admin page to load.
 */
export function groupsInTab(tabId: string, registeredGroupIds: readonly string[]): string[] {
  const tab = SETTINGS_TABS.find((t) => t.id === tabId);
  if (!tab) return [];
  const known = new Set(registeredGroupIds);
  const listed = tab.groups.filter((g) => known.has(g));
  if (!tab.catchAll) return listed;
  const unclaimed = registeredGroupIds.filter(
    (g) => !SETTINGS_TABS.some((t) => t.groups.includes(g)),
  );
  return [...listed, ...unclaimed];
}

/**
 * A category's groups as the sidebar lists them: the ones with something to show, then —
 * behind "More" — the quiet ones (advanced only, every setting at its default). Seven groups
 * were left like that by the settings diet, and seven near-empty entries listed as loudly as
 * FlexRadio made the sidebar read as a list of things needing attention.
 *
 * Order is kept within each half, and every id lands in exactly one of them.
 */
export function splitQuietGroups(
  ids: readonly string[],
  isQuiet: (groupId: string) => boolean,
): { main: string[]; more: string[] } {
  const main: string[] = [];
  const more: string[] = [];
  for (const g of ids) (isQuiet(g) ? more : main).push(g);
  return { main, more };
}

/** Where a settings URL points. `group` and `setting` are null when it names only a category. */
export interface SettingsLocation {
  tab: string;
  group: string | null;
  setting: string | null;
}

type QueryValue = string | string[] | undefined;

function first(v: QueryValue): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Read `?tab=`, `?group=` and `?setting=` into a place on the settings page.
 *
 * The most specific parameter that names something real wins, and the category is derived
 * from it rather than trusted: `?tab=logbooks&group=ft8battle` is a link written before
 * Battle Royale moved to "Spotting & broadcast", and it should still open Battle Royale.
 * Anything unknown falls back to the first category instead of rendering an empty page.
 */
export function resolveSettingsLocation(
  query: { tab?: QueryValue; group?: QueryValue; setting?: QueryValue },
  known: {
    groupIds: readonly string[];
    groupOfSetting: (key: string) => string | undefined;
  },
): SettingsLocation {
  const setting = first(query.setting);
  if (setting) {
    const group = known.groupOfSetting(setting);
    if (group) return { tab: settingsTabFor(group).id, group, setting };
  }
  const group = first(query.group);
  if (group && known.groupIds.includes(group)) {
    return { tab: settingsTabFor(group).id, group, setting: null };
  }
  const tab = first(query.tab);
  const found = SETTINGS_TABS.find((t) => t.id === tab) ?? SETTINGS_TABS[0]!;
  return { tab: found.id, group: null, setting: null };
}

/**
 * A link into the settings page. The category is filled in from the group when it is not
 * given, so the URL still reads sensibly and still works on a build that predates `group`.
 */
export function settingsHref(target: { tab?: string; group?: string; setting?: string }): string {
  const tab = target.tab ?? (target.group ? settingsTabFor(target.group).id : undefined);
  const p = new URLSearchParams();
  if (tab) p.set("tab", tab);
  if (target.group) p.set("group", target.group);
  if (target.setting) p.set("setting", target.setting);
  const qs = p.toString();
  return qs ? `/settings?${qs}` : "/settings";
}

/**
 * The tools that used to be their own top-level nav entries.
 *
 * They keep their own routes — bookmarks and deep links still work, and each has its
 * own data loading and permissions that would be awkward to inline. What changes is
 * that they are reached from the settings sidebar rather than from a sixteen-item
 * navigation menu, which was itself the reason the phone layout was unusable.
 *
 * `minRole` mirrors each page's own guard — `scripts/check-settings-tabs.ts` reads the
 * pages to make sure. Listing a tool an operator cannot open would be worse than not
 * listing it: the guard sends them to the dashboard with no explanation.
 */
export interface ToolTab {
  id: string;
  label: string;
  href: string;
  minRole?: "OPERATOR" | "ADMIN";
  hint: string;
}

export const TOOL_TABS: ToolTab[] = [
  {
    id: "stations",
    label: "Stations",
    href: "/stations",
    minRole: "OPERATOR",
    hint: "Callsigns you operate as",
  },
  // Users belongs here rather than in the main navigation — "users should live in
  // settings". It was the last administrative page still taking a top-level slot.
  { id: "users", label: "Users", href: "/users", minRole: "ADMIN", hint: "Login accounts and roles" },
  { id: "adif", label: "ADIF", href: "/adif", hint: "Import and export the log" },
  // Exchanges the sequencer gave up on, and the QRZ-request comparison that judges them.
  // Configuration-adjacent rather than an operating page: it is a queue you work through, not
  // something watched while the radio runs.
  {
    id: "incomplete",
    label: "Incomplete",
    href: "/incomplete",
    minRole: "OPERATOR",
    hint: "Exchanges with no acknowledgement, and QRZ card requests",
  },
  { id: "dxccdata", label: "DXCC data", href: "/dxcc", minRole: "ADMIN", hint: "Entity and prefix tables" },
  { id: "api", label: "API keys", href: "/api-keys", minRole: "ADMIN", hint: "Programmatic access" },
  {
    id: "integrations",
    label: "Integrations",
    href: "/integrations",
    minRole: "OPERATOR",
    hint: "LoTW, QRZ, eQSL and Club Log",
  },
  { id: "backup", label: "Backup", href: "/backup", minRole: "ADMIN", hint: "Bundles and restore" },
  { id: "update", label: "Updates", href: "/update", minRole: "ADMIN", hint: "Deploy a new version" },
];

const RANK = { VIEWER: 0, OPERATOR: 1, ADMIN: 2 } as const;

/** The tools a role can open. */
export function toolsFor(role: keyof typeof RANK | null | undefined): ToolTab[] {
  if (!role) return [];
  return TOOL_TABS.filter((t) => !t.minRole || RANK[role] >= RANK[t.minRole]);
}

/** Whether a path is a tool page, or a page beneath one (/stations has detail routes). */
export function isToolActive(tool: ToolTab, pathname: string): boolean {
  return pathname === tool.href || pathname.startsWith(`${tool.href}/`);
}
