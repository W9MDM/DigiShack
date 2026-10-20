import Link from "next/link";
import { useEffect, useState } from "react";

import { HelpTip } from "@/components/ui/HelpTip";
import { Td, Th } from "@/components/ui/primitives";
import type { JobHost } from "@/lib/schedule/jobs";
import { settingsHref } from "@/lib/settings/tabs";
import { cn } from "@/lib/utils";

/** A cell's padding moves to its row on a phone, where the cells sit in a line; sm restores Td's `lg`. */
const PHONE_FLAT = "p-0 sm:px-3 sm:py-2";

/** A setting key, as a jump to the setting itself. */
function KeyLink({ k }: { k: string }) {
  return (
    <Link href={settingsHref({ setting: k })} replace shallow scroll={false} className="hover:text-accent-bright hover:underline">
      {k}
    </Link>
  );
}

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

      {/* Five columns do not fit a phone: the job's description wrapped to a word a line
          and Every, Setting and the host were off the right edge behind a scrollbar. So
          below sm each row is a block — the job, then how often, the cron and where it
          runs on one line, then the setting — and from sm up it is the table again. The
          same cells either way, so there is one markup to keep right; `order` only moves
          the interval ahead of the cron on the phone, and means nothing to a table cell.
          The scroll container stays for the sm-to-lg widths where the table is back. */}
      {rows ? (
        <div className="overflow-x-auto border border-line rounded-md bg-surface">
          <table className="block w-full text-sm border-collapse sm:table">
            <thead className="hidden sm:table-header-group">
              <tr className="bg-surface-2 text-left">
                {["Job", "Cron", "Every", "Setting", ""].map((h) => (
                  <Th key={h} size="lg" className="whitespace-nowrap">
                    {h}
                  </Th>
                ))}
              </tr>
            </thead>
            <tbody className="block divide-y divide-line sm:table-row-group">
              {rows.map((j) => (
                <tr
                  key={j.id}
                  className={cn(
                    "flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2.5 sm:table-row sm:p-0",
                    !j.enabled && "opacity-55",
                  )}
                >
                  <Td size="lg" className={cn(PHONE_FLAT, "basis-full")}>
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
                  </Td>
                  <Td
                    size="lg"
                    className={cn(
                      PHONE_FLAT,
                      "order-2 font-mono text-xs whitespace-nowrap text-fg-muted",
                      // On the phone's one line a cron cell in words ("every 30s") only
                      // repeats the interval beside it, and an off job's is a second "—".
                      (!j.enabled || j.cron.startsWith("every")) && "hidden sm:table-cell",
                    )}
                  >
                    {j.enabled ? j.cron : "—"}
                  </Td>
                  <Td size="lg" className={cn(PHONE_FLAT, "order-1 tnum whitespace-nowrap text-fg-muted")}>
                    {/* Without the column header a bare "10 min" is ambiguous. */}
                    {j.enabled && <span className="sm:hidden">every </span>}
                    {j.enabled ? every(j.effectiveMs) : "—"}
                  </Td>
                  <Td size="lg" className={cn(PHONE_FLAT, "order-4 basis-full break-all font-mono text-xs text-fg-subtle sm:break-normal")}>
                    {j.intervalSetting ? <KeyLink k={j.intervalSetting} /> : <span className="italic">not adjustable</span>}
                    {j.enabledSetting ? (
                      <div className="text-fg-subtle/70"><KeyLink k={j.enabledSetting} /></div>
                    ) : null}
                  </Td>
                  <Td size="lg" className={cn(PHONE_FLAT, "order-3 text-xs text-fg-subtle whitespace-nowrap")}>
                    {j.host === "bridge" ? "bridge" : "web"}
                    {j.firstRunDelayMs ? (
                      <div>first run +{Math.round(j.firstRunDelayMs / 1000)}s</div>
                    ) : null}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
