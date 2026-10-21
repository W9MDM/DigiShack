// Slot — the recorded feed folded on the mode's T/R period, for FT8 on the audio passband.
//
// Two panels, Even and Odd: x is audio frequency on the same axis as every other view, y is
// the last few slots of that parity, newest at the top. Each cell is 50 Hz (one FT8 signal) by
// one slot, coloured by how far it stood above the slot's quiet cells, so every signal is a
// block and a frequency that is busy cycle after cycle is a column. The panel we transmit in,
// when the station knows it, is labelled, and the clearest stretch of it is marked with a
// readout. Display only: nothing here sets the transmit frequency or keys anything.
//
// The arithmetic is in lib/spectrum/slots.ts. The fold is redone only when a row lands or a
// setting changes, from per-row cells it keeps, and the picture is a few thousand cells, so a
// draw is cheap; the images and scratch buffers are reused.

import { useEffect, useRef, useState } from "react";

import { drawAxis, newestSpan, rgba, useFeedCanvas, type ClassicViewProps } from "@/components/spectrum/ClassicViews";
import { useNightMode } from "@/lib/client/use-theme";
import { SIGNAL_WIDTH_HZ } from "@/lib/digital/slot";
import { formatUtcClock } from "@/lib/spectrum/axis";
import { colormapChrome, colormapRgb } from "@/lib/spectrum/colormaps";
import { displayWindow } from "@/lib/spectrum/levels";
import {
  clearestGap,
  DEFAULT_SLOT_COUNT,
  loadSlotCount,
  occupancy,
  saveSlotCount,
  SLOT_COUNT_CHOICES,
  slotPeriodMs,
  SlotFolder,
  type ClearGap,
} from "@/lib/spectrum/slots";
import { cn } from "@/lib/utils";

const AXIS_PX = 18;
const TITLE_PX = 16;
const PANEL_GAP_PX = 8;
/** Side by side from this CSS width; stacked below it (a phone). */
const SIDE_BY_SIDE_PX = 640;
const PARITY_LABEL = ["Even", "Odd"] as const;

export interface SlotViewProps extends ClassicViewProps {
  /** The parity we transmit in, when the station knows it (a QSO or CQ under way). */
  txParity?: 0 | 1 | null;
  /** The bridge's measured clock correction (lib/time/clock.ts): row times plus this are UTC. */
  clockOffsetMs?: number;
}

function hz(n: number): string {
  return n.toLocaleString("en-US");
}

/** Even and odd slots side by side, with the clearest frequency in the one we transmit in. */
export function Slot({ feed, contrast, colormap, height, className, txParity = null, clockOffsetMs = 0 }: SlotViewProps) {
  const night = useNightMode();
  const lut = colormapRgb(colormap);
  const chrome = colormapChrome(colormap);
  const [slots, setSlots] = useState(DEFAULT_SLOT_COUNT);
  useEffect(() => {
    try {
      setSlots(loadSlotCount(window.localStorage));
    } catch {
      /* storage blocked: the default it is */
    }
  }, []);
  const choose = (n: number) => {
    setSlots(n);
    try {
      saveSlotCount(window.localStorage, n);
    } catch {
      /* remembered for this page view only */
    }
  };

  // Written straight into the DOM from the draw, like Threshold's count: the readout follows
  // the feed, and the feed is not React state.
  const readoutRef = useRef<HTMLSpanElement>(null);
  const periodRef = useRef<HTMLSpanElement>(null);
  const state = useRef({
    folder: new SlotFolder(),
    revision: -1,
    foldKey: "",
    occ: new Float32Array(0),
    mean: new Float32Array(0),
    gaps: [null, null] as [ClearGap | null, ClearGap | null],
    /** The TX slot's hint came from both parities (see below). */
    fromBoth: false,
    img: [null, null] as [ImageData | null, ImageData | null],
    scratch: null as HTMLCanvasElement | null,
    shown: "",
    shownPeriod: "",
  });
  const offset = Number.isFinite(clockOffsetMs) ? clockOffsetMs : 0;
  // The settings the pixels depend on: a change repaints at once, even with the feed stalled.
  const key = `${colormap}|${night}|${contrast.floorOffsetDb}|${contrast.rangeDb}|${slots}|${txParity}|${offset}`;
  const ref = useFeedCanvas(
    feed,
    (g, w, h, dpr) => {
      const st = state.current;
      const hist = feed.history;
      const bg = chrome.background;
      const [gr, gg, gb, ga] = chrome.gridLine;
      const text = `rgba(${gr},${gg},${gb},${Math.min(1, ga * 4)})`;
      g.fillStyle = rgba(bg);
      g.fillRect(0, 0, w, h);

      const mode = feed.info.mode;
      const period = slotPeriodMs(mode, feed.info.periodMs);
      const periodLabel = `${mode ? `${mode} · ` : ""}${period / 1000} s slots`;
      if (periodLabel !== st.shownPeriod && periodRef.current) {
        periodRef.current.textContent = periodLabel;
        st.shownPeriod = periodLabel;
      }

      const span = newestSpan(feed);
      let fold = st.folder.fold;
      if (span) {
        // Refold only when a row landed (revision) or what the fold depends on changed.
        const foldKey = `${slots}|${period}|${offset}|${span.low}|${span.high}|${txParity}`;
        if (hist.revision !== st.revision || foldKey !== st.foldKey) {
          fold = st.folder.update(hist, { periodMs: period, slots, spanLow: span.low, spanHigh: span.high, offsetMs: offset });
          st.revision = hist.revision;
          st.foldKey = foldKey;
          const cells = fold.grid.cells;
          if (st.occ.length < cells) {
            st.occ = new Float32Array(cells);
            st.mean = new Float32Array(cells);
          }
          const signalHz = SIGNAL_WIDTH_HZ[(mode ?? "FT8").toUpperCase()] ?? 50;
          // Ours alone when known: the stations to stay clear of transmit when we do. Each
          // panel its own otherwise.
          st.fromBoth = false;
          for (const q of [0, 1] as const) {
            st.gaps[q] = null;
            if (txParity !== null && q !== txParity) continue;
            occupancy(fold, [q], st.occ, st.mean);
            st.gaps[q] = clearestGap(st.occ, st.mean, fold.grid, { signalHz });
          }
          // A station calling CQ every cycle has no received rows in its own slots at all (they
          // are all on the air). Then both parities' slots are the best evidence there is, and
          // the readout says so.
          if (txParity !== null && !st.gaps[txParity]) {
            occupancy(fold, [0, 1], st.occ, st.mean);
            st.gaps[txParity] = clearestGap(st.occ, st.mean, fold.grid, { signalHz });
            st.fromBoth = st.gaps[txParity] !== null;
          }
        }
      }
      const g0 = st.gaps[0];
      const g1 = st.gaps[1];
      const gt = txParity !== null ? st.gaps[txParity] : null;
      const label =
        !span || hist.size === 0
          ? "Clearest: —"
          : txParity !== null
            ? `Clearest: ${gt ? `${hz(gt.offsetHz)} Hz${st.fromBoth ? " (both slots)" : ""}` : "—"}`
            : `Clearest: even ${g0 ? `${hz(g0.offsetHz)} Hz` : "—"} · odd ${g1 ? `${hz(g1.offsetHz)} Hz` : "—"}`;
      if (label !== st.shown && readoutRef.current) {
        readoutRef.current.textContent = label;
        st.shown = label;
      }
      if (!span || hist.size === 0 || Number.isNaN(fold.newest)) return;

      const { cells, lowHz: gridLow, cellHz } = fold.grid;
      const spanW = span.high - span.low;
      const win = displayWindow(feed.levels.floorDb, feed.levels.spanDb, contrast);
      // Half the contrast range reaches the top of the map, as in Delta: 20 dB over the quiet
      // cells is full brightness at the default 40 dB window.
      const fullScale = Math.max(6, Math.min(30, win.rangeDb / 2));
      const gapRgb = chrome.gapA;

      const wide = w / dpr >= SIDE_BY_SIDE_PX;
      const gap = PANEL_GAP_PX * dpr;
      const pw = wide ? (w - gap) / 2 : w;
      const ph = wide ? h : (h - gap) / 2;
      if (!st.scratch) st.scratch = document.createElement("canvas");
      const sc = st.scratch;
      if (sc.width !== cells) sc.width = cells;
      if (sc.height !== fold.slots) sc.height = fold.slots;
      const scg = sc.getContext("2d")!;
      g.font = `${11 * dpr}px ui-sans-serif, system-ui, sans-serif`;

      for (const q of [0, 1] as const) {
        const px0 = wide && q === 1 ? pw + gap : 0;
        const py0 = !wide && q === 1 ? ph + gap : 0;
        const plotY = py0 + TITLE_PX * dpr;
        const plotH = ph - (TITLE_PX + AXIS_PX) * dpr;
        if (plotH < 8 || pw < 16) continue;

        // The cells, one pixel each, slot 0 (newest) on the top row.
        let img = st.img[q];
        if (!img || img.width !== cells || img.height !== fold.slots) {
          img = g.createImageData(cells, fold.slots);
          st.img[q] = img;
        }
        const px = img.data;
        for (let s = 0; s < fold.slots; s++) {
          const i = q * fold.slots + s;
          const empty = fold.rows[i] === 0;
          for (let c = 0; c < cells; c++) {
            const j = (s * cells + c) * 4;
            const v = empty ? Number.NaN : fold.level[i * cells + c]!;
            if (Number.isNaN(v)) {
              px[j] = gapRgb[0];
              px[j + 1] = gapRgb[1];
              px[j + 2] = gapRgb[2];
            } else {
              const t = Math.max(0, Math.min(1, (v - contrast.floorOffsetDb) / fullScale));
              const li = Math.round(t * 255) * 3;
              px[j] = lut[li]!;
              px[j + 1] = lut[li + 1]!;
              px[j + 2] = lut[li + 2]!;
            }
            px[j + 3] = 255;
          }
        }
        scg.putImageData(img, 0, 0);
        const xOf = (f: number) => px0 + ((f - span.low) / spanW) * pw;
        g.save();
        g.beginPath();
        g.rect(px0, plotY, pw, plotH);
        g.clip();
        g.imageSmoothingEnabled = false;
        g.drawImage(sc, xOf(gridLow), plotY, xOf(gridLow + cells * cellHz) - xOf(gridLow), plotH);
        // A rule between slots, while the rows are tall enough to need telling apart.
        const rowH = plotH / fold.slots;
        if (rowH >= 8 * dpr) {
          g.fillStyle = rgba([gr, gg, gb], ga);
          for (let s = 1; s < fold.slots; s++) g.fillRect(px0, Math.round(plotY + s * rowH), pw, Math.max(1, dpr / 2));
        }
        // The clearest stretch: a dashed outline the height of the panel, nothing louder.
        const cg = st.gaps[q];
        if (cg) {
          const x0 = xOf(cg.lowHz);
          const x1 = xOf(cg.highHz);
          g.setLineDash([3 * dpr, 3 * dpr]);
          g.lineWidth = dpr;
          g.strokeStyle = text;
          g.strokeRect(x0 + dpr / 2, plotY + dpr / 2, Math.max(dpr, x1 - x0 - dpr), plotH - dpr);
          g.setLineDash([]);
        }
        g.restore();

        // Title: which parity, ours if known, and when its newest slot started (UTC).
        g.fillStyle = text;
        g.textBaseline = "middle";
        const ours = txParity === q;
        const title = ours ? `${PARITY_LABEL[q]} · Your TX slot` : PARITY_LABEL[q];
        g.font = `${ours ? "600 " : ""}${11 * dpr}px ui-sans-serif, system-ui, sans-serif`;
        g.fillText(title, px0 + 2 * dpr, py0 + (TITLE_PX / 2) * dpr);
        g.font = `${11 * dpr}px ui-sans-serif, system-ui, sans-serif`;
        const newestIdx = fold.index[q * fold.slots]!;
        const clock = `${formatUtcClock(newestIdx * fold.periodMs)} UTC`;
        const tw = g.measureText(clock).width;
        if (tw + g.measureText(title).width + 12 * dpr < pw) g.fillText(clock, px0 + pw - tw - 2 * dpr, py0 + (TITLE_PX / 2) * dpr);

        g.save();
        g.translate(px0, py0);
        drawAxis(g, pw, ph, dpr, span.low, span.high, text);
        g.restore();
      }
    },
    key,
  );
  return (
    <div className={cn("flex flex-col", className)} style={{ height }}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line px-2 py-1 text-xs text-fg-muted">
        <div role="radiogroup" aria-label="Slots shown per parity" className="inline-flex items-center gap-1">
          <span className="shrink-0">Slots</span>
          {SLOT_COUNT_CHOICES.map((n) => {
            const on = n === slots;
            return (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => choose(n)}
                className={cn(
                  "tnum rounded-[2px] px-1.5 py-0.5 transition-colors",
                  on ? "bg-accent/20 text-accent-bright" : "hover:bg-surface-2 hover:text-fg",
                )}
              >
                {n}
              </button>
            );
          })}
        </div>
        <span ref={periodRef} className="tnum" />
        {feed.kind === "rf" && <span className="text-warn">Slot view is meant for the audio passband</span>}
        <span
          ref={readoutRef}
          className="ml-auto tnum text-fg"
          title="Transmit offset (lowest tone) that centres a signal in the least-used stretch of 200–2,800 Hz over the slots shown. Display only."
        />
      </div>
      <canvas
        ref={ref}
        aria-label="Slot view: even and odd T/R slots side by side, each cell how busy 50 Hz was in one slot"
        className="block min-h-0 w-full flex-1"
      />
    </div>
  );
}
