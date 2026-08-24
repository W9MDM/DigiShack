// How the 126 settings are grouped into tabs.
//
// Twenty-one groups in one scrolling column was not navigable — finding the transmit
// gate meant scrolling past every log-hosting service. Tabs fix that, but they
// introduce a failure the flat list could not have: a group that belongs to no tab
// simply disappears, and a setting nobody can find is worse than one buried at the
// bottom of a long page.
//
// So the last tab is a catch-all, and `settingsTabFor` never returns undefined. Adding
// a group to the registry without touching this file puts it under "Other" — visible,
// slightly untidy, and impossible to lose. `scripts/check-settings-tabs.ts` asserts
// every registered group lands somewhere.

export interface SettingsTab {
  id: string;
  label: string;
  /** Setting group ids shown under this tab, in order. */
  groups: string[];
  /** Everything not claimed by another tab. Exactly one tab may set this. */
  catchAll?: boolean;
}

export const SETTINGS_TABS: SettingsTab[] = [
  {
    id: "station",
    label: "Station",
    groups: ["general"],
  },
  {
    id: "radio",
    label: "Radio",
    groups: ["digital", "flex", "icom", "wsjtx", "bridge"],
  },
  {
    id: "automation",
    label: "Automation",
    groups: ["auto", "schedule", "watchdog", "pota"],
  },
  {
    id: "logbooks",
    label: "Logbooks",
    groups: ["uploads", "qrz", "lotw", "eqsl", "clublog", "cloudlog", "hrdlog", "pskreporter"],
  },
  {
    id: "qsl",
    label: "QSL",
    groups: ["qsl", "smtp"],
  },
  {
    id: "system",
    label: "System",
    groups: ["dxcc", "update"],
    catchAll: true,
  },
];

/** Which tab a setting group belongs to. Never undefined — see the note above. */
export function settingsTabFor(groupId: string): SettingsTab {
  for (const t of SETTINGS_TABS) {
    if (t.groups.includes(groupId)) return t;
  }
  const fallback = SETTINGS_TABS.find((t) => t.catchAll);
  // The registry check guarantees a catch-all exists; this keeps the type honest.
  return fallback ?? (SETTINGS_TABS[SETTINGS_TABS.length - 1] as SettingsTab);
}

/**
 * The tools that used to be their own top-level nav entries.
 *
 * They keep their own routes — bookmarks and deep links still work, and each has its
 * own data loading and permissions that would be awkward to inline. What changes is
 * that they are reached from the settings tab bar rather than from a sixteen-item
 * navigation menu, which was itself the reason the phone layout was unusable.
 *
 * `minRole` mirrors each page's own guard. Listing a tab an operator cannot open would
 * be worse than not listing it.
 */
export interface ToolTab {
  id: string;
  label: string;
  href: string;
  minRole?: "OPERATOR" | "ADMIN";
  hint: string;
}

export const TOOL_TABS: ToolTab[] = [
  { id: "stations", label: "Stations", href: "/stations", hint: "Callsigns you operate as" },
  // Users belongs here rather than in the main navigation — "users should live in
  // settings". It was the last administrative page still taking a top-level slot, and it
  // was also the only one with no tab bar of its own, so following a link out of it left
  // you with no way back into the section.
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
  { id: "integrations", label: "Integrations", href: "/integrations", hint: "LoTW, QRZ, eQSL and Club Log" },
  { id: "backup", label: "Backup", href: "/backup", minRole: "ADMIN", hint: "Bundles and restore" },
  { id: "update", label: "Updates", href: "/update", minRole: "ADMIN", hint: "Deploy a new version" },
];
