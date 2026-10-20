import Link from "next/link";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

// A headline figure: what it is, the number, and whatever qualifies it.
//
// There were three of these. The dashboard and the POTA page each kept a private `Stat`,
// and they disagreed on background (surface against surface-2), radius, label size (11px
// against 10px), value size and letter-spacing; the Statistics page used a whole titled
// Card to hold one number. Three looks for one idea on three adjacent pages.
//
// The label is sentence case at text-sm, not 10-11px uppercase: it is the one piece of
// text that says what the number IS, and the reasoning that took Field labels out of tiny
// capitals (primitives.tsx) applies here unchanged.

export type StatTone = "neutral" | "accent" | "ok" | "warn" | "danger" | "muted";

/* Text tokens only. `accent` takes the bright red because the brand red fails as text
 * (check:contrast). */
const VALUE_TONE: Record<StatTone, string> = {
  neutral: "text-fg",
  accent: "text-accent-bright",
  ok: "text-ok",
  warn: "text-warn",
  danger: "text-danger",
  muted: "text-fg-muted",
};

export interface StatDelta {
  /** Signed change against the named period. */
  value: number;
  /** What the change is measured against: "vs last year". */
  against: string;
  /**
   * Which direction is good news. Defaults to neither, which colours both directions the
   * same — fewer contacts than yesterday is not a fault, and painting it red would say so.
   */
  good?: "up" | "down" | "neither";
}

export interface StatProps {
  label: string;
  /** Numbers are grouped for display; strings are shown as given. */
  value: number | string;
  /** A qualifier under the value. Plain text when `href` is set — it renders inside a link. */
  hint?: ReactNode;
  tone?: StatTone;
  delta?: StatDelta;
  /** A sparkline under the value, oldest point first. Drawn from zero, so its height is honest. */
  trend?: readonly number[];
  /** What the sparkline shows, for screen readers: "contacts per year, 2017 to 2026". */
  trendLabel?: string;
  /** Makes the whole tile a link — use it where the number has an obvious "show me". */
  href?: string;
  /** `lg` for the one figure a view leads with. */
  size?: "md" | "lg";
  className?: string;
}

export function Stat({
  label,
  value,
  hint,
  tone = "neutral",
  delta,
  trend,
  trendLabel,
  href,
  size = "md",
  className,
}: StatProps) {
  const body = (
    <>
      <span className={cn("block text-sm leading-snug text-fg-muted", href && "pr-5")}>
        {label}
      </span>
      <span
        className={cn(
          "mt-1.5 block font-display leading-none tnum",
          size === "lg" ? "text-4xl" : "text-2xl",
          VALUE_TONE[tone],
        )}
      >
        {typeof value === "number" ? value.toLocaleString() : value}
      </span>
      {delta && <DeltaLine delta={delta} />}
      {hint && (
        <span className="mt-1 block text-xs leading-snug text-fg-subtle">{hint}</span>
      )}
      {trend && trend.length > 1 && <Sparkline points={trend} label={trendLabel} />}
      {href && (
        <span
          aria-hidden="true"
          className="absolute right-3 top-2.5 text-sm text-fg-subtle transition-colors group-hover:text-fg"
        >
          →
        </span>
      )}
    </>
  );

  const frame = cn(
    "relative block rounded-md border border-line bg-surface px-3 py-2.5 shadow-panel",
    className,
  );

  if (href) {
    return (
      <Link
        href={href}
        className={cn(frame, "group transition-colors hover:border-line-strong hover:bg-surface-2")}
      >
        {body}
      </Link>
    );
  }
  return <div className={frame}>{body}</div>;
}

function DeltaLine({ delta }: { delta: StatDelta }) {
  const { value, against, good = "neither" } = delta;
  const dir = value > 0 ? "up" : value < 0 ? "down" : "flat";
  const tone =
    dir === "flat" || good === "neither"
      ? "text-fg-muted"
      : dir === good
        ? "text-ok"
        : "text-danger";

  return (
    <span className={cn("mt-1 block text-xs tnum", tone)}>
      {dir === "flat" ? (
        `No change ${against}`
      ) : (
        <>
          <span aria-hidden="true">{dir === "up" ? "▲" : "▼"}</span>
          <span className="sr-only">{dir === "up" ? "up" : "down"}</span>{" "}
          {Math.abs(value).toLocaleString()} {against}
        </>
      )}
    </span>
  );
}

/**
 * The shape of a series, not its values — those belong in the table it summarises.
 *
 * Stretched to the tile's width with a non-scaling stroke, so the line stays 1.5px at
 * any tile size. The floor is zero rather than the series minimum: a minimum-based floor
 * turns a 5% dip into a cliff.
 */
function Sparkline({ points, label }: { points: readonly number[]; label?: string }) {
  const max = Math.max(...points, 0);
  const min = Math.min(...points, 0);
  const span = max - min || 1;
  const step = 100 / (points.length - 1);
  const coords = points
    .map((p, i) => `${(i * step).toFixed(2)},${(22 - ((p - min) / span) * 20).toFixed(2)}`)
    .join(" ");

  return (
    <>
      <svg
        viewBox="0 0 100 24"
        preserveAspectRatio="none"
        aria-hidden="true"
        className="mt-2 block h-6 w-full text-fg-subtle"
      >
        <polyline
          points={coords}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {label && <span className="sr-only">{label}</span>}
    </>
  );
}
