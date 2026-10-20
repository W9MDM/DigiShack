import { cn } from "@/lib/utils";

/**
 * A small one-of-several switch: All / FT8 / FT4, Worked / Missing / By band.
 *
 * Toggle buttons with `aria-pressed` rather than a tablist: a tablist promises arrow-key
 * navigation, and promising it without delivering is worse than not claiming it. Tab and
 * Enter work, and the pressed state is announced.
 *
 * The selected option is lifted (surface-3, full-strength text) rather than painted red.
 * Accent is the transmit colour; a filter being set is not news.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  className,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  /** Names the group for a screen reader: "Spot mode". */
  label: string;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        "inline-flex flex-wrap items-center gap-0.5 rounded-sm border border-line bg-surface-2 p-0.5",
        className,
      )}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.value)}
            className={cn(
              "rounded-sm px-2.5 py-1 text-xs font-medium transition-colors",
              on ? "bg-surface-3 text-fg shadow-panel" : "text-fg-muted hover:text-fg",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
