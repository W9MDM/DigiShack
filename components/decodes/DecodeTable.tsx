// The decode list itself.
//
// Memoised: the page re-renders every second for its cycle bar, and nothing in a row
// depends on the clock, so up to 500 rows no longer re-render with it. Every prop here is
// state, a memo or a stable callback for that reason — pass primitives, not `status`.
//
// The text size is set on the <table> and everything inside is sized in `em`, so the size
// control moves the header, the rows, the chips and the Call button together.

import { memo } from "react";

import { CallChip } from "@/components/decodes/controls";
import type { DecodeEvent } from "@/components/decodes/types";
import { Td, Th } from "@/components/ui/primitives";
import type { Score } from "@/lib/contest/ft8battle";
import { parseMessage } from "@/lib/digital/qso";
import { formatDistance, gridDistanceKm, type DistanceUnit } from "@/lib/ham/grid-geometry";
import { formatUtcTime } from "@/lib/time";
import { cn } from "@/lib/utils";

/**
 * How loudly a "worth working" reason is said. They were all one green 10px chip — the
 * same as "worked already" — so a new DXCC looked exactly like a station to skip.
 *
 *   entity  gold, full row   a new DXCC or continent: unmissable on purpose
 *   award   blue             a real slot: park, state, zone, entity-on-this-band
 *   minor   grey             a new grid
 *
 * "never worked" is not drawn at all: it fires on most rows of a busy band, so the
 * exception (the `worked` chip) is marked instead. Gold because green already means CQ
 * and accent-bright means "this names me".
 */
type WorthTier = "entity" | "award" | "minor";

const WORTH_RANK: Record<WorthTier, number> = { minor: 0, award: 1, entity: 2 };

/**
 * The tier of a reason string, matched against the literals lib/digital/worth.ts builds.
 * A deliberate coupling — a second scoring model on the client is how the badges and Auto
 * Hunt's choices come to disagree — and scripts/check-worth.ts pins every literal.
 */
function worthTier(reason: string): WorthTier {
  if (reason.startsWith("NEW DXCC:") || reason.startsWith("new continent ")) return "entity";
  // A grid band-slot (3 points) and an entity band-slot (30) share a suffix; worth.ts
  // upper-cases the grid, so AA00 is always a grid.
  if (/^[A-R]{2}\d{2} new on this band$/.test(reason)) return "minor";
  if (/ new on this band$/.test(reason)) return "award";
  if (/^new (park|state|CQ zone) /.test(reason)) return "award";
  if (reason === "POTA activator") return "award";
  return "minor";
}

const WORTH_CHIP: Record<WorthTier, string> = {
  // The entity NAME is the payload, so it keeps its own capitalisation at full size.
  entity: "rounded-sm border border-warn/60 bg-warn/15 px-1.5 py-0.5 font-semibold text-warn align-middle",
  award:
    "rounded-sm border border-info/40 bg-info/12 px-1 py-0.5 text-[0.85em] uppercase tracking-wide text-info align-middle",
  minor:
    "rounded-sm border border-line-strong bg-surface-2 px-1 py-0.5 text-[0.85em] uppercase tracking-wide text-fg-muted align-middle",
};

/** Up to three reasons on the row: `title` never fires on touch, so hidden ones did not exist. */
const MAX_REASONS_SHOWN = 3;

/** Looser on a phone, where the row is the tap target; tighter on a desk, for more rows. */
const CELL = "px-2.5 py-1.5 lg:py-0.5";

function gridOf(message: string): string | null {
  const p = parseMessage(message);
  return p.kind === "cq" ? p.grid : p.kind === "directed" && p.payload.type === "grid" ? p.payload.grid : null;
}

export interface DecodeTableProps {
  rows: DecodeEvent[];
  fontPx: number;
  brMode: boolean;
  brScores: Map<string, Score>;
  worth: Map<string, string[]>;
  /** Worked on this band and mode inside the dupe window, per the server. */
  workedDupe: Set<string>;
  /** Logged this session. */
  workedNow: Set<string>;
  /** The station being worked right now, if any. */
  activeCall: string | null;
  mentionsMe: (message: string) => boolean;
  myGrid: string | null;
  unit: DistanceUnit;
  /** False on WSPR, which is receive-only: no Call button and nothing to select. */
  callable: boolean;
  /** JS8 picks a station into the message line rather than starting a sequenced call. */
  js8: boolean;
  onSelect: (d: DecodeEvent) => void;
  onCall: (d: DecodeEvent) => void;
}

export const DecodeTable = memo(function DecodeTable({
  rows,
  fontPx,
  brMode,
  brScores,
  worth,
  workedDupe,
  workedNow,
  activeCall,
  mentionsMe,
  myGrid,
  unit,
  callable,
  js8,
  onSelect,
  onCall,
}: DecodeTableProps) {
  const headers: { label: string; numeric?: boolean }[] = [
    { label: "UTC" },
    ...(brMode ? [{ label: "Pts", numeric: true }] : []),
    { label: "dB", numeric: true },
    { label: "Hz", numeric: true },
    { label: "dt", numeric: true },
    { label: "Mode" },
    { label: "Message" },
  ];

  return (
    // Below `lg` there is no inner scroller: a scroller inside a scrolling page traps
    // touches on iOS. `overflow-x-auto` stays at every width (scripts/check-pwa.ts).
    <div className="-mx-4 overflow-x-auto lg:overflow-auto lg:max-h-[52rem]">
      <table className="w-full border-collapse" style={{ fontSize: `${fontPx}px` }}>
        {/* Sticky only where there is an inner scroller to stick to. */}
        <thead className="bg-surface-2 lg:sticky lg:top-0">
          <tr className="text-left">
            {headers.map((h) => (
              <Th key={h.label} size="sm" className={cn("px-2.5 py-1", h.numeric && "text-right")}>
                {h.label}
              </Th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line font-mono">
          {rows.map((d) => {
            const call = d.callsign?.toUpperCase() ?? null;
            const isCq = /^CQ\b/i.test(d.message);
            const mine = mentionsMe(d.message);
            const theirGrid = gridOf(d.message);
            const distKm = gridDistanceKm(myGrid, theirGrid);
            const done = call !== null && workedNow.has(call);
            const dupe = call !== null && workedDupe.has(call);
            const reasons = (d.callsign ? (worth.get(d.callsign) ?? []) : []).filter((r) => r !== "never worked");
            // What the ROW may shout. Not once logged this session: a gold NEW DXCC on a
            // finished contact is the "done or not?" confusion the dimming removes.
            const tier: WorthTier | null =
              done || reasons.length === 0
                ? null
                : reasons
                    .map(worthTier)
                    .reduce((best, t) => (WORTH_RANK[t] > WORTH_RANK[best] ? t : best), "minor" as WorthTier);
            const selectable = callable && d.callsign !== null;
            const score = brMode && call ? brScores.get(call) : undefined;

            return (
              <tr
                key={`${d.timestamp}-${d.freqOffset}-${d.message}`}
                onClick={selectable ? () => onSelect(d) : undefined}
                title={
                  !d.callsign
                    ? "No callsign in this message"
                    : !callable
                      ? undefined
                      : js8
                        ? `Start a message to ${d.callsign}`
                        : `Select ${d.callsign} — the Call button transmits straight away`
                }
                className={cn(
                  "hover:bg-surface-2",
                  selectable && "cursor-pointer",
                  tier === "entity" && "bg-warn/10",
                  // A message naming us is about to be a QSO, which outranks a rare one.
                  mine && "bg-accent/10",
                  // After `mine`, so the tail of our own finished exchange reads as finished.
                  done && "opacity-55",
                  activeCall !== null && d.callsign === activeCall && "bg-ok/10 opacity-100",
                )}
              >
                {/* The award tier on the left edge. Every row carries the border so columns
                    cannot shift by 2px, and it sits on a cell because a row border under
                    border-collapse loses to the cell borders. */}
                <Td
                  size="sm"
                  className={cn(
                    CELL,
                    "tnum text-fg-subtle whitespace-nowrap border-l-2",
                    tier === "entity" ? "border-l-warn" : tier === "award" ? "border-l-info/60" : "border-l-transparent",
                  )}
                >
                  {formatUtcTime(d.timestamp)}
                </Td>
                {brMode && (
                  <Td
                    size="sm"
                    className={cn(
                      CELL,
                      "tnum text-right whitespace-nowrap",
                      !score
                        ? "text-fg-subtle"
                        : score.penalty < 0
                          ? "text-danger font-semibold"
                          : score.steal
                            ? "text-warn font-semibold"
                            : score.max >= 12
                              ? "text-ok font-semibold"
                              : "text-fg-muted",
                    )}
                    title={score?.reasons.join(" · ") || undefined}
                  >
                    {!score
                      ? "—"
                      : score.penalty < 0
                        ? score.penalty
                        : (score.steal ? "🔥 " : "") +
                          (score.min === score.max ? String(score.min) : `${score.min}–${score.max}`)}
                  </Td>
                )}
                <Td
                  size="sm"
                  className={cn(
                    CELL,
                    "tnum text-right whitespace-nowrap",
                    d.snr >= 0 ? "text-ok" : d.snr > -15 ? "text-fg" : "text-fg-subtle",
                  )}
                >
                  {d.snr > 0 ? `+${d.snr}` : d.snr}
                </Td>
                <Td size="sm" className={cn(CELL, "tnum text-right text-fg-muted")}>
                  {d.freqOffset}
                </Td>
                <Td size="sm" className={cn(CELL, "tnum text-right text-fg-subtle")}>
                  {d.deltaTime.toFixed(1)}
                </Td>
                <Td size="sm" className={cn(CELL, "text-fg-subtle")}>
                  {d.mode}
                </Td>
                <Td size="sm" className={CELL}>
                  <span className={cn(mine && "text-accent-bright font-semibold", isCq && !mine && "text-ok")}>
                    {d.message}
                  </span>
                  {d.lowConfidence && <span className="ml-2 text-fg-subtle">(low conf)</span>}
                  {distKm !== null && (
                    <span
                      className="ml-2 text-[0.85em] tnum text-fg-subtle align-middle"
                      title={`${theirGrid} — great-circle distance from your grid`}
                    >
                      {formatDistance(distKm, unit)}
                    </span>
                  )}
                  {reasons.slice(0, MAX_REASONS_SHOWN).map((r) => (
                    <span key={r} className={cn("ml-2", WORTH_CHIP[worthTier(r)])} title={reasons.join(" · ")}>
                      {r}
                    </span>
                  ))}
                  {reasons.length > MAX_REASONS_SHOWN && (
                    <span className="ml-1 align-middle text-[0.85em] text-fg-subtle" title={reasons.join(" · ")}>
                      +{reasons.length - MAX_REASONS_SHOWN}
                    </span>
                  )}
                  {/* Named, not only dimmed, and warm rather than grey: a grey chip on grey
                      was legible and still never noticed. */}
                  {(done || dupe) && (
                    <span
                      className="ml-2 rounded-sm border border-warn/35 bg-warn/10 px-1 py-0.5 text-[0.85em] uppercase tracking-wide text-warn/80 align-middle"
                      title={
                        done
                          ? "Contact completed and logged this session."
                          : "Already worked on this band and mode today — the automatic modes will not call them again."
                      }
                    >
                      worked
                    </span>
                  )}
                  {/* The primary action of the application. stopPropagation, or the row's own
                      click runs too. */}
                  {d.callsign && callable && (
                    <CallChip
                      className="ml-2"
                      title={
                        js8
                          ? `Start a message to ${d.callsign}: the JS8 line fills with the callsign, ready for SNR?, GRID?, INFO? or text`
                          : `Call ${d.callsign} now. Click the row instead to select without transmitting.`
                      }
                      onClick={(e) => {
                        e.stopPropagation();
                        onCall(d);
                      }}
                    >
                      Call
                    </CallChip>
                  )}
                </Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
});
