import type { ReactNode } from "react";

import { pct } from "@/components/dashboard/format";

export interface BarRow {
  key: string;
  label: string;
  value: number;
}

/**
 * Counts as labelled bars: label, bar, count, share.
 *
 * Shared by the dashboard's band and mode breakdowns and the three on Statistics, which
 * had drifted into two different drawings of the same thing — a solid brand-red bar on
 * a track on one page, a red wash behind the text on the other, with different rounding
 * of the same percentages.
 *
 * Neutral ink rather than accent: accent is the transmit colour, and these bars are a
 * single series whose identity is already written beside each one.
 *
 * Scaled to the LARGEST row, not the total. Against the total, a log dominated by one
 * mode — every FT8 station's — renders every other row a pixel wide, and the comparison
 * people want is between the small rows.
 */
export function BarList({
  rows,
  total,
  limit,
  labelWidth = "4.5rem",
  empty = "Nothing logged yet.",
}: {
  /** Already in display order, usually largest first. */
  rows: readonly BarRow[];
  /** Denominator for the share column. Defaults to the sum of the rows. */
  total?: number;
  /** Show this many rows at most, folding the rest into one "Other" row. */
  limit?: number;
  /** Width of the label column, as a CSS length. */
  labelWidth?: string;
  empty?: ReactNode;
}) {
  if (rows.length === 0) {
    return <p className="text-sm text-fg-subtle">{empty}</p>;
  }

  // The tail is folded rather than dropped, so the shares still add up to the whole.
  let shown: readonly BarRow[] = rows;
  if (limit !== undefined && rows.length > limit) {
    const tail = rows.slice(limit - 1);
    shown = [
      ...rows.slice(0, limit - 1),
      {
        key: "__other",
        label: `Other (${tail.length})`,
        value: tail.reduce((s, r) => s + r.value, 0),
      },
    ];
  }

  const max = shown.reduce((m, r) => Math.max(m, r.value), 0);
  const whole = total ?? rows.reduce((s, r) => s + r.value, 0);

  return (
    <ul className="flex flex-col gap-2">
      {shown.map((r) => (
        <li
          key={r.key}
          className="grid items-center gap-x-3 text-sm"
          style={{ gridTemplateColumns: `${labelWidth} minmax(0, 1fr) 3.75rem 3rem` }}
        >
          <span className="truncate text-fg-muted">{r.label}</span>
          <span aria-hidden="true" className="h-2.5 rounded-sm bg-surface-2">
            <span
              className="block h-full rounded-r-sm bg-fg-subtle"
              style={{ width: `${max > 0 && r.value > 0 ? Math.max(1.5, (r.value / max) * 100) : 0}%` }}
            />
          </span>
          <span className="text-right tnum text-fg">{r.value.toLocaleString()}</span>
          <span className="text-right text-xs tnum text-fg-subtle">{pct(r.value, whole)}</span>
        </li>
      ))}
    </ul>
  );
}
