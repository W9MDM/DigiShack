import Link from "next/link";
import type { AnchorHTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils";

// Navigation styled as a button, and the one inline-link style for the logbook pages.
//
// These pages wrapped `<Button>` in `<Link>`, which renders a <button> inside an <a>:
// invalid nesting, two tab stops per control, and "link, button" read twice by a screen
// reader. The Button primitive has no link form, so this mirrors its secondary/primary/
// ghost classes on the anchor itself. If components/ui grows a ButtonLink, switch to it.

type Variant = "primary" | "secondary" | "ghost";
type Size = "sm" | "md";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg hover:bg-accent-hover border-accent",
  secondary: "bg-surface-2 text-fg hover:bg-surface-3 border-line-strong",
  ghost: "bg-transparent text-fg-muted hover:text-fg hover:bg-surface-2 border-transparent",
};

const SIZES: Record<Size, string> = {
  sm: "px-2 py-1 text-xs",
  md: "px-3 py-1.5 text-sm",
};

type AnchorProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "className" | "children">;

export function LinkButton({
  href,
  variant = "secondary",
  size = "md",
  kind = "page",
  className,
  children,
  ...rest
}: AnchorProps & {
  href: string;
  variant?: Variant;
  size?: Size;
  /** `page` is a client-side route, `external` opens a new tab, `file` is a plain download. */
  kind?: "page" | "external" | "file";
  className?: string;
  children: ReactNode;
}) {
  // `nav-target` picks up the 44px coarse-pointer touch target globals.css gives buttons.
  const cls = cn(
    "nav-target inline-flex items-center justify-center gap-1.5 border rounded-sm font-medium transition-colors",
    SIZES[size],
    VARIANTS[variant],
    className,
  );
  if (kind === "external") {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={cls} {...rest}>
        {children}
        <span aria-hidden="true">↗</span>
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    );
  }
  if (kind === "file") {
    return (
      <a href={href} className={cls} {...rest}>
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={cls} {...rest}>
      {children}
    </Link>
  );
}

export const textLinkClass =
  "text-accent-bright underline decoration-accent-bright/40 underline-offset-2 hover:decoration-accent-bright";

export function TextLink({
  href,
  className,
  children,
  ...rest
}: AnchorProps & { href: string; className?: string; children: ReactNode }) {
  return (
    <Link href={href} className={cn(textLinkClass, className)} {...rest}>
      {children}
    </Link>
  );
}

export function qrzUrl(callsign: string): string {
  return `https://www.qrz.com/db/${encodeURIComponent(callsign)}`;
}
