import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

// A non-error banner. ErrorBanner covers danger; the logbook pages had five hand-rolled
// copies of the same border/fill recipe for everything else.

type Tone = "ok" | "warn" | "info" | "accent" | "danger";

const TONES: Record<Tone, string> = {
  ok: "border-ok/40 bg-ok/10 text-ok",
  warn: "border-warn/40 bg-warn/10 text-warn",
  info: "border-info/40 bg-info/10 text-info",
  accent: "border-accent/40 bg-accent/10 text-accent-bright",
  danger: "border-danger/40 bg-danger/10 text-danger",
};

export function Notice({
  tone = "info",
  role,
  className,
  children,
}: {
  tone?: Tone;
  role?: "status" | "alert";
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      role={role}
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-2 rounded-sm border px-3 py-2 text-sm",
        TONES[tone],
        className,
      )}
    >
      {children}
    </div>
  );
}
