/**
 * Generates the PWA icon set from a single inline SVG.
 *
 * Run with `npm run gen:icons`. Checked-in output, not a build step: the icons change
 * roughly never, and a shack install may have no outbound internet and no working
 * sharp binary at deploy time. The generator exists so the set can be regenerated
 * consistently, not so it can be regenerated often.
 *
 * Two families, and the distinction is the one people get wrong:
 *
 * - `icon-<n>.png` is the ANY purpose. It carries its own padding and is used as-is.
 * - `icon-maskable-<n>.png` is the MASKABLE purpose. Android crops it to whatever mask
 *   the launcher likes — a circle, a squircle, a rounded square — and anything outside
 *   the centre 80% circle can be cut. So the artwork is drawn smaller inside a filled
 *   bleed. Shipping one image for both purposes is what produces those icons with the
 *   corners sliced off, or a transparent icon floating on a white plate.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import sharp from "sharp";

// From styles/globals.css. Duplicated deliberately: an icon is a build artifact, not a
// stylesheet, and it cannot read CSS custom properties.
const ACCENT = "#c21807";
const BG = "#0a0a0b";
const FG = "#f2f2f4";

/**
 * The mark: a waterfall. Three stacked rows of varying-width bars, which is what an
 * FT8 decode actually looks like on the screen this app is mostly used to watch.
 *
 * `inset` is the fraction of the canvas left empty around the artwork — 0.08 for the
 * any-purpose icon (just enough to breathe) and 0.20 for maskable (so the safe zone
 * survives an aggressive circular crop).
 */
function markSvg(size: number, inset: number, plate: boolean): string {
  const pad = size * inset;
  const inner = size - pad * 2;

  // Four rows of bars. Widths are fixed, not random: a regenerated icon has to be
  // byte-comparable to the one it replaces, or every rebuild shows up as a diff.
  const rows = [
    [0.15, 0.55, 0.85, 0.35],
    [0.65, 0.25, 0.45, 0.95],
    [0.35, 0.8, 0.2, 0.6],
    [0.9, 0.4, 0.7, 0.3],
  ];

  const rowH = inner / (rows.length * 2 - 1);
  const bars: string[] = [];
  rows.forEach((widths, r) => {
    const y = pad + r * rowH * 2;
    let x = pad;
    const cellW = inner / widths.length;
    widths.forEach((w, i) => {
      const barW = cellW * w;
      // The brightest bar in each row is the accent; the rest are foreground grey, so
      // the mark reads as a signal against noise rather than as a flag.
      const strongest = Math.max(...widths);
      const fill = w === strongest ? ACCENT : FG;
      const opacity = w === strongest ? 1 : 0.35 + w * 0.4;
      bars.push(
        `<rect x="${(x + (cellW - barW) / 2).toFixed(2)}" y="${y.toFixed(2)}" ` +
          `width="${barW.toFixed(2)}" height="${rowH.toFixed(2)}" ` +
          `rx="${(rowH * 0.2).toFixed(2)}" fill="${fill}" opacity="${opacity.toFixed(2)}"/>`,
      );
      x += cellW;
      void i;
    });
  });

  // The maskable variant needs an opaque plate covering the FULL canvas including the
  // bleed, because the launcher may show any of it. The any-purpose variant gets a
  // rounded plate instead, so it looks like an app icon on iOS and in a tab strip.
  const backdrop = plate
    ? `<rect width="${size}" height="${size}" fill="${BG}"/>`
    : `<rect width="${size}" height="${size}" rx="${(size * 0.18).toFixed(2)}" fill="${BG}"/>`;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`,
    backdrop,
    ...bars,
    "</svg>",
  ].join("");
}

interface Target {
  file: string;
  size: number;
  inset: number;
  plate: boolean;
}

const TARGETS: Target[] = [
  // Any-purpose. 192 and 512 are the two sizes the install prompt actually requires.
  { file: "icon-192.png", size: 192, inset: 0.08, plate: false },
  { file: "icon-512.png", size: 512, inset: 0.08, plate: false },
  // Maskable, generous safe zone.
  { file: "icon-maskable-192.png", size: 192, inset: 0.2, plate: true },
  { file: "icon-maskable-512.png", size: 512, inset: 0.2, plate: true },
  // iOS ignores the manifest icons and reads this one. 180 is the current size, and
  // iOS does not round the corners of a home-screen icon for you any more — hence the
  // rounded plate rather than the square bleed.
  { file: "apple-touch-icon.png", size: 180, inset: 0.08, plate: false },
  // Browser tab. 32 is small enough that the four-row mark turns to mush, so it gets
  // the same artwork at a size where the bars are still at least 3px tall.
  { file: "favicon-32.png", size: 32, inset: 0.06, plate: false },
  { file: "favicon-16.png", size: 16, inset: 0.0, plate: true },
];

async function main() {
  const outDir = join(process.cwd(), "public", "icons");
  mkdirSync(outDir, { recursive: true });

  for (const t of TARGETS) {
    const svg = markSvg(t.size, t.inset, t.plate);
    const png = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
    writeFileSync(join(outDir, t.file), png);
    console.log(`  ${t.file.padEnd(26)} ${t.size}x${t.size}  ${png.length} bytes`);
  }

  // The source SVG is written out too, at the any-purpose geometry. Browsers that
  // prefer a vector favicon get a crisp one, and the next person to touch the mark can
  // read it instead of reverse-engineering it from a PNG.
  writeFileSync(join(outDir, "icon.svg"), markSvg(512, 0.08, false));
  console.log("  icon.svg");
  console.log(`Wrote ${TARGETS.length + 1} files to public/icons/`);
}

void main();
