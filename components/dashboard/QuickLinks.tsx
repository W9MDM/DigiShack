import Link from "next/link";

import { Card } from "@/components/ui/primitives";

export interface QuickLink {
  href: string;
  title: string;
  description: string;
}

/**
 * Where to go from the landing page.
 *
 * Whole-row targets with a sentence each, because these are the destinations someone
 * opens the app for. The nav lists them too, but as bare words in a row of fifteen.
 */
export function QuickLinks({
  links,
  className,
}: {
  links: readonly QuickLink[];
  className?: string;
}) {
  return (
    <Card title="Go to" className={className}>
      <ul className="-mx-2 flex flex-col">
        {links.map((l) => (
          <li key={l.href}>
            <Link
              href={l.href}
              className="group flex items-center gap-3 rounded-sm px-2 py-2 transition-colors hover:bg-surface-2"
            >
              <span className="min-w-0 flex-1">
                <span className="block font-display text-base text-fg">{l.title}</span>
                <span className="block text-sm text-fg-subtle">{l.description}</span>
              </span>
              <span
                aria-hidden="true"
                className="text-fg-subtle transition-colors group-hover:text-fg"
              >
                →
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}
