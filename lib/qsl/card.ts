// QSL card rendering: composite a QSO table onto the operator's artwork.
//
// Done with sharp (already a dependency) by generating the table as SVG and
// compositing it over the base image. No headless browser, no canvas binding.
//
// Everything about the table is a setting — which columns, where it sits, how big,
// what the footer says. The artwork itself is a path in Settings and is never
// committed: it is the operator's own asset and a full-resolution card runs to
// tens of megabytes.
//
// The table is positioned and sized as a FRACTION of the image, not in pixels, so
// one set of settings works whether the artwork is 1500 px wide or 5625.

import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

import { getBooleanSetting, getNumberSetting, getSetting } from "@/lib/settings";
import {
  DEFAULT_CARD_FONT,
  ensureFontconfig,
  fontStack,
} from "@/lib/qsl/fonts";
import {
  applyTemplate,
  templateValues,
  type QsoForTemplate,
  type StationForTemplate,
} from "@/lib/qsl/template";

/** Columns the table can show, in the order they are offered. */
export const CARD_COLUMNS = {
  CALL: { heading: "Confirming QSO with", token: "THEIR_CALL" },
  DATE: { heading: "Year Month Day", token: "DATE" },
  TIME: { heading: "UTC Time", token: "TIME" },
  BAND: { heading: "Band", token: "BAND" },
  FREQ: { heading: "Freq MHz", token: "FREQ" },
  REPORT: { heading: "Report", token: "RST_SENT" },
  RST_RCVD: { heading: "Rcvd", token: "RST_RCVD" },
  MODE: { heading: "Mode", token: "MODE" },
  POWER: { heading: "Power", token: "POWER" },
  GRID: { heading: "Grid", token: "THEIR_GRID" },
} as const;

export type CardColumn = keyof typeof CARD_COLUMNS;

/** The default column set, matching the traditional card layout. */
export const DEFAULT_COLUMNS = "CALL,DATE,TIME,BAND,REPORT,MODE";

export interface CardSettings {
  enabled: boolean;
  baseImage: string;
  /** Output width in px; height follows the artwork's aspect ratio. */
  width: number;
  columns: CardColumn[];
  footerTemplate: string;
  /** Table geometry, all fractions of the output image. */
  tableRight: number;
  tableBottom: number;
  tableWidth: number;
  fontScale: number;
  /** Family name for the table text. One of the bundled fonts, or a host font by name. */
  font: string;
  textColor: string;
  headingBg: string;
  cellBg: string;
  borderColor: string;
  /** JPEG quality for the emailed copy. */
  quality: number;
}

function parseColumns(raw: string | null): CardColumn[] {
  const wanted = (raw ?? DEFAULT_COLUMNS)
    .split(",")
    .map((c) => c.trim().toUpperCase())
    .filter((c): c is CardColumn => c in CARD_COLUMNS);
  // Never return an empty table — an unparseable setting falls back rather than
  // rendering a card with a blank box on it.
  return wanted.length > 0 ? wanted : (DEFAULT_COLUMNS.split(",") as CardColumn[]);
}

export async function loadCardSettings(): Promise<CardSettings> {
  return {
    enabled: await getBooleanSetting("qsl.card.enabled", false),
    baseImage: (await getSetting("qsl.card.baseImage")) ?? "data/qsl/card-base.png",
    width: await getNumberSetting("qsl.card.width", 1600),
    columns: parseColumns(await getSetting("qsl.card.columns")),
    footerTemplate: (await getSetting("qsl.card.footer")) ?? "",
    tableRight: await getNumberSetting("qsl.card.tableRight", 0.012),
    tableBottom: await getNumberSetting("qsl.card.tableBottom", 0.012),
    tableWidth: await getNumberSetting("qsl.card.tableWidth", 0.6),
    fontScale: await getNumberSetting("qsl.card.fontScale", 1),
    font: (await getSetting("qsl.card.font")) ?? DEFAULT_CARD_FONT,
    textColor: (await getSetting("qsl.card.textColor")) ?? "#000000",
    headingBg: (await getSetting("qsl.card.headingBg")) ?? "#ffffff",
    cellBg: (await getSetting("qsl.card.cellBg")) ?? "#ffffff",
    borderColor: (await getSetting("qsl.card.borderColor")) ?? "#000000",
    quality: await getNumberSetting("qsl.card.quality", 88),
  };
}

/** XML-escape, since every value here lands inside SVG markup. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Approximate text width in a condensed sans face.
 *
 * SVG has no text measurement without a layout engine, so column widths are
 * estimated from character count. 0.58em per character is about right for the
 * condensed faces used on cards; digits and capitals are close enough to uniform
 * that a per-character average does not visibly misalign a six-column table.
 */
function textWidth(s: string, fontPx: number): number {
  return s.length * fontPx * 0.58;
}

export interface RenderedCard {
  jpeg: Buffer;
  width: number;
  height: number;
}

/**
 * Render one card.
 *
 * Throws if the artwork is missing or unreadable — a QSL email whose whole point
 * is the card should fail loudly rather than go out without it.
 */

/** Where a Linux system keeps fonts. Checked in order; the first hit is enough. */
const FONT_DIRS = [
  "/usr/share/fonts",
  "/usr/local/share/fonts",
  "/usr/share/texmf/fonts",
];

let fontsPresentCache: boolean | null = null;

/**
 * Does this machine have ANY font sharp could render with?
 *
 * Checked because the failure is silent and misleading: sharp composites the SVG happily,
 * librsvg draws nothing it has no glyphs for, and the result is a perfectly valid image
 * with an empty table. No error is raised anywhere, so the operator sees a card that
 * looks like the QSO data failed to populate.
 *
 * Deliberately NOT `fc-list`: fontconfig's command line tools are a separate package and
 * are absent even on this project's own working installation, so asking them would report
 * "no fonts" on a machine that renders cards correctly every day. The font FILES are what
 * librsvg needs, so the files are what this looks for.
 */
export function systemFontsPresent(): boolean {
  if (fontsPresentCache !== null) return fontsPresentCache;
  const hasFont = (dir: string, depth = 0): boolean => {
    if (depth > 3 || !existsSync(dir)) return false;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      if (e.isFile() && /\.(ttf|otf|ttc|pfb)$/i.test(e.name)) return true;
      if (e.isDirectory() && hasFont(path.join(dir, e.name), depth + 1)) return true;
    }
    return false;
  };
  fontsPresentCache = FONT_DIRS.some((d) => hasFont(d));
  return fontsPresentCache;
}

export async function renderQslCard(
  qso: QsoForTemplate,
  station: StationForTemplate,
  settings?: CardSettings,
): Promise<RenderedCard> {
  const cfg = settings ?? (await loadCardSettings());
  const values = templateValues(qso, station);

  // NO FONTS, NO CARD — refused up front rather than produced blank.
  //
  // This is the failure that prompted the check, and its whole problem is that it does not
  // look like a font failure. sharp composites the SVG happily, librsvg draws nothing for
  // glyphs it cannot find, and the result is a perfectly valid image with an empty QSO
  // table and a row of tofu boxes. Every layer reports success. The operator sees a card
  // that appears not to have been populated with QSO data, and goes looking in the log.
  //
  // A minimal container has no fonts at all. This project's own working installation has
  // them only because `fonts-dejavu-core` arrived as somebody else's dependency, which is
  // luck rather than design — the card asks for "Arial Narrow, Helvetica", neither of
  // which exists on Linux, and works only because fontconfig substitutes whatever is
  // installed for the final `sans-serif`. With nothing installed there is nothing to
  // substitute.
  // Point librsvg at the shipped fonts. Does nothing if they are missing from the tree,
  // in which case the host-font check below is what catches it.
  const bundled = ensureFontconfig();

  if (!bundled && !systemFontsPresent()) {
    throw new Error(
      "No fonts are installed on this server, so the QSO table would render blank — " +
        "which looks like missing contact data rather than a missing font. Install one: " +
        "`apt install fonts-dejavu-core` (Debian/Ubuntu) or `dnf install dejavu-sans-fonts` " +
        "(Fedora/RHEL), then generate the card again.",
    );
  }

  const abs = path.isAbsolute(cfg.baseImage)
    ? cfg.baseImage
    : path.join(process.cwd(), cfg.baseImage);

  let base: Buffer;
  try {
    base = await readFile(abs);
  } catch {
    throw new Error(
      `QSL card artwork not found at ${cfg.baseImage}. Set qsl.card.baseImage in Settings → QSL to a readable image.`,
    );
  }

  // `sharp(x).resize(...).metadata()` reports the INPUT dimensions, not the
  // output — a genuine trap. Reading it gave H = 3750 for artwork being scaled to
  // 1600x1067, so the table was positioned nearly 3000 px below the bottom of the
  // canvas and sharp refused the composite with "Image to composite must have
  // same dimensions or smaller". The output height has to be computed from the
  // source aspect ratio instead.
  const source = await sharp(base).metadata();
  if (!source.width || !source.height) {
    throw new Error(`Could not read dimensions from ${cfg.baseImage} — is it a valid image?`);
  }
  const W = Math.max(320, Math.round(cfg.width));
  const H = Math.round(W * (source.height / source.width));
  const resized = sharp(base).resize({ width: W });

  // Geometry, all derived from the output size so settings are resolution-free.
  const tableW = Math.round(W * Math.min(0.98, Math.max(0.2, cfg.tableWidth)));
  const font = Math.max(7, (tableW / 46) * cfg.fontScale);
  const pad = font * 0.45;
  const rowH = Math.round(font * 1.9);
  const footer = cfg.footerTemplate ? applyTemplate(cfg.footerTemplate, values).trim() : "";
  const rows = footer ? 3 : 2;
  const tableH = rowH * rows;

  const x0 = Math.round(W - tableW - W * cfg.tableRight);
  const y0 = Math.round(H - tableH - H * cfg.tableBottom);

  // Column widths from the wider of heading and value, then scaled to fit.
  const cols = cfg.columns.map((key) => {
    const def = CARD_COLUMNS[key];
    const value = values[def.token] ?? "";
    return {
      heading: def.heading,
      value,
      natural: Math.max(textWidth(def.heading, font), textWidth(value, font)) + pad * 2,
    };
  });
  const naturalTotal = cols.reduce((a, c) => a + c.natural, 0);
  const scale = tableW / naturalTotal;
  const widths = cols.map((c) => c.natural * scale);

  const parts: string[] = [];
  parts.push(
    `<rect x="0" y="0" width="${tableW}" height="${tableH}" fill="${esc(cfg.cellBg)}" stroke="${esc(cfg.borderColor)}" stroke-width="1"/>`,
  );
  parts.push(
    `<rect x="0" y="0" width="${tableW}" height="${rowH}" fill="${esc(cfg.headingBg)}" stroke="${esc(cfg.borderColor)}" stroke-width="1"/>`,
  );

  let x = 0;
  for (let i = 0; i < cols.length; i++) {
    const w = widths[i]!;
    const cx = x + w / 2;
    // Headings bold, values regular — the convention on printed cards, and it
    // keeps a six-column table readable at email size.
    parts.push(
      `<text x="${cx.toFixed(1)}" y="${(rowH * 0.7).toFixed(1)}" font-family="${esc(fontStack(cfg.font))}" font-size="${font.toFixed(1)}" font-weight="bold" fill="${esc(cfg.textColor)}" text-anchor="middle">${esc(cols[i]!.heading)}</text>`,
    );
    parts.push(
      `<text x="${cx.toFixed(1)}" y="${(rowH * 1.7).toFixed(1)}" font-family="${esc(fontStack(cfg.font))}" font-size="${font.toFixed(1)}" fill="${esc(cfg.textColor)}" text-anchor="middle">${esc(cols[i]!.value)}</text>`,
    );
    if (i > 0) {
      // Dividers stop at the data row. Running them the full height would draw
      // vertical lines straight through the footer sentence, which spans the whole
      // width as a single cell.
      const dividerBottom = footer ? rowH * 2 : tableH;
      parts.push(
        `<line x1="${x.toFixed(1)}" y1="0" x2="${x.toFixed(1)}" y2="${dividerBottom}" stroke="${esc(cfg.borderColor)}" stroke-width="1"/>`,
      );
    }
    x += w;
  }
  parts.push(
    `<line x1="0" y1="${rowH}" x2="${tableW}" y2="${rowH}" stroke="${esc(cfg.borderColor)}" stroke-width="1"/>`,
  );

  if (footer) {
    parts.push(
      `<line x1="0" y1="${rowH * 2}" x2="${tableW}" y2="${rowH * 2}" stroke="${esc(cfg.borderColor)}" stroke-width="1"/>`,
    );
    parts.push(
      `<text x="${(tableW / 2).toFixed(1)}" y="${(rowH * 2.68).toFixed(1)}" font-family="${esc(fontStack(cfg.font))}" font-size="${(font * 0.92).toFixed(1)}" fill="${esc(cfg.textColor)}" text-anchor="middle">${esc(footer)}</text>`,
    );
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${tableW}" height="${tableH}">${parts.join("")}</svg>`;

  const jpeg = await resized
    .composite([{ input: Buffer.from(svg), top: y0, left: x0 }])
    // JPEG, not PNG: a photographic card at 1600 px is ~200 kB as JPEG and over a
    // megabyte as PNG, and this goes out by email once per QSO.
    .jpeg({ quality: Math.min(100, Math.max(40, cfg.quality)), mozjpeg: true })
    .toBuffer();

  return { jpeg, width: W, height: H };
}
