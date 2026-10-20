import { cn } from "@/lib/utils";

/** A disclosure arrow: right when closed, down when open. Kept apart so the sidebar on every
 * tool page can draw one without loading the settings page's widgets. */
export function Chevron({ open, className }: { open: boolean; className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn("shrink-0 transition-transform", open && "rotate-90", className)}
    >
      <path d="M6 4l4 4-4 4" />
    </svg>
  );
}
