// The station clock, two ways: the median DT of everyone else's decodes (real, but needs
// eight of them, so it is silent on a dead band) and an SNTP measurement (one round trip,
// works on a dead band). A drifting clock produces a screen of nothing that looks exactly
// like a dead band, a wrong frequency or broken audio.
//
// A warning is a full banner. A correction that is simply working is one quiet line.

import { useState } from "react";

import type { ClockSync } from "@/components/decodes/types";
import { Button } from "@/components/ui/primitives";
import { apiPost } from "@/lib/client/api";
import { useCan } from "@/lib/client/session";
import type { ClockOffset } from "@/lib/digital/clock-offset";
import { cn } from "@/lib/utils";

export function ClockBanner({
  clock,
  sync,
  onSynced,
}: {
  clock: ClockOffset;
  sync: ClockSync | null;
  onSynced: (c: ClockSync) => void;
}) {
  const [busy, setBusy] = useState(false);
  const canOperate = useCan("OPERATOR");

  const warning = Boolean(clock.message || sync?.refused);
  const correcting = sync !== null && Math.abs(sync.offsetMs) > 0;
  if (!warning && !correcting) return null;

  // Worth a button: "is my clock why nothing decodes" is asked at a moment, by someone
  // staring at an empty screen, and the next scheduled check may be an hour away.
  const syncNow = canOperate ? (
    <Button
      size="sm"
      variant={warning ? "secondary" : "ghost"}
      className="shrink-0"
      loading={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const r = await apiPost<{ clock?: ClockSync }>("/api/bridge/control", { action: "time/sync" });
          if (r?.clock) onSynced(r.clock);
        } catch {
          /* the banner keeps the last measurement, which is honest */
        } finally {
          setBusy(false);
        }
      }}
    >
      Sync now
    </Button>
  ) : null;

  if (!warning && sync) {
    return (
      <div role="status" className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-subtle">
        <ClockSyncLine sync={sync} />
        {syncNow}
      </div>
    );
  }

  return (
    <div
      role="status"
      className={cn(
        "mb-4 rounded-sm border px-3 py-2 text-sm flex items-start gap-3",
        clock.verdict === "bad" ? "border-danger/40 bg-danger/10 text-danger" : "border-warn/40 bg-warn/10 text-warn",
      )}
    >
      <div className="flex-1">
        {clock.message}
        {sync && (
          <div className={clock.message ? "mt-1.5 text-xs" : "text-xs"}>
            <ClockSyncLine sync={sync} />
          </div>
        )}
      </div>
      {syncNow}
    </div>
  );
}

/**
 * What SNTP said, as "behind" or "ahead of": a signed number read backwards sends an
 * operator adjusting the wrong way.
 */
function ClockSyncLine({ sync }: { sync: ClockSync }) {
  const measured = sync.measuredMs;
  if (measured === null) return <span>Clock not measured yet.</span>;

  const abs = Math.abs(measured);
  const magnitude = abs >= 1000 ? `${(abs / 1000).toFixed(2)} s` : `${Math.round(abs)} ms`;
  const direction = abs < 1 ? "exactly right" : `${magnitude} ${measured > 0 ? "behind" : "ahead of"} real time`;
  const applied = Math.abs(sync.offsetMs) > 0;

  return (
    <span>
      Clock is <span className="tnum font-medium">{direction}</span>
      {sync.source ? ` per ${sync.source}` : ""}
      {sync.delayMs !== null ? ` (${Math.round(sync.delayMs)} ms round trip)` : ""}.{" "}
      {applied
        ? `Compensating by ${sync.offsetMs} ms — transmit timing, decode windows and logged times all use the corrected clock.`
        : sync.refused
          ? sync.refused
          : "No correction needed."}
    </span>
  );
}
