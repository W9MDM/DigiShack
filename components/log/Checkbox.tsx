import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** A labelled checkbox. `srLabel` names it when the visible label alone is ambiguous. */
export function Checkbox({
  id,
  label,
  srLabel,
  checked,
  disabled,
  onChange,
  className,
}: {
  id: string;
  label?: ReactNode;
  srLabel?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
  className?: string;
}) {
  return (
    <label
      htmlFor={id}
      className={cn(
        "inline-flex items-center gap-2 text-sm text-fg-muted",
        disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
        className,
      )}
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={srLabel}
        onChange={(e) => onChange(e.target.checked)}
        className="size-4 shrink-0 accent-accent"
      />
      {label}
    </label>
  );
}
