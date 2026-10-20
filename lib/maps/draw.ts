// The grid map, painted on a canvas.
//
// MEASURED BEFORE IT WAS CHANGED. The map was SVG, one React element per marker, and the
// whole tree re-rendered on every pointer move and on the page's one-second clock. With a
// full log on (4,000 contacts, 1,500 worked squares, 300 decodes, 200 receivers — 12,660
// DOM nodes) headless Chrome measured 50 ms a frame panning on a desktop and 46 ms for each
// clock tick; with the CPU throttled 4× as a phone stand-in, 361 ms a frame and a 0.9 s
// stall every second. A canvas redraws the same scene from arrays, and a pan touches no
// React state at all.
//
// Everything here is plain functions over a 2D context: no React, so the bench can drive it.

import { LAND_RINGS } from "@/lib/geo/land";
import type { ViewWindow } from "@/lib/geo/viewport";

import { nightPolygon, terminatorLine, twilightGrid, type SunPosition } from "./greyline";
import { MAP_COLOURS, alpha, rgbOf } from "./palette";
import {
  FIELD_H,
  FIELD_LABELS,
  FIELD_W,
  SQUARE_H,
  SQUARE_W,
  WORLD_H,
  WORLD_W,
  project,
  unproject,
} from "./projection";

/** A worked square: its north-west corner in map units, and how strongly to shade it. */
export interface WorkedCell {
  x: number;
  y: number;
  alpha: number;
}

export type MarkerKind = "live" | "logged" | "heard";

export interface Marker {
  key: string;
  kind: MarkerKind;
  x: number;
  y: number;
}
export interface LiveMarker extends Marker {
  kind: "live";
  callsign: string;
  isCq: boolean;
  /** Fades as the decode ages. */
  opacity: number;
}
export interface LoggedMarker extends Marker {
  kind: "logged";
  colour: string;
}
export interface HeardMarker extends Marker {
  kind: "heard";
}

export interface MapScene {
  worked: readonly WorkedCell[];
  logged: readonly LoggedMarker[];
  heard: readonly HeardMarker[];
  live: readonly LiveMarker[];
  home: { x: number; y: number } | null;
  /** The hovered or selected station, which gets the path and a label. */
  target: { key: string; x: number; y: number; label: string } | null;
  /** Great-circle path to the target, [lon, lat] segments. */
  path: readonly (readonly [number, number])[][] | null;
  /** Null when the greyline layer is off. */
  sun: SunPosition | null;
}

export interface Viewport {
  view: ViewWindow;
  cssW: number;
  cssH: number;
  dpr: number;
}

const FONT = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";
const TAU = Math.PI * 2;

/** CSS px per map unit. */
export function scaleOf(vp: Viewport): number {
  return vp.view.w > 0 ? vp.cssW / vp.view.w : 1;
}

/**
 * Per-canvas caches: the coastline path, the night shapes for the current minute, and the
 * logged contacts grouped by colour. Each is rebuilt only when its input changes.
 */
export class MapPainter {
  private land: Path2D | null = null;
  private nightFor: SunPosition | null = null;
  private night: { poly: Path2D; line: Path2D; twilight: HTMLCanvasElement } | null = null;
  private loggedFor: readonly LoggedMarker[] | null = null;
  private loggedByColour = new Map<string, LoggedMarker[]>();

  private landPath(): Path2D {
    if (!this.land) {
      const p = new Path2D();
      for (const ring of LAND_RINGS) {
        ring.forEach(([lon, lat], i) => {
          const q = project(lat, lon);
          if (i === 0) p.moveTo(q.x, q.y);
          else p.lineTo(q.x, q.y);
        });
        p.closePath();
      }
      this.land = p;
    }
    return this.land;
  }

  private nightShapes(sun: SunPosition) {
    if (this.night && this.nightFor === sun) return this.night;
    const poly = new Path2D();
    nightPolygon(sun, 0, 1).forEach(([lon, lat], i) => {
      const q = project(lat, lon);
      if (i === 0) poly.moveTo(q.x, q.y);
      else poly.lineTo(q.x, q.y);
    });
    poly.closePath();
    const line = new Path2D();
    terminatorLine(sun, 1).forEach(([lon, lat], i) => {
      const q = project(lat, lon);
      if (i === 0) line.moveTo(q.x, q.y);
      else line.lineTo(q.x, q.y);
    });
    // The soft band: twilight depth per degree, stretched with smoothing when drawn.
    const twilight = document.createElement("canvas");
    twilight.width = 360;
    twilight.height = 180;
    const tctx = twilight.getContext("2d");
    if (tctx) {
      const depth = twilightGrid(sun, 360, 180);
      const img = tctx.createImageData(360, 180);
      const [r, g, b] = rgbOf(MAP_COLOURS.night);
      for (let i = 0; i < depth.length; i++) {
        img.data[i * 4] = r;
        img.data[i * 4 + 1] = g;
        img.data[i * 4 + 2] = b;
        img.data[i * 4 + 3] = depth[i]!;
      }
      tctx.putImageData(img, 0, 0);
    }
    this.night = { poly, line, twilight };
    this.nightFor = sun;
    return this.night;
  }

  private groupLogged(logged: readonly LoggedMarker[]) {
    if (this.loggedFor === logged) return this.loggedByColour;
    const m = new Map<string, LoggedMarker[]>();
    for (const p of logged) {
      const list = m.get(p.colour);
      if (list) list.push(p);
      else m.set(p.colour, [p]);
    }
    this.loggedFor = logged;
    this.loggedByColour = m;
    return m;
  }

  draw(ctx: CanvasRenderingContext2D, scene: MapScene, vp: Viewport): void {
    const { view, cssW, cssH, dpr } = vp;
    const k = scaleOf(vp);
    const sx = (x: number) => (x - view.x) * k;
    const sy = (y: number) => (y - view.y) * k;
    const onScreen = (x: number, y: number, pad: number) =>
      x >= -pad && y >= -pad && x <= cssW + pad && y <= cssH + pad;
    /** Map units → device pixels, for shapes that live in map space. */
    const worldTransform = () =>
      ctx.setTransform(dpr * k, 0, 0, dpr * k, -view.x * dpr * k, -view.y * dpr * k);
    const screenTransform = () => ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    screenTransform();
    ctx.globalAlpha = 1;
    ctx.fillStyle = MAP_COLOURS.ocean;
    ctx.fillRect(0, 0, cssW, cssH);

    // Land.
    worldTransform();
    const land = this.landPath();
    ctx.fillStyle = MAP_COLOURS.land;
    ctx.fill(land);
    ctx.strokeStyle = MAP_COLOURS.coast;
    ctx.lineWidth = 1 / k;
    ctx.stroke(land);

    // Worked squares: history, so under everything live. Batched by opacity step.
    if (scene.worked.length > 0) {
      const buckets = new Map<number, WorkedCell[]>();
      for (const c of scene.worked) {
        const q = Math.round(c.alpha * 20) / 20;
        const list = buckets.get(q);
        if (list) list.push(c);
        else buckets.set(q, [c]);
      }
      ctx.fillStyle = MAP_COLOURS.worked;
      const x0 = view.x - SQUARE_W;
      const x1 = view.x + view.w;
      const y0 = view.y - SQUARE_H;
      const y1 = view.y + view.h;
      for (const [a, cells] of buckets) {
        ctx.globalAlpha = a;
        ctx.beginPath();
        for (const c of cells) {
          if (c.x < x0 || c.x > x1 || c.y < y0 || c.y > y1) continue;
          ctx.rect(c.x, c.y, SQUARE_W, SQUARE_H);
        }
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    // Day and night: a crisp night polygon, the soft twilight band, then the greyline.
    if (scene.sun) {
      const n = this.nightShapes(scene.sun);
      // Darkening alone is invisible on a near-black sea, so the whole world is lifted a
      // touch and night takes it back with interest.
      ctx.fillStyle = alpha(MAP_COLOURS.day, 0.06);
      ctx.fillRect(0, 0, WORLD_W, WORLD_H);
      ctx.fillStyle = alpha(MAP_COLOURS.night, 0.42);
      ctx.fill(n.poly);
      ctx.imageSmoothingEnabled = true;
      ctx.globalAlpha = 0.3;
      ctx.drawImage(n.twilight, 0, 0, WORLD_W, WORLD_H);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = alpha(MAP_COLOURS.terminator, 0.6);
      ctx.lineWidth = 1.25 / k;
      ctx.stroke(n.line);
    }

    // Maidenhead fields, then the square mesh once squares are big enough to aim at.
    screenTransform();
    ctx.lineWidth = 1;
    ctx.strokeStyle = MAP_COLOURS.gridLine;
    ctx.beginPath();
    for (let i = 1; i < 18; i++) {
      const x = Math.round(sx(i * FIELD_W)) + 0.5;
      const y = Math.round(sy(i * FIELD_H)) + 0.5;
      if (x > 0 && x < cssW) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, cssH);
      }
      if (y > 0 && y < cssH) {
        ctx.moveTo(0, y);
        ctx.lineTo(cssW, y);
      }
    }
    ctx.stroke();

    const squarePx = SQUARE_W * k;
    if (squarePx >= 14) {
      ctx.strokeStyle = MAP_COLOURS.squareLine;
      ctx.beginPath();
      const i0 = Math.floor(view.x / SQUARE_W);
      const i1 = Math.ceil((view.x + view.w) / SQUARE_W);
      for (let i = i0; i <= i1; i++) {
        const x = Math.round(sx(i * SQUARE_W)) + 0.5;
        ctx.moveTo(x, 0);
        ctx.lineTo(x, cssH);
      }
      const j0 = Math.floor(view.y / SQUARE_H);
      const j1 = Math.ceil((view.y + view.h) / SQUARE_H);
      for (let j = j0; j <= j1; j++) {
        const y = Math.round(sy(j * SQUARE_H)) + 0.5;
        ctx.moveTo(0, y);
        ctx.lineTo(cssW, y);
      }
      ctx.stroke();
    }

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = MAP_COLOURS.label;
    if (FIELD_W * k >= 90) {
      ctx.font = `600 ${Math.min(22, Math.max(12, FIELD_W * k * 0.12))}px ${FONT}`;
      for (const f of FIELD_LABELS) {
        const x = sx(f.x);
        const y = sy(f.y);
        if (onScreen(x, y, 30)) ctx.fillText(f.text, x, y);
      }
    }
    // Square names once a square is big enough to hold one.
    if (squarePx >= 46) {
      ctx.font = `${Math.min(13, squarePx * 0.22)}px ${FONT}`;
      const i0 = Math.floor(view.x / SQUARE_W);
      const i1 = Math.ceil((view.x + view.w) / SQUARE_W);
      const j0 = Math.floor(view.y / SQUARE_H);
      const j1 = Math.ceil((view.y + view.h) / SQUARE_H);
      for (let i = i0; i < i1; i++) {
        for (let j = j0; j < j1; j++) {
          const c = unproject((i + 0.5) * SQUARE_W, (j + 0.5) * SQUARE_H);
          const xx = c.lon + 180;
          const yy = c.lat + 90;
          if (xx < 0 || yy < 0 || xx >= 360 || yy >= 180) continue;
          const name =
            String.fromCharCode(65 + Math.floor(xx / 20)) +
            String.fromCharCode(65 + Math.floor(yy / 10)) +
            Math.floor((xx % 20) / 2) +
            Math.floor(yy % 10);
          ctx.fillText(name, sx((i + 0.5) * SQUARE_W), sy((j + 0.5) * SQUARE_H));
        }
      }
    }

    // Markers grow a little as you zoom in, so a zoomed map is not a field of pinpricks.
    const grow = Math.min(2, Math.max(0, Math.log2(Math.max(1, (WORLD_W / view.w) * 0.8))));

    // Logged contacts, one fill per band colour.
    if (scene.logged.length > 0) {
      const r = 2.4 + grow * 0.6;
      ctx.globalAlpha = 0.7;
      for (const [colour, pts] of this.groupLogged(scene.logged)) {
        ctx.fillStyle = colour;
        ctx.beginPath();
        for (const p of pts) {
          const x = sx(p.x);
          const y = sy(p.y);
          if (!onScreen(x, y, r)) continue;
          ctx.moveTo(x + r, y);
          ctx.arc(x, y, r, 0, TAU);
        }
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    // Who heard us. Hollow, so they read as ears rather than voices.
    if (scene.heard.length > 0) {
      const r = 4 + grow * 0.6;
      ctx.strokeStyle = MAP_COLOURS.heard;
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      for (const p of scene.heard) {
        const x = sx(p.x);
        const y = sy(p.y);
        if (!onScreen(x, y, r)) continue;
        ctx.moveTo(x + r, y);
        ctx.arc(x, y, r, 0, TAU);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // The living band, oldest first so the newest sit on top, CQs above the rest.
    if (scene.live.length > 0) {
      const showCalls = WORLD_W / view.w >= 2.5;
      ctx.font = `12px ${FONT}`;
      ctx.textBaseline = "bottom";
      for (const pass of [false, true]) {
        for (const s of scene.live) {
          if (s.isCq !== pass) continue;
          const x = sx(s.x);
          const y = sy(s.y);
          if (!onScreen(x, y, 60)) continue;
          const r = (s.isCq ? 4.5 : 3.2) + grow * 0.5;
          ctx.globalAlpha = s.opacity;
          ctx.beginPath();
          ctx.arc(x, y, r, 0, TAU);
          ctx.fillStyle = s.isCq ? MAP_COLOURS.cq : MAP_COLOURS.live;
          ctx.fill();
          if (s.isCq) {
            ctx.strokeStyle = MAP_COLOURS.cqRing;
            ctx.lineWidth = 1;
            ctx.stroke();
          }
          if (showCalls) haloText(ctx, s.callsign, x, y - r - 2);
        }
      }
      ctx.globalAlpha = 1;
    }

    // The path to the target, then home and the target on top of everything.
    if (scene.path && scene.home) {
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      for (const [width, colour] of [
        [4, alpha(MAP_COLOURS.halo, 0.7)],
        [1.75, alpha(MAP_COLOURS.path, 0.9)],
      ] as const) {
        ctx.strokeStyle = colour;
        ctx.lineWidth = width;
        ctx.beginPath();
        for (const seg of scene.path) {
          seg.forEach(([lon, lat], i) => {
            const q = project(lat, lon);
            if (i === 0) ctx.moveTo(sx(q.x), sy(q.y));
            else ctx.lineTo(sx(q.x), sy(q.y));
          });
        }
        ctx.stroke();
      }
    }

    if (scene.target) {
      const x = sx(scene.target.x);
      const y = sy(scene.target.y);
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, TAU);
      ctx.strokeStyle = alpha(MAP_COLOURS.halo, 0.8);
      ctx.lineWidth = 4;
      ctx.stroke();
      ctx.strokeStyle = MAP_COLOURS.selected;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.font = `600 12px ${FONT}`;
      ctx.textBaseline = "bottom";
      haloText(ctx, scene.target.label, x, y - 10);
    }

    if (scene.home) {
      const x = sx(scene.home.x);
      const y = sy(scene.home.y);
      // A ringed dot with a cross: nothing else on the map has that shape.
      ctx.lineWidth = 4;
      ctx.strokeStyle = alpha(MAP_COLOURS.halo, 0.8);
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, TAU);
      ctx.stroke();
      ctx.lineWidth = 1.75;
      ctx.strokeStyle = MAP_COLOURS.home;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x - 10, y);
      ctx.lineTo(x - 7, y);
      ctx.moveTo(x + 7, y);
      ctx.lineTo(x + 10, y);
      ctx.moveTo(x, y - 10);
      ctx.lineTo(x, y - 7);
      ctx.moveTo(x, y + 7);
      ctx.lineTo(x, y + 10);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, 2, 0, TAU);
      ctx.fillStyle = MAP_COLOURS.home;
      ctx.fill();
    }
  }
}

function haloText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number): void {
  ctx.lineWidth = 3;
  ctx.lineJoin = "round";
  ctx.strokeStyle = alpha(MAP_COLOURS.halo, 0.85);
  ctx.strokeText(text, x, y);
  ctx.fillStyle = MAP_COLOURS.selected;
  ctx.fillText(text, x, y);
}

/**
 * The marker nearest a point on the canvas, within `radius` CSS px, or null.
 *
 * Linear over every marker: a few thousand distance checks per pointer event is far below a
 * frame, and a spatial index would be one more thing to keep in step with the data.
 * Live decodes win a near-tie, then receivers, because they are what this map is for.
 */
export function hitTest(scene: MapScene, vp: Viewport, px: number, py: number, radius: number): Marker | null {
  const k = scaleOf(vp);
  let best: Marker | null = null;
  let bestD = radius * radius;
  const consider = (m: Marker, bias: number) => {
    const dx = (m.x - vp.view.x) * k - px;
    const dy = (m.y - vp.view.y) * k - py;
    const d = Math.max(0, dx * dx + dy * dy - bias);
    if (d <= bestD) {
      bestD = d;
      best = m;
    }
  };
  for (const m of scene.logged) consider(m, 0);
  for (const m of scene.heard) consider(m, 4);
  for (const m of scene.live) consider(m, 9);
  return best;
}

/** Map units of the point under a CSS-pixel position on the canvas. */
export function pointAt(vp: Viewport, px: number, py: number): { x: number; y: number } {
  const k = scaleOf(vp);
  return { x: vp.view.x + px / k, y: vp.view.y + py / k };
}
