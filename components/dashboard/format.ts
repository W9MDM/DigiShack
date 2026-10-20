/**
 * A share of a whole, rounded to a precision the number can carry.
 *
 * WHOLE NUMBERS ARE WRONG BELOW 10%. The best-day record is 488 of 30,083 contacts —
 * 1.62% — and rounding that to "2%" overstates it by nearly a quarter; the operator
 * caught it reading the Statistics page (1.163.1). One decimal below 10%, none above.
 * Under 0.05% reads "<0.1%" rather than "0.0%": a band with three contacts has not got
 * none.
 *
 * Moved here from pages/stats.tsx when the dashboard's breakdowns started using the same
 * bars, so one band cannot read "1.6%" on one page and "2%" on the next.
 */
export function pct(part: number, whole: number): string {
  if (whole <= 0) return "—";
  const p = (part / whole) * 100;
  if (p > 0 && p < 0.05) return "<0.1%";
  return p < 10 ? `${p.toFixed(1)}%` : `${Math.round(p)}%`;
}

/** "1 contact" / "3 contacts". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}
