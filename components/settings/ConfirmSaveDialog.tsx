import type { PendingConfirmation } from "@/components/settings/useSettingsState";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/primitives";

/**
 * THE CONFIRMATION, for the handful of settings whose off position removes a protection
 * rather than changing a preference.
 *
 * The server decides this, not the page — see the PATCH route. Nothing was written when
 * it answered, so Cancel leaves the stored settings exactly as they were and the edits
 * still in the form. Accepting re-sends the SAME updates the server refused, with exactly
 * their keys acknowledged.
 *
 * Cancel is the first control, so it takes focus: Enter on a dialog that appeared
 * mid-save should be the safe answer, not the dangerous one.
 */
export function ConfirmSaveDialog({
  pending,
  saving,
  groupTitle,
  onCancel,
  onConfirm,
}: {
  pending: PendingConfirmation | null;
  saving: boolean;
  groupTitle: (id: string) => string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const many = (pending?.items.length ?? 0) > 1;

  return (
    <Dialog
      open={pending !== null}
      onClose={onCancel}
      role="alertdialog"
      dismissible={!saving}
      title={many ? "These turn off protections" : "This turns off a protection"}
      description="Nothing has been saved yet."
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          {/* The label says what it does, not "OK": an operator reading only the buttons
              should still learn the consequence. */}
          <Button variant="danger" onClick={onConfirm} loading={saving}>
            Turn {many ? "them" : "it"} off anyway
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {pending?.items.map((c) => (
          <div key={c.key}>
            <p className="text-sm font-medium text-fg">
              {c.label}
              {c.group && <span className="font-normal text-fg-subtle"> — {groupTitle(c.group)}</span>}
            </p>
            <p className="mt-1 text-sm leading-relaxed text-fg-muted">{c.message}</p>
          </div>
        ))}
      </div>
    </Dialog>
  );
}
