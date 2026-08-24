import { useEffect, useRef, useState } from "react";

import { SpectrumCanvas } from "@/components/digital/spectrum-canvas";
import { SpectrumTrace } from "@/components/digital/SpectrumTrace";
import { formatFreqMHz } from "@/lib/ham/bands";
import { segmentLabel, segmentsIn } from "@/lib/ham/band-plan";

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
const SPAN_PRESETS: { label: string; hz: number }[] = [
  { label: "1 MHz", hz: 1_000_000 },
  { label: "500k", hz: 500_000 },
  { label: "200k", hz: 200_000 },
  { label: "100k", hz: 100_000 },
  { label: "50k", hz: 50_000 },
  { label: "20k", hz: 20_000 },
  { label: "5k", hz: 5_000 },
];

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

export function labelledSpots(
  spotsInWindow: PanadapterSpot[],
  lowHz: number,
  spanHz: number,
): Set<string> {
  const out = new Set<string>();
  let lastPct = -Infinity;
  for (const s of spotsInWindow) {
    const p = ((s.freqHz - lowHz) / spanHz) * 100;
    if (p - lastPct >= LABEL_GAP_PCT) {
      out.add(s.key);
      lastPct = p;
    }
  }
  return out;
}

/**
 * Tick spacing that gives roughly six to ten labels across the span.
 *
 * Chosen from the span rather than fixed, because this display covers anything from
 * 5 kHz to 7 MHz. A fixed 500 Hz ruler — which is what the audio waterfall uses — would
 * be 14,000 lines at 7 MHz.
 */
function tickStepHz(spanHz: number): number {
  const rough = spanHz / 8;
  const pow = 10 ** Math.floor(Math.log10(rough));
  for (const mult of [1, 2, 2.5, 5, 10]) {
    if (rough <= pow * mult) return pow * mult;
  }
  return pow * 10;
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
}: PanadapterProps) {
  // Where the mouse is, in Hz. Null when it is not over the spectrum.
  //
  // This is the single thing that made click-to-tune discoverable. The caption said
  // "click the spectrum to tune" and the only marker was a two-pixel line, so there
  // was no way to tell WHERE a click would land until after making it — which is not
  // how any other SDR behaves, and is why it did not feel like tuning.
  const [hoverHz, setHoverHz] = useState<number | null>(null);

  // How long one waterfall row represents, measured rather than assumed.
  //
  // The canvas scrolls exactly one pixel per row, so a row's duration IS the display's
  // vertical scale — "vertical resolution is time", as docs/panadapter.md puts it. It
  // cannot be taken from the configured frame rate, because that is what was ASKED for:
  // the radio delivered 95 against a request of 100, a busy bridge drops frames, and a
  // band change pauses the sweep entirely. An axis built on the request would be
  // confidently wrong in exactly the conditions where an operator looks at it.
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
    // Re-render only on a change worth showing.
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
  const step = tickStepHz(spanHz);
  const ticks: number[] = [];
  for (
    let hz = Math.ceil(lowHz / step) * step;
    hz < lowHz + spanHz;
    hz += step
  ) {
    ticks.push(hz);
  }

  const pct = (hz: number): number => ((hz - lowHz) / spanHz) * 100;
  const passband = passbandOf(radioMode, filterLoHz, filterHiHz);

  // Only the spots inside the window, and only as many as can be read.
  //
  // A 1 MHz span over a busy weekend can hold sixty activators, which as labels is an
  // unreadable stack of overlapping text that hides the very spectrum it describes. Sorted
  // by frequency and thinned so no two labels sit within a few percent of each other —
  // the ones dropped are the ones that would have been illegible anyway, and the marker
  // line is still drawn for every spot so nothing vanishes silently.
  const visibleSpots = spots
    .filter((s) => s.freqHz > lowHz && s.freqHz < lowHz + spanHz)
    .sort((a, b) => a.freqHz - b.freqHz);
  const labelled = labelledSpots(visibleSpots, lowHz, spanHz);
  const planSegments = segmentsIn(lowHz, lowHz + spanHz);

  return (
    <div className="relative bg-bg border border-line rounded-sm overflow-hidden">
      {/* Zoom. Above the display rather than below it, because it changes what the
          display means and a control that changes the axis belongs with the axis.
          OUTSIDE the spectrum stack below, which is what makes these clickable at all:
          click-to-tune is an overlay filling its container, and while the buttons were
          siblings inside that same container the overlay covered them. Every attempt to
          zoom retuned the radio instead. */}
      {onSpan && (
        <div className="flex items-center gap-1 px-2 py-1 border-b border-line/60 bg-bg-raised/40">
          <span className="text-[10px] uppercase tracking-wide text-fg-subtle mr-1">
            Span
          </span>
          {/* Zoom in and out, one preset at a time.
              The preset row alone made every span reachable but none of them adjacent —
              narrowing from 200k meant reading seven labels and picking the next. Both
              reference clients put a pair of magnifiers on the display for exactly this,
              because zooming is something an operator does repeatedly while hunting, not
              a setting they choose once. */}
          {(() => {
            // Presets are widest first, so zooming IN moves forward through the list.
            const idx = SPAN_PRESETS.reduce(
              (best, c, i) =>
                Math.abs(c.hz - spanHz) < Math.abs(SPAN_PRESETS[best]!.hz - spanHz)
                  ? i
                  : best,
              0,
            );
            const step = (delta: number) => {
              const next = SPAN_PRESETS[idx + delta];
              if (next) onSpan(next.hz);
            };
            const btn =
              "px-1.5 py-0.5 text-[11px] rounded-sm border leading-none transition-colors " +
              "border-line text-fg-muted hover:text-fg hover:border-fg-subtle " +
              "disabled:opacity-30 disabled:hover:text-fg-muted disabled:hover:border-line";
            return (
              <>
                <button
                  type="button"
                  onClick={() => step(1)}
                  disabled={idx >= SPAN_PRESETS.length - 1}
                  className={btn}
                  title="Zoom in — show less band in more detail"
                  aria-label="Zoom in"
                >
                  +
                </button>
                <button
                  type="button"
                  onClick={() => step(-1)}
                  disabled={idx <= 0}
                  className={btn}
                  title="Zoom out — show more of the band"
                  aria-label="Zoom out"
                >
                  &minus;
                </button>
                <span className="w-px h-3.5 bg-line mx-0.5" />
              </>
            );
          })()}
          {SPAN_PRESETS.map((p) => {
            // Nearest preset wins the highlight: the radio clamps spans to what it
            // supports, so an exact match is not guaranteed and none of them would
            // light up after a clamp.
            const active =
              SPAN_PRESETS.reduce((best, c) =>
                Math.abs(c.hz - spanHz) < Math.abs(best.hz - spanHz) ? c : best,
              ).hz === p.hz;
            return (
              <button
                key={p.hz}
                type="button"
                onClick={() => onSpan(p.hz)}
                className={
                  "px-1.5 py-0.5 text-[10px] rounded-sm border tnum transition-colors " +
                  (active
                    ? "border-accent text-accent-bright bg-accent/10"
                    : "border-line text-fg-muted hover:text-fg hover:border-fg-subtle")
                }
                title={`Show ${(p.hz / 1000).toFixed(0)} kHz of band`}
              >
                {p.label}
              </button>
            );
          })}
        </div>
      )}

      {/* The spectrum stack, and the positioning context for everything that spans it:
          the gridlines, the centre mark, the dial cursor and click-to-tune. Its own
          container rather than the outer one, so those overlays reach exactly the three
          strips and nothing else. */}
      <div className="relative">
        {/* 1. The live trace. */}
        <div className="border-b border-line/60">
          <SpectrumTrace
            row={row}
            height={traceHeight}
            axis={{ lowHz, spanHz }}
            floorDb={floorDb}
            ceilingDb={ceilingDb}
          />
        </div>

        {/* 1b. THE BAND PLAN — which part of the band this is, and who may use it.
            Reported as "I don't see the labels as to what part of the band it is, phone,
            cw etc", and it is the strip both Aether and RemoteHamRadio put here. It is
            also the only thing on this display that prevents a mistake rather than
            describing one: everything else says what the band is doing, this says whether
            you may join in. Above the ruler so a frequency reads down through segment,
            label and spectrum in one column. */}
        {planSegments.length > 0 && (
          <div className="relative h-4 border-b border-line/60 bg-bg select-none">
            {planSegments.map((s) => {
              const left = pct(s.startHz);
              const width = ((s.endHz - s.startHz) / spanHz) * 100;
              return (
                <div
                  key={`${s.startHz}-${s.mode}`}
                  className={
                    "absolute inset-y-0 flex items-center overflow-hidden border-r border-black/40 " +
                    (s.mode === "PHONE"
                      ? "bg-accent/25"
                      : s.mode === "CW"
                        ? "bg-warn/25"
                        : "bg-ok/25")
                  }
                  style={{ left: `${left}%`, width: `${width}%` }}
                  title={`${segmentLabel(s)} — ${formatFreqMHz(s.startHz)} to ${formatFreqMHz(s.endHz)} MHz (US Part 97)`}
                >
                  {/* Only when it fits. A clipped label on a 2% sliver is unreadable and
                      hides the colour, which is itself the coarse answer. */}
                  {width > 7 && (
                    <span className="px-1 text-[9px] leading-none uppercase tracking-wide text-fg whitespace-nowrap">
                      {segmentLabel(s)}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* 2. The ruler: labels on a solid strip, never over the pixels. */}
        <div className="relative h-5 border-b border-line/60 bg-bg-raised/60 select-none">
          {ticks.map((hz) => (
            <span
              key={hz}
              className="absolute top-0.5 -translate-x-1/2 text-[10px] leading-none text-fg-muted tnum"
              style={{ left: `${pct(hz)}%` }}
            >
              {/* Fixed decimals rather than formatFreqMHz, which trims trailing zeros —
                a ruler reading 7.04, 7.06, 7.08, 7.1, 7.12 makes the 7.1 tick look
                like a different quantity from its neighbours. */}
              {(hz / 1e6).toFixed(spanHz < 50_000 ? 4 : 3)}
            </span>
          ))}
        </div>

        {/* 3. The waterfall.
            The axis goes in rather than a wipe key, so re-centring MOVES the history to
            where its frequencies now are instead of throwing it away. Clicking a signal
            off to one side used to blank several minutes of waterfall in order to shift
            the picture by a fifth of a screen. Only the newly-exposed edge is blank now,
            and the display keeps scrolling. */}
        <SpectrumCanvas
          row={row}
          height={height}
          axis={{ lowHz, spanHz }}
          frameless
        >
          <div className="absolute right-1 bottom-1 text-[10px] text-white/45 tnum">
            {binHz < 1000
              ? `${binHz.toFixed(1)} Hz/bin`
              : `${(binHz / 1000).toFixed(2)} kHz/bin`}
          </div>

          {/* THE TIME AXIS. A waterfall's vertical dimension is history, and until now
              nothing said how much: whether a trace two thirds up was ten seconds old or
              two minutes was unanswerable. Both reference clients show this.
              Left edge, because the right already carries the bin width, and counting up
              from the bottom because that is where new rows land. */}
          {timeTicks.map((t) => (
            <div
              key={t.sec}
              className="absolute left-0 flex items-center gap-1 pointer-events-none"
              style={{ top: `${t.topPx}px` }}
            >
              <div className="h-px w-1.5 bg-white/35" />
              <span className="text-[9px] leading-none text-white/45 tnum">
                {t.sec >= 60
                  ? `${Math.round(t.sec / 60)}m`
                  : `${t.sec}s`}
              </span>
            </div>
          ))}
        </SpectrumCanvas>

        {/* Gridlines, centre and dial span the whole stack: a frequency means the same
          thing on the trace, the ruler and the history. */}
        <div className="absolute inset-0 pointer-events-none">
          {ticks.map((hz) => (
            <div
              key={hz}
              className="absolute top-0 bottom-0 border-l border-white/10"
              style={{ left: `${pct(hz)}%` }}
            />
          ))}

          {/* Centre of the span. Dotted, so it is never mistaken for the dial. */}
          <div
            className="absolute top-0 bottom-0 border-l border-dashed border-white/25"
            style={{ left: "50%" }}
          />

          {/* THE PASSBAND — what you will actually hear.
              A hairline said where the dial was and nothing said how wide the receiver
              was listening, so an SSB signal 2 kHz off the dial looked identical to one
              dead on it. Shading the filter is what every other SDR draws, and it is the
              part that turns a picture of the band into something you can tune with.
              Read from the radio when it reports a filter, and only derived from the
              modulation when it does not; see passbandOf. */}
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

          {/* Where the receiver actually is. Usually the centre, but not while the
            operator is tuning around inside a fixed span. */}
          {dialHz !== null && dialHz > lowHz && dialHz < lowHz + spanHz && (
            <div
              className="absolute top-0 bottom-0 border-l-2 border-accent"
              style={{ left: `${pct(dialHz)}%` }}
              title={`Dial ${formatFreqMHz(dialHz)} MHz`}
            >
              {/* A labelled handle, not just a line. On a display this dense a
                  two-pixel rule is lost among the signals it is meant to sit between. */}
              <span className="absolute -top-0.5 left-0 -translate-x-1/2 rounded-sm bg-accent px-1 text-[10px] font-medium text-black tnum whitespace-nowrap">
                {formatFreqMHz(dialHz)}
              </span>
            </div>
          )}

          {/* Where a click would land. The whole point: see it before committing. */}
          {hoverHz !== null && (
            <div
              className="absolute top-0 bottom-0 border-l border-white/60 pointer-events-none"
              style={{ left: `${pct(hoverHz)}%` }}
            >
              <span
                className={
                  "absolute bottom-0 text-[10px] tnum whitespace-nowrap bg-black/80 px-1 rounded-sm text-white " +
                  // Flip the label to the other side near the right edge so it cannot
                  // run off the display exactly when you are tuning the top of the band.
                  (pct(hoverHz) > 80 ? "right-0.5" : "left-0.5")
                }
              >
                {formatFreqMHz(hoverHz)}
              </span>
            </div>
          )}
        </div>

        {/* Click-to-tune covers the three spectrum strips — clicking a peak on the trace
          should tune there exactly as clicking its stripe on the waterfall does — and
          stops at the edge of that stack, so the Span buttons above stay reachable. */}
        {onTune && (
          <button
            type="button"
            className="absolute inset-0 w-full cursor-crosshair"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const frac = (e.clientX - rect.left) / rect.width;
              onTune(snapHz(lowHz + frac * spanHz, radioMode));
            }}
            onMouseMove={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const frac = (e.clientX - rect.left) / rect.width;
              // Snapped here too, so the readout is a PROMISE rather than an estimate.
              // A cursor that says 7.502553 and a radio that lands on 7.5025 teaches an
              // operator to distrust the readout, which is the one thing on this display
              // that has to be believable.
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

        {/* SPOTS — who is on the air, drawn over everything else.
            AFTER the click-to-tune overlay in the DOM and on a raised layer, because that
            overlay fills the stack: a label underneath it would be visible and dead, which
            is the same trap the Span buttons fell into. */}
        {visibleSpots.length > 0 && (
          <div className="absolute inset-0 z-10 pointer-events-none">
            {visibleSpots.map((s) => {
              const left = pct(s.freqHz);
              const showLabel = labelled.has(s.key);
              // Flip near the right edge, exactly as the hover readout does, or the
              // callsign runs off the display for the spots highest in the band.
              const flip = left > 82;
              return (
                <div
                  key={s.key}
                  className="absolute top-0 bottom-0"
                  style={{ left: `${left}%` }}
                >
                  {/* Every spot gets a marker even when its label was thinned out, so a
                      crowded band still shows where the activity is. */}
                  <div className="absolute inset-y-0 w-px bg-warn/70" />
                  {showLabel && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        (onSpot ?? ((sp: PanadapterSpot) => onTune?.(sp.freqHz)))(s);
                      }}
                      className={
                        "absolute pointer-events-auto whitespace-nowrap rounded-sm px-1 " +
                        "text-[10px] leading-tight font-medium tnum bg-warn text-black " +
                        "hover:ring-1 hover:ring-white/80 cursor-pointer transition-shadow " +
                        (flip ? "-translate-x-full" : "")
                      }
                      style={{ top: `${traceHeight + 22}px` }}
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
