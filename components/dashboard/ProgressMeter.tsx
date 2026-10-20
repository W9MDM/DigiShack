import { cn } from "@/lib/utils";

// Award progress: confirmed, worked but not confirmed, and still needed.
//
// One hue in two steps, because "worked" CONTAINS "confirmed" — the lit part of the bar is
// everything worked and the solid part of it is what is credited. It was green for
// confirmed and half-strength brand red for the rest, which made the gap between worked
// and credited look like an error rather than a to-do list.
//
// `ok` at 55% is measured, not picked: composited over the Card surface it is #2d7039,
// 2.97:1 against the surface, and the pair passes an ordinal-ramp check (one hue,
// monotone lightness, a visible step). 45% fell to 2.39:1. Re-measure if the surface or
// `--color-ok` move. The empty track is surface-3 and is meant to recede; the legend's
// counts carry every value as text, so nothing depends on telling the colours apart.

const SEGMENT = {
  confirmed: "bg-ok",
  worked: "bg-ok/55",
  needed: "bg-surface-3",
} as const;

/** Worked within the target, so stale reference data cannot push the bar past 100%. */
function parts(worked: number, confirmed: number, total: number | null) {
  const credited = Math.max(0, Math.min(confirmed, worked));
  return {
    confirmed: credited,
    worked: Math.max(0, worked - credited),
    needed: total !== null ? Math.max(0, total - worked) : 0,
  };
}

export function ProgressMeter({
  worked,
  confirmed,
  total,
  className,
}: {
  worked: number;
  confirmed: number;
  /** The size of the target set, or null where the award has none. */
  total: number | null;
  className?: string;
}) {
  const p = parts(worked, confirmed, total);
  // Flex-grow in proportion rather than percentage widths, so the 2px gaps between
  // segments come out of the bar instead of overflowing it.
  const segments = (["confirmed", "worked", "needed"] as const).filter((k) => p[k] > 0);

  // A span, not a div: it is drawn inside the awards page's <summary>, which takes
  // phrasing content only.
  return (
    <span aria-hidden="true" className={cn("flex h-2.5 w-full gap-0.5", className)}>
      {segments.length === 0 ? (
        <span className={cn("h-full flex-1 rounded-sm", SEGMENT.needed)} />
      ) : (
        segments.map((k) => (
          <span
            key={k}
            className={cn("h-full min-w-0.5 rounded-sm", SEGMENT[k])}
            style={{ flexGrow: p[k], flexBasis: 0 }}
          />
        ))
      )}
    </span>
  );
}

/** The meter's three colours, named once, for a list of meters that share them. */
export function MeterKey({ withTarget = true }: { withTarget?: boolean }) {
  const items: { key: keyof typeof SEGMENT; text: string }[] = [
    { key: "confirmed", text: "Confirmed" },
    { key: "worked", text: "Worked, not confirmed" },
  ];
  if (withTarget) items.push({ key: "needed", text: "Not worked yet" });
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-muted" aria-label="Key">
      {items.map((i) => (
        <li key={i.key} className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className={cn("size-2.5 rounded-sm", SEGMENT[i.key])} />
          {i.text}
        </li>
      ))}
    </ul>
  );
}

/** The meter's key, with every count written out. */
export function MeterLegend({
  worked,
  confirmed,
  total,
  unit,
}: {
  worked: number;
  confirmed: number;
  total: number | null;
  unit: string;
}) {
  const p = parts(worked, confirmed, total);
  const items: { key: keyof typeof SEGMENT; n: number; text: string }[] = [
    { key: "confirmed", n: p.confirmed, text: "confirmed" },
    { key: "worked", n: p.worked, text: "worked, not confirmed" },
  ];
  if (total !== null) items.push({ key: "needed", n: p.needed, text: "not worked yet" });

  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-muted" aria-label={`${unit} by status`}>
      {items.map((i) => (
        <li key={i.key} className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className={cn("size-2.5 rounded-sm", SEGMENT[i.key])} />
          <span>
            <span className="tnum text-fg">{i.n.toLocaleString()}</span> {i.text}
          </span>
        </li>
      ))}
    </ul>
  );
}
