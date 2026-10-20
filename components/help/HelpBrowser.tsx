import { useMemo, useState, type ReactNode } from "react";

import { FAQ, type FaqSection } from "@/components/help/faq";
import { faqSearch } from "@/components/help/search";
import { Button, Card, EmptyState, Field, Input } from "@/components/ui/primitives";

const matching = faqSearch(FAQ);
const TOTAL = FAQ.reduce((n, s) => n + s.items.length, 0);

/** Section and question links. Rendered once per layout — a sidebar on wide screens, a fold on narrow. */
function Contents({ sections }: { sections: FaqSection[] }) {
  return (
    <nav aria-label="Help topics">
      <ol className="flex flex-col gap-4 text-sm">
        {sections.map((s) => (
          <li key={s.id}>
            <a href={`#${s.id}`} className="font-medium text-fg hover:text-accent-bright">
              {s.title}
            </a>
            <ol className="mt-1.5 flex flex-col gap-1 border-l border-line pl-3">
              {s.items.map((i) => (
                <li key={i.id}>
                  <a
                    href={`#${i.id}`}
                    className="inline-block text-fg-muted hover:text-fg pointer-coarse:py-1.5"
                  >
                    {i.q}
                  </a>
                </li>
              ))}
            </ol>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** The searchable FAQ: a search box, the contents, and every answer with its own anchor. */
export function HelpBrowser({
  initialQuery = "",
  footer,
}: {
  initialQuery?: string;
  /** Rendered after the answers and never filtered — the About card. */
  footer?: ReactNode;
}) {
  const [query, setQuery] = useState(initialQuery);
  const sections = useMemo(() => matching(query), [query]);
  const shown = sections.reduce((n, s) => n + s.items.length, 0);
  const searching = query.trim().length > 0;

  return (
    <div className="flex flex-col gap-6">
      <div className="max-w-xl">
        <Field label="Search the answers" htmlFor="help-search">
          <Input
            id="help-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setQuery("");
            }}
            placeholder="e.g. waterfall, transmit, password"
            autoComplete="off"
            spellCheck={false}
            className="pointer-coarse:text-base"
          />
        </Field>
        <p aria-live="polite" className="mt-2 text-sm text-fg-subtle">
          {searching
            ? shown === 0
              ? "No answers match."
              : `${shown} of ${TOTAL} answers match.`
            : `${TOTAL} answers in ${FAQ.length} topics.`}
        </p>
      </div>

      <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[15rem_minmax(0,48rem)] lg:items-start lg:gap-8">
        {sections.length > 0 && (
          <>
            {/* Top offset clears the sticky site header. */}
            <aside className="hidden lg:sticky lg:top-16 lg:block lg:max-h-[calc(100vh-5rem)] lg:overflow-y-auto lg:pb-4">
              <Contents sections={sections} />
            </aside>
            <details className="rounded-md border border-line bg-surface lg:hidden">
              <summary className="cursor-pointer px-4 py-3 font-display text-base pointer-coarse:py-3.5">
                Contents
              </summary>
              <div className="px-4 pb-4">
                <Contents sections={sections} />
              </div>
            </details>
          </>
        )}

        <div className="flex min-w-0 flex-col gap-4 lg:col-start-2">
          {sections.map((s) => (
            <div key={s.id} id={s.id} className="scroll-mt-20">
              <Card title={s.title}>
                <div className="flex flex-col divide-y divide-line/60">
                  {s.items.map((i) => (
                    <article
                      key={i.id}
                      id={i.id}
                      className="-mx-2 scroll-mt-20 rounded-sm px-2 py-4 first:pt-1 last:pb-1 target:bg-surface-2"
                    >
                      <h3 className="font-sans text-sm font-semibold text-fg">{i.q}</h3>
                      <div className="mt-1.5 flex flex-col gap-2 text-sm leading-relaxed text-fg-muted">
                        {i.a}
                      </div>
                    </article>
                  ))}
                </div>
              </Card>
            </div>
          ))}

          {sections.length === 0 && (
            <EmptyState
              title="Nothing matches that"
              action={<Button onClick={() => setQuery("")}>Clear the search</Button>}
            >
              Try fewer or shorter words. If the question is not here, the bridge log usually has
              the answer.
            </EmptyState>
          )}

          {footer}
        </div>
      </div>
    </div>
  );
}
