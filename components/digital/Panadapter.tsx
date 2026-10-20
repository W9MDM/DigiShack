import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";

import { SpectrumCanvas } from "@/components/digital/spectrum-canvas";
import { SpectrumTrace } from "@/components/digital/SpectrumTrace";
import { Button } from "@/components/ui/primitives";
import { formatFreqMHz } from "@/lib/ham/bands";
import { segmentLabel, segmentsIn } from "@/lib/ham/band-plan";
import { cn } from "@/lib/utils";

/**
 * The receiver's passband, in Hz either side of the dial.
 *
 * THE FALLBACK, not the first choice. When the radio reports its own `filter_lo` and
 * `filter_hi` those are used instead — see `passbandOf` — and this exists for the radios
 * and moments that do not: the Icom selects FIL1/2/3 and cannot be asked what they are,
 * and the FlexRadio has not answered yet in the second after connecting.
 *
 * The shape is what matters and the shape is not symmetrical: on upper sideband the
 * receiver listens ABOVE the dial and on lower sideband below it, so a passband drawn
 * centred on the dial would be wrong by its whole width on every SSB contact and would
 * teach an operator to tune to the wrong side of a signal.
 *
 * Conventional filter edges rather than the exact ones in force. Null for anything
 * unrecognised, which draws nothing — better than shading a width that is a guess.
 */
function passbandFor(
  mode: string | null,
): { loHz: number; hiHz: number; label: string } | null {
  const m = (mode ?? "").toUpperCase();
  if (m.startsWith("USB") || m === "DIGU" || m === "FT8" || m === "FT4") {
    return { loHz: 300, hiHz: 2700, label: "USB 300–2700 Hz" };
  }
  if (m.startsWith("LSB") || m === "DIGL") {
    return { loHz: -2700, hiHz: -300, label: "LSB 300–2700 Hz" };
  }
  if (m === "CW" || m === "CWU") return { loHz: -250, hiHz: 250, label: "CW 500 Hz" };
  if (m === "CWL") return { loHz: -250, hiHz: 250, label: "CW 500 Hz" };
  if (m === "AM" || m === "SAM") return { loHz: -4000, hiHz: 4000, label: "AM 8 kHz" };
  if (m === "NFM" || m === "FM") return { loHz: -6000, hiHz: 6000, label: "FM 12 kHz" };
  return null;
}

/**
 * The passband to shade: what the RADIO says, falling back to what the mode implies.
 *
 * Asked as "is the slice the right width?", and until now it was not — it was the right
 * width for the convention, which is a different claim. An operator on a 1.8 kHz filter
 * and an operator on a 2.9 kHz filter were shown the same 2.4 kHz shading, so the one
 * part of this display that says what you will actually hear was off by up to 1.1 kHz
 * and never moved when the filter did.
 *
 * The radio's numbers are already SIGNED and already asymmetric — a FlexRadio on LSB
 * reports filter_lo=-2700 filter_hi=-300 — which is the same convention `passbandFor`
 * uses, so there is no side to infer and no chance of inferring it wrongly.
 *
 * Zero width is treated as not reported. A slice mid-retune briefly reads lo == hi, and
 * a zero-width shading is an invisible one that would flicker the display for no reason.
 */
function passbandOf(
  mode: string | null,
  loHz: number | null | undefined,
  hiHz: number | null | undefined,
): { loHz: number; hiHz: number; label: string } | null {
  if (loHz != null && hiHz != null && hiHz !== loHz) {
    const width = Math.abs(hiHz - loHz);
    return {
      loHz: Math.min(loHz, hiHz),
      hiHz: Math.max(loHz, hiHz),
      label:
        width >= 1000
          ? `${(width / 1000).toFixed(width % 1000 === 0 ? 0 : 1)} kHz from the radio`
          : `${width} Hz from the radio`,
    };
  }
  return passbandFor(mode);
}

// The RF panadapter: tens of kHz of band, with every station on it.
//
// The other waterfall on this page shows 0-3 kHz of demodulated audio, which is ONE
// signal — "soooo zoomed in, it's focused on like one voice". No FFT setting bridges
// the two; they are different sources of data. Both are kept because both are right
// for different things, and the labelling here is deliberately emphatic about which
// this is: a display that cannot tell 3 kHz of audio from 100 kHz of band will
// eventually be read as the other one.
//
// Three strips, in the order every SDR front end uses:
//
//   1. The TRACE — the current spectrum as a line. This is where you look to find
//      activity: a conversation is a peak, right now.
//   2. The RULER — frequency labels on their own solid strip. They used to be overlaid
//      on the waterfall pixels at 45% white, which is invisible over bright noise; a
//      ruler an operator cannot read is the same as no ruler, and it was reported as
//      "no frequency markers".
//   3. The WATERFALL — history.
//
// The gridlines, centre mark, dial cursor and click-to-tune span all three, because a
// frequency means the same thing in each.

export interface PanadapterProps {
  row: { bins: Uint8Array; at: number } | null;
  centerHz: number;
  spanHz: number;
  binHz: number;
  /** Where the receiver is actually listening, drawn as a cursor. */
  dialHz?: number | null;
  height?: number;
  /** Height of the live trace strip. */
  traceHeight?: number;
  /** Click a frequency to tune there. */
  onTune?: (hz: number) => void;
  /** Change how much band is shown. Omit to hide the zoom control. */
  onSpan?: (hz: number) => void;
  /**
   * The radio's MODULATION — "USB", "LSB", "CW", "DIGU".
   *
   * Used to shade the passband, which is the part of the display that says what you
   * will actually hear if you tune here. Not the digital mode: on this page "mode"
   * means what the radio is demodulating.
   */
  radioMode?: string | null;
  /**
   * The receive filter edges the RADIO reports, in Hz relative to the dial and signed.
   * Preferred over anything derived from `radioMode`; see `passbandOf`.
   */
  filterLoHz?: number | null;
  filterHiHz?: number | null;
  /** The dB window the bytes span, for the trace's vertical scale. */
  floorDb?: number | null;
  ceilingDb?: number | null;
  /**
   * Who is on the air, and where.
   *
   * This is what turns a picture of the band into a list of people to work: a peak on the
   * trace says something is transmitting, and a label says who. Clicking one tunes to it,
   * so a spot is a destination rather than a note.
   */
  spots?: PanadapterSpot[];
  /** Tune to a spot. Separate from onTune so the caller can also log which was taken. */
  onSpot?: (spot: PanadapterSpot) => void;
  /** Shown at the right of the toolbar: the window and which radio it came from. */
  caption?: ReactNode;
  /** No frame has arrived for a while: say so rather than show a frozen picture as live. */
  stale?: boolean;
}

export interface PanadapterSpot {
  key: string;
  callsign: string;
  freqHz: number;
  /** Short context for the tooltip — a park reference, a mode, whatever the source has. */
  detail?: string | null;
  mode?: string | null;
}

/**
 * The zoom presets, widest first.
 *
 * 200 kHz is the default because it holds a whole digital sub-band plus the CW and SSB
 * activity either side of it — the point of a panadapter is seeing what you were not
 * already looking at. 5 kHz is the radio's own minimum and shows a single FT8 window.
 */
const SPAN_PRESETS: number[] = [
  1_000_000, 500_000, 200_000, 100_000, 50_000, 20_000, 5_000,
];

function spanLabel(hz: number): string {
  return hz >= 1_000_000 ? `${hz / 1_000_000} MHz` : `${Math.round(hz / 1000)} kHz`;
}

/**
 * The step a click on the spectrum snaps to, in Hz.
 *
 * Reported as "there's too much granularity to pick a freq while clicking", and the
 * evidence was on the dial: clicking put the radio on **7.502553 MHz**. That is what
 * pixel-accurate tuning produces — the click is mapped straight through to a frequency
 * with no step at all, so the odds of landing on a number anybody would choose are about
 * one in a thousand. Nobody calls CQ on 7.502553.
 *
 * The step is chosen by MODE, because how precisely a frequency needs picking is a
 * property of what is being received:
 *
 *   * CW is 10 Hz. A CW signal is a tone a few tens of Hz wide and operators genuinely
 *     work each other 20 Hz apart in a pile-up, so a coarse step would put the wrong
 *     station in the passband.
 *   * SSB is 100 Hz, which is what an SSB operator's own VFO knob does per detent, and
 *     is fine enough that voice stays intelligible after the snap.
 *   * The data modes are 500 Hz. Their watering holes sit on exact frequencies — 7.074,
 *     14.074 — and the decoder searches an audio passband either side of the dial, so
 *     precision below this buys nothing and losing the round number costs a decode.
 *   * AM and FM are 1 kHz and 5 kHz, the channel spacings those services actually use.
 *
 * Unknown modes get 100 Hz rather than no snap: a step that is occasionally wrong is
 * better than the alternative this replaced.
 *
 * NOTE this is a snap, not a limit on the radio. Typing an exact frequency into the Tune
 * box still goes through untouched — that path is someone stating a frequency rather than
 * pointing at one.
 */
export function tuneStepFor(mode: string | null | undefined): number {
  const m = (mode ?? "").toUpperCase();
  if (m.startsWith("CW")) return 10;
  if (m === "DIGU" || m === "DIGL" || m === "FT8" || m === "FT4" || m.endsWith("-D")) {
    return 500;
  }
  if (m.startsWith("USB") || m.startsWith("LSB")) return 100;
  if (m === "AM" || m === "SAM") return 1_000;
  if (m === "FM" || m === "NFM") return 5_000;
  return 100;
}

/** Snap a frequency to the mode's tuning step. */
export function snapHz(hz: number, mode: string | null | undefined): number {
  const step = tuneStepFor(mode);
  return Math.round(hz / step) * step;
}

/**
 * Tick spacing for the waterfall's time axis, in seconds.
 *
 * Chosen from how much history is on screen rather than fixed, for the same reason the
 * frequency ruler's spacing is: at 10 rows a second a 260-pixel canvas holds 26 seconds
 * and wants 5-second ticks, while a slow frame rate on a tall display can hold minutes.
 */
function timeStepSec(totalSec: number): number {
  for (const step of [1, 2, 5, 10, 15, 30, 60, 120, 300]) {
    if (totalSec / step <= 6) return step;
  }
  return 600;
}

/**
 * Which spots get a readable CALLSIGN rather than only a marker line.
 *
 * A 1 MHz span on a busy weekend can hold sixty POTA activators. Drawn as labels that is
 * an unreadable stack of overlapping text sitting on top of the very spectrum it is
 * describing — the display would be worse for having the data than without it.
 *
 * So labels are thinned to one per `LABEL_GAP_PCT` of the display's width, taking the
 * lowest-frequency spot in each cluster. Every spot still gets its marker line, so a
 * crowded corner of the band reads as crowded rather than as empty; only the text that
 * could not have been read is dropped. Zooming in separates them and the rest appear,
 * which is the behaviour that makes the zoom buttons worth pressing.
 *
 * Exported for the checks: this is off-by-one territory, and a thinning rule that is
 * slightly wrong shows up as labels that flicker in and out while tuning.
 */
const LABEL_GAP_PCT = 6;

/**
 * A callsign label's width at its 11px type, with its padding: about 50 px. Six percent is
 * wider than that on a desk and a third of it on a phone, where W4LXX, VK3XX and W4SK sat
 * on top of one another. So the gap is never narrower than a label, which only ever
 * widens it below about 830 px of display.
 */
const LABEL_MIN_PX = 50;

export function labelledSpots(
  spotsInWindow: PanadapterSpot[],
  lowHz: number,
  spanHz: number,
  /** The display's measured width; 0 (not yet measured) keeps the percentage alone. */
  widthPx = 0,
): Set<string> {
  const gapPct = widthPx > 0 ? Math.max(LABEL_GAP_PCT, (LABEL_MIN_PX / widthPx) * 100) : LABEL_GAP_PCT;
  const out = new Set<string>();
  let lastPct = -Infinity;
  for (const s of spotsInWindow) {
    const p = ((s.freqHz - lowHz) / spanHz) * 100;
    if (p - lastPct >= gapPct) {
      out.add(s.key);
      lastPct = p;
    }
  }
  return out;
}

/**
 * Tick spacing that gives at most `maxTicks` labels across the span.
 *
 * Chosen from the span rather than fixed, because this display covers anything from
 * 5 kHz to 7 MHz. A fixed 500 Hz ruler — which is what the audio waterfall uses — would
 * be 14,000 lines at 7 MHz. And from the measured WIDTH: eight labels fit at 1600 px and
 * overlap into an unreadable strip on a phone.
 */
function tickStepHz(spanHz: number, maxTicks: number): number {
  const rough = spanHz / Math.max(2, maxTicks);
  const pow = 10 ** Math.floor(Math.log10(rough));
  for (const mult of [1, 2, 2.5, 5, 10]) {
    if (rough <= pow * mult) return pow * mult;
  }
  return pow * 10;
}

/** MHz decimals that show every tick of this step exactly, and never fewer than kHz. */
function tickDecimals(stepHz: number): number {
  for (let d = 3; d < 6; d++) {
    const unit = 10 ** (6 - d);
    if (Math.abs(stepHz / unit - Math.round(stepHz / unit)) < 1e-9) return d;
  }
  return 6;
}

/** Pixels a label of `chars` characters needs at the ruler's type size, with margin. */
const LABEL_PX_PER_CHAR = 6.5;

/** The container's rendered width, for spacing labels. 0 until measured. */
function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(el.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

export function Panadapter({
  row,
  centerHz,
  spanHz,
  binHz,
  dialHz = null,
  height = 220,
  traceHeight = 64,
  onTune,
  onSpan,
  floorDb = null,
  ceilingDb = null,
  radioMode = null,
  filterLoHz = null,
  filterHiHz = null,
  spots = [],
  onSpot,
  caption,
  stale = false,
}: PanadapterProps) {
  // Where the mouse is, in Hz. Null when it is not over the spectrum.
  //
  // This is the single thing that made click-to-tune discoverable: with only a two-pixel
  // dial line there was no way to tell WHERE a click would land until after making it.
  const [hoverHz, setHoverHz] = useState<number | null>(null);
  const [stackRef, widthPx] = useWidth<HTMLDivElement>();

  // How long one waterfall row represents, measured rather than assumed.
  //
  // The canvas scrolls exactly one pixel per row, so a row's duration IS the display's
  // vertical scale — "vertical resolution is time", as docs/panadapter.md puts it. It
  // cannot be taken from the configured frame rate, because that is what was ASKED for:
  // the radio delivered 95 against a request of 100, a busy bridge drops frames, and a
  // band change pauses the sweep entirely.
  //
  // Smoothed hard and only re-rendered on a real change, because this component already
  // re-renders on every row and a label that jitters between 9 and 11 seconds is worse
  // than no label.
  const rowClockRef = useRef<{ lastAt: number; ms: number | null }>({
    lastAt: 0,
    ms: null,
  });
  const [rowMs, setRowMs] = useState<number | null>(null);
  useEffect(() => {
    if (!row) return;
    const clock = rowClockRef.current;
    const gap = row.at - clock.lastAt;
    clock.lastAt = row.at;
    // Ignore the first row, and any gap long enough to be a stall rather than a frame —
    // a band change or a reconnect, which would otherwise drag the estimate for minutes.
    if (clock.ms === null && gap > 0 && gap < 2_000) {
      clock.ms = gap;
    } else if (gap > 0 && gap < 2_000 && clock.ms !== null) {
      clock.ms = clock.ms * 0.9 + gap * 0.1;
    }
    if (clock.ms === null) return;
    if (rowMs === null || Math.abs(clock.ms - rowMs) / clock.ms > 0.08) {
      setRowMs(clock.ms);
    }
  }, [row, rowMs]);

  // Newest row at the BOTTOM: the canvas scrolls up and writes at h-1. So the axis counts
  // backwards going up, and 0 belongs at the bottom edge.
  const historySec = rowMs !== null ? (height * rowMs) / 1000 : null;
  const timeTicks: { sec: number; topPx: number }[] = [];
  if (historySec !== null && historySec > 1) {
    const step = timeStepSec(historySec);
    for (let sec = step; sec < historySec; sec += step) {
      timeTicks.push({ sec, topPx: height - (sec / historySec) * height });
    }
  }

  const lowHz = centerHz - spanHz / 2;
  // One label per ~80 px; before the first measurement, the desktop default of eight.
  const maxTicks = widthPx > 0 ? Math.floor(widthPx / 80) : 8;
  const step = tickStepHz(spanHz, maxTicks);
  const decimals = tickDecimals(step);
  const ticks: number[] = [];
  for (let hz = Math.ceil(lowHz / step) * step; hz < lowHz + spanHz; hz += step) {
    ticks.push(hz);
  }

  const pct = (hz: number): number => ((hz - lowHz) / spanHz) * 100;
  const passband = passbandOf(radioMode, filterLoHz, filterHiHz);

  // Only the spots inside the window, sorted, and labels thinned so no two sit within a
  // few percent of each other — the marker line is still drawn for every spot.
  const visibleSpots = spots
    .filter((s) => s.freqHz > lowHz && s.freqHz < lowHz + spanHz)
    .sort((a, b) => a.freqHz - b.freqHz);
  const labelled = labelledSpots(visibleSpots, lowHz, spanHz, widthPx);
  const planSegments = segmentsIn(lowHz, lowHz + spanHz);

  // Where the waterfall starts, so spot labels sit just inside it instead of on top of
  // the ruler's text: trace + border, band plan + border when drawn, ruler + border.
  const waterfallTopPx = traceHeight + 1 + (planSegments.length > 0 ? 17 : 0) + 21;

  // Presets are widest first, so zooming IN moves forward through the list. The nearest
  // preset is the current one: the radio clamps spans, so an exact match is not promised.
  const spanIdx = SPAN_PRESETS.reduce(
    (best, hz, i) =>
      Math.abs(hz - spanHz) < Math.abs(SPAN_PRESETS[best]! - spanHz) ? i : best,
    0,
  );
  const zoom = (delta: number) => {
    const next = SPAN_PRESETS[spanIdx + delta];
    if (next !== undefined) onSpan?.(next);
  };

  return (
    <div className="relative bg-bg border border-line rounded-md overflow-hidden">
      {/* The toolbar: zoom, and what the window is. Above the display because it changes
          what the display means. OUTSIDE the spectrum stack below, which is what makes it
          clickable at all: click-to-tune is an overlay filling that stack, and while the
          span buttons were inside it every attempt to zoom retuned the radio instead. */}
      {(onSpan || caption) && (
        <div className="flex flex-wrap items-center gap-x-1 gap-y-1 border-b border-line bg-surface px-2 py-1">
          {onSpan && (
            <>
              <span className="mr-1 text-xs text-fg-muted">Span</span>
              {/* Adjacent steps, because zooming is something an operator does
                  repeatedly while hunting, not a setting chosen once. */}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => zoom(-1)}
                disabled={spanIdx <= 0}
                title="Zoom out — show more of the band"
                aria-label="Zoom out"
                className="w-7 px-0"
              >
                &minus;
              </Button>
              <span className="min-w-[4rem] text-center text-xs tnum text-fg sm:hidden">
                {spanLabel(SPAN_PRESETS[spanIdx]!)}
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => zoom(1)}
                disabled={spanIdx >= SPAN_PRESETS.length - 1}
                title="Zoom in — show less band in more detail"
                aria-label="Zoom in"
                className="w-7 px-0"
              >
                +
              </Button>
              <div
                role="group"
                aria-label="Span"
                className="ml-1 hidden items-center gap-0.5 sm:flex"
              >
                {SPAN_PRESETS.map((hz, i) => (
                  <Button
                    key={hz}
                    size="sm"
                    variant={i === spanIdx ? "secondary" : "ghost"}
                    aria-pressed={i === spanIdx}
                    onClick={() => onSpan(hz)}
                    title={`Show ${spanLabel(hz)} of band`}
                    className="px-1.5 tnum"
                  >
                    {spanLabel(hz)}
                  </Button>
                ))}
              </div>
            </>
          )}
          {caption && (
            <span className="ml-auto pl-2 text-xs text-fg-subtle tnum">{caption}</span>
          )}
        </div>
      )}

      {/* The spectrum stack, and the positioning context for everything that spans it:
          the gridlines, the centre mark, the dial cursor and click-to-tune. */}
      <div ref={stackRef} className="relative">
        {/* 1. The live trace. */}
        <div className="border-b border-line">
          <SpectrumTrace
            row={row}
            height={traceHeight}
            axis={{ lowHz, spanHz }}
            floorDb={floorDb}
            ceilingDb={ceilingDb}
          />
        </div>

        {/* 1b. THE BAND PLAN — which part of the band this is, and who may use it. The one
            strip that prevents a mistake rather than describing one. Above the ruler so a
            frequency reads down through segment, label and spectrum in one column. */}
        {planSegments.length > 0 && (
          <div className="relative h-4 border-b border-line bg-bg select-none">
            {planSegments.map((s) => {
              const left = pct(s.startHz);
              const width = ((s.endHz - s.startHz) / spanHz) * 100;
              const label = segmentLabel(s);
              // Only when it fits: a clipped label hides the colour, which is itself the
              // coarse answer.
              const fits =
                widthPx > 0
                  ? (width / 100) * widthPx >= label.length * LABEL_PX_PER_CHAR + 8
                  : width > 7;
              return (
                <div
                  key={`${s.startHz}-${s.mode}`}
                  className={cn(
                    "absolute inset-y-0 flex items-center overflow-hidden border-r border-bg/60",
                    s.mode === "PHONE" ? "bg-accent/25" : s.mode === "CW" ? "bg-warn/25" : "bg-ok/25",
                  )}
                  style={{ left: `${left}%`, width: `${width}%` }}
                  title={`${label} — ${formatFreqMHz(s.startHz)} to ${formatFreqMHz(s.endHz)} MHz (US Part 97)`}
                >
                  {fits && (
                    <span className="px-1 text-[10px] leading-none text-fg whitespace-nowrap">
                      {label}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* 2. The ruler: labels on a solid strip, never over the pixels. Fixed decimals for
            the step, so 7.100 never reads as a different quantity from 7.080. A label that
            would be cut in half by the edge is left off; its gridline stays. */}
        <div className="relative h-5 border-b border-line bg-surface select-none">
          {ticks.map((hz) => {
            const text = (hz / 1e6).toFixed(decimals);
            const x = (pct(hz) / 100) * widthPx;
            const half = (text.length * LABEL_PX_PER_CHAR) / 2;
            if (widthPx > 0 && (x < half || x > widthPx - half)) return null;
            return (
              <span
                key={hz}
                className="absolute top-1 -translate-x-1/2 text-[11px] leading-none text-fg-muted tnum"
                style={{ left: `${pct(hz)}%` }}
              >
                {text}
              </span>
            );
          })}
        </div>

        {/* 3. The waterfall. The axis goes in rather than a wipe key, so re-centring MOVES
            the history to where its frequencies now are instead of throwing it away. */}
        <SpectrumCanvas row={row} height={height} axis={{ lowHz, spanHz }} frameless>
          <div className="absolute right-1 bottom-1 rounded-sm bg-bg/70 px-1 text-[10px] text-fg-muted tnum">
            {binHz < 1000
              ? `${binHz.toFixed(1)} Hz/bin`
              : `${(binHz / 1000).toFixed(2)} kHz/bin`}
          </div>

          {/* THE TIME AXIS. A waterfall's vertical dimension is history; this says how
              much. Left edge, counting up from the bottom where new rows land. */}
          {timeTicks.map((t) => (
            <div
              key={t.sec}
              className="absolute left-0 flex items-center gap-1 pointer-events-none"
              style={{ top: `${t.topPx}px` }}
            >
              <div className="h-px w-1.5 bg-fg/40" />
              <span className="rounded-sm bg-bg/60 px-0.5 text-[10px] leading-none text-fg-muted tnum">
                {t.sec >= 60 ? `${Math.round(t.sec / 60)}m` : `${t.sec}s`}
              </span>
            </div>
          ))}

          {stale && (
            <div className="absolute left-8 top-2 rounded-sm bg-bg/85 px-2 py-1 text-xs text-warn">
              No new frames from the radio — this picture is not live
            </div>
          )}
        </SpectrumCanvas>

        {/* Gridlines, centre and dial span the whole stack: a frequency means the same
            thing on the trace, the ruler and the history. */}
        <div className="absolute inset-0 pointer-events-none">
          {ticks.map((hz) => (
            <div
              key={hz}
              className="absolute top-0 bottom-0 border-l border-fg/10"
              style={{ left: `${pct(hz)}%` }}
            />
          ))}

          {/* Centre of the span. Dashed, so it is never mistaken for the dial. */}
          <div
            className="absolute top-0 bottom-0 border-l border-dashed border-fg/25"
            style={{ left: "50%" }}
          />

          {/* THE PASSBAND — what you will actually hear. Read from the radio when it
              reports a filter, and only derived from the modulation when it does not;
              see passbandOf. */}
          {dialHz !== null && passband !== null && (
            <div
              className="absolute top-0 bottom-0 bg-accent/20 border-x border-accent/50"
              style={{
                left: `${pct(dialHz + passband.loHz)}%`,
                width: `${(Math.abs(passband.hiHz - passband.loHz) / spanHz) * 100}%`,
              }}
              title={`Passband ${passband.label}`}
            />
          )}

          {/* Where the receiver actually is, with a labelled handle: on a display this
              dense a two-pixel rule is lost among the signals it sits between. */}
          {dialHz !== null && dialHz > lowHz && dialHz < lowHz + spanHz && (
            <div
              className="absolute top-0 bottom-0 border-l-2 border-accent"
              style={{ left: `${pct(dialHz)}%` }}
              title={`Dial ${formatFreqMHz(dialHz)} MHz`}
            >
              <span
                className={cn(
                  "absolute -top-0.5 rounded-sm bg-accent px-1 text-[11px] font-medium text-accent-fg tnum whitespace-nowrap",
                  // Kept on the display at either edge rather than half cut off.
                  pct(dialHz) < 8 ? "left-0" : pct(dialHz) > 92 ? "right-0" : "left-0 -translate-x-1/2",
                )}
              >
                {formatFreqMHz(dialHz)}
              </span>
            </div>
          )}

          {/* Where a click would land. The whole point: see it before committing. */}
          {hoverHz !== null && (
            <div
              className="absolute top-0 bottom-0 border-l border-fg/60"
              style={{ left: `${pct(hoverHz)}%` }}
            >
              <span
                className={cn(
                  "absolute bottom-0 rounded-sm bg-bg/90 px-1 text-[11px] text-fg tnum whitespace-nowrap",
                  // Flipped near the right edge so it cannot run off the display exactly
                  // when you are tuning the top of the band.
                  pct(hoverHz) > 80 ? "right-0.5" : "left-0.5",
                )}
              >
                {formatFreqMHz(hoverHz)}
              </span>
            </div>
          )}
        </div>

        {/* Click-to-tune covers the three spectrum strips and stops at the edge of that
            stack, so the toolbar above stays reachable. Out of the tab order: the arrow
            keys are this page's keyboard tuning, and a keyboard "click" has no position
            (clientX 0), which would tune below the window. */}
        {onTune && (
          <button
            type="button"
            tabIndex={-1}
            className="absolute inset-0 w-full cursor-crosshair"
            onClick={(e) => {
              if (e.detail === 0) return;
              const rect = e.currentTarget.getBoundingClientRect();
              const frac = (e.clientX - rect.left) / rect.width;
              onTune(snapHz(lowHz + frac * spanHz, radioMode));
            }}
            onMouseMove={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const frac = (e.clientX - rect.left) / rect.width;
              // Snapped here too, so the readout is a PROMISE rather than an estimate.
              setHoverHz(snapHz(lowHz + frac * spanHz, radioMode));
            }}
            onMouseLeave={() => setHoverHz(null)}
            title={`Click to tune the radio to this frequency (snaps to ${
              tuneStepFor(radioMode) >= 1000
                ? `${tuneStepFor(radioMode) / 1000} kHz`
                : `${tuneStepFor(radioMode)} Hz`
            })`}
            aria-label="Click the spectrum to tune"
          />
        )}

        {/* SPOTS — who is on the air, drawn over everything else. After the click-to-tune
            overlay and on a raised layer, because a label underneath it would be visible
            and dead — the same trap the span buttons fell into. */}
        {visibleSpots.length > 0 && (
          <div className="absolute inset-0 z-10 pointer-events-none">
            {visibleSpots.map((s) => {
              const left = pct(s.freqHz);
              const showLabel = labelled.has(s.key);
              // Flip near the right edge, as the hover readout does.
              const flip = left > 82;
              return (
                <div
                  key={s.key}
                  className="absolute top-0 bottom-0"
                  style={{ left: `${left}%` }}
                >
                  {/* Every spot gets a marker even when its label was thinned out. */}
                  <div className="absolute inset-y-0 w-px bg-warn/70" />
                  {showLabel && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        (onSpot ?? ((sp: PanadapterSpot) => onTune?.(sp.freqHz)))(s);
                      }}
                      // tap-inline: a 44 px touch target per callsign would bury the
                      // waterfall it labels.
                      className={cn(
                        "tap-inline absolute pointer-events-auto whitespace-nowrap rounded-sm px-1",
                        "text-[11px] leading-tight font-medium tnum bg-warn text-bg",
                        "hover:ring-1 hover:ring-fg/80 cursor-pointer transition-shadow",
                        flip && "-translate-x-full",
                      )}
                      style={{ top: `${waterfallTopPx + 2}px` }}
                      title={
                        `${s.callsign} on ${formatFreqMHz(s.freqHz)} MHz` +
                        (s.mode ? ` (${s.mode})` : "") +
                        (s.detail ? ` — ${s.detail}` : "") +
                        " · click to tune here"
                      }
                    >
                      {s.callsign}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
