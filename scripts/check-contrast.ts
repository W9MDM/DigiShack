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
//
// TWO PALETTES. The @theme block is the default dark theme; `:root[data-theme="night"]`
// re-points the same tokens at the red night-vision palette. Both get the same
// assertions, and the night palette gets three more of its own: it must override EVERY
// colour token (one left out keeps its dark value — the blue `info`, the green `ok`), it
// must stay on the red-to-amber side of the wheel, and its four semantic tones must stay
// far enough apart to tell from one another.

import { readdirSync, readFileSync, statSync } from "node:fs";
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

// ---------------------------------------------------------------------------
// Colour maths
// ---------------------------------------------------------------------------

type Rgb = [number, number, number];

/** `#rrggbb`, or `rgb(r g b / a)` — the alpha is dropped; callers that need it don't use this. */
function parseColour(value: string): Rgb | null {
  const hex = value.match(/^#([0-9a-fA-F]{6})$/);
  if (hex) {
    const v = hex[1]!;
    return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16)) as Rgb;
  }
  const fn = value.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/);
  if (fn) return [Number(fn[1]), Number(fn[2]), Number(fn[3])];
  return null;
}

/** sRGB channel to linear, per WCAG 2.1 (the 0.03928 threshold is WCAG's, kept as written). */
function linear(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance, per WCAG 2.1. */
function luminance([r, g, b]: Rgb): number {
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** OKLab — a perceptually even space, so a distance in it means roughly the same visible
 *  difference anywhere. ~0.02 is a just-noticeable difference. */
function oklab([r, g, b]: Rgb): [number, number, number] {
  const R = linear(r);
  const G = linear(g);
  const B = linear(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function distance(a: Rgb, b: Rgb): number {
  const x = oklab(a);
  const y = oklab(b);
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

/** HSV hue in degrees. */
function hue([r, g, b]: Rgb): number {
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

const hexOf = (c: Rgb): string => `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;

// ---------------------------------------------------------------------------
// The two palettes, read from the stylesheet
// ---------------------------------------------------------------------------

const CSS_PATH = path.join(process.cwd(), "styles", "globals.css");
const css = readFileSync(CSS_PATH, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The body of the first `{ ... }` block after `marker`, by brace matching. */
function blockAfter(source: string, marker: string): string | null {
  const start = source.indexOf(marker);
  if (start < 0) return null;
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return null;
}

/** `--color-*` declarations at the top level of a block (nested @keyframes skipped). */
function colourTokens(block: string): Map<string, string> {
  const out = new Map<string, string>();
  let depth = 0;
  let flat = "";
  for (const ch of block) {
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (depth === 0) flat += ch;
  }
  for (const m of flat.matchAll(/--color-([a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    out.set(m[1]!, m[2]!.trim());
  }
  return out;
}

const themeBlock = blockAfter(css, "@theme");
const nightBlock = blockAfter(css, ':root[data-theme="night"]');

if (themeBlock === null) {
  console.log("  FAIL  no @theme block in styles/globals.css");
  process.exit(1);
}

const DARK = colourTokens(themeBlock);
const NIGHT = colourTokens(nightBlock ?? "");

interface Palette {
  name: string;
  tokens: Map<string, string>;
}

const PALETTES: Palette[] = [
  { name: "dark", tokens: DARK },
  { name: "night", tokens: NIGHT },
];

function colour(p: Palette, name: string): Rgb {
  const raw = p.tokens.get(name);
  const parsed = raw ? parseColour(raw) : null;
  if (!parsed) {
    fail++;
    console.log(
      `  FAIL  [${p.name}] --color-${name} is ${raw ? `not a colour this check can read (${raw})` : "not defined"}`,
    );
    return [0, 0, 0];
  }
  return parsed;
}

const SURFACES = ["bg", "surface", "surface-2", "surface-3"] as const;

/** AA for normal text. */
const AA = 4.5;
/** AA for large text, and the floor for a non-text indicator like a focus ring or a
 *  control's boundary (WCAG 1.4.11). */
const AA_LARGE = 3;

function worstOnSurfaces(p: Palette, fg: string): { ratio: number; on: string } {
  const c = colour(p, fg);
  let ratio = Infinity;
  let on = "";
  for (const s of SURFACES) {
    const r = contrast(c, colour(p, s));
    if (r < ratio) {
      ratio = r;
      on = s;
    }
  }
  return { ratio, on };
}

function checkAgainstAllSurfaces(p: Palette, fg: string, minimum: number, label: string): void {
  const { ratio, on } = worstOnSurfaces(p, fg);
  ok(
    ratio >= minimum,
    `[${p.name}] ${label} (${hexOf(colour(p, fg))}) — worst ${ratio.toFixed(2)}:1 on ${on}`,
    `needs ${minimum}:1`,
  );
}

// ---------------------------------------------------------------------------
// Assertions both palettes must meet
// ---------------------------------------------------------------------------

for (const p of PALETTES) {
  console.log(`\n=== ${p.name} palette ===`);

  console.log("\ntext colours against every surface (WCAG AA, 4.5:1)");
  checkAgainstAllSurfaces(p, "fg", AA, "fg");
  checkAgainstAllSurfaces(p, "fg-muted", AA, "fg-muted");
  // The quietest text in the interface still has to be readable. Was #6e6e7a at
  // 2.99:1 on surface-3 — under the floor for text of any size.
  checkAgainstAllSurfaces(p, "fg-subtle", AA, "fg-subtle");
  // Used wherever the accent appears as TEXT, which the brand red cannot do.
  checkAgainstAllSurfaces(p, "accent-bright", AA, "accent-bright");

  console.log("\nstatus colours against every surface");
  for (const c of ["ok", "warn", "danger", "info"]) {
    checkAgainstAllSurfaces(p, c, AA, c);
  }

  console.log("\nthe text ladder stays a ladder");
  {
    // Three tiers only help if they are three different brightnesses. The night palette is
    // where this is tight: with blue held at zero, the only way up is towards orange.
    const fg = luminance(colour(p, "fg"));
    const muted = luminance(colour(p, "fg-muted"));
    const subtle = luminance(colour(p, "fg-subtle"));
    const step1 = (fg + 0.05) / (muted + 0.05);
    const step2 = (muted + 0.05) / (subtle + 0.05);
    ok(
      step1 >= 1.2 && step2 >= 1.2,
      `[${p.name}] fg > fg-muted > fg-subtle (${step1.toFixed(2)}:1, ${step2.toFixed(2)}:1)`,
      "adjacent tiers need at least 1.2:1 between them or the hierarchy collapses",
    );
  }

  console.log("\nthe brand accent, in the role it is actually good at");
  {
    // As a FILL it is fine, and that is what it is for: buttons, active states, the
    // selection highlight.
    const r = contrast(colour(p, "accent-fg"), colour(p, "accent"));
    ok(r >= AA, `[${p.name}] accent-fg on accent — ${r.toFixed(2)}:1`, `needs ${AA}:1`);

    const hover = contrast(colour(p, "accent-fg"), colour(p, "accent-hover"));
    ok(hover >= AA, `[${p.name}] accent-fg on accent-hover — ${hover.toFixed(2)}:1`, `needs ${AA}:1`);

    // And a standing reminder of why the second token exists: if someone ever "tidies"
    // accent-bright away and puts the brand red back into text, this fails.
    const asText = worstOnSurfaces(p, "accent").ratio;
    ok(
      asText < AA,
      `[${p.name}] accent is still unsuitable as text (${asText.toFixed(2)}:1) — accent-bright exists for that`,
      "if this passes, the two tokens can be merged",
    );
  }

  console.log("\nnon-text indicators (3:1)");
  {
    // A focus ring below 3:1 against its background is not an indicator.
    checkAgainstAllSurfaces(p, "accent-bright", AA_LARGE, "focus ring (accent-bright)");
    // The edge of every Input, Select, Textarea and secondary Button. It has to clear 3:1
    // on surface-3 too, because that is where a secondary button goes on hover.
    checkAgainstAllSurfaces(p, "line-strong", AA_LARGE, "control boundary (line-strong)");
    // Borders have to be visible enough to read a table by.
    const line = contrast(colour(p, "line"), colour(p, "surface"));
    ok(line >= 1.3, `[${p.name}] line on surface — ${line.toFixed(2)}:1`, "borders are indistinguishable");
  }

  console.log("\naliases");
  {
    // `bg-raised` is surface-2 by another name (see globals.css); nothing else ties them.
    const a = p.tokens.get("bg-raised")?.toLowerCase();
    const b = p.tokens.get("surface-2")?.toLowerCase();
    ok(a !== undefined && a === b, `[${p.name}] bg-raised equals surface-2 (${a} / ${b})`);
  }
}

// ---------------------------------------------------------------------------
// Night only
// ---------------------------------------------------------------------------

const night = PALETTES[1]!;
console.log("\n=== night palette: what makes it a night palette ===");

console.log("\nit overrides every colour token");
{
  // A token the night block forgets keeps its dark value, and the dark values include a
  // blue and a green. A token the night block invents is a typo that does nothing.
  ok(nightBlock !== null, ':root[data-theme="night"] block exists in globals.css');
  const missing = [...DARK.keys()].filter((k) => !NIGHT.has(k));
  const extra = [...NIGHT.keys()].filter((k) => !DARK.has(k));
  ok(missing.length === 0, `all ${DARK.size} @theme colour tokens are overridden`, `missing: ${missing.join(", ")}`);
  ok(extra.length === 0, "and nothing is overridden that @theme does not define", `unknown: ${extra.join(", ")}`);
}

console.log("\nno blue, green or cyan: R >= G >= B, hue at most 45 degrees (amber)");
{
  // R >= G >= B is exactly "a hue between red and yellow"; 45 degrees stops short of the
  // yellows that read as olive when dim. Blue is held near zero on top of that, because
  // per unit of WCAG luminance it costs dark adaptation roughly ten times what green does.
  const bad: string[] = [];
  for (const [name, raw] of NIGHT) {
    const c = parseColour(raw);
    if (!c) {
      bad.push(`${name} (unreadable: ${raw})`);
      continue;
    }
    const [r, g, b] = c;
    if (!(r >= g && g >= b) || hue(c) > 45 || b > 0x20) bad.push(`${name} ${raw} (hue ${hue(c).toFixed(0)})`);
  }
  ok(bad.length === 0, `${NIGHT.size} night tokens are red-to-amber with blue near zero`, bad.join(", "));
}

console.log("\nlow luminance");
{
  // The surfaces are most of the screen, so they are where the light budget is spent;
  // text cannot go lower than the 4.5:1 floor already puts it.
  const surfaces = [...SURFACES, "bg-subtle"].map((s) => [s, luminance(colour(night, s))] as const);
  const brightSurface = surfaces.filter(([, y]) => y > 0.01);
  ok(
    brightSurface.length === 0,
    `every surface is below luminance 0.01 (max ${Math.max(...surfaces.map(([, y]) => y)).toFixed(4)})`,
    brightSurface.map(([s, y]) => `${s} ${y.toFixed(4)}`).join(", "),
  );
  const texts = ["fg", "fg-muted", "fg-subtle", "accent-bright", "accent-fg", "ok", "warn", "danger", "info"];
  const bright = texts.filter((t) => luminance(colour(night, t)) > 0.5);
  const maxText = Math.max(...texts.map((t) => luminance(colour(night, t))));
  ok(
    bright.length === 0,
    `no text colour is above luminance 0.5 (max ${maxText.toFixed(3)}; dark fg is ${luminance(colour(PALETTES[0]!, "fg")).toFixed(3)})`,
    bright.join(", "),
  );
}

console.log("\nthe four semantic tones stay distinguishable");
{
  // Measured in OKLab, where ~0.02 is just noticeable. 0.1 is five times that: different
  // side by side at a glance. Alone, the badge's label still says which tone it is — this
  // stops two tones being quietly merged into one, it does not make colour sufficient.
  const tones = ["ok", "warn", "danger", "info"];
  let min = Infinity;
  let pair = "";
  for (let i = 0; i < tones.length; i++) {
    for (let j = i + 1; j < tones.length; j++) {
      const d = distance(colour(night, tones[i]!), colour(night, tones[j]!));
      if (d < min) {
        min = d;
        pair = `${tones[i]}/${tones[j]}`;
      }
    }
  }
  ok(min >= 0.1, `closest pair ${pair} is ${min.toFixed(3)} apart in OKLab`, "needs 0.1");
}

// ---------------------------------------------------------------------------
// Class names: no text uses the brand accent
// ---------------------------------------------------------------------------
//
// The stylesheet cannot catch this; the class names can.
//
// THE FAULT (R20). This used to shell out to `grep -rn ... || true` and also caught any
// exception as "no hits". On a machine without grep on PATH — a Windows shell, which is
// where it was run — the search printed "grep is not recognized" and the assertion still
// PASSED: a search that could not run was reported as a search that found nothing. It
// now walks the tree in Node, fails if a scan root is missing or yields no files, and
// proves on every run that the detector fires on a known-bad line.

/** `text-accent-bright` and `text-accent-fg` are fine; a bare `text-accent` is not. */
const BARE_ACCENT_TEXT = /(?<![\w-])text-accent(?![\w-])/;

function bareAccentHits(text: string, file: string): string[] {
  const hits: string[] = [];
  text.split("\n").forEach((line, i) => {
    if (BARE_ACCENT_TEXT.test(line)) hits.push(`${file}:${i + 1}`);
  });
  return hits;
}

/** Every .tsx under `dir`. Throws — it does not return an empty list — if `dir` cannot be read. */
function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    const full = path.join(dir, e);
    if (statSync(full).isDirectory()) tsxFiles(full, out);
    else if (e.endsWith(".tsx")) out.push(full);
  }
  return out;
}

console.log("\nno text uses the brand accent");
{
  // The detector has to be able to fail, so it is pointed at a known-bad line first.
  const probe = bareAccentHits('<p className="text-accent">x</p>\n<p className="text-accent-bright" />', "probe");
  ok(
    probe.length === 1 && probe[0] === "probe:1",
    "the detector catches a bare text-accent and passes text-accent-bright",
    JSON.stringify(probe),
  );

  const hits: string[] = [];
  let scanned = 0;
  let scanError = "";
  for (const root of ["components", "pages"]) {
    try {
      const files = tsxFiles(path.join(process.cwd(), root));
      if (files.length === 0) throw new Error(`${root}/ contains no .tsx files`);
      for (const f of files) {
        scanned++;
        hits.push(...bareAccentHits(readFileSync(f, "utf8"), path.relative(process.cwd(), f).replace(/\\/g, "/")));
      }
    } catch (err) {
      scanError += `${root}: ${err instanceof Error ? err.message : String(err)}; `;
    }
  }
  ok(scanError === "", `scanned ${scanned} .tsx files in components/ and pages/`, `the scan could not run — ${scanError}`);
  ok(hits.length === 0, "no bare `text-accent` class remains", hits.slice(0, 5).join(" | "));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
