/* eslint-disable no-console */
/**
 * The QSL label sheet lands on the label stock it names, and prints without the app.
 *
 * A label sheet is unforgiving in a way a screen is not: a stock whose figures do not add
 * up to its paper prints every label a few millimetres off, and a print stylesheet that
 * lets the app's header through pushes the whole grid down by its height. Neither shows up
 * on screen, in the typechecker, or anywhere short of a wasted sheet of labels.
 *
 * No database, no browser: it reads the stock table and the generated CSS.
 */

import {
  LABEL_STOCKS,
  labelDensity,
  labelSheetCss,
  PRINT_ROOT_CLASS,
  sheetGeometry,
} from "@/components/qsl/label-stock";
import { sheetsFor, type LabelQso } from "@/components/qsl/LabelSheet";

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

console.log("\nstock geometry");
for (const s of LABEL_STOCKS) {
  const [cols, rows] = s.grid;
  const [pw, ph] = s.page;
  const [lw, lh] = s.label;
  const [top, left] = s.margin;
  const [px, py] = s.pitch;
  const right = pw - (left + (cols - 1) * px + lw);
  const bottom = ph - (top + (rows - 1) * py + lh);
  // A tolerance of a quarter-millimetre: the published figures are rounded.
  const tol = s.unit === "mm" ? 0.25 : 0.01;
  ok(px >= lw && py >= lh, `${s.name}: labels do not overlap`, `pitch ${px}×${py}, label ${lw}×${lh}`);
  ok(right >= 0 && bottom >= 0, `${s.name}: the last label is on the paper`, `right ${right}, bottom ${bottom}`);
  ok(
    Math.abs(right - left) <= tol && Math.abs(bottom - top) <= tol,
    `${s.name}: the grid is centred on the paper, as the stock is cut`,
    `left ${left} right ${right.toFixed(3)}, top ${top} bottom ${bottom.toFixed(3)}`,
  );
  ok(
    (s.paper === "letter" && s.unit === "in" && pw === 8.5 && ph === 11) ||
      (s.paper === "A4" && s.unit === "mm" && pw === 210 && ph === 297),
    `${s.name}: the paper size matches the @page size it asks for`,
  );

  const print = sheetGeometry(s, true);
  const screen = sheetGeometry(s, false);
  ok(
    parseFloat(print.width!) < pw && parseFloat(print.height!) < ph,
    `${s.name}: the printed sheet is a hair inside the paper`,
    "a sheet exactly the paper's size can round over it and add a blank page or shrink the job",
  );
  ok(
    print.paddingTop === screen.paddingTop && print.paddingLeft === screen.paddingLeft &&
      print.gridTemplateColumns === screen.gridTemplateColumns,
    `${s.name}: trimming the print copy moves no label`,
  );
  ok(!/e-|\d{5,}/.test(Object.values(print).join(" ")), `${s.name}: no float noise in the CSS`, JSON.stringify(print));
}

console.log("\ncontent fits");
ok(labelDensity(LABEL_STOCKS.find((s) => s.id === "avery-5160")!) === "compact", "a one-inch label gets the compact layout");
ok(labelDensity(LABEL_STOCKS.find((s) => s.id === "avery-5163")!) === "roomy", "a two-inch label gets the roomy layout");

console.log("\nprint stylesheet");
for (const paper of ["letter", "A4"] as const) {
  const s = LABEL_STOCKS.find((x) => x.paper === paper)!;
  const css = labelSheetCss(s);
  ok(css.includes(`@page { size: ${paper} portrait; margin: 0; }`), `${paper}: @page sets the paper and zero margins`);
  ok(
    css.includes(`body > :not(.${PRINT_ROOT_CLASS}) { display: none !important; }`),
    `${paper}: everything under <body> but the print copy is hidden when printing`,
    "the app header left visible pushes every label down the page",
  );
  ok(!/#[0-9a-fA-F]{3,8}\b/.test(css), `${paper}: no hex colours`);
}

console.log("\nskipping used labels");
{
  const s = LABEL_STOCKS.find((x) => x.id === "avery-5160")!;
  const q = (i: number): LabelQso => ({
    id: String(i), callsign: `K${i}ABC`, band: "20m", mode: "FT8", startTime: "2026-10-18T14:22:00Z",
    freqHz: 14_074_000, rstSent: "-12", rstRcvd: null, gridSquare: null, station: null,
  });
  const many = Array.from({ length: 31 }, (_, i) => q(i));
  const sheets = sheetsFor(s, many, 5);
  ok(sheets.length === 2 && sheets[0]!.length === 30, "31 contacts after 5 used labels make two sheets");
  ok(sheets[0]!.slice(0, 5).every((x) => x === null) && sheets[0]![5]?.id === "0", "the first five positions are left blank");
  ok(sheetsFor(s, [q(1)], 99)[0]!.length === 30, "a skip past the sheet is clamped to its last label");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
