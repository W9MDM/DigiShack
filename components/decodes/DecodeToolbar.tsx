// The decode card's controls. The heading says what the STATION is doing (the count, the
// Auto Hunt preference, link health); the toolbar row under it says how the list is VIEWED
// (search, filter, text size, pause). Kept apart so neither reads as the other.

import { useEffect, useState } from "react";

import { NativeSelect, ToggleButton } from "@/components/decodes/controls";
import type { DecodeSize } from "@/components/decodes/view-prefs";
import { Badge, Button, Input } from "@/components/ui/primitives";
import { apiGet, apiPatch } from "@/lib/client/api";

export type DecodeFilter = "all" | "cq" | "cq-free" | "cq-pota" | "cq-dx" | "worth" | "me";

export function DecodeToolbar({
  search,
  onSearch,
  filter,
  onFilter,
  myCall,
  size,
  paused,
  onPause,
}: {
  search: string;
  onSearch: (s: string) => void;
  filter: DecodeFilter;
  onFilter: (f: DecodeFilter) => void;
  myCall: string | null;
  size: DecodeSize;
  paused: boolean;
  onPause: () => void;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      {/* Uppercased as typed: every decode is, and a lowercase search matching nothing
          would read as "they are not on the air". The `/` shortcut focuses it by id. */}
      <Input
        id="decode-search"
        value={search}
        onChange={(e) => onSearch(e.target.value.toUpperCase())}
        placeholder="Find a callsign…  (/)"
        aria-label="Search decodes"
        className="min-w-36 flex-1 sm:flex-none sm:w-48 tnum"
      />
      {search !== "" && (
        <Button size="sm" variant="ghost" onClick={() => onSearch("")} title="Clear the search">
          Clear
        </Button>
      )}
      <NativeSelect
        size="md"
        value={filter}
        onChange={(e) => onFilter(e.target.value as DecodeFilter)}
        aria-label="Show"
        className="min-w-36 flex-1 sm:flex-none sm:w-48"
      >
        <option value="all">Everything</option>
        <option value="cq">CQ only</option>
        <option
          value="cq-free"
          title="CQs, plus stations that just sent RR73, RRR or 73 — they have finished and are free to call"
        >
          CQ + just finished
        </option>
        <option value="cq-pota">CQ POTA</option>
        <option value="cq-dx">CQ DX</option>
        <option value="worth">Worth working</option>
        <option value="me" disabled={!myCall}>
          {myCall ? `Mentions ${myCall}` : "Mentions me"}
        </option>
      </NativeSelect>

      {/* Text size, here rather than in Settings: the right size depends on where you are
          sitting right now. The middle figure shows the size and resets it. */}
      <div
        className="flex items-center rounded-sm border border-line-strong"
        role="group"
        aria-label="Decode text size"
      >
        <Button
          size="sm"
          variant="ghost"
          className="rounded-none border-0"
          onClick={size.smaller}
          disabled={!size.canShrink}
          aria-label="Smaller decode text"
          title="Smaller — fits more rows on screen"
        >
          −
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="rounded-none border-0 border-x border-line px-1.5 tnum text-fg-subtle"
          onClick={size.reset}
          disabled={size.isDefault}
          title={size.isDefault ? "Default size" : "Back to the default size"}
        >
          {size.px}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="rounded-none border-0"
          onClick={size.bigger}
          disabled={!size.canGrow}
          aria-label="Larger decode text"
          title="Larger — easier to read across the room"
        >
          +
        </Button>
      </div>

      {/* Pausing stops the list scrolling away from you; the waterfall keeps running. */}
      <ToggleButton
        pressed={paused}
        tone="warn"
        onClick={onPause}
        title={paused ? "Paused — press again to let new decodes in" : "Hold the list still to read it"}
      >
        Pause
      </ToggleButton>
    </div>
  );
}

/**
 * Whether Auto Hunt also calls stations that have just finished (RR73, RRR, 73).
 *
 * Beside the decode count, where the operator asked for it: next to the filters it read
 * as a fifth filter rather than as what the station will do. Read and written through
 * /api/digital/hunt-prefs, a narrow route an operator can reach (/api/settings is admin
 * only). Hidden until loaded: a box that renders unticked and then flips has lied once.
 */
export function CallFinishedToggle() {
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void apiGet<{ prefs: Record<string, boolean> }>("/api/digital/hunt-prefs")
      .then((r) => {
        if (!cancelled) setOn(r.prefs["auto.callFinishedStations"] === true);
      })
      .catch(() => {
        /* null keeps the control out of the way rather than showing a wrong state */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (on === null) return null;

  return (
    <label
      className="flex items-center gap-1.5 text-xs text-fg-muted cursor-pointer select-none font-sans"
      title={
        "Auto Hunt also calls stations that have just sent RR73, RRR or 73 — they have " +
        "finished and are free, which is often the best moment on the band. A station " +
        "mid-exchange with somebody else is still never called. Takes effect within " +
        "about 30 seconds; no restart."
      }
    >
      <input
        type="checkbox"
        checked={on}
        disabled={busy}
        onChange={(e) => {
          const next = e.target.checked;
          setBusy(true);
          // Optimistic, then corrected from the STORED value the response echoes, so a
          // refused write snaps back.
          setOn(next);
          void apiPatch<{ prefs: Record<string, boolean> }>("/api/digital/hunt-prefs", {
            "auto.callFinishedStations": next,
          })
            .then((r) => setOn(r.prefs["auto.callFinishedStations"] === true))
            .catch(() => setOn(!next))
            .finally(() => setBusy(false));
        }}
        className="accent-accent"
      />
      Call finished stations
    </label>
  );
}

/**
 * Said only when something is wrong. A silent socket is the transport; a live socket with
 * an old list is either our own transmit windows (named as ours) or a quiet band. Being
 * disconnected is the header's badge, not repeated here.
 */
export function LinkHealth({
  connected,
  linkStalled,
  msgAgeSeconds,
  staleSeconds,
  gapIsOurs,
  watchDecodes,
}: {
  connected: boolean;
  linkStalled: boolean;
  msgAgeSeconds: number | null;
  staleSeconds: number | null;
  gapIsOurs: boolean;
  /** Off in the text and picture modes, where no decodes arrive by design. */
  watchDecodes: boolean;
}) {
  if (linkStalled) return <Badge tone="warn">{`link stalled ${msgAgeSeconds}s`}</Badge>;
  if (!connected || !watchDecodes || staleSeconds === null) return null;
  // Sooner than the quiet badge: half a minute of nothing is alarming, and "we are
  // transmitting" is the answer the operator needs now.
  if (gapIsOurs && staleSeconds >= 20) {
    return <Badge tone="info">{`${staleSeconds}s — we are transmitting`}</Badge>;
  }
  if (!gapIsOurs && staleSeconds >= 90) {
    return <Badge tone="neutral">{`quiet ${staleSeconds}s — link ok`}</Badge>;
  }
  return null;
}
