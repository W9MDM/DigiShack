import Link from "next/link";

import { Badge, Td, Th } from "@/components/ui/primitives";
import { colourFor } from "@/lib/ham/band-colours";
import { formatKhz, spotClock, tuneTitle } from "@/lib/cluster/view";
import type { ClusterSpot } from "@/lib/cluster/types";
import { cn } from "@/lib/utils";

// The live spot list. The frequency is the tune button, so the one action on a row is aimed
// at deliberately rather than taken by clicking anywhere on a busy table.

/** The same three chips the Digital page uses for the same three facts: gold for an entity, blue for a slot. */
function NeededChips({ s }: { s: ClusterSpot }) {
  if (!s.needed) return null;
  if (s.needed.entity) {
    return (
      <span className="rounded-sm border border-warn/60 bg-warn/15 px-1.5 py-0.5 text-xs font-semibold text-warn">
        NEW {s.entity?.name ?? "entity"}
      </span>
    );
  }
  return (
    <>
      {s.needed.band && (
        <span
          className="rounded-sm border border-info/40 bg-info/12 px-1 py-0.5 text-[11px] uppercase tracking-wide text-info"
          title={`${s.entity?.name ?? "This entity"} is not in the log on ${s.band}`}
        >
          new band
        </span>
      )}
      {s.needed.mode && (
        <span
          className="rounded-sm border border-info/40 bg-info/12 px-1 py-0.5 text-[11px] uppercase tracking-wide text-info"
          title={`${s.entity?.name ?? "This entity"} is not in the log in ${s.modeCategory?.toLowerCase() ?? "this mode"}`}
        >
          new mode
        </span>
      )}
    </>
  );
}

export function SpotTable({
  spots,
  canTune,
  onTune,
  tuningId,
  now,
}: {
  spots: ClusterSpot[];
  canTune: boolean;
  onTune: (s: ClusterSpot) => void;
  tuningId: string | null;
  now: number;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left">
            <Th size="sm">UTC</Th>
            <Th size="sm">kHz</Th>
            <Th size="sm">Call</Th>
            <Th size="sm" className="hidden sm:table-cell">
              Entity
            </Th>
            <Th size="sm">Mode</Th>
            <Th size="sm" className="hidden md:table-cell">
              Spotter
            </Th>
            <Th size="sm" className="hidden lg:table-cell">
              Comment
            </Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {spots.map((s) => {
            const fresh = now - s.receivedAt < 2 * 60_000;
            return (
              <tr key={s.id} className={cn("align-top hover:bg-surface-2", fresh && "bg-surface-2/50")}>
                <Td size="sm" className="whitespace-nowrap tnum text-fg-muted">
                  {spotClock(s.at)}
                  {s.count > 1 && (
                    <span
                      className="ml-1 text-xs text-fg-subtle"
                      title={`Spotted ${s.count} times in the last few minutes, most recently ${spotClock(s.lastSeenAt)}`}
                    >
                      ×{s.count}
                    </span>
                  )}
                </Td>
                <Td size="sm" className="whitespace-nowrap">
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      className="inline-block size-2 shrink-0 rounded-full"
                      style={{ backgroundColor: colourFor(s.band) }}
                      aria-hidden="true"
                    />
                    {canTune ? (
                      <button
                        type="button"
                        onClick={() => onTune(s)}
                        disabled={tuningId === s.id}
                        title={tuneTitle(s, true)}
                        className="tnum text-accent-bright underline-offset-2 hover:underline disabled:opacity-60"
                      >
                        {formatKhz(s.freqHz)}
                      </button>
                    ) : (
                      <span className="tnum" title={tuneTitle(s, false)}>
                        {formatKhz(s.freqHz)}
                      </span>
                    )}
                    <span className="text-xs text-fg-subtle">{s.band}</span>
                  </span>
                </Td>
                <Td size="sm">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Link
                      href={`/qsos?q=${encodeURIComponent(s.dx)}`}
                      className="font-display tracking-wide hover:text-accent-bright"
                      title={`${s.dx} in the log`}
                    >
                      {s.dx}
                    </Link>
                    <NeededChips s={s} />
                  </div>
                  {/* The entity column is gone below sm; the name still matters there. */}
                  {s.entity && <div className="text-xs text-fg-subtle sm:hidden">{s.entity.name}</div>}
                </Td>
                <Td size="sm" className="hidden sm:table-cell">
                  {s.entity ? (
                    <>
                      {s.entity.name}
                      {s.entity.continent && (
                        <span className="ml-1 text-xs text-fg-subtle">{s.entity.continent}</span>
                      )}
                    </>
                  ) : (
                    <span className="text-fg-subtle">—</span>
                  )}
                </Td>
                <Td size="sm" className="whitespace-nowrap">
                  {s.mode ? (
                    <span
                      title={
                        s.modeSource === "comment"
                          ? "The spot says so"
                          : "Guessed from where it sits in the band — the spot does not say"
                      }
                    >
                      <Badge size="sm">
                        {s.mode}
                        {s.modeSource !== "comment" ? "?" : ""}
                      </Badge>
                    </span>
                  ) : (
                    <span className="text-fg-subtle" title="Nothing in the spot or the band plan says">
                      —
                    </span>
                  )}
                </Td>
                <Td size="sm" className="hidden whitespace-nowrap md:table-cell">
                  <span className="text-fg-muted">{s.spotter}</span>
                  {s.skimmer && (
                    <span className="ml-1" title="A Reverse Beacon Network skimmer, not a person">
                      <Badge size="sm" tone="info">
                        RBN
                      </Badge>
                    </span>
                  )}
                  {s.snrDb !== null && <span className="ml-1 text-xs text-fg-subtle tnum">{s.snrDb} dB</span>}
                </Td>
                <Td size="sm" className="hidden max-w-[18rem] truncate text-fg-muted lg:table-cell" title={s.comment}>
                  {s.comment || <span className="text-fg-subtle">—</span>}
                </Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
