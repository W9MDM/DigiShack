/* eslint-disable no-console */
// The fonts DigiShack ships with, and whether librsvg can actually use them.
//
// A card drawn with no usable font is not an error anywhere: sharp composites the SVG,
// librsvg draws nothing for glyphs it cannot find, and the result is a valid image with
// an empty table. So "did it render" has to be measured in PIXELS — asserting that the
// call returned a buffer proves nothing at all.

import sharp from "sharp";

import {
  BUNDLED_FONTS,
  DEFAULT_CARD_FONT,
  bundledFontsPresent,
  ensureFontconfig,
  fontStack,
} from "@/lib/qsl/fonts";

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

/** Dark pixels in a rendering of `text` in `family`. Zero means nothing drew. */
async function inkFor(family: string, text = "K9XYZ 2026 FT8"): Promise<number> {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="460" height="70">` +
    `<rect width="460" height="70" fill="white"/>` +
    `<text x="10" y="48" font-family="${family}" font-size="34" fill="black">${text}</text>` +
    `</svg>`;
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  const { data } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
  let dark = 0;
  for (let i = 0; i < data.length; i++) if (data[i]! < 128) dark++;
  return dark;
}

async function main(): Promise<void> {
  console.log("\nthe shipped font files");
  ok(bundledFontsPresent(), "every bundled face is present in assets/fonts");
  ok(
    BUNDLED_FONTS.some((f) => f.family === DEFAULT_CARD_FONT),
    "the default font is one of the bundled ones",
  );

  console.log("\nfontconfig picks them up");
  const configured = ensureFontconfig();
  ok(configured, "a fontconfig file was written and FONTCONFIG_FILE set");
  ok(
    Boolean(process.env.FONTCONFIG_FILE),
    "FONTCONFIG_FILE points somewhere",
    process.env.FONTCONFIG_FILE ?? "unset",
  );

  console.log("\neach bundled family actually draws");
  const inks: Record<string, number> = {};
  for (const f of BUNDLED_FONTS) {
    const ink = await inkFor(f.family);
    inks[f.family] = ink;
    // 300 is far above any antialiasing fringe and far below a full line of 34px text.
    ok(ink > 300, `${f.family} renders glyphs (${ink} dark px)`, `only ${ink}`);
  }

  console.log("\nand they are DIFFERENT fonts, not one substituted for all three");
  {
    // The failure this catches: fontconfig ignoring the bundle and substituting a single
    // host font for every family, which would pass every test above while shipping a font
    // picker that does nothing.
    const values = Object.values(inks);
    const allSame = values.every((v) => v === values[0]);

    // FONTCONFIG IS A LINUX MECHANISM. Windows resolves fonts through DirectWrite, which
    // does not read FONTCONFIG_FILE, so a dev machine substitutes one host font for all
    // three and this cannot hold there. Measured: an identical 1279 px for every family on
    // Windows against 1641 / 2202 / 2042 on the deployment box.
    //
    // Reported rather than skipped silently. DigiShack is deployed on Linux, so the
    // property holds where it matters, and a check that quietly passed on the machine it
    // was written on would be worth nothing.
    if (process.platform === "linux") {
      ok(!allSame, "the three families produce different ink", JSON.stringify(inks));
    } else {
      console.log(
        "  skip  " + process.platform + " resolves fonts through the OS rather than " +
          "fontconfig — this holds on the Linux deployment target (measured " +
          "1641/2202/2042) and cannot be asserted here: " + JSON.stringify(inks),
      );
    }
  }

  console.log("\nthe stack always ends somewhere real");
  {
    const s = fontStack("Some Font Nobody Has");
    ok(s.startsWith("Some Font Nobody Has"), "an unknown name is still tried first", s);
    ok(s.includes(DEFAULT_CARD_FONT), "with the bundled default behind it");
    ok(s.trimEnd().endsWith("sans-serif"), "and the generic family last");
    const ink = await inkFor(s);
    ok(ink > 300, `a stack naming an absent font still draws (${ink} dark px)`);
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

void main();
