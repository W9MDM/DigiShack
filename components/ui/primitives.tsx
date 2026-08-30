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

type ButtonVariant =
  | "primary"
  | "secondary"
  | "ghost"
  | "danger"
  | "danger-solid"
  | "link";

type ButtonSize = "sm" | "md";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-accent-fg hover:bg-accent-hover border-accent disabled:hover:bg-accent",
  secondary:
    "bg-surface-2 text-fg hover:bg-surface-3 border-line-strong",
  ghost:
    "bg-transparent text-fg-muted hover:text-fg hover:bg-surface-2 border-transparent",
  danger:
    "bg-transparent text-danger hover:bg-danger/10 border-danger/40",

  /* `danger` is an OUTLINE, and outline is the right weight for "Delete this QSO" at the
   * foot of a form — a destructive action you should have to aim at deliberately.
   *
   * It is the wrong weight for HALT TX. Stopping the transmitter is the most consequential
   * control in a radio application, and as an outline it rendered QUIETER than "Log a QSO":
   * a transparent button with a 40%-opacity border, sitting next to a solid red primary. In
   * the moment you need it, the eye goes to the loudest thing on the screen, and the loudest
   * thing was the routine action.
   *
   * The text is `bg` (near-black) rather than white, and that is measured, not chosen: on
   * `--color-danger` (#ff655d) white is 2.89:1 — a fail for normal text at any size we use —
   * while #0a0a0b is 6.86:1. `primary` gets away with white only because its fill is the much
   * darker brand red (6.13:1). Computed by hand against the token as it stands; `check:contrast`
   * does not yet cover solid-fill buttons, so re-measure this pair if `--color-danger` moves.
   *
   * Hover BRIGHTENS rather than swapping the fill, because there is no lighter danger token
   * to swap to and an alpha would blend toward the panel behind it — i.e. would make the most
   * urgent control in the app fainter under the cursor. `disabled:hover:brightness-100` is
   * there for the same reason `primary` carries `disabled:hover:bg-accent`: :hover still
   * matches a disabled button. */
  "danger-solid":
    "bg-danger text-bg border-danger hover:brightness-110 disabled:hover:brightness-100",

  /* There are 74 hand-rolled `text-accent-bright` inline links in the app, a fair number of
   * them wrapping something that performs an action rather than navigating. They are
   * hand-rolled partly because no link-weight button existed to reach for.
   *
   * Padding is zeroed so this can sit in a sentence rather than beside one. Note that the
   * coarse-pointer rule in globals.css still gives it a 44px touch target on a phone; that
   * is left alone on purpose — a tappable link needs the target as much as a button does —
   * but it means this variant belongs on its own line, not mid-paragraph. Unverified at
   * phone width: nothing uses this variant yet. */
  link:
    "bg-transparent border-transparent px-0 py-0 text-accent-bright underline-offset-2 hover:underline disabled:hover:no-underline",
};

/* Every button in the app was `px-3 py-1.5 text-sm`, so a page's primary call to action and
 * a chip tucked into a table row carried exactly the same weight. That flatness is a large
 * part of what the audit read as "admin panel": nothing on the page claims to matter more
 * than anything else.
 *
 * `md` is the existing size and stays the default, so no call site moves. */
const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: "px-2 py-1 text-xs",
  md: "px-3 py-1.5 text-sm",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /**
   * In-flight state: disables the button, marks it `aria-busy`, and shows a spinner.
   *
   * Panels currently hand-write `{busy ? "Saving…" : "Save"}` — one panel does it six times
   * — which indicates progress by changing the LABEL. That costs twice: the button resizes
   * under the cursor mid-click, and a screen reader gets no announcement, because a silently
   * changed label on a control that already has focus is not announced. `aria-busy` is.
   */
  loading?: boolean;
}

/** The in-flight indicator. `aria-hidden` — `aria-busy` on the button is what gets spoken. */
function ButtonSpinner({ size }: { size: ButtonSize }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      /* `motion-reduce:animate-none` leaves a static arc rather than substituting some other
       * animation for it. Under reduced motion the disabled state and `aria-busy` carry the
       * meaning; a spinning thing is precisely what that preference is asking us not to draw. */
      className={cn(
        "animate-spin motion-reduce:animate-none shrink-0",
        size === "sm" ? "size-3" : "size-3.5",
      )}
    >
      <circle
        cx="8"
        cy="8"
        r="6"
        stroke="currentColor"
        strokeOpacity="0.3"
        strokeWidth="2"
      />
      <path
        d="M14 8a6 6 0 0 0-6-6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  className,
  type = "button",
  disabled,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        "inline-flex items-center justify-center gap-2 border rounded-sm",
        "font-medium transition-colors",
        "disabled:opacity-45 disabled:cursor-not-allowed",
        BUTTON_SIZES[size],
        BUTTON_VARIANTS[variant],
        className,
      )}
      {...props}
    >
      {loading && <ButtonSpinner size={size} />}
      {children}
    </button>
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
 * Five things this now does that it did not:
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
 *  4. **Stops shouting the label.** It was
 *     `text-xs uppercase tracking-wide text-fg-muted font-display`: five legibility
 *     reducers stacked on the one piece of text that says what a field IS — 12px, ALL
 *     CAPS, letter-spaced, muted grey, and Oswald, which is a CONDENSED face. Uppercase
 *     destroys word shape, the cue that ageing eyes rely on most; a condensed face removes
 *     the horizontal separation that makes individual letters resolvable; and 12px muted is
 *     where both of those hurt hardest. This was on every field of every form in the
 *     product, and the operator who reported it (74, age-related vision decline) named it
 *     her single highest-priority fix in the whole application.
 *     Now `text-sm font-medium text-fg` in normal case: the same size as the input it
 *     labels, at full contrast. Oswald earns its keep on page titles, callsigns and
 *     frequencies — this was the one place it was deployed against its own strengths.
 *  5. **Sizes the error like the thing it describes.** Error and hint were both `text-xs`,
 *     which made the validation message SMALLER than the input it is about. That is
 *     backwards: it is the text you have been sent to read because something went wrong.
 *     Both are `text-sm` now, and the hint stays quiet through colour (`fg-subtle`, which
 *     `check:contrast` measures at 4.65:1 worst case) rather than through size.
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
    /* `gap-1.5`, not `gap-1`. At 12px uppercase the label read as a tag stuck to the control
       and 4px was enough to hold it off. At 14px normal case it reads as a line of text, and
       4px leaves it touching the input's top border. */
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={htmlFor} className="text-sm font-medium text-fg">
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
        <p id={errorId ?? undefined} role="alert" className="text-sm text-danger">
          {errors?.join(". ")}
        </p>
      )}
      {hint && (
        <p id={hintId ?? undefined} className="text-sm text-fg-subtle">
          {hint}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layout / display
// ---------------------------------------------------------------------------

/**
 * A titled panel. The most-used component in the product: 89 instances across 26 files.
 *
 * The title was `text-sm uppercase tracking-wide text-fg-muted` sitting above a
 * `border-b border-line` hairline. Read that back: 14px — the SAME size as the body text it
 * heads — at LOWER contrast, in caps, with a rule underneath it. That is not a heading, it
 * is a `<legend>`, and it was doing that job 89 times. Of everything the design audit turned
 * up, this is the single loudest reason the application reads as an admin panel rather than
 * as an instrument.
 *
 * So: `text-base` (one step ABOVE the body it heads), display face, full-strength `fg`,
 * sentence case, and no rule. A title one step larger and one step brighter than its content
 * is a heading without needing a line to prove it — and dropping the line takes 89 horizontal
 * rules out of the interface, which is most of the grid that made it look like a spreadsheet.
 *
 * The padding is evened out in the same move. The header was `px-4 py-2.5` against a `p-4`
 * body — `py-2.5` occurs exactly twice in the whole codebase — so a panel's top edge was
 * tighter than every other edge of the same panel. Now 16px on all three outer edges like
 * everything else, with 12px between title and content: the gap does the separating that the
 * rule used to do.
 *
 * `shadow-panel` puts the panel ON the page rather than drawing it onto the page. It depends
 * on `--shadow-panel` existing in globals.css, and Tailwind v4 emits NOTHING for a class
 * whose token is missing — no error, no warning, no rule. That is how `bg-bg-raised` shipped
 * with no background in 19 places. If panels look flat, check the token survived before
 * looking for a bug here.
 *
 * `title` stays `ReactNode`. The ~8 call sites that pass a node style their own heading and
 * are untouched by any of this; several of them use `text-lg`, one step above the string
 * case, which is worth reconciling but not from inside this file.
 */
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
  const hasHeader = Boolean(title || actions);
  return (
    <section
      className={cn(
        "bg-surface border border-line rounded-md shadow-panel",
        className,
      )}
    >
      {hasHeader && (
        <header className="flex items-center justify-between gap-3 px-4 pt-4 pb-3">
          {typeof title === "string" ? (
            <h2 className="font-display text-base text-fg">{title}</h2>
          ) : (
            title
          )}
          {actions}
        </header>
      )}
      {/* The body owns its top padding only when there is no header above it. Otherwise the
          header's `pb-3` is the entire gap, and stacking a `pt-4` on top of it would put back
          the dead band the hairline used to sit in — the thing being removed. */}
      <div className={cn("px-4 pb-4", hasHeader ? "pt-0" : "pt-4")}>{children}</div>
    </section>
  );
}

type BadgeTone = "neutral" | "ok" | "warn" | "danger" | "info" | "accent";
type BadgeSize = "sm" | "md";

/* The tone recipe — `bg-{tone}/12 text-{tone} border-{tone}/35` — is the one real system in
 * this file and it is kept exactly. `accent` was the lone exception at /15 and /40 for no
 * recorded reason; it is on the recipe now like everything else.
 *
 * `accent` still takes `text-accent-bright` where the others use the tone directly, and that
 * is not a second inconsistency: the brand red used as TEXT fails even the large-text floor —
 * `check:contrast` measures it at 2.19:1 and fails the build if the unqualified accent class
 * turns up as a foreground colour anywhere. (Do not name that class in a comment either; the
 * check greps the tsx and cannot tell a comment from a className.) The recipe governs the fill
 * and the border; the text colour is whichever of the two reds is legible. */
const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: "bg-surface-3 text-fg-muted border-line-strong",
  ok: "bg-ok/12 text-ok border-ok/35",
  warn: "bg-warn/12 text-warn border-warn/35",
  danger: "bg-danger/12 text-danger border-danger/35",
  info: "bg-info/12 text-info border-info/35",
  accent: "bg-accent/12 text-accent-bright border-accent/35",
};

/* `text-[11px]` was hardcoded here — the only arbitrary type size living inside a primitive,
 * which meant the SMALLEST text in the product was the one size no token or scale change
 * could ever reach. Both sizes sit on the scale now.
 *
 * That does move the default from 11px to 12px. Deliberate: keeping 11px as the default would
 * have preserved the exact fault being reported, and one extra pixel on the smallest text in
 * the application runs the same direction as everything else in this pass. `sm` is for badges
 * packed into a table row, and it buys its density back from the padding rather than from the
 * type — which is the trade that should have been made in the first place. */
const BADGE_SIZES: Record<BadgeSize, string> = {
  sm: "px-1 py-0 text-xs",
  md: "px-1.5 py-0.5 text-xs",
};

export function Badge({
  tone = "neutral",
  size = "md",
  className,
  children,
}: {
  tone?: BadgeTone;
  size?: BadgeSize;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center border rounded-sm font-medium uppercase tracking-wide",
        BADGE_SIZES[size],
        BADGE_TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * The nothing-here state for a page or a panel.
 *
 * `action` exists because every call site was hand-rolling its own way OUT of the empty
 * state and no two agreed — /qsos and /stations put two different link treatments on what is
 * the same "…so go and make one" affordance, and two of them sit on the same page. A slot
 * does not force them to agree, but it does put the escape route in the same place with the
 * same spacing every time, which is most of what consistency buys here.
 *
 * `className` is the escape hatch for the fixed `py-12`. 48px above and below is right for an
 * empty PAGE and far too much for an empty panel inside a three-up grid, where it forces the
 * whole row taller than its populated neighbours. The default is unchanged, so no existing
 * call site moves.
 */
export function EmptyState({
  title,
  action,
  className,
  children,
}: {
  title: string;
  action?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div
      className={cn("flex flex-col items-center gap-2 py-12 text-center", className)}
    >
      <p className="font-display text-lg text-fg-muted">{title}</p>
      {children && <div className="text-sm text-fg-subtle">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
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

/**
 * The page title block.
 *
 * `mb-6`, not `mb-5`. `mb-5` occurs three times in the entire codebase and this was one of
 * them — so the FIRST vertical interval on EVERY page in the product was a value the product
 * otherwise does not use. `mb-4` (44 uses) and `mb-6` (9) carry the rhythm, and the larger of
 * the two is the right one here: this gap separates the page's name from the page, so it
 * should be bigger than the gaps inside the page rather than smaller than several of them.
 *
 * `title` widened from `string` to `ReactNode` to match Card. Card's was already a node and
 * needed it less; this is the one that wants a live indicator or a callsign badge set into
 * the heading, and pages have been pushing that into `actions` instead because they had to.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 mb-6">
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
