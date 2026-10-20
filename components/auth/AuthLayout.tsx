import Head from "next/head";
import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * The frame every signed-out page shares: wordmark, one card, a line of links under it.
 *
 * These pages render without the Shell, so nothing else keeps them clear of the notch —
 * and an installed app opens straight onto /login under a translucent status bar.
 */
export function AuthLayout({
  title,
  description,
  wide = false,
  links,
  children,
}: {
  /** The card's heading, and the browser tab's title. */
  title: string;
  description?: ReactNode;
  /** Setup puts two fields to a row from `sm` up, which a 24rem card cannot hold. */
  wide?: boolean;
  /** Links under the card: back to sign in, forgot password. */
  links?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex w-full justify-center pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]">
      <Head>
        <title>{`${title} · DigiShack`}</title>
      </Head>
      <div className={cn("flex w-full flex-col gap-5", wide ? "max-w-lg" : "max-w-sm")}>
        <p className="flex items-baseline justify-center gap-1.5 font-display text-3xl uppercase tracking-wider">
          <span>Digi</span>
          <span className="text-accent-bright">Shack</span>
        </p>

        <section className="rounded-md border border-line bg-surface p-5 shadow-panel sm:p-6">
          <h1 className="font-display text-xl text-fg">{title}</h1>
          {description && <div className="mt-1 text-sm text-fg-muted">{description}</div>}
          <div className="mt-5">{children}</div>
        </section>

        {links && (
          <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-1 text-sm">
            {links}
          </div>
        )}
      </div>
    </div>
  );
}

/** A text link on these pages. Underlined, because colour alone does not mark a link. */
export function AuthLink({ className, ...props }: ComponentProps<typeof Link>) {
  return (
    <Link
      className={cn(
        "inline-flex items-center text-accent-bright underline underline-offset-2 hover:no-underline pointer-coarse:min-h-11",
        className,
      )}
      {...props}
    />
  );
}
