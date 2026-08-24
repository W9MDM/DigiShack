import { useEffect, useState } from "react";

import { HelpTip } from "@/components/ui/HelpTip";
import type { JobHost } from "@/lib/schedule/jobs";

// The crontab: everything that runs on a timer, and how often it really runs.
//
// Asked for as "a crontab showing all the schedules". The reason the question came up is that
// there was no answer to it — a dozen timers, each configured from a setting a few hundred
// lines from the last, several with a floor that silently overrode what was typed.
//
// The EFFECTIVE interval is what is shown, not the setting. An operator who put 5 in the LoTW
// interval has 15, because the code clamps it, and until now nothing said so — the reasonable
// conclusion from the outside is that the setting does nothing.

interface Row {
  id: string;
  label: string;
  what: string;
  host: JobHost;
  enabled: boolean;
  effectiveMs: number;
  configured: number | null;
  clampedFrom: number | null;
  cron: string;
  unit?: "minutes" | "hours";
  intervalSetting?: string;
  enabledSetting?: string;
  fixedReason?: string;
  firstRunDelayMs?: number;
}

function every(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)} sec`;
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} min`;
  const h = m / 60;
  return Number.isInteger(h) ? `${h} hr` : `${Math.floor(h)} hr ${m % 60} min`;
}

export function Schedules() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    void fetch("/api/schedules")
      .then(async (r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        const body = (await r.json()) as { jobs: Row[] };
        setRows(body.jobs);
      })
      .catch(() => setProblem("Could not read the schedules"));
  }, []);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="text-xs uppercase tracking-wide text-fg-subtle">
          Scheduled jobs
        </span>
        <HelpTip label="About the schedules">
          Everything DigiShack runs on a timer. The interval shown is the one actually used,
          which is not always the one in the setting: several jobs apply a minimum, and where
          that has overridden your value it is called out on the row.
          <br />
          <br />
          The cron column is approximate on purpose. Cron cannot express &quot;every 90
          minutes&quot; or anything under a minute, so intervals it cannot state are written
          out in words rather than as an expression that would look authoritative and be
          wrong.
          <br />
          <br />
          Most of these run in the <strong>bridge</strong>, so changing one of their settings
          needs the bridge restarted before it takes effect — the interval is read once when
          the timer is created.
        </HelpTip>
      </div>

      {problem ? <p className="text-sm text-danger">{problem}</p> : null}
      {rows === null && !problem ? (
        <p className="text-sm text-fg-subtle">Reading…</p>
      ) : null}

      {rows ? (
        <div className="overflow-x-auto border border-line rounded-md bg-surface">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-surface-2 text-left">
                {["Job", "Cron", "Every", "Setting", ""].map((h) => (
                  <th
                    key={h}
                    className="px-3 py-2 font-medium text-fg-muted text-xs uppercase tracking-wide whitespace-nowrap"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((j) => (
                <tr key={j.id} className={j.enabled ? "" : "opacity-55"}>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{j.label}</span>
                      {!j.enabled ? (
                        <span className="text-xs text-fg-subtle">(off)</span>
                      ) : null}
                    </div>
                    <div className="text-xs text-fg-subtle">{j.what}</div>
                    {j.clampedFrom !== null ? (
                      // The reason this column exists at all.
                      <div className="text-xs text-warn">
                        Set to {j.clampedFrom} {j.unit ?? "minutes"}, but the minimum is{" "}
                        {Math.round(j.effectiveMs / (j.unit === "hours" ? 3_600_000 : 60_000))} —
                        the lower value is ignored.
                      </div>
                    ) : null}
                    {j.fixedReason ? (
                      <div className="text-xs text-fg-subtle italic">{j.fixedReason}</div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs whitespace-nowrap text-fg-muted">
                    {j.enabled ? j.cron : "—"}
                  </td>
                  <td className="px-3 py-2 tnum whitespace-nowrap text-fg-muted">
                    {j.enabled ? every(j.effectiveMs) : "—"}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-fg-subtle">
                    {j.intervalSetting ?? <span className="italic">not adjustable</span>}
                    {j.enabledSetting ? (
                      <div className="text-fg-subtle/70">{j.enabledSetting}</div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-xs text-fg-subtle whitespace-nowrap">
                    {j.host === "bridge" ? "bridge" : "web"}
                    {j.firstRunDelayMs ? (
                      <div>first run +{Math.round(j.firstRunDelayMs / 1000)}s</div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
