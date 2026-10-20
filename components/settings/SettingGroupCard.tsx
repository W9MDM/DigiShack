import { useState, type ReactNode } from "react";

import { groupIdFor, rowFacts, type DisplayItem } from "@/components/settings/display";
import { Chevron } from "@/components/settings/Chevron";
import { HelpText } from "@/components/settings/HelpText";
import { DisplayRow } from "@/components/settings/SettingField";
import type { SettingGroup, SettingsEditor } from "@/components/settings/types";
import { blurbLine, layoutGroup } from "@/components/settings/visibility";
import { HelpTip } from "@/components/ui/HelpTip";
import { Badge, Button, Card } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

const NONE: ReadonlySet<string> = new Set();

function GroupHeading({ group }: { group: SettingGroup }) {
  return (
    <div className="flex items-center gap-2">
      <h3 id={`${groupIdFor(group.id)}-title`} tabIndex={-1} className="font-display text-base text-fg outline-none">
        {group.title}
      </h3>
      {/* Where to read more, set only where a document genuinely covers the settings under
          it. The link lives INSIDE the explanation rather than behind a bare icon: a tablet
          has no hover, and an unlabelled circle that navigates off-site when touched is not
          an explanation. Points at the public repository; the same file is on disk in docs/
          for a shack with no internet. */}
      {group.doc && (
        <HelpTip label={`Help for ${group.title}`}>
          {group.docLabel ?? "Documentation"} for these settings.{" "}
          <a
            href={`https://github.com/W9MDM/DigiShack/blob/main/docs/${group.doc}.md`}
            target="_blank"
            rel="noreferrer"
            className="text-accent-bright underline underline-offset-2"
          >
            Read it on GitHub
          </a>
          , or open <span className="font-mono">docs/{group.doc}.md</span> on the server if the
          shack has no internet.
        </HelpTip>
      )}
    </div>
  );
}

export interface GroupCardProps {
  group: SettingGroup;
  items: readonly DisplayItem[];
  editor: SettingsEditor;
  extra?: ReactNode;
  advancedOpen: boolean;
  onToggleAdvanced: () => void;
  /** For a group with nothing but advanced settings: shown in full rather than as one line. */
  expanded: boolean;
  onToggleExpanded: () => void;
  /** Row or group id to flash after a jump. */
  flashId: string | null;
}

/**
 * One setting group.
 *
 * Everyday settings first, then a closed "Advanced (N)" disclosure for the ones that are
 * rarely changed. The disclosure only ever folds away settings that are at their defaults:
 * one that has been changed, holds an unsaved edit or cannot be decrypted is drawn outside
 * it, marked Advanced — see components/settings/visibility.ts.
 *
 * A group with only advanced settings, all at their defaults, and nothing else to show is
 * one line saying what it controls, not an empty card: a card whose whole body is a closed
 * disclosure is a box with nothing in it.
 */
export function SettingGroupCard({
  group,
  items,
  editor,
  extra,
  advancedOpen,
  onToggleAdvanced,
  expanded,
  onToggleExpanded,
  flashId,
}: GroupCardProps) {
  const anchor = groupIdFor(group.id);
  const flashGroup = flashId === anchor;
  const allAdvanced = items.length > 0 && items.every((it) => it.advanced) && !extra;
  // An all-advanced group has one switch, "Show"; a mixed group has its disclosure.
  const open = allAdvanced ? expanded : advancedOpen;
  const toggle = allAdvanced ? onToggleExpanded : onToggleAdvanced;

  const [held, setHeld] = useState<ReadonlySet<string>>(NONE);
  const layout = layoutGroup(
    items.map((it) => rowFacts(it, editor)),
    { open, held, hasExtra: Boolean(extra) },
  );
  // Remembering which unsaved rows were drawn outside a closed disclosure — state adjusted
  // during render, React's sanctioned form for state derived from props.
  if (layout.held.length !== held.size || layout.held.some((id) => !held.has(id))) {
    setHeld(layout.held.length === 0 ? NONE : new Set(layout.held));
  }

  const byId = new Map(items.map((it) => [it.id, it]));
  const pick = (ids: readonly string[]) =>
    ids.map((id) => byId.get(id)).filter((x): x is DisplayItem => x !== undefined);
  const visible = pick(layout.visible);
  const folded = pick(layout.folded);

  if (layout.quiet && !open) {
    const line = blurbLine(group.blurb);
    return (
      <div
        id={anchor}
        data-group={group.id}
        className={cn(
          "flex scroll-mt-20 flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-dashed border-line-strong bg-surface/60 px-4 py-3",
          flashGroup && "ring-2 ring-accent-bright/60",
        )}
      >
        <h3 id={`${anchor}-title`} tabIndex={-1} className="font-display text-base text-fg outline-none">
          {group.title}
        </h3>
        <Badge size="sm">Advanced only</Badge>
        <span className="tnum text-sm text-fg-subtle">
          {folded.length} {folded.length === 1 ? "setting" : "settings"}, all at their defaults
        </span>
        <Button
          size="sm"
          variant="secondary"
          className="ml-auto"
          aria-expanded={false}
          aria-controls={`${anchor}-body`}
          onClick={toggle}
        >
          Show
          <span className="sr-only"> {group.title}</span>
        </Button>
        {/* What it controls, so a row of these is a list of choices and not a list of
            names. One line: "Show" has the whole blurb. */}
        {line && (
          <p title={line} className="order-last basis-full truncate text-sm text-fg-muted">
            {line}
          </p>
        )}
      </div>
    );
  }

  // An advanced row out in the open says so, or it reads as an everyday setting that
  // vanishes again once it is back at its default. Inside the disclosure it goes without saying.
  const row = (outside: boolean) => (it: DisplayItem) => (
    <DisplayRow key={it.id} item={it} editor={editor} flash={flashId === it.id} showAdvanced={outside} />
  );
  const panelId = `${anchor}-advanced`;
  // An opened quiet group shows its rows directly: the disclosure would be a second click
  // for the same thing.
  const direct = layout.quiet && open;
  const rows = direct ? folded : visible;

  return (
    <div
      id={anchor}
      data-group={group.id}
      className={cn("scroll-mt-20 rounded-md", flashGroup && "ring-2 ring-accent-bright/60")}
    >
      <Card
        title={<GroupHeading group={group} />}
        actions={
          direct ? (
            <Button size="sm" variant="ghost" aria-expanded aria-controls={`${anchor}-body`} onClick={toggle}>
              Hide
            </Button>
          ) : undefined
        }
      >
        <div id={`${anchor}-body`}>
          {group.blurb && <HelpText text={group.blurb} subject={group.title} className="mb-1 text-fg-muted" />}

          {rows.length > 0 && <div className="divide-y divide-line">{rows.map(row(!direct))}</div>}

          {extra && <div className="mt-4 flex flex-col gap-4">{extra}</div>}

          {!direct && folded.length > 0 && (
            <div className="-mx-4 -mb-4 mt-3 border-t border-line">
              <button
                type="button"
                aria-expanded={open}
                aria-controls={panelId}
                onClick={toggle}
                className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-b-md px-4 py-3 text-left text-sm text-fg-muted hover:bg-surface-2 hover:text-fg"
              >
                <Chevron open={open} />
                <span className="font-medium">{visible.some((it) => it.advanced) ? "More advanced" : "Advanced"}</span>
                <span className="tnum text-fg-subtle">({folded.length})</span>
                {!open && <span className="text-xs text-fg-subtle">all at their defaults</span>}
              </button>
              {open && (
                <div id={panelId} className="divide-y divide-line border-t border-line px-4">
                  {folded.map(row(false))}
                </div>
              )}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
