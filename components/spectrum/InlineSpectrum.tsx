// The /spectrum renderers inside another page's display — the Digital waterfall, the Rig
// panadapter — behind a Waterfall / Spectrogram / 3D / Split switch.
//
// The page feeds the frames it already receives on its own socket into `useLiveSpectrum`;
// there is no second connection. Recording starts with the page, whichever view is showing,
// so switching shows history instead of starting blank. Colour map, contrast and history
// length are the ones chosen on /spectrum (read once, after mount).

import { useCallback, useEffect, useRef, useState } from "react";

import { Persistence, Ridgeline } from "@/components/spectrum/ClassicViews";
import { Spectrogram } from "@/components/spectrum/Spectrogram";
import { Waterfall3D } from "@/components/spectrum/Waterfall3D";
import { useNightMode } from "@/lib/client/use-theme";
import { SpectrumFeed } from "@/lib/spectrum/feed";
import { DEFAULT_PREFS, effectiveColormap, loadPrefs, VIEWS, type SpectrumPrefs, type SpectrumView } from "@/lib/spectrum/prefs";
import { FrameDecoder, type FeedKind } from "@/lib/spectrum/wire";
import { cn } from "@/lib/utils";

export type InlineView = "waterfall" | SpectrumView;

export const INLINE_VIEWS: readonly { id: InlineView; label: string }[] = [
  { id: "waterfall", label: "Waterfall" },
  ...VIEWS,
];

function isInlineView(v: unknown): v is InlineView {
  return INLINE_VIEWS.some((x) => x.id === v);
}

/** A feed this page fills from its own socket messages. `ingest` ignores other kinds. */
export function useLiveSpectrum(
  kind: FeedKind,
  /** The station is on the air: hold the colour scale (see SpectrumFeed.transmitting). */
  transmitting = false,
): { feed: SpectrumFeed; ingest: (msg: Record<string, unknown>) => void } {
  const [feed] = useState(() => new SpectrumFeed(kind));
  feed.transmitting = transmitting;
  const decoder = useRef(new FrameDecoder());
  const ingest = useCallback(
    (msg: Record<string, unknown>) => {
      const frame = decoder.current.decode(msg);
      if (frame && frame.kind === kind) feed.ingest(frame, performance.now());
    },
    [feed, kind],
  );
  return { feed, ingest };
}

/** Which view this page shows, remembered per page in this browser. */
export function useInlineView(storageKey: string): [InlineView, (v: InlineView) => void] {
  const [view, setView] = useState<InlineView>("waterfall");
  useEffect(() => {
    try {
      const v = window.localStorage.getItem(storageKey);
      if (isInlineView(v)) setView(v);
    } catch {
      /* storage blocked: the waterfall it is */
    }
  }, [storageKey]);
  const choose = useCallback(
    (v: InlineView) => {
      setView(v);
      try {
        window.localStorage.setItem(storageKey, v);
      } catch {
        /* remembered for this page view only */
      }
    },
    [storageKey],
  );
  return [view, choose];
}

/** The four-way switch. */
export function ViewSwitch({
  value,
  onChange,
  className,
}: {
  value: InlineView;
  onChange: (v: InlineView) => void;
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label="Display" className={cn("inline-flex rounded-sm border border-line p-0.5", className)}>
      {INLINE_VIEWS.map((v) => {
        const on = v.id === value;
        return (
          <button
            key={v.id}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(v.id)}
            className={cn(
              "rounded-[2px] px-2 py-0.5 text-xs transition-colors",
              on ? "bg-accent/20 text-accent-bright" : "text-fg-muted hover:bg-surface-2 hover:text-fg",
            )}
          >
            {v.label}
          </button>
        );
      })}
    </div>
  );
}

/** Spectrogram, 3D or both, at the height the page's own display uses. */
export function InlineSpectrum({
  feed,
  view,
  height,
  dialHz = null,
}: {
  feed: SpectrumFeed;
  view: Exclude<InlineView, "waterfall">;
  height: number;
  dialHz?: number | null;
}) {
  const [prefs, setPrefs] = useState<SpectrumPrefs>(DEFAULT_PREFS);
  useEffect(() => {
    try {
      setPrefs(loadPrefs(window.localStorage));
    } catch {
      /* defaults */
    }
  }, []);
  const [timeLabels, setTimeLabels] = useState<"utc" | "ago">(DEFAULT_PREFS.timeLabels);
  const [depthSec, setDepthSec] = useState(DEFAULT_PREFS.depthSec);
  const [heightScale, setHeightScale] = useState(DEFAULT_PREFS.heightScale);
  useEffect(() => {
    setTimeLabels(prefs.timeLabels);
    setDepthSec(prefs.depthSec);
    setHeightScale(prefs.heightScale);
  }, [prefs]);

  const night = useNightMode();
  const colormap = effectiveColormap(prefs, night);
  const contrast = prefs.contrast[feed.kind];

  const spectrogram = (
    <Spectrogram
      feed={feed}
      contrast={contrast}
      colormap={colormap}
      historySec={prefs.historySec}
      paused={false}
      timeLabels={timeLabels}
      onTimeLabelsChange={setTimeLabels}
      dialHz={feed.kind === "rf" ? dialHz : null}
      className="h-full"
    />
  );
  const surface = (
    <Waterfall3D
      feed={feed}
      contrast={contrast}
      colormap={colormap}
      depthSec={depthSec}
      historySec={prefs.historySec}
      heightScale={heightScale}
      paused={false}
      onDepthChange={setDepthSec}
      onHeightScaleChange={setHeightScale}
      className="h-full"
    />
  );

  return (
    <div
      className={cn("rounded-md border border-line bg-bg overflow-hidden", view === "split" && "grid gap-px md:grid-cols-2")}
      style={{ height: view === "split" ? undefined : height }}
    >
      {view === "ridgeline" && <Ridgeline feed={feed} contrast={contrast} colormap={colormap} height={height} />}
      {view === "persistence" && <Persistence feed={feed} contrast={contrast} colormap={colormap} height={height} />}
      {view === "spectrogram" && spectrogram}
      {view === "3d" && surface}
      {view === "split" && (
        <>
          <div style={{ height }}>{spectrogram}</div>
          <div style={{ height }}>{surface}</div>
        </>
      )}
    </div>
  );
}
