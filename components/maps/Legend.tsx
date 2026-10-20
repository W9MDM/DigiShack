import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export type SwatchShape = "dot" | "ring" | "square" | "terminator" | "bands";

/**
 * The glyph a layer is drawn with, so the legend shows the shape as well as the colour —
 * a hollow ring and a filled dot of similar hue must still be told apart.
 */
export function Swatch({ shape, colour, colours }: { shape: SwatchShape; colour?: string; colours?: readonly string[] }) {
  if (shape === "bands") {
    return (
      <span aria-hidden className="inline-flex -space-x-1">
        {(colours ?? []).slice(0, 3).map((c) => (
          <span key={c} className="inline-block size-2.5 rounded-full ring-1 ring-surface" style={{ background: c }} />
        ))}
      </span>
    );
  }
  if (shape === "terminator") {
    return (
      <span
        aria-hidden
        className="inline-block size-3 rounded-full border"
        style={{ borderColor: colour, background: `linear-gradient(90deg, transparent 50%, ${colour} 50%)` }}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={cn("inline-block", shape === "square" ? "size-2.5 rounded-[1px]" : "size-2.5 rounded-full")}
      style={shape === "ring" ? { border: `1.5px solid ${colour}` } : { background: colour }}
    />
  );
}

/**
 * A layer switch that is also its legend entry: the swatch is what the layer looks like on
 * the map, and the count says how much of it there is — so there is no separate legend to
 * cover the map with.
 */
export function LayerToggle({
  on,
  onToggle,
  shape,
  colour,
  colours,
  count,
  title,
  children,
}: {
  on: boolean;
  onToggle: () => void;
  shape: SwatchShape;
  colour?: string;
  colours?: readonly string[];
  count?: number | null;
  title?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      title={title}
      onClick={onToggle}
      className={cn(
        "inline-flex items-center gap-2 rounded-sm border px-2.5 py-1 text-sm transition-colors",
        on
          ? "border-line-strong bg-surface-2 text-fg"
          : "border-line text-fg-subtle hover:text-fg-muted hover:border-line-strong",
      )}
    >
      <span className={cn("inline-flex", !on && "opacity-40")}>
        <Swatch shape={shape} colour={colour} colours={colours} />
      </span>
      {children}
      {on && count !== undefined && count !== null && (
        <span className="tnum text-xs text-fg-muted">{count.toLocaleString()}</span>
      )}
    </button>
  );
}

/** The band colour key, under a plot rather than over it. */
export function BandKey({ bands }: { bands: readonly { band: string; colour: string; count: number }[] }) {
  if (bands.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-fg-muted" aria-label="Band colours">
      {bands.map((b) => (
        <li key={b.band} className="inline-flex items-center gap-1.5">
          <Swatch shape="dot" colour={b.colour} />
          <span>{b.band}</span>
          <span className="tnum text-fg-subtle">{b.count.toLocaleString()}</span>
        </li>
      ))}
    </ul>
  );
}
