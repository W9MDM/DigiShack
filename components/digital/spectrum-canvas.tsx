import { useEffect, useRef } from "react";

import { remapAxis } from "@/lib/radio/panadapter";

// The scrolling canvas both waterfalls are drawn on.
//
// Lifted out of Waterfall.tsx when the RF panadapter arrived, because the drawing is
// not the part that differs. Scrolling a bitmap up one pixel, reducing bins to pixels
// by peak, and the colour ramp are identical whether the axis is 0-3000 Hz of audio
// or 7.15-7.25 MHz of band. What differs is entirely in the overlay: one labels audio
// offsets and the other labels absolute frequencies.
//
// Keeping one copy matters more than it looks. The peak-per-pixel reduction below is
// a correctness property, not an optimisation — averaging makes a single-bin carrier
// vanish — and a second hand-copied waterfall is exactly where that would have been
// quietly rewritten as an average.

/**
 * Colour ramp, modelled on the classic SDR waterfall: near-black through navy and
 * blue, into cyan, green, yellow and finally red.
 *
 * The important property is that the **bottom half is almost entirely dark blue**.
 * A waterfall spends most of its area showing noise, so if the low end of the ramp
 * carries any real colour the whole display washes out and discrete signals stop
 * being legible — which is exactly what an earlier black/violet/red/cream ramp did
 * here. Only genuine signals should reach green and above.
 */
export const PALETTE = (() => {
  // [position 0..1, r, g, b]
  const stops: [number, number, number, number][] = [
    [0.0, 0, 0, 6],
    [0.12, 0, 4, 40],
    [0.28, 0, 16, 110],
    [0.44, 0, 92, 178],
    [0.58, 0, 178, 170],
    [0.7, 40, 224, 72],
    [0.82, 214, 232, 40],
    [0.92, 255, 150, 24],
    [1.0, 255, 48, 40],
  ];

  const table = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;

    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1]![0]) k++;

    const [p0, r0, g0, b0] = stops[k]!;
    const [p1, r1, g1, b1] = stops[k + 1]!;
    const u = p1 === p0 ? 0 : (t - p0) / (p1 - p0);

    table[i * 3] = Math.round(r0 + (r1 - r0) * u);
    table[i * 3 + 1] = Math.round(g0 + (g1 - g0) * u);
    table[i * 3 + 2] = Math.round(b0 + (b1 - b0) * u);
  }
  return table;
})();

export interface SpectrumCanvasProps {
  /** Latest row, one byte per bin. Push a new object to advance the display. */
  row: { bins: Uint8Array; at: number } | null;
  height: number;
  /** Gain applied to byte values before colouring. */
  gain?: number;
  /**
   * Wipe the history and start again.
   *
   * Change this whenever the horizontal axis changes meaning. Without it the old rows
   * stay on screen underneath the new ones at their old scale, so a band change leaves
   * the previous band's signals sitting at frequencies they were never on. A waterfall
   * that lies about where a signal was is worse than one that is briefly empty.
   *
   * Prefer `axis` where the axis is a frequency window: it keeps the history instead of
   * throwing it away. This is the fallback for axes that are not a simple window.
   */
  resetKey?: string | number;

  /**
   * The frequency window the canvas currently spans — and the better option.
   *
   * Given this, a change of centre or span REMAPS the existing history onto the new axis
   * rather than wiping it: every old pixel moves to where its frequency now sits, only
   * the newly-exposed edge is blank, and the display keeps scrolling. Which is the
   * behaviour asked for in as many words — "it should only re render the missing part and
   * continue scrolling up" — and the behaviour of every hardware panadapter.
   *
   * It matters most for small moves. Clicking a signal off to one side re-centres by a
   * few tens of kHz, and wiping several minutes of history to shift the picture sideways
   * by a fifth of a screen loses far more than it redraws.
   */
  axis?: { lowHz: number; spanHz: number };
  /** Drawn over the canvas: rulers, markers, labels. */
  children?: React.ReactNode;
  /**
   * Skip the component's own border and rounding.
   *
   * For embedding inside a larger framed stack — the panadapter wraps this in its own
   * bordered container with a trace and a ruler above, and a frame inside a frame
   * reads as a layout mistake.
   */
  frameless?: boolean;
}

/** The empty-waterfall colour: the bottom of PALETTE, so a blank edge is not a black bar. */
const BACKGROUND = "#000006";

export function SpectrumCanvas({
  row,
  height,
  gain = 1,
  resetKey,
  axis,
  children,
  frameless = false,
}: SpectrumCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const lastAtRef = useRef<number>(0);
  const rowBufRef = useRef<ImageData | null>(null);
  /** The axis the pixels currently on screen were drawn against. */
  const drawnAxisRef = useRef<{ lowHz: number; spanHz: number } | null>(null);
  /** Snapshot surface for the remap. Created once, resized never. */
  const scratchRef = useRef<HTMLCanvasElement | null>(null);

  // Clear on a scale change. See resetKey — the fallback for axes `axis` cannot express.
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d", { alpha: false });
    if (!canvas || !ctx) return;
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    drawnAxisRef.current = null;
  }, [resetKey]);

  // Move the history to where its frequencies now are.
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d", { alpha: false });
    if (!canvas || !ctx || !axis) return;

    const was = drawnAxisRef.current;
    drawnAxisRef.current = { lowHz: axis.lowHz, spanHz: axis.spanHz };
    if (!was) return;
    if (was.lowHz === axis.lowHz && was.spanHz === axis.spanHz) return;

    const w = canvas.width;
    const h = canvas.height;

    // A pure pan gives a shifted rectangle of the same width; a zoom gives a narrower or
    // wider one, and scaling it to the full canvas is exactly right — the history
    // stretches with the axis, which is what makes zooming keep its context. The
    // arithmetic lives in lib/radio/panadapter.ts, where it is asserted.
    const map = remapAxis(was, axis, w);

    let scratch = scratchRef.current;
    if (!scratch) {
      scratch = document.createElement("canvas");
      scratchRef.current = scratch;
    }
    if (scratch.width !== w || scratch.height !== h) {
      scratch.width = w;
      scratch.height = h;
    }
    const sctx = scratch.getContext("2d", { alpha: false });
    if (!sctx) return;

    // Snapshot, blank, then put the overlap back in its new place. Blanking first is
    // what leaves the newly-exposed edge empty instead of holding stale pixels.
    sctx.drawImage(canvas, 0, 0);
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, w, h);

    // Null means the windows share no frequency — a band change rather than a nudge —
    // and the blank canvas is the whole answer.
    if (!map) return;

    // Nearest-neighbour, matching the pixelated rendering the canvas is displayed with.
    // Smoothing a remapped waterfall blurs every carrier into its neighbours, and after
    // a few pans the history would be visibly softer than the rows arriving now.
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      scratch,
      map.srcX0,
      0,
      map.srcX1 - map.srcX0,
      h,
      map.dstX0,
      0,
      map.dstX1 - map.dstX0,
      h,
    );
  }, [axis?.lowHz, axis?.spanHz, axis]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !row || row.at === lastAtRef.current) return;
    lastAtRef.current = row.at;

    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;

    // Scroll up one pixel. drawImage onto itself is well-defined and hardware
    // accelerated; round-tripping through getImageData would be far slower.
    ctx.drawImage(canvas, 0, -1);

    if (!rowBufRef.current || rowBufRef.current.width !== w) {
      rowBufRef.current = ctx.createImageData(w, 1);
    }
    const line = rowBufRef.current;
    const px = line.data;
    const bins = row.bins;

    for (let x = 0; x < w; x++) {
      // Take the strongest bin each pixel covers, so a narrow signal stays visible
      // whatever the canvas width relative to the bin count. Averaging would make
      // a single-bin carrier vanish — which on a panadapter is every CW station and
      // every FT8 tone.
      const from = Math.floor((x * bins.length) / w);
      const to = Math.max(from + 1, Math.floor(((x + 1) * bins.length) / w));
      let peak = 0;
      for (let b = from; b < to && b < bins.length; b++) {
        if (bins[b]! > peak) peak = bins[b]!;
      }
      const v = Math.max(0, Math.min(255, Math.round(peak * gain)));
      const o = x * 4;
      px[o] = PALETTE[v * 3]!;
      px[o + 1] = PALETTE[v * 3 + 1]!;
      px[o + 2] = PALETTE[v * 3 + 2]!;
      px[o + 3] = 255;
    }

    ctx.putImageData(line, 0, h - 1);
  }, [row, gain]);

  return (
    <div
      className={
        frameless
          ? "relative bg-bg overflow-hidden"
          : "relative bg-bg border border-line rounded-sm overflow-hidden"
      }
    >
      <canvas
        ref={canvasRef}
        width={1024}
        height={height}
        className="block w-full"
        style={{ height, imageRendering: "pixelated" }}
      />
      <div className="absolute inset-0 pointer-events-none">{children}</div>
    </div>
  );
}
