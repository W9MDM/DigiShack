
import { useEffect, useState } from "react";

import { CallChip } from "@/components/decodes/controls";
import type { DecodeEvent } from "@/components/decodes/types";
import { Button, ErrorBanner } from "@/components/ui/primitives";
import type { Score } from "@/lib/contest/ft8battle";
import type { Ft8brFeedResponse } from "@/lib/contest/ft8battle-feed";
import { formatUtcTime } from "@/lib/time";
import { cn } from "@/lib/utils";

export function BattleRoyaleAutoWarning({ autoMode }: { autoMode: string }) {
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  useEffect(() => {
    try {
      setDismissedFor(window.localStorage.getItem(DISMISS_KEY));
    } catch {
    }
  }, []);

  if (dismissedFor === autoMode) return null;

  const dismiss = () => {
    setDismissedFor(autoMode);
    try {
      window.localStorage.setItem(DISMISS_KEY, autoMode);
    } catch {
    }
  };

  return (
    <div className="mb-4">
      <ErrorBanner>
        <div className="flex items-start gap-3">
          <p className="min-w-0 flex-1">
            <strong>The auto operator is running ({autoMode}).</strong> FT8 Battle Royale requires
            human-operated contacts — automated operation is detected and carries a permanent ban.
            Stop auto before logging contacts you intend to score.
          </p>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Dismiss this warning"
            title={`Hide this while auto is in ${autoMode}. It comes back if the auto mode changes.`}
            className="-my-0.5 shrink-0 rounded-sm px-1.5 text-lg leading-none text-danger hover:bg-danger/15 focus-visible:outline-2 focus-visible:outline-danger"
          >
            ×
          </button>
        </div>
      </ErrorBanner>
    </div>
  );
}

const DISMISS_KEY = "digishack.brAutoWarningDismissed";

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
  heardNow: Map<string, DecodeEvent>;
  workedDupe: Set<string>;
  scores: Map<string, Score>;
  onCall: (d: DecodeEvent) => void;
}) {
  const [phoneShown, setPhoneShown] = useState(PHONE_FIRST);
  const total = feed?.activity.length ?? 0;
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
      <div className="sm:max-h-44 sm:overflow-y-auto divide-y divide-line text-xs font-mono">
        {feed && feed.activity.length === 0 && (
          <p className="px-3 py-2 text-fg-muted font-sans">
            Nothing tracked yet. The bridge polls ft8battle.com every 20 s while BR mode is on.
          </p>
        )}
        {feed?.activity.map((e, i) => {
          const heard = heardNow.get(e.contact);
          const sc = scores.get(e.contact);
          const worth = !sc ? "" : sc.min === sc.max ? ` ${sc.min}` : ` ${sc.min}–${sc.max}`;
          return (
            <div
              key={`${e.at}|${e.station}|${e.contact}|${e.band}|${e.mode}`}
              className={cn(
                "px-3 py-0.5 flex flex-wrap items-center gap-x-2",
                e.type === "steal" ? "text-warn" : e.type === "penalty" ? "text-danger" : "",
                i >= phoneShown && "max-sm:hidden",
              )}
            >
              <span className="text-fg-subtle tnum">
                <span className="sm:hidden">{shortTime(e.at)}</span>
                <span className="max-sm:hidden">{formatUtcTime(e.at)}</span>
              </span>
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
              <span aria-hidden="true" className="h-0 basis-full sm:hidden" />
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
      {total > PHONE_FIRST && (
        <div
          className={cn(
            "flex items-center gap-2 px-3 py-1.5 text-xs sm:hidden",
            phoneShown >= total && "border-t border-line",
          )}
        >
          {phoneShown < total && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setPhoneShown((n) => n + PHONE_STEP)}
            >
              {`Show ${Math.min(PHONE_STEP, total - phoneShown)} more`}
            </Button>
          )}
          {phoneShown > PHONE_FIRST && (
            <Button size="sm" variant="ghost" onClick={() => setPhoneShown(PHONE_FIRST)}>
              Show fewer
            </Button>
          )}
          <span className="ml-auto text-fg-subtle tnum">
            {Math.min(phoneShown, total)} of {total}
          </span>
        </div>
      )}
    </section>
  );
}

const PHONE_FIRST = 5;
const PHONE_STEP = 20;

function shortTime(at: Parameters<typeof formatUtcTime>[0]): string {
  const full = formatUtcTime(at);
  return full.length >= 5 ? `${full.slice(0, 5)}Z` : full;
}
