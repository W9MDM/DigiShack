import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

// Fonts DigiShack ships, so a QSL card renders the same on every machine.
//
// THE PROBLEM THIS SOLVES: sharp draws the card's table by handing an SVG to librsvg,
// which resolves fonts through fontconfig — that is, through whatever happens to be
// installed on the host. A minimal container has nothing installed, and the card comes
// out with an empty table and a row of tofu boxes while every layer reports success. It
// reads as missing QSO data, which is exactly how it was reported.
//
// Relying on the host is also non-deterministic even when it works: this project's own
// installation renders cards only because `fonts-dejavu-core` arrived as somebody else's
// dependency, and the card asked for "Arial Narrow, Helvetica" — neither of which exists
// on Linux — so what actually drew them was fontconfig substituting for `sans-serif`.
//
// MEASURED, not assumed. On the live box, with FONTCONFIG_FILE pointing at a directory
// holding a font that is NOT installed system-wide, the same SVG rendered 940 dark pixels
// against 1484 without it — different glyphs, so librsvg genuinely used the bundled file.
//
// The generated config lists the bundled directory AND the system directories, so a host
// that does have fonts keeps them. Bundled families are simply always available too.

/** Where the shipped font files live, relative to the repository root. */
const FONT_DIR = path.join(process.cwd(), "assets", "fonts");

/**
 * The families offered for a card, and the file that provides each.
 *
 * Regular and Bold only: the card draws headings bold and values regular, and nothing
 * else. Italic and the other weights would be megabytes for faces no card uses.
 *
 * All three are SIL Open Font License 1.1, with the licence text shipped beside them.
 * Chosen for what a QSL card actually wants rather than for variety:
 */
export const BUNDLED_FONTS: { family: string; label: string; files: string[] }[] = [
  {
    // The traditional card look. Arial Narrow is what the old hardcoded stack asked for
    // and PT Sans Narrow is the free equivalent — condensed, so a six-column QSO table
    // fits across the width of the artwork without shrinking the type.
    family: "PT Sans Narrow",
    label: "PT Sans Narrow — condensed, the classic QSL table",
    files: ["PTSansNarrow-Regular.ttf", "PTSansNarrow-Bold.ttf"],
  },
  {
    family: "Lato",
    label: "Lato — a wider humanist sans",
    files: ["Lato-Regular.ttf", "Lato-Bold.ttf"],
  },
  {
    family: "PT Serif",
    label: "PT Serif — serif, for a more formal card",
    files: ["PTSerif-Regular.ttf", "PTSerif-Bold.ttf"],
  },
];

export const DEFAULT_CARD_FONT = "PT Sans Narrow";

/** Do the shipped font files exist where they should? */
export function bundledFontsPresent(): boolean {
  return BUNDLED_FONTS.every((f) => f.files.every((n) => existsSync(path.join(FONT_DIR, n))));
}

let configured = false;

/**
 * Point fontconfig at the shipped fonts, once per process.
 *
 * Sets `FONTCONFIG_FILE`, which fontconfig reads instead of the system configuration.
 * The generated file lists our directory FIRST and then the usual system paths, so
 * bundled families always resolve and a host's own fonts still work — a card configured
 * before this existed, naming a font this machine happens to have, keeps rendering.
 *
 * The cache directory matters more than it looks: without a writable one fontconfig
 * rebuilds its index on every render, which on a card-sending sweep is the difference
 * between milliseconds and seconds per card.
 */
export function ensureFontconfig(): boolean {
  if (configured) return true;
  if (!bundledFontsPresent()) return false;

  const dir = path.join(tmpdir(), "digishack-fontconfig");
  const cache = path.join(dir, "cache");
  try {
    mkdirSync(cache, { recursive: true });
    const conf = [
      '<?xml version="1.0"?>',
      '<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">',
      "<fontconfig>",
      `  <dir>${FONT_DIR}</dir>`,
      "  <dir>/usr/share/fonts</dir>",
      "  <dir>/usr/local/share/fonts</dir>",
      "  <dir prefix=\"xdg\">fonts</dir>",
      `  <cachedir>${cache}</cachedir>`,
      "</fontconfig>",
      "",
    ].join("\n");
    const file = path.join(dir, "fonts.conf");
    writeFileSync(file, conf, "utf8");
    process.env.FONTCONFIG_FILE = file;
    configured = true;
    return true;
  } catch {
    // Never fatal. A read-only tmp is a strange machine, and falling back to the host's
    // own fonts is better than refusing to draw a card at all.
    return false;
  }
}

/** The family to render with, and a fallback chain behind it. */
export function fontStack(family: string): string {
  const known = BUNDLED_FONTS.some((f) => f.family === family);
  const first = known ? family : family.trim() || DEFAULT_CARD_FONT;
  // The bundled default, then what a Linux host is likely to have, then the generic.
  return `${first}, ${DEFAULT_CARD_FONT}, DejaVu Sans, Liberation Sans, Arial, sans-serif`;
}
