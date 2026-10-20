/* eslint-disable no-console */
// The help page: its anchors, its search, and the links inside its answers.
// Run: npx tsx scripts/check-help.ts
//
// The anchors are a public surface — people paste /help#nothing-transmits into a chat —
// so a duplicated or renamed id is a broken link somewhere this repo cannot see. The search
// reads the answers' own JSX, so a refactor of an answer into a component that hides its
// text from that walk would make the answer unfindable while it still renders fine.

import { existsSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { FAQ } from "@/components/help/faq";
import { HelpBrowser } from "@/components/help/HelpBrowser";
import { faqSearch, normalize, textOf } from "@/components/help/search";

let pass = 0;
let fail = 0;
const warnings: string[] = [];

function ok(cond: boolean, label: string, detail = ""): void {
  if (cond) {
    pass++;
    console.log(`  ok    ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("anchors");
{
  const ids = FAQ.flatMap((s) => [s.id, ...s.items.map((i) => i.id)]);
  const dupes = ids.filter((id, n) => ids.indexOf(id) !== n);
  ok(dupes.length === 0, "every section and answer id is unique", dupes.join(", "));
  const bad = ids.filter((id) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id));
  ok(bad.length === 0, "ids are lower-case kebab, so they survive being typed into a URL", bad.join(", "));
  // The Shell's own ids. A help anchor with one of these names would jump somewhere else.
  const taken = ["main", "mobile-nav", "help-search"];
  const clash = ids.filter((id) => taken.includes(id));
  ok(clash.length === 0, "no anchor reuses an id the page already has", clash.join(", "));
  ok(FAQ.every((s) => s.items.length > 0), "no empty section");
}

console.log("\nsearch");
{
  const search = faqSearch(FAQ);
  const hits = (q: string): string[] => search(q).flatMap((s) => s.items.map((i) => i.id));

  ok(hits("").length === FAQ.reduce((n, s) => n + s.items.length, 0), "an empty query shows everything");
  ok(hits("waterfall").includes("waterfall-dark"), "'waterfall' finds the dark-waterfall answer");
  ok(hits("WATERFALL dark").includes("waterfall-dark"), "case does not matter and every word must match");
  ok(hits("password").includes("forgot-password"), "'password' finds the forgotten-password answer");
  ok(hits("re-arm").includes("stopped-on-its-own"), "a hyphenated word matches its spaced form");
  ok(hits("rearm").includes("stopped-on-its-own"), "and its run-together form, through keywords");
  ok(hits("decod").includes("no-decodes"), "a partial word matches");
  ok(hits("stations").includes("placeholder-callsign"), "text inside a link in an answer is searched");
  ok(hits("qzxv").length === 0, "nonsense finds nothing");
  ok(normalize("Ré-arm — now") === "re arm   now", "normalize drops accents and turns dashes to spaces");
  ok(textOf(createElement("p", null, "a ", createElement("code", null, "b"))).includes("b"), "textOf walks nested elements");
}

console.log("\nrendering");
{
  const html = renderToStaticMarkup(createElement(HelpBrowser, { initialQuery: "waterfall" }));
  ok(html.includes('id="waterfall-dark"'), "a matching answer renders with its anchor");
  ok(!html.includes('id="forgot-password"'), "a non-matching answer is not rendered");
  ok(html.includes('href="#waterfall-dark"'), "the contents links to it");
  const none = renderToStaticMarkup(createElement(HelpBrowser, { initialQuery: "qzxv" }));
  ok(none.includes("Clear the search"), "no matches offers a way back");
}

console.log("\nlinks inside answers");
{
  const hrefs = new Set<string>();
  const html = renderToStaticMarkup(createElement(HelpBrowser, {}));
  for (const m of html.matchAll(/href="(\/[^"#?]*)"/g)) hrefs.add(m[1]!);
  for (const href of hrefs) {
    const page = href === "/" ? "pages/index.tsx" : `pages${href}.tsx`;
    const index = `pages${href}/index.tsx`;
    // A warning, not a failure: Spectrum, Tools and Cluster land from other branches, and
    // this one must not fail for their absence.
    if (!existsSync(page) && !existsSync(index)) warnings.push(`  warn  ${href} has no page in this tree`);
  }
  ok(hrefs.size > 0, `${hrefs.size} internal links found`);
}

for (const w of warnings) console.log(w);
console.log(`\n${pass} passed, ${fail} failed, ${warnings.length} warned\n`);
if (fail > 0) process.exit(1);
