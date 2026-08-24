import { useState } from "react";

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
// same daily cap as a new QSL, so the confirmation says "queued"; saying "sent" would be a
// lie the moment `qsl.auto.approve` is off, which is its default.

export function ResendQslButton({
  qsoId,
  callsign,
  /** `icon` for the log table's dense QSL column, `button` for a page with room. */
  variant = "icon",
}: {
  qsoId: string;
  callsign: string;
  variant?: "icon" | "button";
}) {
  const isAdmin = useCan("ADMIN");
  const [state, setState] = useState<"idle" | "busy" | "done" | "failed">("idle");
  const [detail, setDetail] = useState<string | null>(null);

  async function resend() {
    // Confirmed, because it is outbound mail to somebody else and in the log the button
    // sits in a dense table where the wrong row is a few pixels away.
    if (!confirm(`Send the QSL card to ${callsign} again?`)) return;
    setState("busy");
    setDetail(null);
    try {
      const res = await fetch("/api/qsl/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "resend", qsoId }),
      });
      const body = (await res.json().catch(() => null)) as
        | { result?: { status?: string; detail?: string }; error?: string }
        | null;
      if (!res.ok) {
        setState("failed");
        setDetail(body?.error ?? `Failed (${res.status})`);
        return;
      }
      const r = body?.result;
      if (r?.status === "queued") {
        setState("done");
        setDetail("Queued for the next send");
        return;
      }
      // Everything else is a REASON rather than a failure of the button: opted out, no
      // published address, no base URL. Shown as it comes back, because "could not queue"
      // would send the operator hunting for a fault that is really somebody's stated
      // preference not to be emailed.
      setState("failed");
      setDetail(r?.detail ?? r?.status ?? "Not queued");
    } catch {
      setState("failed");
      setDetail("Could not reach the server");
    }
  }

  // Hidden rather than disabled for a non-admin: a greyed control invites a question about
  // why it is greyed, and the answer is only that this is not their button.
  if (!isAdmin) return null;

  const tone = state === "done" ? "text-ok" : "text-warn";

  if (variant === "button") {
    return (
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void resend()}
          disabled={state === "busy"}
          className="rounded border border-line px-2 py-1 text-xs text-fg hover:border-accent-bright hover:text-accent-bright disabled:opacity-50"
        >
          {state === "busy" ? "Queueing…" : "Re-send card"}
        </button>
        {detail ? <span className={`text-xs ${tone}`}>{detail}</span> : null}
      </div>
    );
  }

  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        onClick={() => void resend()}
        disabled={state === "busy"}
        title={`Send the QSL card to ${callsign} again`}
        aria-label={`Re-send the QSL card to ${callsign}`}
        className="text-xs text-fg-subtle hover:text-accent-bright disabled:opacity-50"
      >
        {state === "busy" ? "…" : "↻"}
      </button>
      {detail ? <span className={`text-xs ${tone}`}>{detail}</span> : null}
    </span>
  );
}
