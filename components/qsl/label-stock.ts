// Label stock geometry for the QSL card label sheet, and the print stylesheet that
// keeps it exact.
//
// Plain data and strings, no React, so scripts/check-qsl-labels.ts can load it.
//
// Figures are the published Avery layouts. Pitch is START-TO-START, so the gap between
// two labels is pitch minus label. UNVERIFIED on a physical sheet: the geometry is
// arithmetic against Avery's published figures, and a printer's feed tolerance is
// around a millimetre either way — hence the test-print advice on the page.

export type LabelUnit = "in" | "mm";

export interface LabelStock {
  id: string;
  name: string;
  /** Size, count and paper, as the box describes it. */
  detail: string;
  paper: "letter" | "A4";
  unit: LabelUnit;
  /** [width, height] of the paper. */
  page: [number, number];
  /** [width, height] of one label. */
  label: [number, number];
  /** [columns, rows]. */
  grid: [number, number];
  /** [top, left] from the paper edge to the first label. */
  margin: [number, number];
  /** [across, down], start of one label to the start of the next. */
  pitch: [number, number];
}

export const LABEL_STOCKS: readonly LabelStock[] = [
  {
    id: "avery-5160",
    name: "Avery 5160 / 8160",
    detail: "1 × 2⅝ in, 30 per sheet, US Letter",
    paper: "letter",
    unit: "in",
    page: [8.5, 11],
    label: [2.625, 1],
    grid: [3, 10],
    margin: [0.5, 0.1875],
    pitch: [2.75, 1],
  },
  {
    id: "avery-5161",
    name: "Avery 5161 / 8161",
    detail: "1 × 4 in, 20 per sheet, US Letter",
    paper: "letter",
    unit: "in",
    page: [8.5, 11],
    label: [4, 1],
    grid: [2, 10],
    margin: [0.5, 0.15625],
    pitch: [4.1875, 1],
  },
  {
    id: "avery-5163",
    name: "Avery 5163 / 8163",
    detail: "2 × 4 in, 10 per sheet, US Letter",
    paper: "letter",
    unit: "in",
    page: [8.5, 11],
    label: [4, 2],
    grid: [2, 5],
    margin: [0.5, 0.15625],
    pitch: [4.1875, 2],
  },
  {
    id: "avery-l7160",
    name: "Avery L7160",
    detail: "63.5 × 38.1 mm, 21 per sheet, A4",
    paper: "A4",
    unit: "mm",
    page: [210, 297],
    label: [63.5, 38.1],
    grid: [3, 7],
    margin: [15.15, 7.25],
    pitch: [66.04, 38.1],
  },
  {
    id: "avery-l7163",
    name: "Avery L7163",
    detail: "99.1 × 38.1 mm, 14 per sheet, A4",
    paper: "A4",
    unit: "mm",
    page: [210, 297],
    label: [99.1, 38.1],
    grid: [2, 7],
    margin: [15.15, 4.65],
    pitch: [101.6, 38.1],
  },
];

export const DEFAULT_LABEL_STOCK = "avery-5160";

export function labelStock(id: string | null | undefined): LabelStock {
  return LABEL_STOCKS.find((s) => s.id === id) ?? LABEL_STOCKS[0]!;
}

export function labelsPerSheet(stock: LabelStock): number {
  return stock.grid[0] * stock.grid[1];
}

/** How much a label can hold, by its height. */
export type LabelDensity = "compact" | "medium" | "roomy";

export function labelDensity(stock: LabelStock): LabelDensity {
  const heightIn = stock.unit === "mm" ? stock.label[1] / 25.4 : stock.label[1];
  if (heightIn <= 1.05) return "compact";
  return heightIn < 1.75 ? "medium" : "roomy";
}

/** Four decimals: enough for a hundredth of a millimetre, and no float noise in the CSS. */
function len(n: number, unit: LabelUnit): string {
  return `${Math.round(n * 10_000) / 10_000}${unit}`;
}

/**
 * The inline geometry of one sheet.
 *
 * The PRINTED copy is a hair short of the paper on both axes. A sheet exactly the size
 * of the page can round a fraction of a pixel over it, and the browser then either adds a
 * blank page after every sheet or shrinks the whole job to fit — which moves every label.
 * Labels are placed from the top-left, so trimming the bottom-right edge moves none.
 */
export function sheetGeometry(
  stock: LabelStock,
  forPrint: boolean,
): Record<string, string> {
  const u = stock.unit;
  const trim = forPrint ? (u === "in" ? 0.02 : 0.5) : 0;
  return {
    width: len(stock.page[0] - trim, u),
    height: len(stock.page[1] - trim, u),
    paddingTop: len(stock.margin[0], u),
    paddingLeft: len(stock.margin[1], u),
    gridTemplateColumns: `repeat(${stock.grid[0]}, ${len(stock.label[0], u)})`,
    gridAutoRows: len(stock.label[1], u),
    columnGap: len(stock.pitch[0] - stock.label[0], u),
    rowGap: len(stock.pitch[1] - stock.label[1], u),
  };
}

/** Wraps the portal copy that is the only thing printed. */
export const PRINT_ROOT_CLASS = "qsl-print-only";

/**
 * The sheet styles, on screen and in print.
 *
 * Printing hides every child of <body> except the portal copy, rather than naming the
 * app's header and nav: the chrome is someone else's markup and can change, and any
 * piece of it left visible pushes every label down the page.
 *
 * Paper colours are named rather than themed on purpose. A label is black on white
 * whatever theme the app is in.
 */
export function labelSheetCss(stock: LabelStock): string {
  return `
.qsl-sheet {
  box-sizing: border-box;
  display: grid;
  align-content: start;
  justify-content: start;
  overflow: hidden;
  background: white;
  color: black;
  font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
  line-height: 1.2;
}
.qsl-label {
  box-sizing: border-box;
  overflow: hidden;
  overflow-wrap: anywhere;
  display: flex;
  flex-direction: column;
  justify-content: center;
}
.qsl-sheet[data-density="compact"] .qsl-label { padding: 0.04in 0.12in; font-size: 7.5pt; }
.qsl-sheet[data-density="medium"] .qsl-label { padding: 0.08in 0.14in; font-size: 8.5pt; }
.qsl-sheet[data-density="roomy"] .qsl-label { padding: 0.16in 0.22in; font-size: 10pt; }
.qsl-sheet .qsl-call { font-weight: 700; font-size: 1.4em; letter-spacing: 0.02em; }
.qsl-sheet .qsl-rule { margin-top: 0.35em; padding-top: 0.25em; border-top: 0.5pt solid black; }
.qsl-sheet.qsl-guides .qsl-label { outline: 0.5pt dashed gray; outline-offset: -0.5pt; }
.${PRINT_ROOT_CLASS} { display: none; }
@media print {
  @page { size: ${stock.paper} portrait; margin: 0; }
  html, body { background: white !important; margin: 0 !important; padding: 0 !important; }
  body > :not(.${PRINT_ROOT_CLASS}) { display: none !important; }
  .${PRINT_ROOT_CLASS} { display: block !important; }
  .${PRINT_ROOT_CLASS} .qsl-sheet { break-after: page; }
  .${PRINT_ROOT_CLASS} .qsl-sheet:last-child { break-after: auto; }
}
`;
}
