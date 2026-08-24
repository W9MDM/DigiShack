import {
  cloneElement,
  isValidElement,
  useId,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";

import { cn } from "@/lib/utils";

// Small hand-rolled primitives rather than a component library. An earlier iteration
// pulled in Radix for menus and dialogs; nothing in Phase 1 needs that, and
// adding it back should wait until a real popover/dialog requirement appears.

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-accent-fg hover:bg-accent-hover border-accent disabled:hover:bg-accent",
  secondary:
    "bg-surface-2 text-fg hover:bg-surface-3 border-line-strong",
  ghost:
    "bg-transparent text-fg-muted hover:text-fg hover:bg-surface-2 border-transparent",
  danger:
    "bg-transparent text-danger hover:bg-danger/10 border-danger/40",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

export function Button({
  variant = "secondary",
  className,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex items-center justify-center gap-2 border px-3 py-1.5 rounded-sm",
        "text-sm font-medium transition-colors",
        "disabled:opacity-45 disabled:cursor-not-allowed",
        BUTTON_VARIANTS[variant],
        className,
      )}
      {...props}
    />
  );
}

// ---------------------------------------------------------------------------
// Form controls
// ---------------------------------------------------------------------------

const CONTROL_BASE =
  "w-full bg-surface-2 border border-line-strong rounded-sm px-2.5 py-1.5 text-sm text-fg " +
  "placeholder:text-fg-subtle transition-colors " +
  "hover:border-line-strong focus:border-accent-bright " +
  "focus-visible:outline-2 focus-visible:outline-accent-bright focus-visible:outline-offset-1 " +
  "disabled:opacity-50 disabled:cursor-not-allowed " +
  "aria-[invalid=true]:border-danger";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(CONTROL_BASE, className)} {...props} />;
}

export function Textarea({
  className,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea className={cn(CONTROL_BASE, "resize-y min-h-20", className)} {...props} />
  );
}

export function Select({
  className,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn(CONTROL_BASE, "appearance-none pr-8", className)} {...props}>
      {children}
    </select>
  );
}

export interface FieldProps {
  label: string;
  htmlFor?: string;
  /** Validation messages for this field, as returned by the API. */
  errors?: string[];
  hint?: string;
  required?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * A labelled form control.
 *
 * Three things this now does that it did not:
 *
 *  1. **Shows the hint AND the error.** They used to be mutually exclusive, so the
 *     moment you got a field wrong you also lost the text explaining the format —
 *     precisely when it is needed. "IOTA looks like NA-001" replaced "e.g. NA-001",
 *     and if the error is less specific than the hint you are worse off than before
 *     you typed.
 *  2. **Links both to the control** with `aria-describedby`, so a screen reader reads
 *     the hint and the error with the field rather than as loose text somewhere after
 *     it. Every form in the application goes through this component, so it is the one
 *     place worth fixing.
 *  3. **Announces the error** with `role="alert"`, because validation failures arrive
 *     after submit, when focus is on a button and nothing else says what happened.
 *
 * The child is cloned to attach the description. Field always wraps exactly one
 * control, and asking thirty call sites to thread an id each would guarantee some of
 * them never did.
 */
export function Field({
  label,
  htmlFor,
  errors,
  hint,
  required,
  className,
  children,
}: FieldProps) {
  const generated = useId();
  const base = htmlFor ?? generated;
  const hasError = Boolean(errors?.length);
  const hintId = hint ? `${base}-hint` : null;
  const errorId = hasError ? `${base}-error` : null;
  const describedBy = [errorId, hintId].filter(Boolean).join(" ") || undefined;

  const described =
    isValidElement(children) && describedBy
      ? cloneElement(children as ReactElement<Record<string, unknown>>, {
          "aria-describedby":
            [
              (children.props as Record<string, unknown>)["aria-describedby"],
              describedBy,
            ]
              .filter(Boolean)
              .join(" ") || undefined,
          ...(hasError ? { "aria-invalid": true } : {}),
        })
      : children;

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <label
        htmlFor={htmlFor}
        className="text-xs uppercase tracking-wide text-fg-muted font-display"
      >
        {label}
        {required && (
          <>
            <span aria-hidden="true" className="text-accent-bright ml-0.5">
              *
            </span>
            {/* The asterisk is a convention, not a word. A screen reader reads it as
                "star" or skips it entirely. */}
            <span className="sr-only"> (required)</span>
          </>
        )}
      </label>
      {described}
      {hasError && (
        <p id={errorId ?? undefined} role="alert" className="text-xs text-danger">
          {errors?.join(". ")}
        </p>
      )}
      {hint && (
        <p id={hintId ?? undefined} className="text-xs text-fg-subtle">
          {hint}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layout / display
// ---------------------------------------------------------------------------

export function Card({
  title,
  actions,
  className,
  children,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={cn("bg-surface border border-line rounded-md", className)}
    >
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
          {typeof title === "string" ? (
            <h2 className="text-sm uppercase tracking-wide text-fg-muted">
              {title}
            </h2>
          ) : (
            title
          )}
          {actions}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

type BadgeTone = "neutral" | "ok" | "warn" | "danger" | "info" | "accent";

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: "bg-surface-3 text-fg-muted border-line-strong",
  ok: "bg-ok/12 text-ok border-ok/35",
  warn: "bg-warn/12 text-warn border-warn/35",
  danger: "bg-danger/12 text-danger border-danger/35",
  info: "bg-info/12 text-info border-info/35",
  accent: "bg-accent/15 text-accent-bright border-accent/40",
};

export function Badge({
  tone = "neutral",
  className,
  children,
}: {
  tone?: BadgeTone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center border px-1.5 py-0.5 rounded-sm text-[11px] font-medium uppercase tracking-wide",
        BADGE_TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function EmptyState({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 py-12 text-center">
      <p className="font-display text-lg text-fg-muted">{title}</p>
      {children && <div className="text-sm text-fg-subtle">{children}</div>}
    </div>
  );
}

export function ErrorBanner({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      className="border border-danger/40 bg-danger/10 text-danger text-sm px-3 py-2 rounded-sm"
    >
      {children}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 mb-5">
      <div>
        <h1 className="font-display text-2xl uppercase tracking-wide">
          {title}
        </h1>
        {subtitle && <p className="text-sm text-fg-muted mt-0.5">{subtitle}</p>}
      </div>
      {/*
       * `flex-wrap` here, not just on the row above.
       *
       * The outer row wraps, so the actions cluster drops onto its own line on a narrow
       * screen — and then could not wrap INTERNALLY, so its min-content width became the
       * document's width. On /decodes that cluster is the band-conditions strip plus a TX
       * badge plus a live badge plus a button, and at 375px it pushed the page about
       * 165px wider than the viewport: every page on the site scrolled sideways, header
       * included, because of one missing class on a shared component.
       *
       * Found by measurement at 375px, not by reading — the same row looks perfectly
       * fine at every width where it happens to fit.
       */}
      {actions && (
        <div className="flex flex-wrap items-center justify-end gap-2 min-w-0">
          {actions}
        </div>
      )}
    </div>
  );
}
