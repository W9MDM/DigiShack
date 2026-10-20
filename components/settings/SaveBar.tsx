import { useState } from "react";

import type { NamedSetting, SaveReport } from "@/components/settings/useSettingsState";
import { Button } from "@/components/ui/primitives";

const SHOWN = 6;

/** Names, each a jump to the setting, folding a long list behind "N more". */
function Names({
  items,
  groupTitle,
  onJump,
}: {
  items: NamedSetting[];
  groupTitle: (id: string) => string;
  onJump: (key: string) => void;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, SHOWN);
  return (
    <>
      {shown.map((s, i) => (
        <span key={s.key}>
          {i > 0 && ", "}
          <button
            type="button"
            onClick={() => onJump(s.key)}
            className="tap-inline text-fg underline-offset-2 hover:underline"
          >
            {s.label}
          </button>
          {s.group && <span className="text-fg-subtle"> ({groupTitle(s.group)})</span>}
        </span>
      ))}
      {items.length > SHOWN && !all && (
        <>
          {" "}
          <button type="button" onClick={() => setAll(true)} className="tap-inline text-accent-bright hover:underline">
            and {items.length - SHOWN} more
          </button>
        </>
      )}
    </>
  );
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The save bar, along the bottom of the screen whenever there is something to say.
 *
 * Unsaved work: how much, where, and the two ways out. After a save: WHICH settings were
 * written, by name — "3 saved" told the operator nothing they could check. After a
 * discard: a way back, because a discard across several groups is easy to regret.
 */
export function SaveBar({
  dirtyCount,
  dirtyGroups,
  groupTitle,
  saving,
  error,
  onSave,
  onDiscard,
  report,
  onDismissReport,
  discarded,
  onUndoDiscard,
  onDismissDiscarded,
  onJumpToGroup,
  onJumpToSetting,
}: {
  dirtyCount: number;
  dirtyGroups: string[];
  groupTitle: (id: string) => string;
  saving: boolean;
  error: string | null;
  onSave: () => void;
  onDiscard: () => void;
  report: SaveReport | null;
  onDismissReport: () => void;
  discarded: { count: number } | null;
  onUndoDiscard: () => void;
  onDismissDiscarded: () => void;
  onJumpToGroup: (group: string) => void;
  onJumpToSetting: (key: string) => void;
}) {
  const mode = dirtyCount > 0 ? "dirty" : report ? "report" : discarded ? "discarded" : null;

  return (
    <>
      {/* Always in the DOM, so the announcement of what was saved is actually read out. */}
      <div aria-live="polite" className="sr-only">
        {mode === "report" && report
          ? `Saved ${report.saved.length + report.cleared.length} settings` +
            (report.rejected.length ? `, ${report.rejected.length} rejected` : "")
          : ""}
        {mode === "discarded" ? "Changes discarded" : ""}
      </div>
      {mode && (
        <div
          role="region"
          aria-label={mode === "dirty" ? "Unsaved changes" : "Last save"}
          className="fixed inset-x-0 bottom-0 z-30 border-t border-line-strong bg-surface pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3"
        >
          <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-4 gap-y-2 px-4">
            {mode === "dirty" && (
              <>
                <div className="min-w-0 flex-1 text-sm">
                  <p className="font-medium text-fg">{plural(dirtyCount, "unsaved change", "unsaved changes")}</p>
                  <p className="truncate text-fg-muted">
                    in{" "}
                    {dirtyGroups.slice(0, 3).map((g, i) => (
                      <span key={g}>
                        {i > 0 && ", "}
                        <button
                          type="button"
                          onClick={() => onJumpToGroup(g)}
                          className="tap-inline underline-offset-2 hover:text-fg hover:underline"
                        >
                          {groupTitle(g)}
                        </button>
                      </span>
                    ))}
                    {dirtyGroups.length > 3 && ` and ${dirtyGroups.length - 3} more`}
                  </p>
                  {error && (
                    <p role="alert" className="text-danger">
                      Not saved: {error}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button variant="ghost" onClick={onDiscard} disabled={saving}>
                    Discard
                  </Button>
                  <Button variant="primary" onClick={onSave} loading={saving}>
                    Save changes
                  </Button>
                </div>
              </>
            )}

            {mode === "report" && report && (
              <>
                <div className="min-w-0 flex-1 text-sm leading-relaxed">
                  {report.saved.length > 0 && (
                    <p>
                      <span className="font-medium text-ok">Saved: </span>
                      <Names items={report.saved} groupTitle={groupTitle} onJump={onJumpToSetting} />
                    </p>
                  )}
                  {report.cleared.length > 0 && (
                    <p>
                      <span className="font-medium text-warn">Cleared: </span>
                      <Names items={report.cleared} groupTitle={groupTitle} onJump={onJumpToSetting} />
                    </p>
                  )}
                  {report.rejected.length > 0 && (
                    <p className="text-danger">
                      <span className="font-medium">Not saved: </span>
                      {report.rejected.map((r, i) => (
                        <span key={r.key}>
                          {i > 0 && "; "}
                          <button type="button" onClick={() => onJumpToSetting(r.key)} className="tap-inline underline">
                            {r.label}
                          </button>{" "}
                          ({r.reason})
                        </span>
                      ))}
                      <span className="text-fg-muted"> — still in the form, so it can be corrected.</span>
                    </p>
                  )}
                  {report.saved.length + report.cleared.length + report.rejected.length === 0 && (
                    <p className="text-fg-muted">Nothing needed saving.</p>
                  )}
                </div>
                <Button variant="ghost" onClick={onDismissReport}>
                  Dismiss
                </Button>
              </>
            )}

            {mode === "discarded" && discarded && (
              <>
                <p className="min-w-0 flex-1 text-sm text-fg-muted">
                  Discarded {plural(discarded.count, "change", "changes")}.
                </p>
                <div className="flex shrink-0 items-center gap-2">
                  <Button variant="ghost" onClick={onDismissDiscarded}>
                    Dismiss
                  </Button>
                  <Button variant="secondary" onClick={onUndoDiscard}>
                    Undo
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
