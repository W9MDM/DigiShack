// Small controls shared by the Digital page and its mode panels, so the same kind of
// control looks the same everywhere: an on/off toggle, a ±step pair, a compact select, the
// in-row Call chip, a readout, and the waterfall's resize grip.

import type {
  ButtonHTMLAttributes,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  SelectHTMLAttributes,
} from "react";

import { Button, Select, type ButtonProps } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

type ToggleTone = "accent" | "neutral" | "warn";

/* Tinted, never solid: a solid red on this page means HALT TX. */
const PRESSED: Record<ToggleTone, string> = {
  accent: "border-accent bg-accent/15 text-accent-bright hover:bg-accent/25 hover:text-accent-bright",
  neutral: "border-line-strong bg-surface-3 text-fg hover:bg-surface-3 hover:text-fg",
  warn: "border-warn/60 bg-warn/15 text-warn hover:bg-warn/25 hover:text-warn",
};

/**
 * A button that stays down. `aria-pressed` carries the state; the pressed look survives
 * `disabled`, because the active choice in a group is often the one that cannot be
 * pressed again and must still read as the active one.
 */
export function ToggleButton({
  pressed,
  tone = "accent",
  size = "sm",
  className,
  ...props
}: Omit<ButtonProps, "variant"> & { pressed: boolean; tone?: ToggleTone }) {
  return (
    <Button
      variant="ghost"
      size={size}
      aria-pressed={pressed}
      className={cn(
        "border-line text-fg-muted hover:border-line-strong",
        pressed && PRESSED[tone],
        pressed && "disabled:opacity-100 disabled:cursor-default",
        className,
      )}
      {...props}
    />
  );
}

/** A −step / +step pair for moving a tone, a carrier or a speed. */
export function Nudge({
  step,
  unit = "",
  onStep,
  disabled = false,
  downDisabled = false,
  upDisabled = false,
  downTitle,
  upTitle,
}: {
  step: number;
  unit?: string;
  onStep: (delta: number) => void;
  disabled?: boolean;
  downDisabled?: boolean;
  upDisabled?: boolean;
  downTitle: string;
  upTitle: string;
}) {
  return (
    <span className="inline-flex items-center gap-1">
      <Button
        size="sm"
        className="tnum"
        onClick={() => onStep(-step)}
        disabled={disabled || downDisabled}
        title={downTitle}
      >
        −{step}
        {unit}
      </Button>
      <Button
        size="sm"
        className="tnum"
        onClick={() => onStep(step)}
        disabled={disabled || upDisabled}
        title={upTitle}
      >
        +{step}
        {unit}
      </Button>
    </span>
  );
}

/**
 * The Select primitive in the Digital page's two sizes. It used to add `appearance-auto`
 * for the platform's arrow, from when the primitive drew none; the primitive now draws its
 * own chevron, so that put two arrows on every one of these. The right padding leaves room
 * for the drawn chevron (`pr-7` on the small one; the default `pr-8` on `md`).
 */
export function NativeSelect({
  size = "sm",
  className,
  ...props
}: Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> & { size?: "sm" | "md" }) {
  return (
    <Select
      className={cn(size === "sm" && "w-auto py-1 pl-2 pr-7 text-xs", className)}
      {...props}
    />
  );
}

/**
 * The Call (or Steal) chip inside a decode row. Sized in `em` so it follows the decode
 * list's text-size control, and `tap-inline` because the row itself is the touch target:
 * a 44px chip would triple the row height on the screen with the least of it.
 */
export function CallChip({
  tone = "neutral",
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "neutral" | "warn" }) {
  return (
    <button
      type="button"
      className={cn(
        "tap-inline rounded-sm border px-1.5 py-0.5 align-middle",
        "text-[0.85em] uppercase tracking-wide transition-colors",
        "focus-visible:outline-2 focus-visible:outline-accent-bright",
        tone === "warn"
          ? "border-warn text-warn hover:bg-warn/10"
          : "border-line-strong text-fg-muted hover:border-accent-bright hover:text-accent-bright",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

/** A figure with its label above it. Use inside a <dl>. */
export function Readout({
  label,
  title,
  className,
  valueClassName,
  children,
}: {
  label: string;
  title?: string;
  className?: string;
  valueClassName?: string;
  children: ReactNode;
}) {
  return (
    <div title={title} className={className}>
      <dt className="text-xs text-fg-muted">{label}</dt>
      <dd className={cn("font-display text-xl leading-none tnum", valueClassName)}>{children}</dd>
    </div>
  );
}

/** One label/value line of a details list. Use inside a <dl>. */
export function DetailRow({ label, value, tnum }: { label: string; value: string; tnum?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-fg-subtle">{label}</dt>
      <dd className={cn("text-fg-muted text-right", tnum && "tnum")}>{value}</dd>
    </div>
  );
}

/**
 * A drag strip under a resizable pane, with a taller invisible hit area than its 1px
 * line. Double-click restores the default.
 */
export function ResizeHandle({
  label,
  title,
  onPointerDown,
  onDoubleClick,
}: {
  label: string;
  title: string;
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onDoubleClick: () => void;
}) {
  return (
    <div
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      role="separator"
      aria-orientation="horizontal"
      aria-label={label}
      title={title}
      className="group relative h-1.5 cursor-ns-resize touch-none select-none"
    >
      <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-px bg-line group-hover:bg-line-strong" />
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 h-1 w-10 rounded-sm bg-line-strong opacity-0 group-hover:opacity-100 transition-opacity" />
    </div>
  );
}
