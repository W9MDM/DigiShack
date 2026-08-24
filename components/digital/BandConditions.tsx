import { useEffect } from "react";

import { useApi } from "@/lib/client/api";
import { formatMinutesAgo } from "@/lib/time";
import { cn } from "@/lib/utils";

/**
 * Band conditions from three independent angles, kept visibly separate.
 *
 *   SEEN    how many stations the PSKReporter network is hearing on each band right
 *           now, in the mode we are running. This is the "how busy is 20 m" answer.
 *   HEARD   what THIS receiver decoded. Only ever one band at a time, but it is
 *           ground truth for our own antenna, and needs no network.
 *   EST     a coarse usability guess from solar flux and local time, for the bands
 *           nobody is watching.
 *
 * Not blended into one score on purpose. They answer different questions with wildly
 * different confidence, and a single number would hide which one produced it. A
 * measurement always beats an estimate, so where a real figure exists it is the one
 * shown large.
 */
interface BandRow {
  band: string;
  current: boolean;
  heard: { stations: number; decodes: number; minutesAgo: number | null; state: string } | null;
  psk: {
    transmitting: number;
    receivers: number;
    entities: number;
    bestSnr: number | null;
    heardUsBy: number;
  } | null;
  usable: "good" | "fair" | "poor" | "unknown";
}

interface Report {
  bands: BandRow[];
  current: string | null;
  mode: string;
  solar: {
    sfi: number | null;
    ssn: number | null;
    kp: number | null;
    aIndex: number | null;
    sources: string[];
  } | null;
  pskWindowMinutes: number;
}

/** Colour AND a letter, so nothing depends on hue alone. */
const USABLE: Record<BandRow["usable"], { bar: string; text: string; letter: string }> = {
  good: { bar: "bg-ok", text: "text-ok", letter: "G" },
  fair: { bar: "bg-warn", text: "text-warn", letter: "F" },
  poor: { bar: "bg-danger/70", text: "text-danger", letter: "P" },
  unknown: { bar: "bg-fg-subtle/30", text: "text-fg-subtle", letter: "?" },
};


export function BandConditions({
  currentBand,
  mode,
}: {
  currentBand: string | null;
  mode: string | null;
}) {
  const q = new URLSearchParams();
  if (currentBand) q.set("current", currentBand);
  if (mode && /^FT[0248]$/i.test(mode)) q.set("mode", mode);

  const { data, reload } = useApi<Report>(`/api/stats/bands?${q.toString()}`);

  // Refresh on a timer: this strip is the answer to "where should I be right now",
  // and it used to be fetched once when the page mounted. A station left running
  // overnight was reading band conditions from whenever the tab was opened.
  //
  // Two minutes against server-side caches of five (PSKReporter) and longer (solar),
  // so most of these cost a database query for our own decode counts and nothing
  // over the network. See lib/propagation — the fetcher will not query PSKReporter
  // more often than its own interval no matter how often it is asked.
  useEffect(() => {
    const id = setInterval(() => void reload(), 120_000);
    return () => clearInterval(id);
  }, [reload]);

  if (!data) return null;

  // Only bands worth a tile: seen on the network, heard here, or the one we are on.
  const shown = data.bands
    .filter((b) => b.current || (b.psk?.transmitting ?? 0) > 0 || (b.heard?.stations ?? 0) > 0)
    .slice(0, 10);
  if (shown.length === 0) return null;

  const busiest = Math.max(...shown.map((b) => b.psk?.transmitting ?? 0), 1);
  const s = data.solar;

  return (
    <div className="flex items-center gap-2 min-w-0">
      <div className="flex items-stretch gap-1 overflow-x-auto no-scrollbar">
        {shown.map((b) => {
          const u = USABLE[b.usable];
          const seen = b.psk?.transmitting ?? null;
          const fill = Math.max(2, Math.round(((seen ?? 0) / busiest) * 100));
          return (
            <div
              key={b.band}
              className={cn(
                "flex flex-col gap-0.5 rounded-sm border px-1.5 py-1 min-w-[54px] shrink-0",
                b.current ? "border-accent bg-accent/10" : "border-line bg-surface",
              )}
              title={
                [
                  `${b.band}${b.current ? " — decoding now" : ""}`,
                  seen === null
                    ? `Nothing seen on the network in the last ${data.pskWindowMinutes} min`
                    : `${seen} stations transmitting ${data.mode} across ${b.psk!.entities} DXCC entities, ` +
                      `heard by ${b.psk!.receivers} receivers (last ${data.pskWindowMinutes} min, a sample)`,
                  b.psk?.bestSnr != null
                    ? `Best report anywhere: ${b.psk.bestSnr > 0 ? "+" : ""}${b.psk.bestSnr} dB`
                    : "",
                  b.psk?.heardUsBy ? `${b.psk.heardUsBy} stations heard YOU here` : "",
                  b.heard
                    ? `You decoded ${b.heard.stations} stations here (${formatMinutesAgo(b.heard.minutesAgo)} ago)`
                    : "You have not decoded this band recently",
                  `Estimate from SFI/time: ${b.usable}`,
                ]
                  .filter(Boolean)
                  .join("\n")
              }
            >
              <div className="flex items-center justify-between gap-1">
                <span className="font-display text-[11px] tracking-wide leading-none">
                  {b.band}
                </span>
                <span className={cn("text-[9px] font-bold leading-none", u.text)}>{u.letter}</span>
              </div>
              <div className="flex items-baseline gap-1">
                <span className="text-sm tnum leading-none">{seen ?? "–"}</span>
                {b.psk && b.psk.entities > 0 && (
                  <span className="text-[9px] text-fg-subtle tnum leading-none">
                    /{b.psk.entities}
                  </span>
                )}
              </div>
              <div className="h-0.5 w-full bg-line rounded-full overflow-hidden">
                <div className={cn("h-full rounded-full", u.bar)} style={{ width: `${fill}%` }} />
              </div>
            </div>
          );
        })}
      </div>

      {/* The legend was `hidden lg:flex`, so below 1024px the strip was a row of bare
          numbers and single letters with nothing anywhere saying what they meant. The
          numbers are the part that can be dropped on a narrow screen; the key to
          reading them is not. */}
      <div className="flex flex-col leading-tight shrink-0">
        <span className="text-[9px] uppercase tracking-wider text-fg-subtle">
          {data.mode} seen / DXCC · {data.pskWindowMinutes}m
        </span>
        {/* G/F/P is meaningless until something spells it out, and the letters exist
            precisely so the strip does not depend on colour alone. */}
        <span className="text-[9px] text-fg-subtle">
          <span className="text-ok">G</span>ood · <span className="text-warn">F</span>air
          · <span className="text-danger">P</span>oor
        </span>
        {s && (
          <span className="text-[9px] text-fg-subtle tnum" title={`Source: ${s.sources.join(", ")}`}>
            SFI {s.sfi ?? "–"} · SSN {s.ssn ?? "–"} · Kp {s.kp ?? "–"}
          </span>
        )}
      </div>
    </div>
  );
}
