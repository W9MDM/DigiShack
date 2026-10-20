import { useState } from "react";

import { Badge } from "@/components/ui/primitives";
import { HelpTip } from "@/components/ui/HelpTip";
import { apiPost } from "@/lib/client/api";
import { refreshStationGate, useStationGate } from "@/lib/client/use-station-gate";
import { cn } from "@/lib/utils";

/**
 * FT-0: stop everything.
 *
 * Named for the joke mode at ft-0.com — 0 baud, 0 Hz bandwidth, −∞ dB minimum SNR,
 * a 100% success rate, and "when all else fails: nothing". The name is the joke; the
 * button is a real kill switch, and it lives in the header because the one control
 * you need in a hurry should not be two pages deep.
 *
 * Engaging unkeys the radio, stops the automatic modes, persists the master transmit
 * switch OFF, and drops the radio connection — in that order, because a transmitting
 * radio is the only urgent part.
 *
 * Releasing brings the radio back but deliberately does NOT re-enable transmit.
 * Coming out of a full stop should be a deliberate act, and re-arming a transmitter
 * because someone pressed the same button twice is the exact surprise this exists to
 * prevent.
 */
export function Ft0Button() {
  const gate = useStationGate();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const engaged = gate?.ft0 === true;

  const send = async (engage: boolean) => {
    setBusy(true);
    try {
      await apiPost("/api/bridge/control", { action: "ft0", engage });
    } catch {
      // The status poll is the source of truth; a failed call shows up there.
    } finally {
      setBusy(false);
      setConfirming(false);
      void refreshStationGate();
    }
  };

  if (engaged) {
    return (
      <div className="flex items-center gap-2">
        <Badge tone="accent">FT-0</Badge>
        <button
          type="button"
          disabled={busy}
          onClick={() => void send(false)}
          className="text-xs text-fg-subtle hover:text-fg disabled:opacity-50"
          title="Reconnect the radio. Transmit stays off until you enable it yourself."
        >
          {busy ? "…" : "resume"}
        </button>
      </div>
    );
  }

  // Two-step, because it disconnects the radio mid-session. Not a modal — a modal
  // in the way of a panic button is worse than the accident it prevents.
  if (confirming) {
    return (
      <div className="flex items-center gap-2">
        {/* On a phone, "Stop everything" and "cancel" in this slot pushed the header about
            80px past the right edge of the screen, and "cancel" went with it. There FT-0
            stays where it was, shown pressed (pressing it again cancels), and the two
            buttons drop into a panel under the header the way the TX pill's confirmation
            does. From `sm` up the panel classes all undo themselves and the row is the
            inline pair it always was. */}
        <button
          type="button"
          onClick={() => setConfirming(false)}
          aria-expanded="true"
          title="Cancel FT-0"
          className="sm:hidden rounded-sm border border-accent bg-accent/15 px-2 py-1 text-xs tracking-wide text-accent-bright"
        >
          FT-0
        </button>
        <div
          role="group"
          aria-label="Stop everything?"
          className={cn(
            "fixed inset-x-4 top-[calc(3rem+env(safe-area-inset-top)+0.5rem)] z-40",
            "flex flex-wrap items-center justify-end gap-2",
            "rounded-md border border-line-strong bg-surface p-3 shadow-pop",
            "sm:static sm:z-auto sm:flex-nowrap sm:justify-start",
            "sm:rounded-none sm:border-0 sm:bg-transparent sm:p-0 sm:shadow-none",
          )}
        >
          <p className="sm:hidden w-full text-sm text-fg-muted">
            Unkey the radio, stop the automatic modes, turn transmit off and release the
            radio?
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void send(true)}
            className="rounded-sm border border-accent px-3 py-2 text-sm sm:px-2 sm:py-1 sm:text-xs text-fg hover:bg-accent/20 disabled:opacity-50"
          >
            {busy ? "stopping…" : "Stop everything"}
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="px-2 text-sm sm:px-0 sm:text-xs text-fg-subtle hover:text-fg"
          >
            cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className={cn(
          "rounded-sm border border-line px-2 py-1 text-xs tracking-wide",
          "text-fg-muted hover:text-fg hover:border-line-strong transition-colors",
        )}
        title="FT-0 — transmit nothing. Unkeys, stops the automatic modes, disables transmit and releases the radio."
      >
        FT-0
      </button>
      {/* The one button in the header somebody might press without knowing what it does,
          and the one whose name actively misleads: it looks like a mode selector. So it
          gets a marker, and the marker credits the joke it is named after — the name is
          borrowed and the attribution belongs next to the borrowing. */}
      <HelpTip label="What FT-0 does" align="right">
        <strong>Stop everything.</strong> Unkeys the radio, stops the automatic modes,
        turns the transmit gate off so a restart cannot resume, then releases the radio.
        Resuming reconnects but deliberately leaves transmit off — coming out of a full
        stop should be a deliberate act.
        <br />
        <br />
        The name is borrowed from <strong>ft-0.com</strong>, a joke mode with 0 baud, 0 Hz
        bandwidth and a 100% success rate: <em>&ldquo;when all else fails:
        nothing.&rdquo;</em> Their joke, our kill switch — this one really does something.
      </HelpTip>
    </div>
  );
}
