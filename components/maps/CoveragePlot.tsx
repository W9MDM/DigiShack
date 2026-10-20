import { memo, useCallback, useMemo, useRef, useState } from "react";

import { useActiveTheme } from "@/lib/client/use-theme";
import type { ViewWindow } from "@/lib/geo/viewport";
import type { DistanceUnit } from "@/lib/maps/geodesy";
import { mapColourFor } from "@/lib/maps/palette";
import { PLOT_SIZE, radiusFor, ringsFor, wedgePath } from "@/lib/maps/polar";

import { ZoomControls } from "./ZoomControls";
import { useMapGestures } from "./useMapGestures";

export interface PlotDot {
  key: string;
  x: number;
  y: number;
  colour: string;
}

const SIZE = PLOT_SIZE;
const CENTRE = SIZE / 2;
const BOUNDS = { width: SIZE, height: SIZE };
const WHOLE: ViewWindow = { x: 0, y: 0, w: SIZE, h: SIZE };
/** About 8× at most: the dots are 2.5 units across and nothing finer is meaningful. */
const MIN_W = SIZE * 0.12;

/** Zoom snapped to steps of 1.25×, so a pan never re-renders the dots and a zoom rarely does. */
function zoomStep(view: ViewWindow): number {
  const z = SIZE / view.w;
  return Math.pow(1.25, Math.round(Math.log(z) / Math.log(1.25)));
}

/**
 * Everything that does not move with the view, memoised: a pan changes only the viewBox.
 *
 * The dots are one <path> per band colour rather than one <circle> each. 4,000 circles with a
 * <title> apiece was 8,000 nodes React re-rendered on every pointer move; a path per colour
 * is ten, and the nearest-dot lookup below replaces the per-dot titles and click handlers.
 */
const PlotLayers = memo(function PlotLayers({
  groups,
  unit,
  deadSectors,
  zoom,
}: {
  groups: readonly { colour: string; fill: string; dots: readonly PlotDot[] }[];
  unit: DistanceUnit;
  deadSectors: readonly number[];
  zoom: number;
}) {
  const r = 2.5 / Math.pow(zoom, 0.6);
  const font = 10 / zoom;
  return (
    <>
      {/* Directions never worked, shaded where they are rather than only listed. */}
      {deadSectors.map((from) => (
        <path key={from} d={wedgePath(from, from + 22.5)} className="fill-danger" fillOpacity={0.08} />
      ))}
      {ringsFor(unit).map((ring) => (
        <g key={ring.label}>
          <circle
            cx={CENTRE}
            cy={CENTRE}
            r={radiusFor(ring.km)}
            fill="none"
            className="stroke-line"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
          <text x={CENTRE + 4 / zoom} y={CENTRE - radiusFor(ring.km) + 12 / zoom} className="fill-fg-subtle" fontSize={font}>
            {ring.label}
          </text>
        </g>
      ))}
      {[0, 45, 90, 135, 180, 225, 270, 315].map((deg) => {
        const rad = ((deg - 90) * Math.PI) / 180;
        return (
          <line
            key={deg}
            x1={CENTRE}
            y1={CENTRE}
            x2={CENTRE + CENTRE * Math.cos(rad)}
            y2={CENTRE + CENTRE * Math.sin(rad)}
            className="stroke-line"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        );
      })}
      {(
        [
          ["N", 0],
          ["E", 90],
          ["S", 180],
          ["W", 270],
        ] as const
      ).map(([label, deg]) => {
        const rad = ((deg - 90) * Math.PI) / 180;
        const r2 = CENTRE - 10 / zoom;
        return (
          <text
            key={label}
            x={CENTRE + r2 * Math.cos(rad)}
            y={CENTRE + r2 * Math.sin(rad) + 4 / zoom}
            textAnchor="middle"
            className="fill-fg-muted font-display"
            fontSize={12 / zoom}
          >
            {label}
          </text>
        );
      })}
      {groups.map((g) => (
        <path
          key={g.colour}
          fill={g.fill}
          opacity={0.75}
          d={g.dots
            .map((d) => `M${(d.x - r).toFixed(2)},${d.y.toFixed(2)}a${r},${r} 0 1 0 ${2 * r},0a${r},${r} 0 1 0 ${-2 * r},0`)
            .join("")}
        />
      ))}
    </>
  );
});

/** The polar coverage plot, with pan, pinch, wheel and keyboard zoom, and tappable dots. */
export function CoveragePlot({
  dots,
  unit,
  deadSectors,
  highlight,
  onPick,
  onHover,
}: {
  dots: readonly PlotDot[];
  unit: DistanceUnit;
  /** Starting bearings of the 22.5° sectors with no contacts. */
  deadSectors: readonly number[];
  /** The selected or hovered dot. */
  highlight: string | null;
  onPick: (key: string | null) => void;
  onHover: (key: string | null) => void;
}) {
  const [view, setViewState] = useState<ViewWindow>(WHOLE);
  const viewRef = useRef(view);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const hoverKey = useRef<string | null>(null);

  const setView = useCallback((v: ViewWindow) => {
    viewRef.current = v;
    setViewState(v);
  }, []);
  const reset = useCallback(() => setView(WHOLE), [setView]);

  // Band colours are a rainbow; at night each is moved onto the red-amber line, as on the map.
  const theme = useActiveTheme();
  const groups = useMemo(() => {
    const m = new Map<string, PlotDot[]>();
    for (const d of dots) {
      const list = m.get(d.colour);
      if (list) list.push(d);
      else m.set(d.colour, [d]);
    }
    return [...m.entries()].map(([colour, list]) => ({ colour, fill: mapColourFor(colour, theme), dots: list }));
  }, [dots, theme]);

  /** The nearest dot to a point on the element, within `radius` CSS px. */
  const nearest = (px: number, py: number, radius: number): PlotDot | null => {
    const r = svgRef.current?.getBoundingClientRect();
    const v = viewRef.current;
    if (!r || !(r.width > 0)) return null;
    const k = r.width / v.w;
    let best: PlotDot | null = null;
    let bestD = radius * radius;
    for (const d of dots) {
      const dx = (d.x - v.x) * k - px;
      const dy = (d.y - v.y) * k - py;
      const dd = dx * dx + dy * dy;
      if (dd <= bestD) {
        bestD = dd;
        best = d;
      }
    }
    return best;
  };

  const hover = (key: string | null) => {
    if (key === hoverKey.current) return;
    hoverKey.current = key;
    if (svgRef.current) svgRef.current.style.cursor = key ? "pointer" : "";
    onHover(key);
  };

  const g = useMapGestures({
    ref: svgRef,
    getView: () => viewRef.current,
    setView,
    reset,
    bounds: BOUNDS,
    minW: MIN_W,
    onTap: (x, y, type) => onPick(nearest(x, y, type === "mouse" ? 10 : 22)?.key ?? null),
    onHover: (x, y) => hover(nearest(x, y, 10)?.key ?? null),
    onHoverEnd: () => hover(null),
    onEscape: () => onPick(null),
  });

  const zoom = zoomStep(view);
  const hl = highlight ? dots.find((d) => d.key === highlight) : undefined;
  const actual = SIZE / view.w;

  return (
    <div className="flex flex-col">
      <ZoomControls
        zoomed={view.w < SIZE - 0.5}
        onZoom={(f) => g.zoomAt(f)}
        onReset={reset}
        hint="Drag to pan · scroll or double-click to zoom"
        touchHint="Drag to pan · pinch to zoom · tap a dot"
      />
      <div className="flex justify-center p-2">
        <svg
          ref={svgRef}
          width="100%"
          viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
          className="max-w-[560px] aspect-square touch-none select-none cursor-grab"
          role="img"
          tabIndex={0}
          aria-label="Contacts by bearing and distance. Arrow keys pan, plus and minus zoom, 0 resets."
          {...g.handlers}
        >
          <PlotLayers groups={groups} unit={unit} deadSectors={deadSectors} zoom={zoom} />
          {hl && (
            <circle
              cx={hl.x}
              cy={hl.y}
              r={6 / actual}
              fill="none"
              className="stroke-fg"
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
            />
          )}
          {/* Home. Drawn last so it is never hidden under a contact. */}
          <circle cx={CENTRE} cy={CENTRE} r={3.5 / actual} className="fill-accent-bright" />
        </svg>
      </div>
    </div>
  );
}
