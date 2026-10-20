import { useEffect, useSyncExternalStore } from "react";

import { displayItems } from "@/components/settings/display";
import { Highlight } from "@/components/settings/HelpText";
import { DisplayRow } from "@/components/settings/SettingField";
import type { ClientSetting, SettingGroup, SettingsEditor } from "@/components/settings/types";
import { Button, Card, EmptyState, Input } from "@/components/ui/primitives";
import { groupResults } from "@/lib/settings/search";
import { SETTINGS_TABS } from "@/lib/settings/tabs";

export const SEARCH_INPUT_ID = "settings-search";

function isTyping(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
}

// Tailwind's sm. Below it the full placeholder was cut at "help tex", so a phone gets a
// shorter one; the server renders the full one, as before.
const WIDE = "(min-width: 40rem)";

function subscribeWide(onChange: () => void): () => void {
  const mq = window.matchMedia(WIDE);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

function isWide(): boolean {
  return window.matchMedia(WIDE).matches;
}

/** The search field. "/" focuses it from anywhere on the page that is not a text field. */
export function SettingsSearchBox({
  value,
  onChange,
  summary,
}: {
  value: string;
  onChange: (v: string) => void;
  summary?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      if (isTyping(e.target) || document.querySelector("[aria-modal='true']")) return;
      e.preventDefault();
      document.getElementById(SEARCH_INPUT_ID)?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const wide = useSyncExternalStore(subscribeWide, isWide, () => true);

  return (
    <div className="mb-4 flex flex-col gap-2 sm:mb-6 sm:flex-row sm:items-center sm:gap-4">
      <div role="search" className="relative min-w-0 flex-1">
        <svg
          viewBox="0 0 16 16"
          width="15"
          height="15"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          aria-hidden="true"
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle"
        >
          <circle cx="7" cy="7" r="4.5" />
          <path d="M10.5 10.5L14 14" />
        </svg>
        <Input
          id={SEARCH_INPUT_ID}
          type="search"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && value) {
              e.preventDefault();
              onChange("");
            }
          }}
          placeholder={wide ? "Search settings — name, key or help text" : "Search name, key or help text"}
          aria-label="Search settings"
          aria-keyshortcuts="/"
          enterKeyHint="search"
          autoComplete="off"
          spellCheck={false}
          className="pl-8 pr-10 [&::-webkit-search-cancel-button]:appearance-none"
        />
        {value ? (
          <button
            type="button"
            onClick={() => {
              onChange("");
              document.getElementById(SEARCH_INPUT_ID)?.focus();
            }}
            aria-label="Clear search"
            className="tap-inline absolute right-1.5 top-1/2 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-sm text-fg-subtle hover:bg-surface-3 hover:text-fg"
          >
            <svg viewBox="0 0 16 16" width="12" height="12" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        ) : (
          <kbd
            aria-hidden="true"
            className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 rounded-sm border border-line-strong px-1.5 font-mono text-xs text-fg-subtle sm:inline"
          >
            /
          </kbd>
        )}
      </div>
      {summary && <p className="shrink-0 text-xs text-fg-subtle tnum sm:text-sm">{summary}</p>}
    </div>
  );
}

/**
 * Every match, laid out like the page: category, then group, then the settings themselves
 * — editable in place, on the same draft as the category view, so a search can be used to
 * change something and cleared without losing it.
 *
 * Advanced settings are always included and shown open: a search is how somebody looks for
 * the knob they cannot find, and the knob they cannot find is usually an advanced one.
 */
export function SearchResults({
  query,
  terms,
  hits,
  byKey,
  groups,
  editor,
  onOpenGroup,
  onClear,
}: {
  query: string;
  terms: readonly string[];
  hits: ClientSetting[];
  byKey: ReadonlyMap<string, ClientSetting>;
  groups: SettingGroup[];
  editor: SettingsEditor;
  onOpenGroup: (group: string) => void;
  onClear: () => void;
}) {
  const arranged = groupResults(hits, groups.map((g) => g.id));
  const groupCount = arranged.reduce((n, t) => n + t.groups.length, 0);
  const advanced = hits.filter((h) => h.advanced).length;
  const group = (id: string) => groups.find((g) => g.id === id);

  return (
    <section aria-labelledby="settings-results-title">
      <h2 id="settings-results-title" className="sr-only">
        Search results
      </h2>
      <p role="status" className="mb-4 text-sm text-fg-muted">
        {hits.length === 0
          ? `No settings match “${query.trim()}”.`
          : `${hits.length} ${hits.length === 1 ? "setting" : "settings"} in ${groupCount} ${groupCount === 1 ? "group" : "groups"}` +
            (advanced > 0 ? `, ${advanced} of them advanced` : "")}
      </p>

      {hits.length === 0 ? (
        <EmptyState
          title="Nothing found"
          action={
            <Button variant="secondary" onClick={onClear}>
              Clear the search
            </Button>
          }
        >
          Try a shorter word, a group name such as “QRZ”, or a setting key from an error
          message, such as <span className="font-mono">flex.allowTransmit</span>.
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-6">
          {arranged.flatMap((rt) =>
            rt.groups.map((rg) => {
              const g = group(rg.group);
              const tabLabel = SETTINGS_TABS.find((t) => t.id === rt.tab)?.label ?? rt.tab;
              return (
                <Card
                  key={rg.group}
                  title={
                    <div className="min-w-0">
                      <p className="text-xs text-fg-subtle">{tabLabel}</p>
                      <h3 className="font-display text-base text-fg">
                        <Highlight text={g?.title ?? rg.group} terms={terms} />
                      </h3>
                    </div>
                  }
                  actions={
                    <Button size="sm" variant="ghost" onClick={() => onOpenGroup(rg.group)}>
                      Open group
                      <span className="sr-only"> {g?.title}</span>
                    </Button>
                  }
                >
                  <div className="divide-y divide-line">
                    {displayItems(rg.items, byKey).map((it) => (
                      <DisplayRow
                        key={it.id}
                        item={it}
                        editor={editor}
                        terms={terms}
                        idPrefix="search-"
                        showKey
                        showAdvanced
                      />
                    ))}
                  </div>
                </Card>
              );
            }),
          )}
        </div>
      )}
    </section>
  );
}
