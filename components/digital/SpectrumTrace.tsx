import { useEffect, useRef } from "react";

// The live spectrum trace: a filled line graph of the current row.
//
// This is the "where are the conversations" display. The waterfall shows history, and
// finding activity on it means reading texture out of noise; the trace shows NOW, and a
// conversation is simply a peak.
//
// Drawn the way AetherSDR's panscope draws it (GPL-3.0, the same licence as this
// project — see resources/shaders/panscope.frag there). Three passes, and each one is
// doing a job:
//
//   1. A GRADIENT FILL under the curve. Flat grey reads as a chart; a fill that goes
//      from dark at the floor to hot at the top reads as signal strength, and it agrees
//      with the waterfall's palette underneath so the same colour means the same power
//      in both.
//   2. A FEATHER stroke — wide and faint. This is what makes the line look like it is
//      glowing rather than drawn, and it is why a single-bin carrier is still visible
//      as a spike instead of a one-pixel hairline.
//   3. A CORE stroke — thin and bright, on top.
//   4. A PEAK HOLD line, added later and for a different reason from the other three.
//
// Theirs is a GPU shader; this is the same idea on a 2D canvas, which at ten to fifteen
// rows a second costs nothing measurable.
//
// On the fill's opacity: it was nearly transparent — a clear bottom rising to 0.7 — and
// against RemoteHamRadio on the same band it read as a line drawn over darkness where
// theirs reads as a solid silhouette. Raised to 0.6-0.95 so the occupied part of the band
// is a shape rather than an outline. The COLOURS are unchanged and still track the
// waterfall's palette, which was the point of a gradient rather than flat grey: a colour
// means the same power in the trace as in the history below it.

export interface SpectrumTraceProps {
  row: { bins: Uint8Array; at: number } | null;
  height: number;
  /** Same meaning as the waterfall's: multiplies byte values before display. */
  gain?: number;
  /**
   * The frequency window the trace spans.
   *
   * A change REMAPS the smoothing buffer rather than clearing it, for the same reason the
   * waterfall remaps its history: a small re-centre should slide the picture, not blank
   * it. The trace refills in a frame or two either way, but a trace that drops to the
   * floor every time the operator clicks off to one side reads as a stall.
   */
  axis?: { lowHz: number; spanHz: number };
  /**
   * The dB window the bytes span, for the vertical scale.
   *
   * Both or neither. Without them the trace is still correct — it is a relative
   * display — but there is no way to say whether a peak is a local station or a
   * marginal one, which is half of what an operator reads a panadapter for.
   */
  floorDb?: number | null;
  ceilingDb?: number | null;
}

/** Logical pixel width of the drawing surface. CSS stretches it to the container. */
const TRACE_W = 1024;

/**
 * Decay per frame once a peak passes. About four frames to fade — slow enough that a
 * 15 s FT8 transmission reads as a steady peak, fast enough that a station that stops
 * transmitting visibly leaves.
 */
const DECAY = 0.72;

/**
 * Where the fill's colour stops sit, as a fraction of full scale, and what colour each
 * one is.
 *
 * The same progression as the waterfall palette in spectrum-canvas.tsx — dark navy
 * through blue, cyan, green, yellow to red — so a colour means the same power in the
 * trace as it does in the history below it. Two displays of one measurement disagreeing
 * on their colour scale is worse than either of them having no colour at all.
 */
const FILL_STOPS: [number, string][] = [
  [0.0, "rgba(8, 12, 30, 0.60)"],
  [0.15, "rgba(28, 52, 122, 0.75)"],
  [0.35, "rgba(30, 110, 200, 0.82)"],
  [0.55, "rgba(34, 200, 210, 0.86)"],
  [0.72, "rgba(90, 220, 120, 0.89)"],
  [0.88, "rgba(240, 210, 70, 0.92)"],
  [1.0, "rgba(255, 90, 60, 0.95)"],
];

/**
 * How fast the peak-hold line falls back, per frame.
 *
 * 0.99 is roughly ten seconds at the ten rows a second this display runs at — long enough
 * that a station which has just stopped transmitting is still visibly marked, short enough
 * that the line follows a changing band rather than accumulating every signal since the
 * page was opened.
 *
 * The point of peak hold on a panadapter is intermittent traffic. FT8 keys for thirteen
 * seconds in every fifteen and SSB is speech with gaps in it, so the instantaneous trace
 * shows an empty channel about as often as an occupied one; a station that is plainly
 * there reads as absent at the moment you happen to look. The held line is what says "this
 * frequency was busy just now", which is the question being asked when hunting.
 */
const HOLD_DECAY = 0.99;

/** dB between horizontal grid lines. 10 is what every radio's S-meter scale uses. */
const DB_GRID_STEP = 10;

export function SpectrumTrace({
  row,
  height,
  gain = 1,
  axis,
  floorDb = null,
  ceilingDb = null,
}: SpectrumTraceProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const smoothRef = useRef<Float32Array | null>(null);
  const holdRef = useRef<Float32Array | null>(null);
  const lastAtRef = useRef<number>(0);
  const drawnAxisRef = useRef<{ lowHz: number; spanHz: number } | null>(null);

  // Slide the smoothing buffer to follow the axis.
  useEffect(() => {
    if (!axis) return;
    const was = drawnAxisRef.current;
    drawnAxisRef.current = { lowHz: axis.lowHz, spanHz: axis.spanHz };
    const smooth = smoothRef.current;
    if (!was || !smooth) return;
    if (was.lowHz === axis.lowHz && was.spanHz === axis.spanHz) return;

    const w = smooth.length;
    const moved = new Float32Array(w);
    // The peak hold slides with it. It is a per-FREQUENCY memory, so leaving it behind on
    // a re-centre would park every held peak on whatever frequency now occupies that
    // pixel — the display would assert activity on frequencies that never had any, which
    // is the same class of lie the waterfall's remap exists to avoid.
    const held = holdRef.current;
    const movedHold = held ? new Float32Array(w) : null;
    for (let x = 0; x < w; x++) {
      // The frequency this pixel now shows, and where that frequency used to sit.
      const hz = axis.lowHz + ((x + 0.5) / w) * axis.spanHz;
      const src = Math.floor(((hz - was.lowHz) / was.spanHz) * w);
      // Outside the old window leaves zero: the newly-exposed edge starts at the floor
      // and rises with the next frame, rather than inheriting a neighbour's value.
      if (src >= 0 && src < w) {
        moved[x] = smooth[src]!;
        if (movedHold && held) movedHold[x] = held[src]!;
      }
    }
    smoothRef.current = moved;
    if (movedHold) holdRef.current = movedHold;
  }, [axis?.lowHz, axis?.spanHz, axis]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !row || row.at === lastAtRef.current) return;
    lastAtRef.current = row.at;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    const bins = row.bins;

    if (!smoothRef.current || smoothRef.current.length !== w) {
      smoothRef.current = new Float32Array(w);
    }
    if (!holdRef.current || holdRef.current.length !== w) {
      holdRef.current = new Float32Array(w);
    }
    const smooth = smoothRef.current;
    const hold = holdRef.current;

    for (let x = 0; x < w; x++) {
      // Peak per pixel, same reduction as the waterfall and for the same reason: an
      // average makes a single-bin carrier vanish, and a trace that misses the CW
      // station the waterfall shows would read as a broken trace.
      const from = Math.floor((x * bins.length) / w);
      const to = Math.max(from + 1, Math.floor(((x + 1) * bins.length) / w));
      let peak = 0;
      for (let b = from; b < to && b < bins.length; b++) {
        if (bins[b]! > peak) peak = bins[b]!;
      }
      const v = Math.min(1, (peak * gain) / 255);

      // Fast attack, slow decay.
      const prev = smooth[x]!;
      smooth[x] = v >= prev ? v : prev * DECAY + v * (1 - DECAY);

      // Peak hold: instant up, and a slow bleed down that never falls below the live
      // trace — otherwise the held line would sink through a signal that is still there.
      const heldPrev = hold[x]!;
      hold[x] = Math.max(smooth[x]!, v >= heldPrev ? v : heldPrev * HOLD_DECAY);
    }

    ctx.clearRect(0, 0, w, h);

    const yOf = (v: number): number => h - v * (h - 2) - 1;

    // The dB grid, first, so the trace covers it rather than the other way round.
    if (floorDb !== null && ceilingDb !== null && ceilingDb > floorDb) {
      ctx.strokeStyle = "rgba(255, 255, 255, 0.07)";
      ctx.lineWidth = 1;
      const first = Math.ceil(floorDb / DB_GRID_STEP) * DB_GRID_STEP;
      for (let db = first; db < ceilingDb; db += DB_GRID_STEP) {
        const y = Math.round(yOf((db - floorDb) / (ceilingDb - floorDb))) + 0.5;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
    }

    // 1. The gradient fill.
    const grad = ctx.createLinearGradient(0, h, 0, 0);
    for (const [at, colour] of FILL_STOPS) grad.addColorStop(at, colour);

    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let x = 0; x < w; x++) ctx.lineTo(x, yOf(smooth[x]!));
    ctx.lineTo(w - 1, h);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // The curve itself, walked once and stroked twice.
    const curve = (): void => {
      ctx.beginPath();
      for (let x = 0; x < w; x++) {
        const y = yOf(smooth[x]!);
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
    };

    // 2. The feather: wide, faint, and rounded so spikes glow instead of ending in a
    // hard mitre.
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    curve();
    ctx.strokeStyle = "rgba(120, 220, 255, 0.20)";
    ctx.lineWidth = 4;
    ctx.stroke();

    // 3. The core.
    curve();
    ctx.strokeStyle = "rgba(190, 240, 255, 0.92)";
    ctx.lineWidth = 1;
    ctx.stroke();

    // 4. The peak hold, ON TOP and deliberately unfilled.
    //
    // A thin dry line rather than another glowing stroke, because it is a different KIND
    // of statement from the rest of the display: everything else is what the receiver
    // hears now, and this is what it heard recently. Drawn last so it is never buried by
    // the live trace it sits above, and left unfilled so it can never be mistaken for
    // signal that is present.
    ctx.beginPath();
    for (let x = 0; x < w; x++) {
      const y = yOf(hold[x]!);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = "rgba(255, 210, 140, 0.55)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }, [row, gain, floorDb, ceilingDb]);

  // The dB labels are DOM rather than canvas text: the canvas is 1024 logical pixels
  // stretched to whatever width the panel is, so anything drawn as text on it is
  // stretched with it and comes out subtly wrong-shaped.
  const labels: { db: number; pct: number }[] = [];
  if (floorDb !== null && ceilingDb !== null && ceilingDb > floorDb) {
    const first = Math.ceil(floorDb / DB_GRID_STEP) * DB_GRID_STEP;
    for (let db = first; db < ceilingDb; db += DB_GRID_STEP) {
      labels.push({
        db,
        pct: (1 - (db - floorDb) / (ceilingDb - floorDb)) * 100,
      });
    }
  }

  return (
    <div className="relative">
      <canvas
        ref={canvasRef}
        width={TRACE_W}
        height={height}
        className="block w-full"
        style={{ height }}
        aria-label="Live spectrum trace"
      />
      {labels.map((l) => (
        <span
          key={l.db}
          className="absolute left-1 -translate-y-1/2 text-[9px] leading-none text-white/35 tnum pointer-events-none"
          style={{ top: `${l.pct}%` }}
        >
          {l.db}
        </span>
      ))}
      {labels.length > 0 && (
        <span className="absolute right-1 top-0.5 text-[9px] leading-none text-white/30 pointer-events-none">
          dBm
        </span>
      )}
    </div>
  );
}
