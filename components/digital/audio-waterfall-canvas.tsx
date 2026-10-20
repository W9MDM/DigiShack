import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { WaterfallHistory, waterfallSlots, waterfallWidth, writeWaterfallRow } from "@/lib/radio/waterfall-history";
import { useWaterfallPalette } from "./spectrum-canvas";

/** Audio history is timed; RF history and its axis remapping remain in SpectrumCanvas. */
export function AudioWaterfallCanvas({
  row, height, gain, resetKey, stepMs, viewAt, children,
}: {
  row: { bins: Uint8Array; at: number } | null;
  height: number;
  gain: number;
  resetKey: string;
  stepMs: number;
  viewAt: number;
  children?: ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const historyRef = useRef(new WaterfallHistory());
  const frameRef = useRef<ImageData | null>(null);
  const [width, setWidth] = useState(1024);
  // Night red in the night theme. History is kept as bins, so a theme change simply
  // redraws every row in the new palette.
  const palette = useWaterfallPalette();

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const measure = () => {
      const cssWidth = container.getBoundingClientRect().width;
      if (cssWidth > 0) setWidth(waterfallWidth(cssWidth, window.devicePixelRatio || 1));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    window.addEventListener("resize", measure);
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); };
  }, []);

  useEffect(() => { historyRef.current.clear(); }, [resetKey, stepMs]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d", { alpha: false });
    if (!canvas || !ctx) return;
    if (row) historyRef.current.push(row);
    let frame = frameRef.current;
    if (!frame || frame.width !== width || frame.height !== height) {
      frame = ctx.createImageData(width, height);
      frameRef.current = frame;
    }
    const slots = waterfallSlots(historyRef.current.entries, viewAt, height, stepMs);
    const empty = new Uint8Array(0);
    // On a gain/size change every historical row is recoloured from its bins, instead
    // of stretching a previously clipped bitmap. The full image buffer is reused.
    for (let y = 0; y < height; y++) {
      writeWaterfallRow(slots[y]?.bins ?? empty, frame.data.subarray(y * width * 4, (y + 1) * width * 4), width, gain, palette);
    }
    ctx.putImageData(frame, 0, 0);
  }, [row, viewAt, width, height, gain, resetKey, stepMs, palette]);

  return (
    <div ref={containerRef} className="relative overflow-hidden bg-bg">
      <canvas ref={canvasRef} width={width} height={height} className="block w-full" style={{ height, imageRendering: "pixelated" }} aria-label="Receive audio waterfall, newest at the bottom" />
      <div className="absolute inset-0 pointer-events-none">{children}</div>
    </div>
  );
}
