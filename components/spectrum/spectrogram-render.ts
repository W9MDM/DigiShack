// Drawing the spectrogram: WebGL2 when available, a simpler Canvas2D path when not.
//
// Both draw the same picture from the same inputs. Each output pixel row is a slice of
// time and each column a slice of frequency; the pixel shows the STRONGEST bin of every
// history row overlapping that slice, so neither zooming out in frequency nor a long history
// in a short canvas can average a narrow or brief signal away. A slice no row covers is
// drawn as the "no data" hatch, never as the bottom of the colour map.

import {
  colormapRgb,
  colormapRgba,
  CYCLE_LINE_RGBA,
  GAP_RGB_A,
  GAP_RGB_B,
  type ColormapId,
} from "@/lib/spectrum/colormaps";
import type { SpectrumHistory } from "@/lib/spectrum/history";

import {
  bindSpectrumTextures,
  createProgram,
  HistoryTextures,
  LutTexture,
  peakGlsl,
  RowMapTexture,
  type Program,
} from "./gl";

export interface SpectrogramFrame {
  history: SpectrumHistory;
  /** Bridge-clock time at the bottom edge (newest). */
  endAt: number;
  spanMs: number;
  viewLowHz: number;
  viewHighHz: number;
  loDb: number;
  rangeDb: number;
  colormap: ColormapId;
  /** Mode period for cycle rules, or null for none. */
  periodMs: number | null;
}

export interface SpectrogramRenderer {
  readonly kind: "webgl2" | "canvas2d";
  /** Size the drawing surface in device pixels. */
  resize(width: number, height: number): void;
  draw(frame: SpectrogramFrame): void;
  dispose(): void;
}

const VS = `#version 300 es
void main() {
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
precision highp int;
${peakGlsl(16, 64)}
uniform highp sampler2D uLut;
uniform vec2 uView;       // low edge (Hz, relative to refHz), span (Hz)
uniform vec2 uSize;       // drawing surface, device px
uniform vec2 uLevel;      // lo dB, 1 / range dB
uniform vec3 uGapA;
uniform vec3 uGapB;
uniform vec3 uCycle;      // first boundary (px from bottom), period (px), enabled
uniform vec4 uCycleColor;
out vec4 outColor;

void main() {
  float px = gl_FragCoord.x - 0.5;
  float py = gl_FragCoord.y - 0.5;
  float hzPerPx = uView.y / uSize.x;
  float f0 = uView.x + px * hzPerPx;
  float peak;
  vec3 c;
  if (peakAt(int(py), f0, f0 + hzPerPx, peak)) {
    float t = clamp((peak - uLevel.x) * uLevel.y, 0.0, 1.0);
    c = texture(uLut, vec2((t * 255.0 + 0.5) / 256.0, 0.5)).rgb;
  } else {
    c = mod(gl_FragCoord.x + gl_FragCoord.y, 8.0) < 4.0 ? uGapA : uGapB;
  }
  if (uCycle.z > 0.5 && mod(uCycle.x - py, uCycle.y) < 1.0) {
    c = mix(c, uCycleColor.rgb, uCycleColor.a);
  }
  outColor = vec4(c, 1.0);
}`;

/** Where the most recent cycle boundary falls, and the spacing, in pixels from the bottom. */
export function cycleRule(
  endAt: number,
  spanMs: number,
  heightPx: number,
  periodMs: number | null,
): { firstPx: number; periodPx: number } | null {
  if (!periodMs || periodMs <= 0 || !(spanMs > 0) || !(heightPx > 0)) return null;
  const msPerPx = spanMs / heightPx;
  const periodPx = periodMs / msPerPx;
  // Too dense to read as rules rather than texture.
  if (periodPx < 6) return null;
  const last = Math.floor(endAt / periodMs) * periodMs;
  return { firstPx: (endAt - last) / msPerPx, periodPx };
}

export class SpectrogramGL implements SpectrogramRenderer {
  readonly kind = "webgl2" as const;
  private prog: Program;
  private textures: HistoryTextures;
  private rowMap: RowMapTexture;
  private lut: LutTexture;
  private vao: WebGLVertexArrayObject | null;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly canvas: HTMLCanvasElement,
  ) {
    this.prog = createProgram(gl, VS, FS);
    this.textures = new HistoryTextures(gl);
    this.rowMap = new RowMapTexture(gl);
    this.lut = new LutTexture(gl);
    this.vao = gl.createVertexArray();
  }

  resize(width: number, height: number): void {
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
  }

  draw(f: SpectrogramFrame): void {
    const gl = this.gl;
    const w = this.canvas.width;
    const h = this.canvas.height;
    gl.viewport(0, 0, w, h);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);

    const ok = this.textures.sync(f.history);
    const map = this.rowMap.ensure(h);
    if (ok) f.history.buildRowMap(f.endAt, f.spanMs, h, map);
    else map.fill(0);
    this.rowMap.upload();
    this.lut.set(colormapRgba(f.colormap));

    gl.useProgram(this.prog.program);
    bindSpectrumTextures(gl, this.prog, this.textures, this.rowMap, this.lut);
    const u = this.prog.uniform;
    gl.uniform2f(u("uView"), f.viewLowHz - this.textures.refHz, f.viewHighHz - f.viewLowHz);
    gl.uniform2f(u("uSize"), w, h);
    gl.uniform2f(u("uLevel"), f.loDb, 1 / Math.max(1e-3, f.rangeDb));
    gl.uniform3f(u("uGapA"), GAP_RGB_A[0] / 255, GAP_RGB_A[1] / 255, GAP_RGB_A[2] / 255);
    gl.uniform3f(u("uGapB"), GAP_RGB_B[0] / 255, GAP_RGB_B[1] / 255, GAP_RGB_B[2] / 255);
    const cycle = cycleRule(f.endAt, f.spanMs, h, f.periodMs);
    gl.uniform3f(u("uCycle"), cycle?.firstPx ?? 0, cycle?.periodPx ?? 1, cycle ? 1 : 0);
    const [cr, cg, cb, ca] = CYCLE_LINE_RGBA;
    gl.uniform4f(u("uCycleColor"), cr / 255, cg / 255, cb / 255, ca);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    const gl = this.gl;
    if (gl.isContextLost()) return;
    this.textures.dispose();
    this.rowMap.dispose();
    this.lut.dispose();
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.prog.program);
  }
}

/**
 * The fallback: the same reduction in JavaScript into an ImageData, at CSS-pixel resolution
 * capped at 1024 x 768. Slower, so it draws less often (see the component), but the picture
 * means the same thing.
 */
export class Spectrogram2D implements SpectrogramRenderer {
  readonly kind = "canvas2d" as const;
  private image: ImageData | null = null;
  private map = new Float32Array(0);

  constructor(
    private readonly ctx: CanvasRenderingContext2D,
    private readonly canvas: HTMLCanvasElement,
  ) {}

  resize(width: number, height: number): void {
    const w = Math.max(1, Math.min(1024, width));
    const h = Math.max(1, Math.min(768, height));
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
  }

  draw(f: SpectrogramFrame): void {
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (!this.image || this.image.width !== w || this.image.height !== h) {
      this.image = this.ctx.createImageData(w, h);
      this.map = new Float32Array(h * 2);
    }
    const px = this.image.data;
    const hist = f.history;
    const lut = colormapRgb(f.colormap);
    if (hist.size > 0) hist.buildRowMap(f.endAt, f.spanMs, h, this.map);
    else this.map.fill(0);
    const hzPerPx = (f.viewHighHz - f.viewLowHz) / w;
    const inv = 1 / Math.max(1e-3, f.rangeDb);
    const cycle = cycleRule(f.endAt, f.spanMs, h, f.periodMs);
    const [cr, cg, cb, ca] = CYCLE_LINE_RGBA;

    for (let y = 0; y < h; y++) {
      // Canvas rows run top-down; slot 0 (newest) is the bottom row.
      const slot = h - 1 - y;
      const start = this.map[slot * 2]!;
      const count = this.map[slot * 2 + 1]!;
      const rule = cycle !== null && (((cycle.firstPx - slot) % cycle.periodPx) + cycle.periodPx) % cycle.periodPx < 1;
      for (let x = 0; x < w; x++) {
        const f0 = f.viewLowHz + x * hzPerPx;
        const f1 = f0 + hzPerPx;
        let peak = Number.NEGATIVE_INFINITY;
        for (let k = 0; k < count; k++) {
          const p = (start + k) % hist.capacity;
          const bh = hist.binHz[p]!;
          const low = hist.lowHz[p]!;
          let b0 = Math.floor((f0 - low) / bh + 1e-3);
          let b1 = Math.ceil((f1 - low) / bh - 1e-3) - 1;
          if (b1 < b0) b1 = b0;
          if (b0 < 0) b0 = 0;
          if (b1 > hist.count[p]! - 1) b1 = hist.count[p]! - 1;
          const o = p * hist.width;
          for (let b = b0; b <= b1; b++) {
            const v = hist.data[o + b]!;
            if (v > peak) peak = v;
          }
        }
        const i = (y * w + x) * 4;
        let r: number;
        let g: number;
        let b: number;
        if (peak === Number.NEGATIVE_INFINITY) {
          const gap = (x + slot) % 8 < 4 ? GAP_RGB_A : GAP_RGB_B;
          r = gap[0];
          g = gap[1];
          b = gap[2];
        } else {
          const t = (peak - f.loDb) * inv;
          const v = t <= 0 ? 0 : t >= 1 ? 255 : Math.round(t * 255);
          r = lut[v * 3]!;
          g = lut[v * 3 + 1]!;
          b = lut[v * 3 + 2]!;
        }
        if (rule) {
          r += (cr - r) * ca;
          g += (cg - g) * ca;
          b += (cb - b) * ca;
        }
        px[i] = r;
        px[i + 1] = g;
        px[i + 2] = b;
        px[i + 3] = 255;
      }
    }
    this.ctx.putImageData(this.image, 0, 0);
  }

  dispose(): void {
    this.image = null;
  }
}
