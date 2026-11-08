// RSID on the keyboard modes' panels: the last mode identifier heard, and the two
// switches - what to do when one is heard, and whether to send one before each line.
// See lib/digital/rsid.ts.

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/primitives";

export interface RsidStatus {
  receive: "switch" | "notify" | "off";
  transmit: boolean;
  last: { name: string; hz: number; at: number; supported: boolean; switched: boolean } | null;
}

/** fldigi's names, as an operator reads them: OLIVIA-8-250 is Olivia 8/250. */
export function rsidLabel(name: string): string {
  const m = /^(OLIVIA|CONTESTIA)-(\d+)-(\d+)$/.exec(name);
  if (m) return `${m[1] === "OLIVIA" ? "Olivia" : "Contestia"} ${m[2]}/${m[3]}`;
  const names: Record<string, string> = {
    BPSK31: "PSK31",
    BPSK63: "PSK63",
    BPSK125: "PSK125",
    "FELD-HELL": "Feld Hell",
    "FM-HELL-105": "FM Hell-105",
    "FM-HELL-245": "FM Hell-245",
    "HELL-80": "Hell 80",
    "RTTY-45": "RTTY 45",
    "RTTY-50": "RTTY 50",
    "RTTY-75": "RTTY 75",
  };
  return names[name] ?? name;
}

function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

export function RsidBar({
  rsid,
  canSwitch,
  onSet,
}: {
  rsid: RsidStatus | null | undefined;
  canSwitch: boolean;
  onSet: (patch: { receive?: RsidStatus["receive"]; transmit?: boolean; apply?: true }) => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);
  if (!rsid) return null;
  const last = rsid.last;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-muted">
      <span title="RSID: the burst fldigi sends before a transmission to name its mode and mark its frequency">
        RSID{" "}
        {last ? (
          <>
            heard <span className="text-fg">{rsidLabel(last.name)}</span> at <span className="tnum text-fg">{Math.round(last.hz)}</span> Hz,{" "}
            {ago(last.at, now)}
            {last.switched
              ? " · switched to it"
              : !last.supported
                ? " · not a mode DigiShack has yet"
                : canSwitch && (
                    <>
                      {" · "}
                      <Button variant="link" className="tap-inline" onClick={() => onSet({ apply: true })}>
                        Switch to it
                      </Button>
                    </>
                  )}
          </>
        ) : rsid.receive === "off" ? (
          "not listened for"
        ) : (
          "none heard yet"
        )}
      </span>
      {canSwitch && (
        <>
          <label className="flex items-center gap-1">
            When heard
            <select
              className="rounded-sm border border-line bg-bg px-1 py-0.5 text-fg"
              value={rsid.receive}
              onChange={(e) => onSet({ receive: e.target.value as RsidStatus["receive"] })}
            >
              <option value="switch">switch to it</option>
              <option value="notify">just show it</option>
              <option value="off">ignore</option>
            </select>
          </label>
          <label className="flex items-center gap-1" title="fldigi stations with RxID on switch to your mode and frequency by themselves. Adds 2.3 s to each line.">
            <input type="checkbox" checked={rsid.transmit} onChange={(e) => onSet({ transmit: e.target.checked })} />
            Send RSID before each line
          </label>
        </>
      )}
    </div>
  );
}
