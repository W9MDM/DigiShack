// Which radio the bridge should drive.
//
// Shared by the digital page and the rig page, because an operator looking at either one may
// want to change radios and having it on only one of them is the sort of gap that gets
// worked around instead of reported.

import { useState } from "react";

import { Select } from "@/components/ui/primitives";
import { ApiError, apiPost } from "@/lib/client/api";
import { useCan } from "@/lib/client/session";

/**
 * Which radio to drive.
 *
 * Changing this used to mean editing `digital.source` in Settings and restarting the
 * bridge from a terminal — two steps and a shell for something an operator does to try
 * the other radio. The bridge tears the current source down and brings the new one up
 * in place.
 *
 * It STOPS any automatic mode on the way through, and says so before you pick. Carrying
 * "hunt" across a radio change would start an unattended session on a radio whose
 * antenna, power and tuner state nobody has looked at yet.
 */
export function SourcePicker({ source }: { source: "flex" | "icom" | "wsjtx" | null }) {
  const canOperate = useCan("OPERATOR");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!canOperate || !source) return null;

  async function pick(kind: string) {
    if (kind === source) return;
    // Confirmed, because a <select> changes on a scroll wheel or an arrow key while it
    // has focus, and this one takes the station off the air: it tears down the radio and
    // stops any automatic mode. That happened — the source went icom -> wsjtx with nobody
    // meaning to touch it, the Icom was released, and the bridge sat listening for a
    // WSJT-X decoder that was not running.
    const names: Record<string, string> = {
      flex: "the FlexRadio",
      icom: "the Icom",
      wsjtx: "an external decoder",
    };
    if (
      !window.confirm(
        `Switch to ${names[kind] ?? kind}? This disconnects the current radio and stops ` +
          `any automatic mode.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiPost("/api/bridge/control", { action: "source", kind });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not change radio");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 pt-3 border-t border-line">
      <label className="flex items-center gap-2 text-sm">
        <span className="text-fg-subtle">Use</span>
        <Select
          value={source}
          disabled={busy}
          onChange={(e) => void pick(e.target.value)}
          className="flex-1"
        >
          <option value="flex">FlexRadio</option>
          <option value="icom">Icom (network)</option>
          <option value="wsjtx">External decoder</option>
        </Select>
      </label>
      <p className="mt-1.5 text-xs text-fg-subtle">
        {busy
          ? "Switching — the radio is being released and the other one opened…"
          : "Stops any automatic mode. The radio takes a few seconds to come up."}
      </p>
      {error && <p className="mt-1.5 text-xs text-danger">{error}</p>}
    </div>
  );
}
