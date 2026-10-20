import { useEffect, useRef, type ReactNode } from "react";

import { Button } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

/** A checkbox that can also say "some of these", which `checked` alone cannot. */
export function TickBox({
  checked,
  indeterminate = false,
  onChange,
  label,
  disabled,
  className,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: (checked: boolean) => void;
  /** Accessible name; leave out only when a wrapping <label> supplies one. */
  label?: string;
  disabled?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  // `indeterminate` is a DOM property with no attribute, so it has to be set by hand.
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate && !checked;
  }, [indeterminate, checked]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
      aria-label={label}
      className={cn(
        "size-4 shrink-0 cursor-pointer accent-accent disabled:cursor-not-allowed",
        className,
      )}
    />
  );
}

type NoticeTone = "ok" | "warn" | "info";

const NOTICE_TONES: Record<NoticeTone, string> = {
  ok: "border-ok/35 bg-ok/12",
  warn: "border-warn/35 bg-warn/12",
  info: "border-line bg-surface",
};

/** What the last action did. Errors go in ErrorBanner; this is for outcomes. */
export function Notice({
  tone = "info",
  onDismiss,
  children,
}: {
  tone?: NoticeTone;
  onDismiss?: () => void;
  children: ReactNode;
}) {
  return (
    <div
      role="status"
      className={cn(
        "flex items-start gap-3 rounded-sm border px-3 py-2 text-sm text-fg",
        NOTICE_TONES[tone],
      )}
    >
      <div className="min-w-0 flex-1">{children}</div>
      {onDismiss && (
        <Button variant="ghost" size="sm" onClick={onDismiss} className="-my-1 -mr-1.5 shrink-0">
          Dismiss
        </Button>
      )}
    </div>
  );
}

/** Callsigns for a sentence: the first few, then a count. */
export function callList(calls: string[], max = 8): string {
  if (calls.length <= max) return calls.join(", ");
  return `${calls.slice(0, max).join(", ")} and ${calls.length - max} more`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
