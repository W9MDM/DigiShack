/* eslint-disable no-console */
// Every setting must be reachable.
//
// The flat settings page could not lose anything: if a group existed it was on the
// page, somewhere below the fold. Tabs introduce a failure that list could not have —
// a group belonging to no tab renders nowhere, and a setting nobody can find is worse
// than one buried at the bottom of a long scroll.
//
// This is the check that makes the tab layout safe to add groups to. It is also why
// `settingsTabFor` returns a tab rather than `undefined`.

import { SETTING_GROUPS, SETTINGS } from "@/lib/settings/registry";
import { SETTINGS_TABS, settingsTabFor, TOOL_TABS } from "@/lib/settings/tabs";

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail = ""): void {
  if (cond) {
    pass++;
    console.log(`  ok    ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
function eq(a: unknown, b: unknown, label: string): void {
  ok(JSON.stringify(a) === JSON.stringify(b), label, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

console.log("\nnothing can hide");
{
  // The assertion that matters: every registered group lands on a tab.
  const missing = SETTING_GROUPS.filter(
    (g) => !SETTINGS_TABS.some((t) => t.groups.includes(g.id)),
  ).map((g) => g.id);

  const catchAll = SETTINGS_TABS.find((t) => t.catchAll);
  ok(catchAll !== undefined, "a catch-all tab exists");
  if (missing.length) {
    console.log(`        (unassigned, so they land on "${catchAll?.label}": ${missing.join(", ")})`);
  }

  for (const g of SETTING_GROUPS) {
    const tab = settingsTabFor(g.id);
    ok(tab !== undefined && SETTINGS_TABS.includes(tab), `group "${g.id}" resolves to a tab`);
  }

  // And every setting belongs to a group that exists — a typo in `group:` would
  // otherwise put a setting on no tab at all.
  const groupIds = new Set(SETTING_GROUPS.map((g) => g.id));
  const orphans = SETTINGS.filter((s) => !groupIds.has(s.group)).map((s) => s.key);
  eq(orphans, [], "no setting names a group that does not exist");
}

console.log("\nthe tabs themselves");
{
  eq(
    SETTINGS_TABS.filter((t) => t.catchAll).length,
    1,
    "exactly one catch-all — two would make which one wins arbitrary",
  );

  const ids = SETTINGS_TABS.map((t) => t.id);
  eq(ids.length, new Set(ids).size, "tab ids are unique");

  const labels = SETTINGS_TABS.map((t) => t.label);
  eq(labels.length, new Set(labels).size, "so are the labels");

  // A group listed under two tabs would render twice and save twice.
  const seen = new Map<string, string>();
  const dupes: string[] = [];
  for (const t of SETTINGS_TABS) {
    for (const g of t.groups) {
      if (seen.has(g)) dupes.push(`${g} (${seen.get(g)} and ${t.id})`);
      seen.set(g, t.id);
    }
  }
  eq(dupes, [], "no group appears on two tabs");

  // A tab listing a group that does not exist is dead UI: an empty tab with a label.
  const ghosts = [...seen.keys()].filter((g) => !SETTING_GROUPS.some((x) => x.id === g));
  eq(ghosts, [], "no tab lists a group that has been removed from the registry");

  // Every tab must have something to show, or it is a label leading nowhere.
  for (const t of SETTINGS_TABS) {
    const n = SETTING_GROUPS.filter((g) => settingsTabFor(g.id).id === t.id).length;
    ok(n > 0, `tab "${t.label}" has at least one group`, `${n} groups`);
  }
}

console.log("\nthe tool tabs");
{
  const ids = TOOL_TABS.map((t) => t.id);
  eq(ids.length, new Set(ids).size, "tool tab ids are unique");
  for (const t of TOOL_TABS) {
    ok(t.href.startsWith("/"), `${t.label} points at an internal route`, t.href);
    ok(t.hint.length > 0, `${t.label} has a hint, so the label alone need not explain it`);
  }

  // These are the six that came off the main navigation. If one is dropped here it
  // becomes unreachable for admins, who no longer have it in the nav.
  for (const href of ["/stations", "/adif", "/dxcc", "/api-keys", "/backup", "/update"]) {
    ok(
      TOOL_TABS.some((t) => t.href === href),
      `${href} is still reachable — it was removed from the nav`,
    );
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
