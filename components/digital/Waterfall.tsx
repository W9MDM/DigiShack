import { useEffect, useRef, useState } from "react";
import { AudioWaterfallCanvas } from "@/components/digital/audio-waterfall-canvas";

// Canvas waterfall for the FT8/FT4 AUDIO passband — 0-3 kHz of what the receiver is
// demodulating, which is one signal.
//
// Kept, deliberately, now that there is an RF panadapter. It is the right display for
// FT8: the decoder searches a 3 kHz passband and the waterfall must show the same span
// or it lies about what will decode. It is also the quickest confirmation that audio is
// arriving at all. See components/digital/Panadapter.tsx for the band view, and
// docs/panadapter.md for why one cannot become the other by tuning.
//
// The timed audio canvas retains raw rows for resizing and recolouring. Its palette and
// peak reduction are shared with the RF renderer; labels and markers live here.

export interface WaterfallMarker {
  /** Audio offset, Hz. */
  hz: number;
  label: string;
  /** Highlighted differently — used for anything mentioning the operator. */
  emphasis?: boolean;
}

/** A labelled, clickable tag on the waterfall: "found +78", and a click goes there. */
export interface WaterfallTag {
  hz: number;
  label: string;
  /** What hovering says the click does. */
  title: string;
  onClick: () => void;
}

export interface WaterfallProps {
  /** Latest row, one byte per bin. Push a new object to advance the display. */
  row: { bins: Uint8Array; at: number } | null;
  binHz: number;
  maxHz: number;
  markers: WaterfallMarker[];
  /** Audio offset the radio transmits on, if known. */
  txHz?: number | null;
  height?: number;
  /** Gain applied to byte values before colouring. */
  gain?: number;
  /** Called with the audio frequency under a click, when the display is a control as well as a picture. */
  onPickHz?: (hz: number) => void;
  /** Clickable tags drawn over the display, above the click layer. */
  tags?: WaterfallTag[];
  /** Mode period from the spectrum message; matches the page's cycle indicator. */
  periodMs?: number | null;
  /** Digital rows arrive every 250 ms; voice uses 50 ms. Also defines history speed. */
  rowIntervalMs?: number;
}

export function Waterfall({
  row,
  binHz,
  maxHz,
  markers,
  txHz = null,
  height = 320,
  gain = 1,
  onPickHz,
  tags = [],
  periodMs = 15_000,
  rowIntervalMs = 250,
}: WaterfallProps) {
  const [viewAt, setViewAt] = useState(row?.at ?? 0);
  const rulerRef = useRef<HTMLDivElement>(null);
  const [plotWidth, setPlotWidth] = useState(600);
  useEffect(() => {
    const ruler = rulerRef.current;
    if (!ruler) return;
    const measure = () => setPlotWidth(Math.max(1, ruler.getBoundingClientRect().width));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(ruler);
    return () => observer.disconnect();
  }, []);
  // Anchor to the bridge's clock, not the browser's wall clock. Continue advancing when
  // reception stops so an outage is a visible gap, rather than a frozen "live" picture.
  useEffect(() => {
    if (!row) return;
    const received = performance.now();
    setViewAt(row.at);
    const timer = setInterval(() => setViewAt(row.at + performance.now() - received), rowIntervalMs);
    return () => clearInterval(timer);
  }, [row?.at, rowIntervalMs]);

  const ticks: number[] = [];
  const tickStep = Math.max(500, Math.ceil((maxHz * 64 / plotWidth) / 500) * 500);
  for (let hz = tickStep; hz < maxHz - tickStep * 0.3; hz += tickStep) ticks.push(hz);
  const cycleTicks: { y: number; at: number }[] = [];
  const timeTicks: { y: number; at: number }[] = [];
  const period = Math.max(1000, periodMs ?? 15_000);
  const endBucket = Math.floor(viewAt / rowIntervalMs);
  for (let at = Math.floor(viewAt / period) * period; at > viewAt - height * rowIntervalMs; at -= period) {
    const y = height - 1 - (endBucket - Math.floor(at / rowIntervalMs));
    if (y >= 0 && y < height) cycleTicks.push({ y, at });
  }
  // Time labels stay 15 seconds apart even when a WSPR cycle is longer than the view.
  for (let at = Math.floor(viewAt / 15_000) * 15_000; at > viewAt - height * rowIntervalMs; at -= 15_000) {
    const y = height - 1 - (endBucket - Math.floor(at / rowIntervalMs));
    if (y >= 0 && y < height) timeTicks.push({ y, at });
  }
  const stale = row && viewAt - row.at > 2000;

  return (
    <div className="border border-line rounded-sm overflow-hidden bg-bg">
      <div className="flex h-7 items-center border-b border-line bg-surface-2 text-[10px] text-fg-muted tnum">
        <span className="w-14 shrink-0 pl-1">UTC</span>
        <div ref={rulerRef} className="relative h-full flex-1 min-w-0">
          <span className="absolute left-1 top-1">0 Hz</span>
          {ticks.map((hz) => (
            <span key={hz} className="absolute top-1 -translate-x-1/2" style={{ left: `${(hz / maxHz) * 100}%` }}>{hz}</span>
          ))}
          <span className="absolute right-1 top-1">{Math.round(maxHz)}</span>
        </div>
      </div>
      <div className="relative pl-14">
        <div className="absolute left-0 top-0 bottom-0 w-14 border-r border-line text-[10px] text-fg-muted tnum overflow-hidden">
          {timeTicks.map((tick) => (
            <span key={tick.at} className="absolute left-1" style={{ top: Math.min(height - 14, Math.max(0, tick.y - 6)) }}>
              {new Date(tick.at).toISOString().slice(11, 19)}
            </span>
          ))}
        </div>
        <AudioWaterfallCanvas row={row} height={height} gain={gain} resetKey={`${maxHz}:${binHz}`} stepMs={rowIntervalMs} viewAt={viewAt}>
          {ticks.map((hz) => (
            <div
              key={hz}
              className="absolute top-0 bottom-0 border-l border-fg/10"
              style={{ left: `${(hz / maxHz) * 100}%` }}
            />
          ))}
          {cycleTicks.map((tick) => (
            <div key={tick.at} className="absolute left-0 right-0 border-t border-fg/10" style={{ top: tick.y }} />
          ))}

          {txHz !== null && txHz > 0 && txHz < maxHz && (
            <div
              className="absolute top-0 bottom-0 border-l-2 border-accent"
              style={{ left: `${(txHz / maxHz) * 100}%` }}
              title={`TX offset ${txHz} Hz`}
            />
          )}

          <div className="absolute left-0 right-0 bottom-0 h-5">
            {markers.map((m, i) => (
              <div
                key={`${m.hz}-${i}`}
                className="absolute bottom-0"
                style={{ left: `${Math.min(99.5, (m.hz / maxHz) * 100)}%` }}
                title={`${m.hz} Hz — ${m.label}`}
              >
                <div className={m.emphasis ? "w-0.5 h-4 bg-accent" : "w-0.5 h-2.5 bg-ok/70"} />
              </div>
            ))}
          </div>

          {/* pointer-events-auto, explicitly: SpectrumCanvas wraps every overlay in a
              pointer-events-none layer so the ruler and markers never eat a scroll or a
              touch, and a click layer inside it inherits that and receives nothing. That is
              how "click the waterfall to set the centre" did nothing for RTTY, PSK31, Olivia
              and the JS8 offset alike. scripts/check-waterfall-pick.ts asserts the class. */}
          {onPickHz && (
            <div
              className="absolute inset-0 cursor-crosshair pointer-events-auto"
              title="Click to listen here"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                if (r.width > 0) onPickHz(Math.round(((e.clientX - r.left) / r.width) * maxHz));
              }}
            />
          )}

          {/* Tags sit above the click layer and opt into pointer events themselves, for the
              same reason the click layer does: the canvas wraps overlays inert. */}
          {tags.map((t, i) => (
            <button
              key={`${t.hz}-${i}`}
              type="button"
              className="absolute top-5 -translate-x-1/2 pointer-events-auto rounded-sm border border-accent bg-bg/80 px-1.5 py-0.5 text-xs text-accent-bright tnum hover:bg-accent hover:text-accent-fg focus-visible:outline-2 focus-visible:outline-accent-bright"
              style={{ left: `${Math.min(97, Math.max(3, (t.hz / maxHz) * 100))}%` }}
              title={t.title}
              onClick={(e) => {
                e.stopPropagation();
                t.onClick();
              }}
            >
              {t.label}
            </button>
          ))}

          {(!row || stale) && (
            <div className="absolute left-2 top-2 rounded-sm bg-bg/80 px-2 py-1 text-xs text-warn">
              {row ? "No new spectrum — check receiver audio" : "Waiting for receiver audio…"}
            </div>
          )}
        </AudioWaterfallCanvas>
      </div>
      {/* The resolution note lived over the plot, on top of the newest rows; it is chrome. */}
      <div className="flex flex-wrap justify-between gap-x-3 border-t border-line px-2 py-1 text-xs text-fg-subtle tnum">
        <span>Receive audio · newest at the bottom</span>
        <span>
          {(height * rowIntervalMs / 1000).toFixed(0)} s shown
          {periodMs !== null && <> · {(period / 1000).toFixed(1)} s cycle</>} · {binHz.toFixed(1)} Hz/bin
        </span>
      </div>
    </div>
  );
}
