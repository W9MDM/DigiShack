import { useState } from "react";

import { apiPost, useApi } from "@/lib/client/api";
import { useCan, useUser } from "@/lib/client/session";

type ActiveView = { activeId: string | null; stations: { id: string; callsign: string; grid: string }[] };

/**
 * "Operating as" - which station the radio is on the air as, beside the logo.
 *
 * Shown only when the install has more than one station, so a single-station header is
 * unchanged. Switching goes through the bridge, which refuses while transmitting, stops any
 * automatic mode and rebuilds the radio connection under the new callsign; the uploads that
 * follow use that station's own accounts. Viewers see the station but cannot change it.
 */
export function StationSwitcher() {
  const user = useUser();
  const canSwitch = useCan("OPERATOR");
  const { data, reload } = useApi<ActiveView>(user ? "/api/station/active" : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!data || data.stations.length < 2) return null;
  const active = data.stations.find((s) => s.id === data.activeId);

  async function pick(stationId: string) {
    if (stationId === data?.activeId) return;
    const to = data?.stations.find((s) => s.id === stationId);
    if (!window.confirm(`Operate as ${to?.callsign}? Any automatic mode stops, and contacts from now on are logged and uploaded as ${to?.callsign}.`)) return;
    setBusy(true);
    setError(null);
    try {
      await apiPost("/api/bridge/control", { action: "station", stationId });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not switch");
    } finally {
      setBusy(false);
      void reload();
    }
  }

  return (
    <span className="hidden md:inline-flex items-center gap-1.5 text-xs" title={error ?? "The station the radio is operating as"}>
      <span className="text-fg-muted">as</span>
      {canSwitch ? (
        <select
          aria-label="Operating as"
          value={data.activeId ?? ""}
          disabled={busy}
          onChange={(e) => void pick(e.target.value)}
          className={`rounded-sm border bg-surface px-1.5 py-0.5 font-display tracking-wide ${error ? "border-danger" : "border-line"}`}
        >
          {data.stations.map((s) => (
            <option key={s.id} value={s.id}>
              {s.callsign} {s.grid}
            </option>
          ))}
        </select>
      ) : (
        <span className="font-display tracking-wide">{active?.callsign ?? "?"}</span>
      )}
    </span>
  );
}
