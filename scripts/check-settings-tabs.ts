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

import { existsSync, readFileSync } from "node:fs";

import { navGroups, partitionAdvanced, safetyKind, SETTINGS_LOOKUP } from "@/lib/settings/presentation";
import { SETTING_GROUPS, SETTINGS } from "@/lib/settings/registry";
import {
  groupResults,
  HELP_PREVIEW_CHARS,
  helpPreview,
  highlightSegments,
  searchSettings,
} from "@/lib/settings/search";
import {
  groupsInTab,
  resolveSettingsLocation,
  SETTINGS_TABS,
  settingsHref,
  settingsTabFor,
  TOOL_TABS,
} from "@/lib/settings/tabs";

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

console.log("\nthe Logbooks split");
{
  const sync = SETTINGS_TABS.find((t) => t.id === "logbooks");
  const spot = SETTINGS_TABS.find((t) => t.id === "spotting");
  eq(sync?.label, "Logbook sync", "?tab=logbooks still exists, now labelled Logbook sync");
  eq(spot?.label, "Spotting & broadcast", "Spotting & broadcast exists");
  for (const g of ["uploads", "qrz", "lotw", "eqsl", "clublog", "cloudlog", "n3fjp"]) {
    if (SETTING_GROUPS.some((x) => x.id === g)) eq(settingsTabFor(g).id, "logbooks", `${g} is under Logbook sync`);
  }
  for (const g of ["pskreporter", "wspr", "ft8battle", "udplog", "youtube"]) {
    if (SETTING_GROUPS.some((x) => x.id === g)) eq(settingsTabFor(g).id, "spotting", `${g} is under Spotting & broadcast`);
  }
  ok(!SETTINGS_TABS.some((t) => t.label === "Logbooks"), "no category is still called Logbooks");
  ok(SETTINGS_TABS.every((t) => t.description.trim().length > 20), "every category says what lives in it");
}

console.log("\ngroupsInTab shows every group exactly once");
{
  const ids = SETTING_GROUPS.map((g) => g.id);
  const shown = SETTINGS_TABS.flatMap((t) => groupsInTab(t.id, ids));
  eq([...shown].sort(), [...ids].sort(), "the categories between them list every registered group once");
  // A group nobody claimed lands in the catch-all, in the sidebar as well as on the page.
  const withNew = [...ids, "zz-new-group"];
  const catchAll = SETTINGS_TABS.find((t) => t.catchAll)!;
  ok(groupsInTab(catchAll.id, withNew).includes("zz-new-group"), "an unclaimed new group appears under the catch-all");
  ok(!groupsInTab("radio", ["hrdlog-gone", "flex"]).includes("hrdlog-gone"), "an unregistered id is not listed");
}

console.log("\ndeep links land where they point");
{
  const known = SETTINGS_LOOKUP;
  // Every id a ?tab= link could have carried before this layout.
  for (const id of ["station", "radio", "modes", "automation", "logbooks", "qsl", "system"]) {
    eq(resolveSettingsLocation({ tab: id }, known).tab, id, `?tab=${id} opens ${id}`);
  }
  eq(resolveSettingsLocation({}, known), { tab: SETTINGS_TABS[0]!.id, group: null, setting: null }, "bare /settings opens the first category");
  eq(resolveSettingsLocation({ tab: "nope", group: "nope", setting: "nope" }, known).tab, SETTINGS_TABS[0]!.id, "unknown everything falls back to the first category");
  for (const g of SETTING_GROUPS) {
    const loc = resolveSettingsLocation({ group: g.id }, known);
    ok(loc.group === g.id && loc.tab === settingsTabFor(g.id).id, `?group=${g.id} opens its category`);
  }
  // A link written before Battle Royale moved categories still opens Battle Royale.
  eq(resolveSettingsLocation({ tab: "logbooks", group: "ft8battle" }, known).tab, "spotting", "the group wins over a stale tab");
  let bad = 0;
  for (const s of SETTINGS) {
    const loc = resolveSettingsLocation({ setting: s.key }, known);
    if (loc.group !== s.group || loc.setting !== s.key || loc.tab !== settingsTabFor(s.group).id) bad++;
  }
  eq(bad, 0, `?setting= resolves for all ${SETTINGS.length} settings`);
  eq(resolveSettingsLocation({ tab: ["radio", "modes"] }, known).tab, "radio", "a repeated parameter uses the first");
  // And the links the page builds come back to the same place.
  for (const g of ["flex", "youtube", "uploads"]) {
    const href = settingsHref({ group: g });
    const q = Object.fromEntries(new URL(href, "http://x").searchParams);
    eq(resolveSettingsLocation(q, known).group, g, `${href} round-trips`);
  }
  eq(settingsHref({}), "/settings", "an empty target is plain /settings");
}

console.log("\nsearch");
{
  const ctx = { groupTitle: (id: string) => SETTING_GROUPS.find((g) => g.id === id)?.title ?? id };
  const find = (q: string) => searchSettings(SETTINGS, q, ctx).map((s) => s.key);
  ok(find("allow transmit").includes("flex.allowTransmit"), "label words find the Flex transmit gate");
  ok(find("ALLOW TRANSMIT").includes("icom.allowTransmit"), "case does not matter");
  ok(find("qrz.logbookApiKey").includes("qrz.logbookApiKey"), "a key from an error message finds its setting");
  const qrz = SETTINGS.filter((s) => s.group === "qrz").map((s) => s.key);
  ok(qrz.every((k) => find("QRZ.com").includes(k)), "a group title finds every setting in the group");
  const both = find("allow transmit icom");
  ok(both.includes("icom.allowTransmit") && !both.includes("flex.allowTransmit"), "terms AND together");
  eq(find("   "), [], "a blank query finds nothing (it is not a search)");
  eq(find("zzqqxx-no-such-thing"), [], "nonsense finds nothing");
  const font = SETTINGS.find((s) => s.type === "select" && s.options?.length);
  if (font?.options?.[0]) ok(find(font.options[0].label.split(" ")[0]!).includes(font.key), "a picker's choice finds its setting");

  const arranged = groupResults(searchSettings(SETTINGS, "port", ctx), SETTING_GROUPS.map((g) => g.id));
  const order = arranged.map((t) => SETTINGS_TABS.findIndex((x) => x.id === t.tab));
  eq(order, [...order].sort((a, b) => a - b), "results come back in category order");
}

console.log("\nhighlighting");
{
  const join = (segs: { text: string }[]) => segs.map((s) => s.text).join("");
  const text = "Allow transmit on the FlexRadio. Transmit carefully.";
  const segs = highlightSegments(text, ["transmit", "trans"]);
  eq(join(segs), text, "segments put the text back together exactly");
  eq(segs.filter((s) => s.hit).map((s) => s.text), ["transmit", "Transmit"], "overlapping terms merge, either case");
  eq(highlightSegments("a.b(c)", [".b("]).filter((s) => s.hit).map((s) => s.text), [".b("], "regex characters are literal");
  eq(highlightSegments("", ["x"]), [], "empty text is empty");
}

console.log("\nhelp previews");
{
  const short = "Short help that fits.";
  eq(helpPreview(short), { preview: short, truncated: false }, "short help is left whole");
  let broken = 0;
  let unbroken = 0;
  for (const s of SETTINGS) {
    const h = s.help ?? "";
    const p = helpPreview(h);
    if (h.trim().length <= HELP_PREVIEW_CHARS && p.truncated) broken++;
    if (p.truncated && p.preview.replace(/…$/, "").length > HELP_PREVIEW_CHARS * 1.6) broken++;
    if (p.truncated && !h.trim().startsWith(p.preview.replace(/…$/, ""))) broken++;
    if (h.trim().length > HELP_PREVIEW_CHARS && !p.truncated) unbroken++;
  }
  eq(broken, 0, "every preview is the start of its help and short enough to be a preview");
  ok(unbroken < SETTINGS.length / 4, `long help is folded (${unbroken} left whole as barely over the limit)`);
  const eg = helpPreview(
    "Pick a value, e.g. Twenty is common for a station that operates through the evening hours. " +
      "The rest of this explanation is long enough to need folding away behind the More button, really.",
  );
  ok(eg.preview.length > 40, "an e.g. does not end the first sentence");
  const tx = helpPreview(SETTINGS.find((s) => s.key === "flex.allowTransmit")?.help ?? "");
  ok(tx.truncated && tx.preview.endsWith("."), "the transmit gate's help splits at a sentence (the page shows it whole anyway)");
}

console.log("\nsafety and advanced");
{
  eq(safetyKind("flex.allowTransmit"), "transmit", "flex.allowTransmit is a transmit gate");
  eq(safetyKind("icom.allowTransmit"), "transmit", "icom.allowTransmit is a transmit gate");
  eq(safetyKind("flex.host"), null, "an ordinary setting is not");
  for (const s of SETTINGS.filter((d) => d.confirm)) ok(safetyKind(s.key) === "confirm", `${s.key} (asks to confirm) is marked`);
  for (const s of SETTINGS.filter((d) => d.key.endsWith(".allowTransmit"))) ok(safetyKind(s.key) === "transmit", `${s.key} is marked`);

  const sample = [{ advanced: false }, { advanced: true }, { advanced: false }];
  const parts = partitionAdvanced(sample);
  eq([parts.basic.length, parts.advanced.length], [2, 1], "advanced settings partition out");
  eq(partitionAdvanced([{ advanced: false }]).advanced.length, 0, "with nothing tagged, nothing is hidden");
  const tagged = SETTINGS.filter((s) => s.advanced).length;
  console.log(`        (${tagged} of ${SETTINGS.length} settings are tagged advanced)`);
  const nav = navGroups();
  eq(nav.length, SETTING_GROUPS.length, "the sidebar knows every group");
  for (const g of nav.filter((n) => n.advancedOnly)) {
    ok(SETTINGS.filter((s) => s.group === g.id).every((s) => s.advanced), `${g.id} is advanced-only because all of it is`);
  }
}

console.log("\none navigation for the admin area");
{
  // Every tool page renders the shared layout, and the old tab bar is gone.
  for (const t of TOOL_TABS) {
    const file = [`pages${t.href}.tsx`, `pages${t.href}/index.tsx`].find((f) => existsSync(f));
    ok(file !== undefined, `${t.href} has a page`);
    if (!file) continue;
    const src = readFileSync(file, "utf8");
    ok(src.includes("<SettingsLayout>"), `${file} renders the settings sidebar`);
    ok(!src.includes("ToolTabs"), `${file} no longer renders the old tab bar`);
    // minRole mirrors the page's guard — a link a role cannot open sends it to the dashboard.
    const m = /withPageAuth\(\s*(?:\{\s*role:\s*"(\w+)")?/.exec(src);
    const role = m?.[1];
    eq(t.minRole ?? null, role === "VIEWER" ? null : (role ?? null), `${t.label}'s minRole matches its page guard`);
  }
  ok(readFileSync("pages/settings.tsx", "utf8").includes("<SettingsLayout"), "the settings page uses it too");
  ok(!existsSync("components/settings/ToolTabs.tsx"), "ToolTabs is deleted");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
