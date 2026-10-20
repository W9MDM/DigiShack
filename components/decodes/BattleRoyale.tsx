// FT8 Battle Royale on the Digital page: the auto-operator warning, and the last two hours
// of the feed the bridge keeps (who worked whom, for how much, every steal), which is what
// the steal marks in the points column are scored from.

import { CallChip } from "@/components/decodes/controls";
import type { DecodeEvent } from "@/components/decodes/types";
import { ErrorBanner } from "@/components/ui/primitives";
import type { Score } from "@/lib/contest/ft8battle";
import type { Ft8brFeedResponse } from "@/lib/contest/ft8battle-feed";
import { formatUtcTime } from "@/lib/time";
import { cn } from "@/lib/utils";

/**
 * FT8BR bans automated operation — detected automatically, permanent ban — and BR mode
 * plus a running auto operator is exactly that combination. It warns rather than switching
 * anything off: a display option must not silently change what the station is doing.
 */
export function BattleRoyaleAutoWarning({ autoMode }: { autoMode: string }) {
  return (
    <div className="mb-4">
      <ErrorBanner>
        <strong>The auto operator is running ({autoMode}).</strong> FT8 Battle Royale requires
        human-operated contacts — automated operation is detected and carries a permanent ban.
        Stop auto before logging contacts you intend to score.
      </ErrorBanner>
    </div>
  );
}

export function BattleRoyaleFeed({
  feed,
  myCall,
  heardNow,
  workedDupe,
  scores,
  onCall,
}: {
  feed: Ft8brFeedResponse | null;
  myCall: string | null;
  /** The latest decode per callsign from the last two minutes, upper-case keys. */
  heardNow: Map<string, DecodeEvent>;
  workedDupe: Set<string>;
  scores: Map<string, Score>;
  onCall: (d: DecodeEvent) => void;
}) {
  return (
    <section className="border border-line rounded-md bg-surface shadow-panel overflow-hidden">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 px-3 py-1.5 bg-surface-2 text-xs">
        <h2 className="font-medium text-fg">Battle Royale — last 2 hours</h2>
        <span className="text-fg-subtle tnum">
          {feed
            ? `${feed.activity.length} events · ` +
              `${feed.activity.filter((e) => e.type === "steal").length} steals · ` +
              `${feed.claims.length} holdings today`
            : "loading…"}
        </span>
      </div>
      <div className="max-h-44 overflow-y-auto divide-y divide-line text-xs font-mono">
        {feed && feed.activity.length === 0 && (
          <p className="px-3 py-2 text-fg-muted font-sans">
            Nothing tracked yet. The bridge polls ft8battle.com every 20 s while BR mode is on.
          </p>
        )}
        {feed?.activity.map((e) => {
          // A holding we can hear right now gets a Call, labelled with what it is worth on
          // OUR band and mode; one we already hold today is a duplicate that costs double.
          const heard = heardNow.get(e.contact);
          const sc = scores.get(e.contact);
          const worth = !sc ? "" : sc.min === sc.max ? ` ${sc.min}` : ` ${sc.min}–${sc.max}`;
          return (
            <div
              key={`${e.at}|${e.station}|${e.contact}|${e.band}|${e.mode}`}
              className={cn(
                "px-3 py-0.5 flex flex-wrap items-center gap-x-2",
                e.type === "steal" ? "text-warn" : e.type === "penalty" ? "text-danger" : "",
              )}
            >
              <span className="text-fg-subtle tnum">{formatUtcTime(e.at)}</span>
              <span>
                {e.station === myCall ? <strong>{e.station}</strong> : e.station}
                {e.type === "steal" ? " STOLE " : " → "}
                {heard ? <strong>{e.contact}</strong> : e.contact}
                {e.victim && (
                  <>
                    {" from "}
                    {e.victim === myCall ? <strong>YOU</strong> : e.victim}
                  </>
                )}
              </span>
              <span className="text-fg-subtle">
                {e.band} {e.mode}
              </span>
              <span className="ml-auto tnum">
                {e.points === null ? "held" : e.points > 0 ? `+${e.points}` : e.points}
                {e.first ? " ★" : ""}
              </span>
              {heard &&
                (workedDupe.has(e.contact) ? (
                  <span
                    className="text-danger text-[0.85em] uppercase tracking-wide"
                    title="Already worked on this band and mode today — working them again costs double."
                  >
                    yours
                  </span>
                ) : (
                  <CallChip
                    tone={sc?.steal ? "warn" : "neutral"}
                    title={
                      `Call ${e.contact} now — heard ${formatUtcTime(heard.timestamp)} at ` +
                      `${heard.freqOffset} Hz, ${heard.snr} dB.` +
                      (sc?.steal ? ` Takes the points ${sc.steal.from} holds.` : "")
                    }
                    onClick={() => onCall(heard)}
                  >
                    {sc?.steal ? "Steal" : "Call"}
                    {worth}
                  </CallChip>
                ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}
