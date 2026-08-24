import { useState } from "react";

import { Badge } from "@/components/ui/primitives";
import { HelpTip } from "@/components/ui/HelpTip";
import { apiPost, useApi } from "@/lib/client/api";
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
  const { data, reload } = useApi<{ status: { ft0?: boolean } | null }>(
    "/api/bridge/status",
  );
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const engaged = data?.status?.ft0 === true;

  const send = async (engage: boolean) => {
    setBusy(true);
    try {
      await apiPost("/api/bridge/control", { action: "ft0", engage });
      reload();
    } catch {
      // The status poll is the source of truth; a failed call shows up there.
    } finally {
      setBusy(false);
      setConfirming(false);
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
        <button
          type="button"
          disabled={busy}
          onClick={() => void send(true)}
          className="rounded-sm border border-accent px-2 py-1 text-xs text-fg hover:bg-accent/20 disabled:opacity-50"
        >
          {busy ? "stopping…" : "Stop everything"}
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="text-xs text-fg-subtle hover:text-fg"
        >
          cancel
        </button>
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
