/* eslint-disable no-console */
// WCAG contrast for the theme, measured from globals.css.
//
// A red on near-black looks fine to anyone with ordinary vision and is genuinely hard
// to read for anyone without, which is exactly why this needs measuring rather than
// judging. The brand red was being used as text in 39 places at 2.45:1 — below even
// the 3:1 floor for large text — and nobody had noticed because it looks deliberate.
//
// Ratios are parsed from the stylesheet rather than duplicated here, so changing a
// colour and forgetting to re-check is not possible.

import { readFileSync } from "node:fs";
import path from "node:path";

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

/** Relative luminance, per WCAG 2.1. */
function luminance(hex: string): number {
  const v = hex.replace("#", "");
  const parts = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255);
  const lin = parts.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
}

function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const css = readFileSync(path.join(process.cwd(), "styles", "globals.css"), "utf8");

/** Read a --color-* token straight from the stylesheet. */
function token(name: string): string {
  const m = css.match(new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!m) {
    console.log(`  FAIL  --color-${name} is not defined in globals.css`);
    fail++;
    return "#000000";
  }
  return m[1]!.toLowerCase();
}

const SURFACES = ["bg", "surface", "surface-2", "surface-3"] as const;

/** AA for normal text. */
const AA = 4.5;
/** AA for large text, and the floor for a non-text indicator like a focus ring. */
const AA_LARGE = 3;

function checkAgainstAllSurfaces(fg: string, minimum: number, label: string): void {
  const colour = token(fg);
  let worst = Infinity;
  let worstOn = "";
  for (const s of SURFACES) {
    const r = contrast(colour, token(s));
    if (r < worst) {
      worst = r;
      worstOn = s;
    }
  }
  ok(
    worst >= minimum,
    `${label} (${colour}) — worst ${worst.toFixed(2)}:1 on ${worstOn}`,
    `needs ${minimum}:1`,
  );
}

console.log("\ntext colours against every surface (WCAG AA, 4.5:1)");
{
  checkAgainstAllSurfaces("fg", AA, "fg");
  checkAgainstAllSurfaces("fg-muted", AA, "fg-muted");
  // The quietest text in the interface still has to be readable. Was #6e6e7a at
  // 2.99:1 on surface-3 — under the floor for text of any size.
  checkAgainstAllSurfaces("fg-subtle", AA, "fg-subtle");
  // Used wherever the accent appears as TEXT, which the brand red cannot do.
  checkAgainstAllSurfaces("accent-bright", AA, "accent-bright");
}

console.log("\nstatus colours against every surface");
{
  for (const c of ["ok", "warn", "danger", "info"]) {
    checkAgainstAllSurfaces(c, AA, c);
  }
}

console.log("\nthe brand accent, in the role it is actually good at");
{
  // As a FILL it is fine, and that is what it is for: buttons, active states, the
  // selection highlight.
  const r = contrast(token("accent-fg"), token("accent"));
  ok(r >= AA, `accent-fg on accent — ${r.toFixed(2)}:1`, `needs ${AA}:1`);

  const hover = contrast(token("accent-fg"), token("accent-hover"));
  ok(hover >= AA, `accent-fg on accent-hover — ${hover.toFixed(2)}:1`, `needs ${AA}:1`);

  // And a standing reminder of why the second token exists: if someone ever "tidies"
  // accent-bright away and puts the brand red back into text, this fails.
  let worstAsText = Infinity;
  for (const s of SURFACES) worstAsText = Math.min(worstAsText, contrast(token("accent"), token(s)));
  ok(
    worstAsText < AA,
    `accent is still unsuitable as text (${worstAsText.toFixed(2)}:1) — accent-bright exists for that`,
    "if this passes, the two tokens can be merged",
  );
}

console.log("\nnon-text indicators (3:1)");
{
  // A focus ring below 3:1 against its background is not an indicator.
  checkAgainstAllSurfaces("accent-bright", AA_LARGE, "focus ring (accent-bright)");
  // Borders have to be visible enough to read a table by.
  const line = contrast(token("line"), token("surface"));
  ok(line >= 1.3, `line on surface — ${line.toFixed(2)}:1`, "borders are indistinguishable");
}

console.log("\nno text uses the brand accent");
{
  // The stylesheet cannot catch this; the class names can.
  const { execSync } = require("node:child_process") as typeof import("node:child_process");
  let hits = "";
  try {
    hits = execSync(
      'grep -rn "text-accent\\b" --include=*.tsx components pages || true',
      { encoding: "utf8" },
    ).trim();
  } catch {
    hits = "";
  }
  // `text-accent-bright` and `text-accent-fg` are fine; a bare `text-accent` is not.
  const bare = hits
    .split("\n")
    .filter((l) => l && /text-accent(?![\w-])/.test(l))
    .slice(0, 5);
  ok(bare.length === 0, "no bare `text-accent` class remains", bare.join(" | "));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
