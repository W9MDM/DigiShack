import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Something worth knowing that is not an error.
 *
 * "No DXCC reference data loaded" and "POTA has no profile for this callsign" were drawn
 * as red ErrorBanners or as a hand-rolled grey box. Neither is a failure — the page works,
 * it is telling you what it cannot know — and red for a setup hint teaches people to
 * ignore red.
 */
export function Notice({
  tone = "info",
  className,
  children,
}: {
  tone?: "info" | "warn";
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      role="note"
      className={cn(
        "rounded-sm border px-3 py-2 text-sm text-fg",
        tone === "warn" ? "border-warn/40 bg-warn/10" : "border-info/40 bg-info/10",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** First-load placeholder. A refetch keeps the previous figures on screen instead. */
export function Loading({ children = "Loading…" }: { children?: ReactNode }) {
  return (
    <p role="status" className="text-sm text-fg-subtle">
      {children}
    </p>
  );
}
