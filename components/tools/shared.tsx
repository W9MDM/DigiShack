import type { ReactNode } from "react";

import { Card } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

/**
 * One tool: a Card behind an anchor, so /tools#grid lands on it.
 *
 * `scroll-mt-16` clears the sticky 48px header; without it a deep link scrolls the tool's
 * title underneath the navigation.
 */
export function ToolSection({
  id,
  title,
  wide,
  actions,
  children,
}: {
  id: string;
  title: string;
  wide?: boolean;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div id={id} className={cn("scroll-mt-16 min-w-0", wide && "xl:col-span-2")}>
      <Card title={title} actions={actions} className="h-full">
        {children}
      </Card>
    </div>
  );
}

/** A small heading inside a tool, for tools with more than one part. */
export function SubHead({ children }: { children: ReactNode }) {
  return <h3 className="text-sm font-medium text-fg-muted mb-2">{children}</h3>;
}

/** A labelled result. `value` is the figure; `sub` is the same figure in other units. */
export function Readout({
  label,
  value,
  sub,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-1 border-b border-line/50 last:border-0">
      <dt className="text-sm text-fg-muted">{label}</dt>
      <dd className="text-right tnum">
        <span className="text-fg">{value}</span>
        {sub && <span className="block text-xs text-fg-subtle">{sub}</span>}
      </dd>
    </div>
  );
}

export function Readouts({ children, className }: { children: ReactNode; className?: string }) {
  return <dl className={cn("flex flex-col", className)}>{children}</dl>;
}

/** A sentence in place of results, for input that cannot be computed yet. */
export function Problem({ children }: { children: ReactNode }) {
  return <p className="text-sm text-fg-subtle">{children}</p>;
}

/**
 * A row of mutually exclusive choices — the units toggle on the log, as a component.
 * Buttons with `aria-pressed`, because each is an on/off state the operator flips.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <div role="group" aria-label={label} className={cn("inline-flex flex-wrap items-center gap-1 text-xs", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={
            value === o.value
              ? "rounded-sm border border-accent/40 bg-accent/20 text-accent-bright px-2 py-1"
              : "rounded-sm border border-line-strong px-2 py-1 text-fg-muted hover:text-fg"
          }
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Footnote({ children }: { children: ReactNode }) {
  return <p className="mt-3 text-xs text-fg-subtle leading-relaxed">{children}</p>;
}
