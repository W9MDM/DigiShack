import type { ReactNode } from "react";

import { groupIdFor, itemSettings, type DisplayItem } from "@/components/settings/display";
import { Chevron } from "@/components/settings/Chevron";
import { HelpText } from "@/components/settings/HelpText";
import { DisplayRow } from "@/components/settings/SettingField";
import type { SettingGroup, SettingsEditor } from "@/components/settings/types";
import { HelpTip } from "@/components/ui/HelpTip";
import { Badge, Button, Card } from "@/components/ui/primitives";
import { partitionAdvanced } from "@/lib/settings/presentation";
import { cn } from "@/lib/utils";

/** How many of these rows hold unsaved edits, and how many differ from the defaults. */
function tally(items: readonly DisplayItem[], editor: SettingsEditor) {
  let unsaved = 0;
  let customised = 0;
  for (const it of items) {
    for (const s of itemSettings(it)) {
      if (editor.isDirty(s.key)) unsaved++;
      else if (s.customised) customised++;
    }
  }
  return { unsaved, customised };
}

/** The dot on a closed disclosure: something in there is not as a fresh install has it. */
function HiddenChanges({ unsaved, customised }: { unsaved: number; customised: number }) {
  if (unsaved === 0 && customised === 0) return null;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <span
        aria-hidden="true"
        className={cn("size-1.5 rounded-full", unsaved > 0 ? "bg-info" : "bg-fg-subtle")}
      />
      {unsaved > 0 && <span className="text-info">{unsaved} unsaved</span>}
      {unsaved > 0 && customised > 0 && <span className="text-fg-subtle">·</span>}
      {customised > 0 && <span className="text-fg-subtle">{customised} customised</span>}
    </span>
  );
}

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
 * rarely changed — with a dot when something in there has an unsaved edit or is not at its
 * default, so a knob turned months ago is not forgotten just because it is folded away.
 *
 * A group with only advanced settings and nothing else to show is one line, not an empty
 * card: a card whose whole body is a closed disclosure is a box with nothing in it.
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
  const { basic, advanced } = partitionAdvanced(items);
  const anchor = groupIdFor(group.id);
  const flashGroup = flashId === anchor;
  const advancedOnly = basic.length === 0 && advanced.length > 0 && !extra;

  if (advancedOnly && !expanded) {
    const t = tally(advanced, editor);
    return (
      <div
        id={anchor}
        data-group={group.id}
        className={cn(
          "flex scroll-mt-20 flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-dashed border-line-strong bg-surface/60 px-4 py-3",
          flashGroup && "ring-2 ring-accent-bright/60",
        )}
      >
        <h3 id={`${anchor}-title`} tabIndex={-1} className="font-display text-base text-fg outline-none">
          {group.title}
        </h3>
        <Badge size="sm">Advanced only</Badge>
        <span className="tnum text-sm text-fg-subtle">
          {advanced.length} {advanced.length === 1 ? "setting" : "settings"}
        </span>
        <HiddenChanges {...t} />
        <Button
          size="sm"
          variant="secondary"
          className="ml-auto"
          aria-expanded={false}
          aria-controls={`${anchor}-body`}
          onClick={onToggleExpanded}
        >
          Show
          <span className="sr-only"> {group.title}</span>
        </Button>
      </div>
    );
  }

  const row = (it: DisplayItem) => (
    <DisplayRow key={it.id} item={it} editor={editor} flash={flashId === it.id} />
  );
  const t = tally(advanced, editor);
  const panelId = `${anchor}-advanced`;

  return (
    <div
      id={anchor}
      data-group={group.id}
      className={cn("scroll-mt-20 rounded-md", flashGroup && "ring-2 ring-accent-bright/60")}
    >
      <Card
        title={<GroupHeading group={group} />}
        actions={
          advancedOnly ? (
            <Button size="sm" variant="ghost" aria-expanded aria-controls={`${anchor}-body`} onClick={onToggleExpanded}>
              Hide
            </Button>
          ) : undefined
        }
      >
        <div id={`${anchor}-body`}>
          {group.blurb && <HelpText text={group.blurb} subject={group.title} className="mb-1 text-fg-muted" />}

          {/* An advanced-only group that has been opened shows its rows directly: the
              disclosure would be a second click for the same thing. */}
          {(advancedOnly ? advanced : basic).length > 0 && (
            <div className="divide-y divide-line">{(advancedOnly ? advanced : basic).map(row)}</div>
          )}

          {extra && <div className="mt-4 flex flex-col gap-4">{extra}</div>}

          {!advancedOnly && advanced.length > 0 && (
            <div className="-mx-4 -mb-4 mt-3 border-t border-line">
              <button
                type="button"
                aria-expanded={advancedOpen}
                aria-controls={panelId}
                onClick={onToggleAdvanced}
                className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-b-md px-4 py-3 text-left text-sm text-fg-muted hover:bg-surface-2 hover:text-fg"
              >
                <Chevron open={advancedOpen} />
                <span className="font-medium">Advanced</span>
                <span className="tnum text-fg-subtle">({advanced.length})</span>
                {!advancedOpen && <HiddenChanges {...t} />}
              </button>
              {advancedOpen && (
                <div id={panelId} className="divide-y divide-line border-t border-line px-4">
                  {advanced.map(row)}
                </div>
              )}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
