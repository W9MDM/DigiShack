import { SpectrumCanvas } from "@/components/digital/spectrum-canvas";

// Canvas waterfall for the FT8/FT4 AUDIO passband — 0-3 kHz of what the receiver is
// demodulating, which is one signal.
//
// Kept, deliberately, now that there is an RF panadapter. It is the right display for
// FT8: the decoder searches a 3 kHz passband and the waterfall must show the same span
// or it lies about what will decode. It is also the quickest confirmation that audio is
// arriving at all. See components/digital/Panadapter.tsx for the band view, and
// docs/panadapter.md for why one cannot become the other by tuning.
//
// The drawing lives in SpectrumCanvas, shared with the panadapter. What is left here is
// the part that genuinely assumes audio: a ruler in Hz from zero, and markers placed at
// audio offsets.

export interface WaterfallMarker {
  /** Audio offset, Hz. */
  hz: number;
  label: string;
  /** Highlighted differently — used for anything mentioning the operator. */
  emphasis?: boolean;
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
}

export function Waterfall({
  row,
  binHz,
  maxHz,
  markers,
  txHz = null,
  height = 320,
  gain = 1,
}: WaterfallProps) {
  // The ruler and markers are an overlay rather than being drawn into the
  // waterfall, so they stay put instead of scrolling away with the history.
  const ticks: number[] = [];
  for (let hz = 500; hz < maxHz; hz += 500) ticks.push(hz);

  return (
    <SpectrumCanvas row={row} height={height} gain={gain} resetKey={`${maxHz}:${binHz}`}>
      {ticks.map((hz) => (
        <div
          key={hz}
          className="absolute top-0 bottom-0 border-l border-white/10"
          style={{ left: `${(hz / maxHz) * 100}%` }}
        >
          <span className="absolute top-0 left-1 text-[10px] text-white/40 tnum">{hz}</span>
        </div>
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

      <div className="absolute right-1 bottom-1 text-[10px] text-white/40 tnum">
        {binHz.toFixed(1)} Hz/bin
      </div>
    </SpectrumCanvas>
  );
}
