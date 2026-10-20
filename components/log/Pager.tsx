import { Button } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

/** Previous / next with the page count; first and last from sm up. Renders nothing for one page. */
export function Pager({
  page,
  pageCount,
  onPage,
  label,
  className,
}: {
  /** Zero-based. */
  page: number;
  pageCount: number;
  onPage: (page: number) => void;
  /** Distinguishes two pagers on one page for a screen reader. */
  label: string;
  className?: string;
}) {
  if (pageCount <= 1) return null;
  const last = pageCount - 1;
  return (
    <nav aria-label={label} className={cn("flex items-center gap-1", className)}>
      <Button
        variant="ghost"
        className="hidden sm:inline-flex"
        disabled={page === 0}
        onClick={() => onPage(0)}
        aria-label="First page"
      >
        «
      </Button>
      <Button disabled={page === 0} onClick={() => onPage(page - 1)}>
        <span aria-hidden="true">‹</span> Previous
      </Button>
      <span className="px-2 text-sm text-fg-muted tnum whitespace-nowrap">
        Page {(page + 1).toLocaleString()} of {pageCount.toLocaleString()}
      </span>
      <Button disabled={page >= last} onClick={() => onPage(page + 1)}>
        Next <span aria-hidden="true">›</span>
      </Button>
      <Button
        variant="ghost"
        className="hidden sm:inline-flex"
        disabled={page >= last}
        onClick={() => onPage(last)}
        aria-label="Last page"
      >
        »
      </Button>
    </nav>
  );
}
