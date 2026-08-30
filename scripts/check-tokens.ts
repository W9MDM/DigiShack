/* eslint-disable no-console */
// Every design token a class name asks for actually exists.
//
// THE FAULT THIS EXISTS FOR: in Tailwind v4 a theme key that cannot be resolved emits
// NOTHING. Not an error, not a warning, not even an empty rule — the utility simply is
// not generated, the class stays on the element, and the element renders without the
// property. `bg-bg-raised` was written in 19 places across 8 files and `--color-bg-raised`
// had never been defined, so nineteen panels and inputs — including the HelpTip popover,
// which floats over page content and needs an opaque background to be readable at all —
// had no background for as long as anyone could remember. `bg-bg-subtle` was another 3.
// `accent-[var(--accent)]` was 2 more, referring to a variable that has never existed
// under that name (the token is `--color-accent`).
//
// Nothing in the toolchain could see any of it. `tsc` sees a string. ESLint sees a string.
// The build succeeds. `check:contrast` reads the stylesheet and is therefore blind to
// class names. A human reading a diff sees a plausible class. It took someone looking at
// the running page and asking why a panel was transparent.
//
// So this reads the tokens out of the @theme block and the class names out of the source,
// and insists the two agree.
//
// TARGETING: it does NOT try to know all of Tailwind's built-in utilities — that list is
// large, versioned, and getting it wrong in either direction makes the check useless. It
// looks only at utilities whose value begins with one of THIS PROJECT'S token families
// (`bg`, `surface`, `fg`, `line`, `accent`, `ok`, `warn`, `danger`, `info`). Tailwind ships
// nothing called `bg-fg-subtle` or `border-line-strong`, so a match is a project token by
// construction and a false positive would need Tailwind to add a built-in colour named
// after one of the nine.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

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

function warn(label: string, detail = ""): void {
  warnings.push(`  warn  ${label}${detail ? ` — ${detail}` : ""}`);
}

const ROOT = process.cwd();

// ---------------------------------------------------------------------------
// 1. What is defined
// ---------------------------------------------------------------------------

const CSS_PATH = path.join(ROOT, "styles", "globals.css");
const css = readFileSync(CSS_PATH, "utf8");

/** The @theme block, by brace matching — it is the entire design system; there is no
 *  tailwind.config to fall back on. */
function themeBlock(source: string): string {
  const start = source.indexOf("@theme");
  if (start < 0) return "";
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return "";
}

/** Comments quote class names — this file's own do, at length. Left in, they would
 *  vouch for a token that nothing actually uses. */
const stripCssComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "");

const THEME = themeBlock(css);
if (THEME === "") {
  console.log("  FAIL  no @theme block in styles/globals.css");
  console.log("\n0 passed, 1 failed\n");
  process.exit(1);
}

/** name (with the leading --) → declared value. */
const defined = new Map<string, string>();
for (const m of stripCssComments(THEME).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
  defined.set(m[1]!, m[2]!.trim());
}

console.log("\ntokens defined in @theme");
{
  const byNamespace = new Map<string, number>();
  for (const name of defined.keys()) {
    const ns = name.replace(/^--/, "").split("-")[0]!;
    byNamespace.set(ns, (byNamespace.get(ns) ?? 0) + 1);
  }
  const summary = [...byNamespace.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([ns, n]) => `${n} --${ns}-*`)
    .join(", ");
  ok(defined.size > 0, `${defined.size} tokens parsed from styles/globals.css (${summary})`);
}

// ---------------------------------------------------------------------------
// 2. What the source asks for
// ---------------------------------------------------------------------------

const SCAN_DIRS = ["pages", "components", "lib", "styles"];
const SCAN_EXT = new Set([".tsx", ".ts", ".css"]);

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === "node_modules" || e === ".next" || e.startsWith(".")) continue;
    const full = path.join(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SCAN_EXT.has(path.extname(e))) out.push(full);
  }
  return out;
}

const files = SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d)));

/** The nine families this project names its colours after. A utility whose value starts
 *  with one of these is ours, not Tailwind's. */
const FAMILIES = ["bg", "surface", "fg", "line", "accent", "ok", "warn", "danger", "info"];

/** Colour-ish utilities. Deliberately not exhaustive — see the header. */
const UTILITIES = [
  "bg",
  "text",
  "border",
  "divide",
  "ring",
  "outline",
  "accent",
  "fill",
  "stroke",
  "shadow",
];

const U = UTILITIES.join("|");
const F = FAMILIES.join("|");

/** `hover:bg-bg-raised/40` → utility `bg`, token `bg-raised`. The `(?<![\w-])` lets a
 *  variant prefix (`hover:`, `file:`, `aria-[invalid=true]:`) through while refusing a
 *  match in the middle of a longer word. The trailing `(?![\w-])` is what stops
 *  `border-line` matching inside `border-line-strong`. */
const CLASS_REF = new RegExp(
  `(?<![\\w-])(${U})-((?:${F})(?:-[a-z0-9]+)*)(?:\\/(?:\\d{1,3}|\\[[^\\]]*\\]))?(?![\\w-])`,
  "g",
);

/** The arbitrary-value escape hatch: `accent-[var(--accent)]`. Tailwind does not resolve
 *  these through the theme at all, it passes the var() straight to CSS — so an undefined
 *  variable here fails even more quietly than a missing theme key, because the declaration
 *  IS emitted and simply computes to nothing. */
const ARBITRARY_REF = new RegExp(`(?<![\\w-])(${U})-\\[([^\\]]*)\\]`, "g");

/** A bare var() in a stylesheet. --font-* is exempt: --font-oswald is injected at runtime
 *  by next/font and is correctly absent from @theme. */
const CSS_VAR_REF = /var\(\s*(--(?:color|radius|shadow)-[a-z0-9-]+)/g;

interface Ref {
  /** The theme key this class needs, with its leading `--`. */
  token: string;
  /** The class or expression as written, for the report. */
  written: string;
  file: string;
  line: number;
}

const refs: Ref[] = [];

for (const file of files) {
  const raw = readFileSync(file, "utf8");
  // Only stylesheets get their comments stripped: in .tsx the class names live in string
  // literals, and a `//` strip there would eat every URL in the file.
  const isCss = path.extname(file) === ".css";
  const body = isCss ? stripCssComments(raw) : raw;
  const rel = path.relative(ROOT, file).replace(/\\/g, "/");
  const lines = body.split("\n");

  lines.forEach((text, i) => {
    for (const m of text.matchAll(CLASS_REF)) {
      refs.push({
        token: `--color-${m[2]}`,
        written: `${m[1]}-${m[2]}`,
        file: rel,
        line: i + 1,
      });
    }
    for (const m of text.matchAll(ARBITRARY_REF)) {
      for (const v of m[2]!.matchAll(/var\(\s*(--[a-z0-9-]+)/g)) {
        refs.push({
          token: v[1]!,
          written: `${m[1]}-[${m[2]}]`,
          file: rel,
          line: i + 1,
        });
      }
    }
    if (isCss) {
      for (const m of text.matchAll(CSS_VAR_REF)) {
        refs.push({ token: m[1]!, written: `var(${m[1]})`, file: rel, line: i + 1 });
      }
    }
  });
}

console.log(`\nclass references resolve to a defined token (${files.length} files scanned)`);
{
  const byToken = new Map<string, Ref[]>();
  for (const r of refs) {
    const list = byToken.get(r.token);
    if (list) list.push(r);
    else byToken.set(r.token, [r]);
  }

  const unresolved = [...byToken.entries()].filter(([t]) => !defined.has(t));
  const resolved = [...byToken.entries()].filter(([t]) => defined.has(t));

  for (const [token, uses] of resolved.sort((a, b) => b[1].length - a[1].length)) {
    const nFiles = new Set(uses.map((u) => u.file)).size;
    ok(true, `${token.padEnd(24)} ${uses.length} uses, ${nFiles} file${nFiles === 1 ? "" : "s"}`);
  }

  for (const [token, uses] of unresolved.sort((a, b) => b[1].length - a[1].length)) {
    // Name every site: the whole point is that the page looked fine and the diff looked
    // fine, so "somewhere in components/" is not a finding anyone can act on.
    const sites = uses.map((u) => `${u.file}:${u.line} (${u.written})`);
    const shown = sites.slice(0, 6).join(", ");
    ok(
      false,
      `${token.padEnd(24)} is not defined in @theme — ${uses.length} use${uses.length === 1 ? "" : "s"}`,
      shown + (sites.length > 6 ? `, +${sites.length - 6} more` : ""),
    );
  }

  if (unresolved.length === 0) {
    ok(true, "no class names reference an undefined token");
  }
}

// ---------------------------------------------------------------------------
// 3. The reverse: tokens nothing asks for
// ---------------------------------------------------------------------------
//
// A warning, not a failure. A token can legitimately exist ahead of the code that will
// use it — the elevation shadows were added in one step and applied in the next — and a
// check that fails on that would just get bypassed. But an unused token is also how a
// palette rots: `--color-accent-muted` has been defined and unreferenced for its whole
// life, so nobody knows whether it is a plan or a leftover.
//
// The reference patterns here are broader than the ones above on purpose: this side wants
// to avoid calling a live token dead, so it will accept any plausible utility form.

const scanned = files
  .map((f) => (path.extname(f) === ".css" ? stripCssComments(readFileSync(f, "utf8")) : readFileSync(f, "utf8")))
  .join("\n")
  // The definitions themselves must not count as uses. Strip the COMMENT-STRIPPED form of
  // the block, because that is what globals.css contributed to the join above.
  .replace(stripCssComments(THEME), "");

function isReferenced(name: string): boolean {
  if (scanned.includes(`var(${name})`)) return true;
  const bare = name.replace(/^--/, "");
  const [ns, ...rest] = bare.split("-");
  const suffix = rest.join("-");
  if (suffix === "") return new RegExp(`(?<![\\w-])${ns}(?![\\w-])`).test(scanned);

  const patterns: string[] = [];
  switch (ns) {
    case "color":
      patterns.push(
        `(?<![\\w-])(?:${U}|from|via|to|caret|decoration|placeholder)-${suffix}(?![\\w-])`,
      );
      break;
    case "radius":
      patterns.push(`(?<![\\w-])rounded(?:-[a-z]{1,2})?-${suffix}(?![\\w-])`);
      break;
    case "font":
      patterns.push(`(?<![\\w-])font-${suffix}(?![\\w-])`);
      break;
    case "shadow":
      patterns.push(`(?<![\\w-])(?:inset-)?shadow-${suffix}(?![\\w-])`);
      break;
    default:
      // An unknown namespace: accept the suffix as the tail of any utility rather than
      // guess at the prefix, and accept the full token name too.
      patterns.push(`(?<![\\w-])[a-z]+(?:-[a-z]+)*-${suffix}(?![\\w-])`);
      patterns.push(bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      break;
  }
  return patterns.some((p) => new RegExp(p).test(scanned));
}

const dead = [...defined.keys()].filter((n) => !isReferenced(n));
for (const n of dead) warn(n, "defined in @theme, referenced nowhere");

// ---------------------------------------------------------------------------

if (warnings.length > 0) {
  console.log("\ntokens that nothing references (not a failure — may be intentional)");
  for (const w of warnings) console.log(w);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
