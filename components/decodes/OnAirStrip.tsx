// What is on the air right now: this cycle's decode count, how fresh the list is, the
// day's contacts, the recent cycles, where we are in the cycle — and, on the right, the
// band and mode the radio is on, and the automatic mode with its HALT TX. One bar.

import type { ReactNode } from "react";

import { Readout } from "@/components/decodes/controls";
import { formatUtcTime } from "@/lib/time";

export function OnAirStrip({
  slotted,
  decodingAs,
  periodMs,
  cyclePct,
  latestCycleCount,
  staleSeconds,
  qsosToday,
  recentCycles,
  picker,
  operate,
}: {
  /** Modes with cycles and a decode list. The text and picture modes have neither. */
  slotted: boolean;
  decodingAs: string;
  periodMs: number;
  /** Position in the current cycle, 0-100. */
  cyclePct: number;
  latestCycleCount: number;
  staleSeconds: number | null;
  qsosToday: number | null;
  recentCycles: { at: number; count: number }[];
  /** The band and mode controls. */
  picker: ReactNode;
  /** The automatic mode, its status and HALT TX. */
  operate?: ReactNode;
}) {
  // Scaled to its own peak; an absolute scale flattens a quiet band into nothing.
  const peak = Math.max(1, ...recentCycles.map((c) => c.count));

  return (
    <div className="mb-4 rounded-md border border-line bg-surface shadow-panel">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-3 py-2">
        <dl className="flex flex-wrap items-end gap-x-5 gap-y-2">
          {slotted && (
            <>
              {/* The number to watch: the cycle just finished says whether the band is open
                  now, which a running total cannot. */}
              <Readout label="This cycle" valueClassName="text-accent-bright">
                {latestCycleCount}
              </Readout>
              <Readout label="Last decode">{staleSeconds === null ? "—" : `${staleSeconds}s`}</Readout>
            </>
          )}
          {/* Contacts, not decodes: the one figure that says whether the evening is working.
              From 00:00 UTC, the day the log runs on. */}
          <Readout
            label="QSOs today"
            title="Contacts logged since 00:00 UTC"
            valueClassName={(qsosToday ?? 0) > 0 ? "text-ok" : "text-fg-muted"}
          >
            {qsosToday ?? "—"}
          </Readout>
          {slotted && recentCycles.length > 1 && (
            <div className="hidden sm:block">
              <dt className="text-xs text-fg-muted">Recent cycles</dt>
              <dd className="flex items-end gap-1 h-5">
                {/* Oldest first, so it reads left to right in time. */}
                {recentCycles
                  .slice()
                  .reverse()
                  .map((c) => (
                    <span
                      key={c.at}
                      className="block w-2 bg-accent/50 rounded-sm"
                      style={{ height: `${Math.max(3, (c.count / peak) * 20)}px` }}
                      title={`${c.count} decode${c.count === 1 ? "" : "s"} at ${formatUtcTime(c.at)}`}
                    />
                  ))}
              </dd>
            </div>
          )}
        </dl>
        {picker}
        {operate && <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">{operate}</div>}
      </div>

      {/* Where we are in the cycle: FT8 transmits for 12.6 s of every 15, so this says
          whether decodes are about to land. */}
      {slotted && (
        <div className="flex items-center gap-2 px-3 pb-2">
          <div className="h-1 flex-1 bg-surface-2 rounded-sm overflow-hidden" aria-hidden="true">
            <div
              className="h-full bg-accent/60 transition-[width] duration-1000 ease-linear"
              style={{ width: `${cyclePct}%` }}
            />
          </div>
          <span className="shrink-0 text-xs text-fg-subtle tnum">
            {decodingAs} · {(periodMs / 1000).toFixed(1)} s
          </span>
        </div>
      )}
    </div>
  );
}
