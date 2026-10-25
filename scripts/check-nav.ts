/* eslint-disable no-console */
/**
 * The main navigation: who sees what, where every link goes, and the wiring that is
 * invisible on screen.
 *
 * Most of what can go wrong here looks fine. A link a role cannot open renders and then
 * bounces them to the dashboard (Stations did that to viewers). A container-query class
 * Tailwind cannot parse emits nothing and the bar never appears. An Escape that a menu
 * swallows would stop /decodes' transmit halt; an arrow key a menu lets through tunes the
 * radio on /rig. So this runs the nav model for every role, renders the components, and
 * compiles the classes they depend on.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { compile } from "@tailwindcss/node";

import {
  BAR_COMPACT_REM,
  BAR_FULL_REM,
  barEntries,
  barWidthPx,
  currentEntry,
  destinationsFor,
  ELSEWHERE,
  isActive,
  isGroup,
  NAV,
  rankDestinations,
  visibleNav,
  type NavEntry,
  type NavLink,
} from "@/components/layout/NavConfig";
import { NavDrawer } from "@/components/layout/NavDrawer";
import { NavMenus } from "@/components/layout/NavMenus";
import type { Role } from "@/lib/types";

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail = ""): void {
  if (cond) {
    pass++;
    console.log(`  ok    ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ""}`);
  }
}
function eq(got: unknown, want: unknown, label: string): void {
  ok(JSON.stringify(got) === JSON.stringify(want), label, `got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);
}

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const RANK: Record<Role, number> = { VIEWER: 0, OPERATOR: 1, ADMIN: 2 };
const ROLES: Role[] = ["VIEWER", "OPERATOR", "ADMIN"];
const ON = { rig: true };
const OFF = { rig: false };
const as = (role: Role) => ({ role });

const allLinks: NavLink[] = [...NAV.flatMap((e) => (isGroup(e) ? e.items : [e])), ...ELSEWHERE];

function shape(entries: NavEntry[]): string {
  return entries
    .map((e) => (isGroup(e) ? `${e.label}: ${e.items.map((i) => i.label).join(", ")}` : e.label))
    .join(" | ");
}

async function main() {
  // -------------------------------------------------------------------------
  console.log("\nevery link opens a page this role is allowed on");
  {
    const hrefs = allLinks.map((l) => l.href);
    eq(hrefs.filter((h, i) => hrefs.indexOf(h) !== i), [], "no destination is listed twice");

    for (const l of allLinks) {
      const base = l.href === "/" ? "pages/index" : `pages${l.href}`;
      const file = [`${base}.tsx`, `${base}/index.tsx`].find((f) => existsSync(join(ROOT, f)));
      if (!file) {
        ok(false, `${l.href} exists`, "the nav links to a page that is not in pages/ — land the page or drop the entry");
        continue;
      }
      const src = read(file);
      const at = src.search(/getServerSideProps\s*=\s*withPageAuth\b/);
      if (at < 0) {
        ok(false, `${l.href}: guard found`, `${file} has no withPageAuth, so the nav's role cannot be checked`);
        continue;
      }
      // The options object, up to any `inner:` — whose body may say "role:" about something else.
      const opts = src.slice(at, at + 400).split(/\binner\s*:/)[0] ?? "";
      const guard = (opts.match(/\brole:\s*"(\w+)"/)?.[1] ?? "VIEWER") as Role;
      const shown = (l.minRole ?? "VIEWER") as Role;
      ok(
        RANK[shown] >= RANK[guard],
        `${l.href}: shown from ${shown}, page admits ${guard}`,
        "a role below the page's guard is shown a link that bounces them to the dashboard",
      );
      ok(
        !l.qsl || /\bqsl:\s*true\b/.test(opts),
        `${l.href}: shown to the QSL manager, and the page lets them in`,
        "a QSL link the page does not open for the QSL manager bounces them to the dashboard",
      );
    }
  }

  // -------------------------------------------------------------------------
  console.log("\nwhat each role sees");
  {
    const operate4 = "Operate: Digital, Grid map, Spectrum, DX cluster";
    const operate5 = `${operate4}, Rig control`;
    const analyze = "Analyze: Statistics, Awards, Coverage";
    eq(
      shape(visibleNav(as("VIEWER"), ON)),
      `Dashboard | ${operate4} | Log: Logbook, POTA | ${analyze} | Tools: Ham toolkit, ADIF | Help`,
      "viewer: nothing that needs OPERATOR, and no Rig even with the flag on",
    );
    eq(
      shape(visibleNav(as("OPERATOR"), OFF)),
      `Dashboard | ${operate4} | Log: Logbook, New QSO, QSL, POTA | ${analyze} | Tools: Ham toolkit, Stations, ADIF | Help`,
      "operator, flag off: Stations and ADIF kept, no Settings, no Rig",
    );
    eq(
      shape(visibleNav(as("OPERATOR"), ON)),
      `Dashboard | ${operate5} | Log: Logbook, New QSO, QSL, POTA | ${analyze} | Tools: Ham toolkit, Stations, ADIF | Help`,
      "operator, flag on: Rig appears",
    );
    eq(
      shape(visibleNav(as("ADMIN"), ON)),
      `Dashboard | ${operate5} | Log: Logbook, New QSO, QSL, POTA | ${analyze} | Tools: Ham toolkit | Settings | Help`,
      "admin: Stations and ADIF give way to the settings tabs; Settings appears",
    );
    eq(
      shape(visibleNav(as("OPERATOR"), undefined)).includes("Rig"),
      false,
      "flags that never arrived fail closed",
    );
    eq(
      shape(visibleNav(null, ON)),
      `Dashboard | ${operate4} | Log: Logbook, POTA | ${analyze} | Tools: Ham toolkit, ADIF | Help`,
      "no session: only what needs no role",
    );
    eq(
      shape(barEntries(visibleNav(as("ADMIN"), ON))).split(" | ")[4],
      "Tools",
      "a group left with one item is a plain link on the bar, not a one-item menu",
    );
    eq(NAV[NAV.length - 1] && !isGroup(NAV[NAV.length - 1]!) && NAV[NAV.length - 1]!.label, "Help", "Help is last");
  }

  // -------------------------------------------------------------------------
  console.log("\nwhere the current page is");
  {
    ok(isActive("/", "/") && !isActive("/qsos", "/"), "Dashboard matches only itself");
    ok(isActive("/qsos/abc", "/qsos") && !isActive("/qsos/new", "/qsos"), "a QSO detail page is the logbook; New QSO is not");
    ok(isActive("/qsl/cards", "/qsl") && !isActive("/stationsx", "/stations"), "prefixes match on a path boundary");

    const where = (role: Role, path: string) => {
      const menu = visibleNav(as(role), ON);
      const cur = currentEntry(menu, path);
      return cur ? `${cur.key}:${cur.kind}` : null;
    };
    eq(where("OPERATOR", "/qsos/new"), "log:page", "New QSO lights Log");
    eq(where("VIEWER", "/calls/K9XYZ"), "log:section", "a callsign page sits under Log without claiming a page");
    eq(where("ADMIN", "/users"), "/settings:section", "admin on Users: Settings");
    eq(where("ADMIN", "/stations"), "/settings:section", "admin on Stations: Settings, where they reach it");
    eq(where("OPERATOR", "/stations"), "tools:page", "operator on Stations: Tools");
    eq(where("OPERATOR", "/integrations"), "tools:section", "operator on Integrations: Tools, via the tool bar on Stations");
    eq(where("ADMIN", "/account"), null, "Account is the right-hand cluster's, not the menu's");
  }

  // -------------------------------------------------------------------------
  console.log("\nthe go-to palette");
  {
    for (const role of ROLES) {
      const dest = destinationsFor(as(role), ON).map((d) => d.href);
      const menu = visibleNav(as(role), ON).flatMap((e) => (isGroup(e) ? e.items : [e])).map((l) => l.href);
      eq(menu.filter((h) => !dest.includes(h)), [], `${role}: every menu link is in the palette`);
    }
    const admin = destinationsFor(as("ADMIN"), ON);
    const sec = (href: string) => admin.find((d) => d.href === href)?.section;
    ok(admin.some((d) => d.href === "/adif"), "admin can jump to ADIF, which the menu leaves to the settings tabs");
    eq([sec("/users"), sec("/stations"), sec("/qsos/new"), sec("/"), sec("/account")], ["Settings", "Settings", "Log", null, null], "sections follow the menu's own highlighting");
    ok(!destinationsFor(as("VIEWER"), ON).some((d) => d.href === "/users" || d.href === "/qsos/new"), "a viewer is offered nothing they cannot open");
    const manager = destinationsFor({ role: "VIEWER", qslManager: true }, ON).map((d) => d.href);
    ok(manager.includes("/qsl") && manager.includes("/qsl/cards") && !manager.includes("/qsos/new"), "a viewer who is the QSL manager is offered the QSL pages, and no more");

    const top = (q: string) => rankDestinations(admin, q)[0]?.label;
    eq(top("nq"), "New QSO", "initials: nq → New QSO");
    eq(top("stats"), "Statistics", "a keyword beats a loose subsequence: stats → Statistics");
    eq(top("map"), "Grid map", "map → Grid map first");
    eq(top("ft8"), "Digital", "ft8 → Digital");
    eq(top("set"), "Settings", "set → Settings");
    eq(rankDestinations(admin, "qzxv").length, 0, "nonsense matches nothing");
    eq(rankDestinations(admin, "  ").length, admin.length, "an empty query lists everything");
  }

  // -------------------------------------------------------------------------
  console.log("\nthe desktop bar fits its thresholds");
  {
    for (const role of ROLES) {
      for (const flags of [ON, OFF]) {
        const menu = visibleNav(as(role), flags);
        const full = barWidthPx(menu, "full");
        const compact = barWidthPx(menu, "compact");
        ok(full <= BAR_FULL_REM * 16, `${role} rig=${flags.rig}: full bar ~${full}px within ${BAR_FULL_REM}rem`, "raise BAR_FULL_REM (and the classes in NavMenus) or shorten a label");
        ok(compact <= BAR_COMPACT_REM * 16, `${role} rig=${flags.rig}: compact bar ~${compact}px within ${BAR_COMPACT_REM}rem`, "raise BAR_COMPACT_REM (and the classes in NavMenus)");
      }
    }
    const src = read("components/layout/NavMenus.tsx");
    const used = new Set([...src.matchAll(/@min-\[(\d+)rem\]/g)].map((m) => Number(m[1])));
    eq([...used].sort((a, b) => a - b), [BAR_COMPACT_REM, BAR_FULL_REM].sort((a, b) => a - b), "NavMenus' container classes use exactly the two thresholds");

    // Tailwind emits NOTHING for a class it cannot parse — no error, no rule — and a bar
    // whose show-class never generates is a bar that never appears.
    const classes = [...new Set([...src.matchAll(/@(?:min-\[\d+rem\]:[\w-]+|container)/g)].map((m) => m[0]))];
    const compiler = await compile(read("styles/globals.css"), { base: ROOT, onDependency: () => {} });
    const css = compiler.build([...classes, "transition-[transform,visibility]"]);
    const esc = (c: string) => `.${c.replace(/[@[\]:,]/g, "\\$&")}`;
    for (const c of [...classes, "transition-[transform,visibility]"]) {
      ok(css.includes(esc(c)), `Tailwind generates ${c}`);
    }
    ok(/@container \(width >= 26rem\)|@container \(width >= 36rem\)/.test(css), "as a container query, not a media query");
  }

  // -------------------------------------------------------------------------
  console.log("\nthe markup");
  {
    const menu = visibleNav(as("ADMIN"), ON);
    const desk = renderToStaticMarkup(
      createElement(NavMenus, { entries: menu, pathname: "/qsos/new", drawerOpen: false, onOpenDrawer: () => {} }),
    );
    const triggers = [...desk.matchAll(/<button[^>]*aria-haspopup="menu"[^>]*>/g)].map((m) => m[0]);
    eq(triggers.length, 3, "three menus for an admin: Operate, Log, Analyze (Tools is a link)");
    for (const t of triggers) {
      const controls = t.match(/aria-controls="([^"]+)"/)?.[1];
      ok(
        Boolean(controls) && desk.includes(`id="${controls}" role="menu"`) && t.includes('aria-expanded="false"'),
        `${controls}: trigger controls a menu that exists, collapsed`,
      );
    }
    ok(/role="menuitem" tabindex="-1" aria-current="page"[^>]*href="\/qsos\/new"|href="\/qsos\/new"[^>]*aria-current="page"/.test(desk), "the current page is marked aria-current in its menu");
    ok(/aria-current="page"/.test(desk) && desk.split('aria-current="page"').length === 2, "exactly one aria-current");
    ok(desk.includes(", current section"), "the group holding the page says so to a screen reader");
    ok(/href="\/settings"[\s\S]*?<span class="sr-only @min-\[36rem\]:hidden">Settings<\/span>/.test(desk), "the glyph-only Settings link keeps its name");

    const drawer = renderToStaticMarkup(
      createElement(NavDrawer, { open: false, onClose: () => {}, entries: menu, pathname: "/stats" }),
    );
    ok(drawer.includes('id="mobile-nav"') && drawer.includes('aria-modal="true"'), "the drawer is a modal dialog with the id the menu buttons point at");
    const tabbable = [...drawer.matchAll(/<(?:a|button)\b[^>]*>/g)]
      .map((m) => m[0])
      .filter((t) => !t.includes('tabindex="-1"'));
    ok(/inert=""/.test(drawer) && tabbable.length === 0, "closed: inert, and nothing of its own left in the tab order", tabbable.join(" "));
    for (const g of menu.filter(isGroup)) {
      ok(drawer.includes(`aria-labelledby="drawer-${g.id}"`), `drawer section "${g.label}" is a labelled list`);
    }
    const open = renderToStaticMarkup(
      createElement(NavDrawer, { open: true, onClose: () => {}, entries: menu, pathname: "/stats" }),
    );
    ok(/aria-current="page"[^>]*>Statistics|href="\/stats"[^>]*aria-current="page"/.test(open), "the drawer marks the current page");
  }

  // -------------------------------------------------------------------------
  console.log("\nkeys that belong to the page");
  {
    const src = read("components/layout/NavMenus.tsx");
    const escBlock = src.slice(src.indexOf('if (e.key !== "Escape") return;'), src.indexOf("document.addEventListener"));
    ok(escBlock.length > 0 && !/\.stopPropagation\(\)/.test(escBlock.replace(/\/\/[^\n]*/g, "")), "Escape is never stopped — /decodes' halt must still hear it");
    ok(/function consume[\s\S]{0,120}e\.stopPropagation\(\)/.test(src), "arrow keys that walk a menu stop at the menu — /rig tunes on them");
    const drawer = read("components/layout/NavDrawer.tsx");
    ok(/e\.key !== "Tab"/.test(drawer) && /focusin/.test(drawer), "the open drawer traps focus");
    ok(/opener\??\.isConnected/.test(drawer), "and hands it back on close");
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

void main();
