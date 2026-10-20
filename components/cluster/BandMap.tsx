import { isChannelised, segmentLabel, segmentsIn, type SegmentMode } from "@/lib/ham/band-plan";
import { formatFreqMHz } from "@/lib/ham/bands";
import {
  bandMapLayout,
  bandMapRange,
  formatKhz,
  isNeeded,
  spotClock,
  tickStepHz,
  tuneTitle,
} from "@/lib/cluster/view";
import type { ClusterSpot } from "@/lib/cluster/types";
import { cn } from "@/lib/utils";

// One band, top to bottom: a frequency ruler, the US sub-bands shaded behind it, and every
// spot on the band labelled beside its frequency. Low frequency at the top, so the map reads
// down the page the way a frequency list does.

const BASE_HEIGHT = 560;
const LABEL_H = 24;
/** The ruler column, then the gap the leader lines cross. */
const RULER_W = 64;
const LEADER_W = 20;

/** The Panadapter's colours for the same three segments, fainter: here they sit behind text. */
const SEGMENT_BG: Record<SegmentMode, string> = {
  CW: "bg-warn/10",
  DATA: "bg-ok/10",
  PHONE: "bg-accent/10",
};
const SEGMENT_EDGE: Record<SegmentMode, string> = {
  CW: "bg-warn/50",
  DATA: "bg-ok/50",
  PHONE: "bg-accent/50",
};

function labelTone(s: ClusterSpot): string {
  if (s.needed?.entity) return "border-warn/60 bg-warn/15 text-warn";
  if (isNeeded(s)) return "border-info/40 bg-info/12 text-info";
  return "border-line bg-surface-2 text-fg";
}

/** Older spots fade: the band map is a picture of now. */
function ageOpacity(s: ClusterSpot, now: number): string {
  const min = (now - s.lastSeenAt) / 60_000;
  if (min < 5) return "opacity-100";
  if (min < 15) return "opacity-85";
  return "opacity-65";
}

export function BandMap({
  band,
  spots,
  dialHz,
  canTune,
  onTune,
  tuningId,
  now,
}: {
  band: string;
  spots: ClusterSpot[];
  dialHz: number | null;
  canTune: boolean;
  onTune: (s: ClusterSpot) => void;
  tuningId: string | null;
  now: number;
}) {
  const { lowHz, highHz, cropped } = bandMapRange(band, spots);
  const { height, placed } = bandMapLayout(spots, lowHz, highHz, BASE_HEIGHT, LABEL_H);
  const span = Math.max(1, highHz - lowHz);
  const y = (hz: number) => ((hz - lowHz) / span) * height;
  const byId = new Map(spots.map((s) => [s.id, s]));
  const newest = spots.reduce<ClusterSpot | null>(
    (best, s) => (best === null || s.receivedAt > best.receivedAt ? s : best),
    null,
  );

  const step = tickStepHz(span, height);
  const ticks: number[] = [];
  for (let hz = Math.ceil(lowHz / step) * step; hz <= highHz; hz += step) ticks.push(hz);
  const segments = segmentsIn(lowHz, highHz);
  const dialShown = dialHz !== null && dialHz >= lowHz && dialHz <= highHz;

  return (
    <div>
      <p className="mb-2 text-xs text-fg-subtle">
        {formatFreqMHz(lowHz)}–{formatFreqMHz(highHz)} MHz
        {cropped && " — the busy part of a wide band"}
        {isChannelised(lowHz) && " — 60 m is channels, so no sub-bands are shaded"}
        {segments.length > 0 && " · shading: US sub-bands"}
      </p>
      <div className="relative max-h-[70vh] overflow-y-auto rounded-sm border border-line bg-bg">
        <div className="relative" style={{ height }}>
          {segments.map((s) => (
            <div
              key={`${s.startHz}-${s.mode}`}
              className={cn("absolute inset-x-0", SEGMENT_BG[s.mode])}
              style={{ top: y(s.startHz), height: y(s.endHz) - y(s.startHz) }}
              title={`${segmentLabel(s)} — ${formatFreqMHz(s.startHz)} to ${formatFreqMHz(s.endHz)} MHz (US Part 97)`}
            >
              <div className={cn("absolute inset-y-0 w-1", SEGMENT_EDGE[s.mode])} style={{ left: RULER_W - 4 }} />
              {y(s.endHz) - y(s.startHz) > 28 && (
                <span className="absolute right-1 top-0.5 text-[10px] uppercase tracking-wide text-fg-subtle">
                  {segmentLabel(s)}
                </span>
              )}
            </div>
          ))}

          {ticks.map((hz) => (
            <div
              key={hz}
              className="absolute left-0 border-t border-line-strong/60"
              style={{ top: y(hz), width: RULER_W - 4 }}
            >
              <span className="absolute -top-2 left-1 bg-bg px-0.5 text-[10px] leading-none text-fg-muted tnum">
                {formatKhz(hz).replace(/\.0$/, "")}
              </span>
            </div>
          ))}

          {dialShown && (
            <div
              className="absolute inset-x-0 z-10 border-t-2 border-info pointer-events-none"
              style={{ top: y(dialHz) }}
            >
              <span className="absolute right-1 -top-4 text-[10px] font-medium uppercase tracking-wide text-info">
                radio {formatKhz(dialHz)}
              </span>
            </div>
          )}

          <svg
            className="absolute top-0 text-line-strong pointer-events-none"
            style={{ left: RULER_W }}
            width={LEADER_W}
            height={height}
            aria-hidden="true"
          >
            {placed.map((p) => (
              <line
                key={p.id}
                x1={0}
                y1={p.y}
                x2={LEADER_W}
                y2={p.labelY + LABEL_H / 2}
                stroke="currentColor"
                strokeWidth={1}
              />
            ))}
          </svg>

          {placed.map((p) => (
            <div
              key={`m-${p.id}`}
              className="absolute h-px bg-fg"
              style={{ top: p.y, left: RULER_W - 12, width: 12 }}
            />
          ))}

          {placed.map((p) => {
            const s = byId.get(p.id);
            if (!s) return null;
            const isNewest = newest?.id === s.id;
            const body = (
              <>
                <span className="font-display tracking-wide">{s.dx}</span>
                <span className="tnum text-[11px] opacity-80">{formatKhz(s.freqHz)}</span>
                {s.mode && (
                  <span className="text-[10px] uppercase tracking-wide opacity-80">
                    {s.mode}
                    {s.modeSource !== "comment" ? "?" : ""}
                  </span>
                )}
                {s.needed?.entity && s.entity && (
                  <span className="truncate text-[10px] font-semibold">{s.entity.name}</span>
                )}
                {isNewest && <span className="sr-only">(newest)</span>}
              </>
            );
            const cls = cn(
              "absolute right-1 flex items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-sm border px-1.5 text-left text-xs",
              labelTone(s),
              ageOpacity(s, now),
              isNewest && "ring-2 ring-fg/70 font-semibold",
              tuningId === s.id && "animate-pulse motion-reduce:animate-none",
            );
            const style = { top: p.labelY, height: LABEL_H - 2, left: RULER_W + LEADER_W };
            const detail =
              `${s.dx} — ${formatKhz(s.freqHz)} kHz` +
              (s.mode ? ` ${s.mode}${s.modeSource !== "comment" ? " (guessed from the frequency)" : ""}` : "") +
              (s.entity ? ` · ${s.entity.name}` : "") +
              ` · de ${s.spotter} ${spotClock(s.at)}` +
              (s.comment ? ` · ${s.comment}` : "");
            return canTune ? (
              <button
                key={p.id}
                type="button"
                className={cn(cls, "cursor-pointer hover:brightness-125")}
                style={style}
                onClick={() => onTune(s)}
                title={`${detail}\n${tuneTitle(s, true)}`}
                aria-label={`Tune to ${s.dx} on ${formatKhz(s.freqHz)} kilohertz`}
              >
                {body}
              </button>
            ) : (
              <div key={p.id} className={cls} style={style} title={`${detail}\n${tuneTitle(s, false)}`}>
                {body}
              </div>
            );
          })}

          {placed.length === 0 && (
            <p className="absolute inset-x-0 top-1/3 text-center text-sm text-fg-subtle">
              Nothing spotted on this band.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
