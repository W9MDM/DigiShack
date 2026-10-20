import type { ReactNode } from "react";

import { Button, type ButtonProps } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

// The small pieces every Rig panel is built from, so the band buttons, the filter presets,
// NB/NR and the span presets all look and behave like one control rather than four
// hand-rolled button styles.

const SELECTED = {
  accent: "border-accent bg-accent/12 text-accent-bright hover:bg-accent/20",
  warn: "border-warn/70 bg-warn/12 text-warn hover:bg-warn/20",
} as const;

/**
 * One option in a set, lit from what the RADIO reports rather than from the last click.
 *
 * `selected: null` is a state the radio has not reported: a dashed outline rather than
 * "off", because a panel that guesses "off" is wrong whenever the radio is on.
 */
export function ChoiceButton({
  selected,
  tone = "accent",
  className,
  ...props
}: Omit<ButtonProps, "variant" | "size"> & {
  selected: boolean | null;
  tone?: keyof typeof SELECTED;
}) {
  return (
    <Button
      size="sm"
      variant="secondary"
      aria-pressed={selected ?? undefined}
      className={cn(
        "tnum",
        selected === true && SELECTED[tone],
        selected === null && "border-dashed text-fg-muted",
        className,
      )}
      {...props}
    />
  );
}

/** Label-and-control rows. Baseline-aligned so a label sits level with a button's text. */
export function ControlGrid({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-baseline gap-x-3 gap-y-3">
      {children}
    </div>
  );
}

export function ControlRow({
  label,
  htmlFor,
  help,
  children,
}: {
  label: string;
  /** The control's id, when the row holds a single form control. */
  htmlFor?: string;
  help?: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <div className="flex items-center gap-1.5 text-sm text-fg-muted">
        {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span>{label}</span>}
        {help}
      </div>
      <div className="min-w-0">{children}</div>
    </>
  );
}

/** A meter value. Callers render nothing for a reading the radio has not reported. */
export function Readout({
  label,
  value,
  tone,
  title,
}: {
  label: string;
  value: string;
  tone?: string;
  title?: string;
}) {
  return (
    <span className="inline-flex items-baseline gap-1" title={title}>
      <span className="text-xs text-fg-subtle">{label}</span>
      <span className={cn("text-sm tnum", tone ?? "text-fg")}>{value}</span>
    </span>
  );
}

/** A refused command, shown in the panel whose control sent it. */
export function InlineError({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="mt-3 text-sm text-danger">
      {children}
    </p>
  );
}
