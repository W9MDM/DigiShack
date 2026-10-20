import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * A table that fills its Card edge to edge.
 *
 * Inside a Card's 16px padding, a table's own 12px cell padding put the first column 28px
 * in while the Card title sat at 16px, and the header band stopped short of both edges.
 * This bleeds the table out to the Card's edges and pads the outer cells back to 16px, so
 * the first column lines up with the title and a wide table scrolls within the Card
 * rather than pushing the page sideways at 375px.
 *
 * Use the shared Th/Td inside it, with `bg-surface-2` on the header row as the log does.
 */
export function CardTable({
  label,
  className,
  children,
}: {
  /** Accessible name, when the Card title alone would be ambiguous. */
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className="-mx-4 overflow-x-auto">
      <table
        aria-label={label}
        className={cn(
          "w-full border-collapse text-sm",
          "[&_th:first-child]:pl-4 [&_td:first-child]:pl-4",
          "[&_th:last-child]:pr-4 [&_td:last-child]:pr-4",
          className,
        )}
      >
        {children}
      </table>
    </div>
  );
}
