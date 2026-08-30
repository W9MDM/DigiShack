/* eslint-disable no-console */
/**
 * The shared table header keeps its accessibility, and a disabled control keeps its reason.
 *
 * THE FAULT THIS EXISTS FOR. This exact string —
 *
 *     px-3 py-2 font-medium text-fg-muted text-xs uppercase tracking-wide
 *
 * was copy-pasted into eight files, and not one of those `<th>` elements carried
 * `scope="col"`. Meanwhile a header that did it correctly — `scope`, `aria-sort`, a real
 * button, an `aria-hidden` arrow and screen-reader text — sat as a private function at the
 * bottom of pages/qsos/index.tsx, reaching exactly one of the sixteen tables in the
 * product. Extracting it fixes that once; nothing stops it being unpicked again, because
 * every one of those attributes is invisible on screen. Delete `scope` and the log looks
 * identical, typechecks, and reads to a screen reader as 450 unlabelled cells.
 *
 * So this RENDERS the component and reads the markup, rather than grepping for the
 * attributes. A grep passes on an attribute that is present but wrong — `aria-sort="none"`
 * left on the active column, an arrow that lost its `aria-hidden` — and those are the
 * failures that actually happen when someone edits the branch structure.
 *
 * It also refuses a HALF-migrated file: one that imports the shared `Th` and still has raw
 * `<th>` elements of its own. That combination is the state a page ends up in when a table
 * is converted in a hurry, and it is worse than not converting it, because the file now
 * looks done.
 *
 * Tables outside the migration are counted and named, NOT failed. They belong to work that
 * is still in flight, and a check that fails the build for someone else's half-finished
 * page is a check people delete.
 */

import { readdirSync, readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Button, Td, Th } from "@/components/ui/primitives";

let pass = 0;
let fail = 0;
const warnings: string[] = [];

function ok(cond: boolean, label: string, detail = ""): void {
  if (cond) {
    pass++;
    console.log(`  ok    ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ""}`);
  }
}

function warn(label: string): void {
  warnings.push(`  warn  ${label}`);
}

const noop = () => {};

// ---------------------------------------------------------------------------
// The column header, as it actually renders
// ---------------------------------------------------------------------------

console.log("\ncolumn headers");

const plain = renderToStaticMarkup(createElement(Th, null, "Freq"));

ok(
  plain.includes('scope="col"'),
  "a plain header still declares scope",
  "without scope a screen reader has no column name to attach to any cell in it",
);
ok(
  !plain.includes("aria-sort"),
  "a plain header claims no sort order",
  `aria-sort on a column that cannot be sorted is a claim a screen reader repeats: ${plain}`,
);
ok(
  !plain.includes("<button"),
  "a plain header renders no button",
  "a button that does nothing is a tab stop that does nothing",
);

const inactive = renderToStaticMarkup(
  createElement(Th, { field: "band", sort: "startTime", dir: "desc", onSort: noop }, "Band"),
);
const ascending = renderToStaticMarkup(
  createElement(Th, { field: "band", sort: "band", dir: "asc", onSort: noop }, "Band"),
);
const descending = renderToStaticMarkup(
  createElement(Th, { field: "band", sort: "band", dir: "desc", onSort: noop }, "Band"),
);

ok(
  inactive.includes('scope="col"') &&
    ascending.includes('scope="col"') &&
    descending.includes('scope="col"'),
  "a sortable header declares scope in every state",
);
ok(
  inactive.includes('aria-sort="none"'),
  "an unsorted column reports none",
  inactive,
);
ok(
  ascending.includes('aria-sort="ascending"'),
  "the sorted column reports ascending",
  ascending,
);
ok(
  descending.includes('aria-sort="descending"'),
  "the sorted column reports descending",
  descending,
);
ok(
  ascending.includes('<span aria-hidden="true">▲</span>') &&
    descending.includes('<span aria-hidden="true">▼</span>'),
  "the direction arrow is hidden from assistive tech",
  '"black up-pointing triangle" is not information; aria-sort carries it instead',
);
ok(
  inactive.includes("activate to sort by this column") &&
    ascending.includes("sorted ascending") &&
    descending.includes("sorted descending"),
  "the header says out loud what activating it does",
  "the arrow is the only visual cue and it is deliberately hidden, so the sentence is the whole of it",
);
ok(
  inactive.includes("<button") && inactive.includes('type="button"'),
  "a sortable header is a real button",
  "a click handler on the th itself is unreachable from the keyboard",
);

// ---------------------------------------------------------------------------
// Sizing
// ---------------------------------------------------------------------------

console.log("\nsizing");

ok(
  plain.includes("text-[0.85em]") && !/text-xs[\s"]/.test(plain),
  "the header size is relative to the table, not a hardcoded 12px",
  `a table that changes its own font size — the decode table does, from a slider — leaves a fixed header behind: ${plain}`,
);

const cells = {
  sm: renderToStaticMarkup(createElement(Td, { size: "sm" }, "x")),
  md: renderToStaticMarkup(createElement(Td, null, "x")),
  lg: renderToStaticMarkup(createElement(Td, { size: "lg" }, "x")),
};
ok(
  cells.sm.includes("px-2 py-1") &&
    cells.md.includes("px-3 py-1.5") &&
    cells.lg.includes("px-3 py-2"),
  "each row density keeps the padding it was extracted from",
  `sm=${cells.sm} md=${cells.md} lg=${cells.lg}`,
);

const merged = renderToStaticMarkup(
  createElement(Td, { size: "lg", className: "tnum whitespace-nowrap" }, "x"),
);
ok(
  merged.includes("tnum") && merged.includes("whitespace-nowrap") && merged.includes("py-2"),
  "a cell's own classes survive alongside the padding",
  merged,
);

// ---------------------------------------------------------------------------
// A disabled control that explains itself
// ---------------------------------------------------------------------------

console.log("\ndisabled controls");

const quiet = renderToStaticMarkup(createElement(Button, { disabled: true }, "Mark sent"));
const opacity = /disabled:opacity-(\d+)/.exec(quiet);

ok(
  opacity !== null && Number(opacity[1]) >= 60,
  `the disabled label stays legible (disabled:opacity-${opacity?.[1] ?? "?"})`,
  "at 45% the four button variants measured 1.99, 2.63, 3.09 and 3.82:1 against their own " +
    "fills — WCAG exempts disabled controls, but an operator reading a greyed button as a " +
    "broken one stops there. Do not lower this without re-measuring; check:contrast reads " +
    "the stylesheet and knows nothing about composited opacity.",
);

const explained = renderToStaticMarkup(
  createElement(
    Button,
    { disabled: true, disabledReason: "Tick a contact first." },
    "Mark sent",
  ),
);
ok(
  explained.includes("Tick a contact first."),
  "the reason is on the page, not only in a title attribute",
  "a tooltip needs a pointer, a hover, and the knowledge that there is something to hover",
);
{
  const id = /<span id="([^"]+)"/.exec(explained)?.[1];
  ok(
    id !== undefined && explained.includes(`aria-describedby="${id}"`),
    "the reason is tied to the button it is about",
    `otherwise it is loose text somewhere after the control: ${explained}`,
  );
}

const busy = renderToStaticMarkup(
  createElement(
    Button,
    { disabled: true, loading: true, disabledReason: "Tick a contact first." },
    "Mark sent",
  ),
);
ok(
  !busy.includes("Tick a contact first.") && busy.includes('aria-busy="true"'),
  "a busy button does not borrow the disabled reason",
  `"nothing is ticked" is not what is happening while a request is in flight: ${busy}`,
);

const enabled = renderToStaticMarkup(
  createElement(Button, { disabledReason: "Tick a contact first." }, "Mark sent"),
);
ok(
  !enabled.includes("Tick a contact first."),
  "an enabled button shows no reason at all",
  enabled,
);

const passthrough = renderToStaticMarkup(
  createElement(
    Button,
    { disabled: true, "aria-describedby": "shared-hint" },
    "Mark received",
  ),
);
ok(
  passthrough.includes("shared-hint"),
  "a caller's own aria-describedby survives",
  "several controls sharing one sentence is the other half of this pattern — see pages/qsl/cards.tsx",
);

// ---------------------------------------------------------------------------
// Nothing is half-migrated
// ---------------------------------------------------------------------------

console.log("\nadoption");

/**
 * Blank out comments, keeping every line and column.
 *
 * Lifted from scripts/check-pwa.ts, which explains why at length: a source check that
 * greps raw text cannot tell code from the prose explaining it, and this has already
 * broken three separate pieces of work — including check-pwa itself, on a comment that
 * happened to contain the characters of a table tag. This file is a prime candidate: its
 * own header quotes the class string it is about.
 */
function stripComments(src: string): string {
  const blank = (m: string): string => m.replace(/[^\n]/g, " ");
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, lead: string) => lead + blank(m.slice(lead.length)));
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel, out);
    else if (e.name.endsWith(".tsx")) out.push(rel);
  }
  return out;
}

const files = [...walk("pages"), ...walk("components")];

const halfMigrated: string[] = [];
const notYet: string[] = [];

/** The definition site. Its `<th>` and `<td>` are the ones everything else stops writing. */
const PRIMITIVES = "components/ui/primitives.tsx";

for (const rel of files) {
  if (rel === PRIMITIVES) continue;
  const raw = readFileSync(rel, "utf8");
  const src = stripComments(raw);
  const importsTh = /import\s*\{[^}]*\bTh\b[^}]*\}\s*from\s*"@\/components\/ui\/primitives"/s.test(
    src,
  );
  // `<thead` must not count as `<th`, and a self-closing `<th />` must.
  const rawCells = (src.match(/<th[\s/>]/g) ?? []).length + (src.match(/<td[\s/>]/g) ?? []).length;

  if (importsTh && rawCells > 0) halfMigrated.push(`${rel} (${rawCells})`);
  else if (!importsTh && rawCells > 0) notYet.push(`${rel} (${rawCells})`);
}

ok(
  halfMigrated.length === 0,
  "no file uses the shared header and raw cells at the same time",
  `half-migrated: ${halfMigrated.join(", ")} — a page in this state looks converted and is not`,
);

// Not a failure. These are pages owned by work still in flight; naming them keeps the
// remaining surface countable instead of carried in conversation, which is where a
// fourteen-item list with three duplicates came from last time.
if (notYet.length > 0) {
  warn(`${notYet.length} file(s) still hand-roll table cells: ${notYet.join(", ")}`);
}

for (const line of warnings) console.log(line);
console.log(`\n${pass} passed, ${fail} failed, ${warnings.length} warned\n`);
if (fail > 0) process.exit(1);
