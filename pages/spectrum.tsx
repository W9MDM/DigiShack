import type { GetServerSidePropsContext } from "next";
import { useRouter } from "next/router";
import { useCallback, useEffect, useRef, useState } from "react";

import { Persistence, Ridgeline } from "@/components/spectrum/ClassicViews";
import { Spectrogram } from "@/components/spectrum/Spectrogram";
import { Waterfall3D } from "@/components/spectrum/Waterfall3D";
import { HelpTip } from "@/components/ui/HelpTip";
import { Badge, Button, EmptyState, PageHeader, Select } from "@/components/ui/primitives";
import { withPageAuth } from "@/lib/auth/guard";
import { bridgeWsUrl } from "@/lib/bridge/ws-url";
import { linkLabel } from "@/lib/client/socket-retry";
import { useBridgeSocket } from "@/lib/client/use-bridge-socket";
import { useNightMode } from "@/lib/client/use-theme";
import { useVisibleInterval } from "@/lib/client/use-visible-interval";
import { formatFreqDial } from "@/lib/ham/bands";
import { colormapRgb, COLORMAPS, isColormapId } from "@/lib/spectrum/colormaps";
import { SpectrumFeed } from "@/lib/spectrum/feed";
import {
  DEFAULT_CONTRAST,
  displayWindow,
  MAX_FLOOR_OFFSET_DB,
  MIN_FLOOR_OFFSET_DB,
  type Contrast,
} from "@/lib/spectrum/levels";
import {
  DEFAULT_PREFS,
  effectiveColormap,
  HISTORY_CHOICES_SEC,
  isFeedKind,
  isView,
  loadPrefs,
  savePrefs,
  VIEWS,
  type SpectrumPrefs,
} from "@/lib/spectrum/prefs";
import { FrameDecoder, type FeedKind } from "@/lib/spectrum/wire";
import { cn } from "@/lib/utils";

// Spectrum: a full-page spectrogram and 3D waterfall of what the radio is receiving.
//
// Receive-only. Nothing here tunes, keys or changes the radio, so it is open to every
// signed-in role. Both feeds are recorded from the moment the page opens, whichever is on
// screen, so switching between the audio passband and the RF panadapter shows history
// rather than starting blank.

interface Props extends Record<string, unknown> {
  wsUrl: string;
}

/** The parts of the bridge's status message this page reads. */
interface LiveStatus {
  connected?: boolean;
  dialFrequency?: number | null;
  band?: string | null;
  mode?: string | null;
  subMode?: string | null;
  transmitting?: boolean;
  radio?: { model?: string } | null;
}

interface FeedStats {
  fps: number;
  ageMs: number | null;
  floorDb: number | null;
  spanDb: number | null;
}

/** Range slider limits, dB. */
const RANGE_MIN = 6;
const RANGE_MAX = 100;

export default function SpectrumPage({ wsUrl }: Props) {
  const router = useRouter();
  const [feeds] = useState(() => ({ audio: new SpectrumFeed("audio"), rf: new SpectrumFeed("rf") }));
  const decoder = useRef(new FrameDecoder());
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [seen, setSeen] = useState<Record<FeedKind, boolean>>({ audio: false, rf: false });
  const seenRef = useRef(seen);
  seenRef.current = seen;

  const { connected, attempts } = useBridgeSocket(wsUrl, (msg) => {
    if (msg.kind === "status" && msg.status && typeof msg.status === "object") {
      setStatus(msg.status as LiveStatus);
      return;
    }
    const frame = decoder.current.decode(msg);
    if (!frame) return;
    const feed = feeds[frame.kind];
    if (feed.ingest(frame, performance.now()) && !seenRef.current[frame.kind]) {
      setSeen((s) => ({ ...s, [frame.kind]: true }));
    }
  });

  // ---- preferences: localStorage, then the query string (?view=3d&source=rf) on top ----
  const [prefs, setPrefs] = useState<SpectrumPrefs>(DEFAULT_PREFS);
  const loaded = useRef(false);
  useEffect(() => {
    if (!router.isReady || loaded.current) return;
    let storage: Storage | null = null;
    try {
      storage = window.localStorage;
    } catch {
      storage = null;
    }
    const p = loadPrefs(storage);
    const { view, source } = router.query;
    if (isView(view)) p.view = view;
    if (isFeedKind(source)) p.source = source;
    loaded.current = true;
    setPrefs(p);
  }, [router.isReady, router.query]);
  useEffect(() => {
    if (!loaded.current) return;
    let storage: Storage | null = null;
    try {
      storage = window.localStorage;
    } catch {
      storage = null;
    }
    savePrefs(storage, prefs);
  }, [prefs]);
  const update = useCallback((patch: Partial<SpectrumPrefs>) => setPrefs((p) => ({ ...p, ...patch })), []);

  const source: FeedKind = prefs.source === "rf" && seen.rf ? "rf" : "audio";
  // Hold the colour scale while on the air (see SpectrumFeed.transmitting).
  feeds.audio.transmitting = feeds.rf.transmitting = status?.transmitting === true;
  const feed = feeds[source];
  const contrast = prefs.contrast[source];
  const setContrast = (c: Contrast) => setPrefs((p) => ({ ...p, contrast: { ...p.contrast, [source]: c } }));

  const [paused, setPaused] = useState(false);

  // ---- once a second: rates and levels for the status line ----
  const statsOf = (f: SpectrumFeed, now: number): FeedStats => ({
    fps: f.rate.fps(now),
    ageMs: f.frames > 0 ? now - f.lastReceived : null,
    floorDb: f.levels.floorDb,
    spanDb: f.levels.spanDb,
  });
  const [stats, setStats] = useState<Record<FeedKind, FeedStats>>(() => ({
    audio: { fps: 0, ageMs: null, floorDb: null, spanDb: null },
    rf: { fps: 0, ageMs: null, floorDb: null, spanDb: null },
  }));
  useVisibleInterval(() => {
    const now = performance.now();
    setStats({ audio: statsOf(feeds.audio, now), rf: statsOf(feeds.rf, now) });
  }, 1000);

  const s = stats[source];
  const win = displayWindow(s.floorDb, s.spanDb, contrast);
  const info = feed.info;
  const rfStale = seen.rf && stats.rf.ageMs !== null && stats.rf.ageMs > 15_000;
  const mode = status?.subMode || status?.mode || info.mode;

  // Night red in the night theme unless a map was picked from the menu.
  const night = useNightMode();
  const colormap = effectiveColormap(prefs, night);

  const legendRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = legendRef.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const img = ctx.createImageData(256, 1);
    const lut = colormapRgb(colormap);
    for (let i = 0; i < 256; i++) {
      img.data[i * 4] = lut[i * 3]!;
      img.data[i * 4 + 1] = lut[i * 3 + 1]!;
      img.data[i * 4 + 2] = lut[i * 3 + 2]!;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }, [colormap]);

  const empty = !feed.hasData;
  const unit = source === "rf" ? "dBm" : info.calibrated ? "dBFS" : "dB";

  const spectrogram = (
    <Spectrogram
      feed={feed}
      contrast={contrast}
      colormap={colormap}
      historySec={prefs.historySec}
      paused={paused}
      timeLabels={prefs.timeLabels}
      onTimeLabelsChange={(m) => update({ timeLabels: m })}
      dialHz={source === "rf" ? (status?.dialFrequency ?? null) : null}
      className="h-full"
    />
  );
  const waterfall = (
    <Waterfall3D
      feed={feed}
      contrast={contrast}
      colormap={colormap}
      depthSec={prefs.depthSec}
      historySec={prefs.historySec}
      heightScale={prefs.heightScale}
      paused={paused}
      onDepthChange={(sec) => update({ depthSec: sec })}
      onHeightScaleChange={(v) => update({ heightScale: v })}
      className="h-full"
    />
  );

  return (
    <div className="flex flex-col gap-3 md:h-[calc(100dvh-8.5rem)] md:min-h-[520px]">
      <PageHeader
        title="Spectrum"
        subtitle="What the radio is hearing, live — spectrogram and 3D waterfall"
        actions={
          <>
            {status?.transmitting && <Badge tone="danger">TX</Badge>}
            <Badge tone={connected ? "ok" : "warn"}>{linkLabel(connected, attempts)}</Badge>
            <Button
              size="sm"
              variant={paused ? "primary" : "secondary"}
              aria-pressed={paused}
              onClick={() => setPaused((v) => !v)}
            >
              {paused ? "Resume" : "Pause"}
            </Button>
          </>
        }
      />

      <div className="flex flex-wrap items-end gap-x-4 gap-y-2 rounded-md border border-line bg-surface px-3 py-2 shadow-panel">
        <Segmented
          label="View"
          value={prefs.view}
          options={VIEWS.map((v) => ({ value: v.id, label: v.label }))}
          onChange={(v) => update({ view: v })}
        />
        <Segmented
          label="Source"
          value={source}
          options={[
            { value: "audio", label: "Audio" },
            {
              value: "rf",
              label: "RF",
              disabled: !seen.rf,
              title: seen.rf
                ? "The radio's RF panadapter"
                : "No RF panadapter frames yet — only a FlexRadio with the panadapter on sends them",
            },
          ]}
          onChange={(v) => update({ source: v })}
        />
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          Colours
          <Select
            value={colormap}
            onChange={(e) => {
              if (isColormapId(e.target.value)) update({ colormap: e.target.value, colormapChosen: true });
            }}
            className="w-auto py-1 text-xs"
          >
            {COLORMAPS.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          <span className="tnum">
            Floor {contrast.floorOffsetDb >= 0 ? "+" : ""}
            {contrast.floorOffsetDb} dB
          </span>
          <input
            type="range"
            min={MIN_FLOOR_OFFSET_DB}
            max={MAX_FLOOR_OFFSET_DB}
            step={1}
            value={contrast.floorOffsetDb}
            onChange={(e) => setContrast({ ...contrast, floorOffsetDb: Number(e.target.value) })}
            className="w-28 accent-accent"
            aria-label="Where the colour map starts, in dB above the tracked noise floor"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          <span className="tnum">
            Range {Math.round(win.rangeDb)} dB{contrast.rangeDb === null ? " (auto)" : ""}
          </span>
          <input
            type="range"
            min={RANGE_MIN}
            max={RANGE_MAX}
            step={1}
            value={Math.round(Math.max(RANGE_MIN, Math.min(RANGE_MAX, win.rangeDb)))}
            onChange={(e) => setContrast({ ...contrast, rangeDb: Number(e.target.value) })}
            className="w-28 accent-accent"
            aria-label="How many dB the colour map spans"
          />
        </label>
        <div className="flex flex-col gap-1 text-xs text-fg-muted">
          <span className="flex items-center gap-1.5">
            Scale
            <HelpTip label="About the contrast controls">
              The floor follows the noise floor the bridge measures, so 0 dB colours the band the way
              the Decodes waterfall does. Raise it to darken noise, narrow the range to lift weak
              signals. Changes recolour all history at once. Bins below the bridge&apos;s floor arrive
              clipped, so a negative floor shows them as one flat colour.
              {source === "rf" && " Panadapter levels are not calibrated dBm."}
            </HelpTip>
          </span>
          <span className="flex items-center gap-2">
            <canvas ref={legendRef} width={256} height={1} className="h-3 w-24 rounded-sm" aria-hidden="true" />
            <span className="tnum text-[11px] text-fg-subtle">
              {s.floorDb === null
                ? "—"
                : `${Math.round(win.loDb)}…${Math.round(win.loDb + win.rangeDb)} ${unit}`}
            </span>
          </span>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setContrast({ ...DEFAULT_CONTRAST })}
          disabled={contrast.floorOffsetDb === 0 && contrast.rangeDb === null}
        >
          Reset scale
        </Button>
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          History
          <Select
            value={String(prefs.historySec)}
            onChange={(e) => update({ historySec: Number(e.target.value) })}
            className="w-auto py-1 text-xs"
          >
            {HISTORY_CHOICES_SEC.map((sec) => (
              <option key={sec} value={sec}>
                {sec / 60} min
              </option>
            ))}
          </Select>
        </label>
      </div>

      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted tnum" aria-live="polite">
        <span className="flex items-center gap-1.5">
          <span
            className={cn("inline-block size-2 rounded-full", connected ? "bg-ok" : "bg-warn")}
            aria-hidden="true"
          />
          {connected ? "Connected to the bridge" : linkLabel(connected, attempts)}
        </span>
        <span>{s.fps > 0 ? `${s.fps.toFixed(1)} frames/s` : "no frames"}</span>
        {s.ageMs !== null && s.ageMs > 3000 && (
          <span className="text-warn">last frame {Math.round(s.ageMs / 1000)} s ago</span>
        )}
        {info.bins > 0 && (
          <span>
            {source === "rf"
              ? `${formatFreqDial(info.lowHz)}–${formatFreqDial(info.highHz)} MHz`
              : `${Math.round(info.lowHz)}–${Math.round(info.highHz)} Hz`}
            {` · ${info.bins} bins`}
          </span>
        )}
        {status?.band && <span>{status.band}</span>}
        {mode && <span>{mode}</span>}
        {status?.dialFrequency ? <span>dial {formatFreqDial(status.dialFrequency)}</span> : null}
        {status?.radio?.model && <span>{status.radio.model}</span>}
        {prefs.source === "rf" && !seen.rf && <span className="text-warn">no RF panadapter — showing audio</span>}
        {source === "rf" && rfStale && <span className="text-warn">RF panadapter frames stopped</span>}
      </p>

      <div
        className={cn(
          "relative min-h-0 flex-1 h-[72dvh] md:h-auto",
          prefs.view === "split" && "grid grid-rows-2 gap-3 lg:grid-cols-2 lg:grid-rows-1",
        )}
      >
        {prefs.view === "spectrogram" && spectrogram}
        {prefs.view === "3d" && waterfall}
        {prefs.view === "ridgeline" && <Ridgeline feed={feed} contrast={contrast} colormap={colormap} height="100%" />}
        {prefs.view === "persistence" && <Persistence feed={feed} contrast={contrast} colormap={colormap} height="100%" />}
        {prefs.view === "split" && (
          <>
            <div className="min-h-0">{spectrogram}</div>
            <div className="min-h-0">{waterfall}</div>
          </>
        )}
        {empty && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-4">
            <div className="pointer-events-auto rounded-md border border-line bg-surface/95 px-4 shadow-raised">
              <EmptyState
                title={connected ? "Waiting for spectrum frames from the radio…" : "Connecting to the bridge…"}
                className="py-6"
              >
                {connected
                  ? "The bridge sends these while a radio is connected and receiving. Nothing is drawn until real frames arrive."
                  : "The bridge is a separate process; this page reconnects on its own when it comes back."}
              </EmptyState>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** A row of mutually exclusive buttons. */
function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; disabled?: boolean; title?: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-col gap-1 text-xs text-fg-muted">
      <span id={`seg-${label}`}>{label}</span>
      <div role="group" aria-labelledby={`seg-${label}`} className="inline-flex rounded-sm border border-line-strong">
        {options.map((o) => {
          const active = o.value === value;
          return (
            <button
              key={o.value}
              type="button"
              aria-pressed={active}
              disabled={o.disabled}
              title={o.title}
              onClick={() => onChange(o.value)}
              className={cn(
                "px-2.5 py-1 text-xs transition-colors first:rounded-l-sm last:rounded-r-sm",
                "border-r border-line-strong last:border-r-0",
                "disabled:cursor-not-allowed disabled:opacity-60",
                active ? "bg-accent text-accent-fg" : "bg-surface-2 text-fg-muted hover:text-fg",
              )}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export const getServerSideProps = withPageAuth<Props>({
  role: "VIEWER",
  inner: async (ctx: GetServerSidePropsContext) => {
    const { wsUrl } = await bridgeWsUrl(ctx.req.headers);
    return { props: { wsUrl } };
  },
});
