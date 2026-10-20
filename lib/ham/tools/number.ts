// Parsing and formatting shared by the calculators on the Tools page.
//
// Every calculator there recomputes on each keystroke, from text the operator is still
// typing. So parsing returns a REASON rather than NaN, and formatting never prints NaN or
// Infinity: a value that is not finite becomes "—". A blank result with a sentence beside
// it is an answer; "NaN ft" is a bug report.

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export interface NumberRule {
  /** What the field is, for the message: "Frequency". */
  label: string;
  /** Unit for the range message: "MHz". */
  unit?: string;
  min?: number;
  max?: number;
  /** `min` itself is not allowed — "greater than 0". */
  exclusiveMin?: boolean;
}

const PLAIN_NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

/**
 * A number typed by the operator, or why it is not one.
 *
 * Commas are refused rather than guessed at: "1,500" is fifteen hundred to an American and
 * one and a half to most of Europe, and a calculator that silently picks one is wrong by
 * a factor of a thousand for the other.
 */
export function parseNumber(text: string, rule: NumberRule): Parsed<number> {
  const t = text.trim().replace(/\s+/g, "");
  const unit = rule.unit ? ` ${rule.unit}` : "";
  if (t === "") return { ok: false, error: `Enter ${article(rule.label)} ${rule.label.toLowerCase()}` };
  if (t.includes(",")) {
    return { ok: false, error: `Use a decimal point, not a comma, in the ${rule.label.toLowerCase()}` };
  }
  if (!PLAIN_NUMBER.test(t)) return { ok: false, error: `${rule.label} must be a number` };
  const n = Number(t);
  if (!Number.isFinite(n)) return { ok: false, error: `${rule.label} is too large` };
  if (rule.min !== undefined) {
    const below = rule.exclusiveMin ? n <= rule.min : n < rule.min;
    if (below) {
      return {
        ok: false,
        error: `${rule.label} must be ${rule.exclusiveMin ? "greater than" : "at least"} ${trim(rule.min)}${unit}`,
      };
    }
  }
  if (rule.max !== undefined && n > rule.max) {
    return { ok: false, error: `${rule.label} must be no more than ${trim(rule.max)}${unit}` };
  }
  return { ok: true, value: n };
}

function article(label: string): string {
  return /^[aeiou]/i.test(label) ? "an" : "a";
}

function trim(n: number): string {
  return String(Number(n.toPrecision(12)));
}

const FIXED = new Map<number, Intl.NumberFormat>();

/**
 * A number to a fixed number of decimals, with thousands separators.
 *
 * Pinned to en-US so the server render and the browser render agree: a page rendered in
 * one locale and hydrated in another prints "1,500" then "1.500" for the same value.
 */
export function fmt(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return "—";
  let f = FIXED.get(digits);
  if (!f) {
    f = new Intl.NumberFormat("en-US", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
    FIXED.set(digits, f);
  }
  const s = f.format(n);
  // -0.00 is a rounding artefact, not a value worth a sign.
  return /^-0(\.0+)?$/.test(s) ? s.slice(1) : s;
}

/** A signed figure: "+6.0", "-1.5", "0.0". For gains and losses, where the sign is the point. */
export function fmtSigned(n: number, digits = 1): string {
  const s = fmt(n, digits);
  if (s === "—" || s.startsWith("-") || /^0(\.0+)?$/.test(s)) return s;
  return `+${s}`;
}

/** Three significant figures, for quantities that span many decades. */
function sig3(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const digits = n >= 100 ? 0 : n >= 10 ? 1 : 2;
  return fmt(n, digits);
}

const POWER_STEPS: readonly [number, string][] = [
  [1, "W"],
  [1e-3, "mW"],
  [1e-6, "µW"],
  [1e-9, "nW"],
  [1e-12, "pW"],
  [1e-15, "fW"],
];

/**
 * Watts in whichever SI step keeps three significant figures: "100 W", "50.1 pW".
 * Watts up to 9,999 — an operator thinks of 1,500 W, not 1.50 kW.
 */
export function formatWatts(w: number): string {
  if (!Number.isFinite(w) || w <= 0) return "—";
  if (w >= 9_999.5) return `${sig3(w / 1e3)} kW`;
  for (const [scale, unit] of POWER_STEPS) {
    if (w >= scale * 0.9995) return `${sig3(w / scale)} ${unit}`;
  }
  return `${w.toExponential(2)} W`;
}

/** Volts the same way: "50.1 µV", "1.12 mV". */
export function formatVolts(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "—";
  if (v >= 0.9995) return `${sig3(v)} V`;
  if (v >= 0.9995e-3) return `${sig3(v * 1e3)} mV`;
  if (v >= 0.9995e-6) return `${sig3(v * 1e6)} µV`;
  return `${sig3(v * 1e9)} nV`;
}

export const METRES_PER_FOOT = 0.3048;

/** Feet and inches to the nearest tenth of an inch: 32′ 10.8″ — what a tape measure reads. */
export function feetInches(ft: number): string {
  if (!Number.isFinite(ft) || ft < 0) return "—";
  let whole = Math.floor(ft);
  let inches = Math.round((ft - whole) * 120) / 10;
  if (inches >= 12) {
    whole += 1;
    inches -= 12;
  }
  return `${whole}′ ${inches.toFixed(1)}″`;
}
