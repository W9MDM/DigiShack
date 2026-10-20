import { useState } from "react";

import { Button } from "@/components/ui/primitives";
import { ApiError, apiPost } from "@/lib/client/api";
import { useCan } from "@/lib/client/session";

// Send one contact's QSL card again.
//
// Asked for once the card designer landed: having changed the artwork, there was no way to
// put the new card in front of somebody already sent the old one short of editing the
// database.
//
// PER-CONTACT AND NOT A BULK ACTION, deliberately. The bulk path already exists for the case
// it is right for — `requeue-gateways`, for QSLs that provably never arrived — and a button
// that re-mails a page of the log by accident is a spam complaint rather than a bug.
//
// It QUEUES rather than sends. The re-send passes through the same approval gate and the
// same daily cap as a new QSL, so the confirmation says "queue"; saying "send" would be a
// lie the moment `qsl.auto.approve` is off, which is its default.

export function ResendQslButton({
  qsoId,
  callsign,
  /** `icon` for the log table's dense QSL column, `button` for a page with room. */
  variant = "icon",
  label = "Re-send card",
  onQueued,
}: {
  qsoId: string;
  callsign: string;
  variant?: "icon" | "button";
  /** The `button` variant's text. */
  label?: string;
  /** After a successful queue, so a list showing the old row can reload. */
  onQueued?: () => void;
}) {
  const isAdmin = useCan("ADMIN");
  const [state, setState] = useState<"idle" | "busy" | "done" | "failed">("idle");
  const [detail, setDetail] = useState<string | null>(null);

  async function resend() {
    // Confirmed, because it is outbound mail to somebody else and in the log the button
    // sits in a dense table where the wrong row is a few pixels away.
    if (
      !window.confirm(
        `Queue another QSL email to ${callsign}? It goes through the QSL queue like any new one.`,
      )
    ) {
      return;
    }
    setState("busy");
    setDetail(null);
    try {
      const body = await apiPost<{ result?: { status?: string; detail?: string } }>(
        "/api/qsl/queue",
        { action: "resend", qsoId },
      );
      const r = body?.result;
      if (r?.status === "queued") {
        setState("done");
        setDetail("Queued");
        onQueued?.();
        return;
      }
      // Everything else is a REASON rather than a failure of the button: opted out, no
      // published address, no base URL. Shown as it comes back, because "could not queue"
      // would send the operator hunting for a fault that is really somebody's stated
      // preference not to be emailed.
      setState("failed");
      setDetail(r?.detail ?? r?.status ?? "Not queued");
    } catch (err) {
      setState("failed");
      setDetail(err instanceof ApiError ? err.message : "Could not reach the server");
    }
  }

  // Hidden rather than disabled for a non-admin: a greyed control invites a question about
  // why it is greyed, and the answer is only that this is not their button.
  if (!isAdmin) return null;

  const note = detail ? (
    <span role="status" className={`text-xs ${state === "done" ? "text-ok" : "text-warn"}`}>
      {detail}
    </span>
  ) : null;

  if (variant === "button") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" loading={state === "busy"} onClick={() => void resend()}>
          {label}
        </Button>
        {note}
      </div>
    );
  }

  return (
    <span className="inline-flex items-center gap-1">
      {/* globals.css gives a touch screen 44px of height but leaves width to the content,
          and a lone glyph is about 18px wide: a thumb aimed at it opened the contact
          underneath instead. 40px wide on a coarse pointer only, so the log table stays
          dense under a mouse. */}
      <Button
        variant="ghost"
        size="sm"
        className="px-1 py-0 pointer-coarse:min-w-10"
        loading={state === "busy"}
        onClick={() => void resend()}
        title={`Queue the QSL card for ${callsign} again`}
        aria-label={`Re-send the QSL card to ${callsign}`}
      >
        {state === "busy" ? null : <span aria-hidden="true">↻</span>}
      </Button>
      {note}
    </span>
  );
}
