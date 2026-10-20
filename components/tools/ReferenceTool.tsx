import { useDeferredValue, useId, useMemo, useState } from "react";

import { EmptyState, Field, Input, Td, Th } from "@/components/ui/primitives";
import { ToolSection } from "@/components/tools/shared";
import { filterReference, REFERENCE_GROUPS } from "@/lib/ham/tools/reference";
import { cn } from "@/lib/utils";

export function ReferenceTool() {
  const ids = useId();
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query);
  const groups = useMemo(() => filterReference(deferred), [deferred]);
  const count = groups.reduce((n, g) => n + g.entries.length, 0);

  return (
    <ToolSection id="reference" title="References" wide>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Filter" htmlFor={`${ids}-q`} className="w-full sm:w-80">
          <Input
            id={`${ids}-q`}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="QRZ, 73, Kilo, AR …"
            autoComplete="off"
          />
        </Field>
        <p className="text-sm text-fg-subtle pb-2" aria-live="polite">
          {query.trim() ? `${count} match${count === 1 ? "" : "es"}` : ""}
        </p>
      </div>
      <nav aria-label="Reference tables" className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-sm">
        {REFERENCE_GROUPS.map((g) => (
          <a key={g.id} href={`#${g.id}`} className="text-fg-muted hover:text-accent-bright underline-offset-2 hover:underline">
            {g.title}
          </a>
        ))}
      </nav>
      {groups.length === 0 ? (
        <EmptyState title="Nothing matches" className="py-8">
          Try a code (QSL), a word (Kilo) or a number (73).
        </EmptyState>
      ) : (
        <div className="mt-4 grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-x-8 gap-y-5">
          {groups.map(({ group, entries }) => (
            <section key={group.id} id={group.id} className="scroll-mt-16 min-w-0">
              <h3 className="text-sm font-medium text-fg-muted mb-1">{group.title}</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left">
                      {group.columns.map((c, i) => (
                        <Th key={i} size="sm">
                          {c || <span className="sr-only">{i === 0 ? "Term" : "Value"}</span>}
                        </Th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((e) => (
                      <tr key={e.term} className="border-t border-line/60 align-top">
                        <Td size="sm" className={cn("font-mono whitespace-nowrap text-fg", group.overline && "overline")}>
                          {e.term}
                        </Td>
                        <Td size="sm" className="text-fg-muted">{e.meaning}</Td>
                        {group.columns.length === 3 && (
                          <Td size="sm" className={cn("whitespace-nowrap", group.overline ? "font-mono tracking-widest" : "text-fg-subtle")}>
                            {e.extra}
                          </Td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        </div>
      )}
    </ToolSection>
  );
}
