import { createContext, useContext } from "react";

import { useApi } from "@/lib/client/api";

/** The station whose accounts the settings page is editing; null is the home station. */
export const StationAccountContext = createContext<string | null>(null);

/** `?stationId=…` for an account endpoint, or "" for the home station. */
export function useStationQuery(): string {
  const id = useContext(StationAccountContext);
  return id ? `?stationId=${encodeURIComponent(id)}` : "";
}

type ActiveView = { activeId: string | null; stations: { id: string; callsign: string; grid: string }[] };

/**
 * "Accounts for: K9XYZ / K9PC" above the Logbook sync settings.
 *
 * Each station has its own QRZ logbook key, LoTW account and location, eQSL, Club Log and
 * Cloudlog - a K9PC contact is uploaded with K9PC's, never K9XYZ's. Hidden on a
 * single-station install, where there is only one set and nothing to choose.
 */
export function StationAccountPicker({ value, onChange }: { value: string | null; onChange: (id: string | null) => void }) {
  const { data } = useApi<ActiveView>("/api/station/active");
  if (!data || data.stations.length < 2) return null;
  const home = data.stations[0];
  const current = value ?? home?.id ?? "";
  return (
    <div className="mb-4 rounded-md border border-line bg-surface-2 p-3 text-sm">
      <label className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Accounts for station</span>
        <select
          value={current}
          onChange={(e) => onChange(e.target.value === home?.id ? null : e.target.value)}
          className="rounded-sm border border-line bg-surface px-2 py-1 font-display tracking-wide"
        >
          {data.stations.map((s) => (
            <option key={s.id} value={s.id}>
              {s.callsign} {s.grid}
              {s.id === data.activeId ? " (on the air)" : ""}
            </option>
          ))}
        </select>
      </label>
      <p className="mt-1 text-xs text-fg-muted">
        QRZ, LoTW, eQSL, Club Log and Cloudlog below belong to this station. Its contacts upload with these and
        nothing else; a station with an account left blank does not upload there.
      </p>
    </div>
  );
}
