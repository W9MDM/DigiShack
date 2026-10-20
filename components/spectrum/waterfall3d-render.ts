// Drawing the 3D waterfall: a fixed grid mesh whose vertex shader reads its height and
// colour straight out of the history textures.
//
// The geometry never changes after it is built. A new frame is one texture row and a new
// row map, uploaded the same way the spectrogram uploads them; the vertex shader does the
// rest. Each vertex takes the strongest bin under its column and the strongest row in its
// time slice — the same peak rule as the spectrogram, so a narrow carrier stands up as a
// ridge instead of being averaged into the floor between two vertices.
//
// Newest row at the front edge, history receding. Where no row covers a slice (an outage,
// or history not yet collected) the surface is cut away, and the grid underneath shows.

import {
  cameraEye,
  FOV_Y,
  lookAt,
  mat4,
  multiply,
  perspective,
  type OrbitCamera,
} from "@/lib/spectrum/camera";
import { BACKGROUND_RGB, colormapRgba, type ColormapId } from "@/lib/spectrum/colormaps";
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

/** World extents: frequency across x, time along z (newest at +z), level up y. */
export const HALF_WIDTH = 1;
export const HALF_DEPTH = 0.75;
export const BASE_HEIGHT = 0.42;

/** Mesh resolution. Columns beyond the texture's are pointless; 512 holds a 3 kHz passband at 6 Hz. */
const COLUMNS = 512;
const SLOTS = 192;
/** The 3D texture keeps at most this many columns, peak-reduced. */
const MAX_TEXTURE_COLUMNS = 1024;
const MAX_LINE_VERTICES = 512;

export interface Waterfall3DFrame {
  history: SpectrumHistory;
  /** Bridge-clock time at the front edge. */
  endAt: number;
  depthMs: number;
  viewLowHz: number;
  viewHighHz: number;
  loDb: number;
  rangeDb: number;
  colormap: ColormapId;
  heightScale: number;
  camera: OrbitCamera;
  /** Frequencies (Hz) for grid lines along the time axis. */
  freqTicks: readonly number[];
  /** Times before endAt (ms) for grid lines across the surface. */
  timeTicks: Float64Array;
  timeTickCount: number;
}

const SURFACE_VS = `#version 300 es
precision highp float;
precision highp int;
${peakGlsl(8, 16)}
in vec2 aUV;
uniform vec2 uView;      // low edge (Hz, relative to refHz), span (Hz)
uniform vec2 uLevel;     // lo dB, 1 / range dB
uniform vec2 uGrid;      // columns - 1, slots - 1
uniform float uHeight;
uniform vec2 uExtent;    // half width, half depth
uniform mat4 uMVP;
out float vLevel;
out float vNoData;
out vec3 vPos;

void main() {
  int slot = int(aUV.y * uGrid.y + 0.5);
  float colHz = uView.y / uGrid.x;
  float fc = uView.x + aUV.x * uView.y;
  float peak;
  bool ok = peakAt(slot, fc - 0.5 * colHz, fc + 0.5 * colHz, peak);
  float t = ok ? clamp((peak - uLevel.x) * uLevel.y, 0.0, 1.0) : 0.0;
  vLevel = t;
  vNoData = ok ? 0.0 : 1.0;
  vec3 pos = vec3((aUV.x * 2.0 - 1.0) * uExtent.x, t * uHeight, (1.0 - 2.0 * aUV.y) * uExtent.y);
  vPos = pos;
  gl_Position = uMVP * vec4(pos, 1.0);
}`;

const SURFACE_FS = `#version 300 es
precision highp float;
uniform highp sampler2D uLut;
uniform vec3 uLight;
in float vLevel;
in float vNoData;
in vec3 vPos;
out vec4 outColor;

void main() {
  if (vNoData > 0.5) discard;
  // Facet normal from screen-space derivatives: shape without a normal pass.
  vec3 n = normalize(cross(dFdx(vPos), dFdy(vPos)));
  if (n.y < 0.0) n = -n;
  float diffuse = max(dot(n, uLight), 0.0);
  vec3 base = texture(uLut, vec2((vLevel * 255.0 + 0.5) / 256.0, 0.5)).rgb;
  outColor = vec4(base * (0.45 + 0.55 * diffuse), 1.0);
}`;

const LINE_VS = `#version 300 es
in vec3 aPos;
uniform mat4 uMVP;
void main() {
  gl_Position = uMVP * vec4(aPos, 1.0);
}`;

const LINE_FS = `#version 300 es
precision mediump float;
uniform vec4 uColor;
out vec4 outColor;
void main() {
  outColor = uColor;
}`;

export class Waterfall3DGL {
  readonly mvp = mat4();
  private readonly proj = mat4();
  private readonly view = mat4();
  private readonly eye = new Float32Array(3);
  private surface: Program;
  private lines: Program;
  private textures: HistoryTextures;
  private rowMap: RowMapTexture;
  private lut: LutTexture;
  private surfaceVao: WebGLVertexArrayObject | null;
  private lineVao: WebGLVertexArrayObject | null;
  private uvBuffer: WebGLBuffer | null;
  private indexBuffer: WebGLBuffer | null;
  private lineBuffer: WebGLBuffer | null;
  private readonly lineData = new Float32Array(MAX_LINE_VERTICES * 3);
  private readonly indexCount: number;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly canvas: HTMLCanvasElement,
  ) {
    this.surface = createProgram(gl, SURFACE_VS, SURFACE_FS);
    this.lines = createProgram(gl, LINE_VS, LINE_FS);
    this.textures = new HistoryTextures(gl, MAX_TEXTURE_COLUMNS);
    this.rowMap = new RowMapTexture(gl);
    this.lut = new LutTexture(gl);

    // The grid: (u, v) per vertex, u along frequency, v from newest (0) to oldest (1).
    const uv = new Float32Array(COLUMNS * SLOTS * 2);
    for (let j = 0; j < SLOTS; j++) {
      for (let i = 0; i < COLUMNS; i++) {
        const o = (j * COLUMNS + i) * 2;
        uv[o] = i / (COLUMNS - 1);
        uv[o + 1] = j / (SLOTS - 1);
      }
    }
    const idx = new Uint32Array((COLUMNS - 1) * (SLOTS - 1) * 6);
    let n = 0;
    for (let j = 0; j < SLOTS - 1; j++) {
      for (let i = 0; i < COLUMNS - 1; i++) {
        const a = j * COLUMNS + i;
        const b = a + 1;
        const c = a + COLUMNS;
        const d = c + 1;
        idx[n++] = a;
        idx[n++] = c;
        idx[n++] = b;
        idx[n++] = b;
        idx[n++] = c;
        idx[n++] = d;
      }
    }
    this.indexCount = n;

    this.surfaceVao = gl.createVertexArray();
    gl.bindVertexArray(this.surfaceVao);
    this.uvBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW);
    const uvLoc = gl.getAttribLocation(this.surface.program, "aUV");
    gl.enableVertexAttribArray(uvLoc);
    gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 0, 0);
    this.indexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);

    this.lineVao = gl.createVertexArray();
    gl.bindVertexArray(this.lineVao);
    this.lineBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.lineData.byteLength, gl.DYNAMIC_DRAW);
    const posLoc = gl.getAttribLocation(this.lines.program, "aPos");
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  resize(width: number, height: number): void {
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
  }

  /** Draw a frame. Returns the model-view-projection used, for placing DOM labels. */
  draw(f: Waterfall3DFrame): Float32Array {
    const gl = this.gl;
    const w = this.canvas.width;
    const h = this.canvas.height;
    gl.viewport(0, 0, w, h);
    gl.clearColor(BACKGROUND_RGB[0] / 255, BACKGROUND_RGB[1] / 255, BACKGROUND_RGB[2] / 255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    perspective(this.proj, FOV_Y, w / Math.max(1, h), 0.05, 50);
    const e = cameraEye(f.camera, this.eye);
    lookAt(this.view, e[0]!, e[1]!, e[2]!, f.camera.tx, f.camera.ty, f.camera.tz);
    multiply(this.mvp, this.proj, this.view);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);

    const span = f.viewHighHz - f.viewLowHz;
    const nLines = this.buildLines(f, span);
    if (nLines > 0) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(this.lines.program);
      gl.uniformMatrix4fv(this.lines.uniform("uMVP"), false, this.mvp);
      gl.uniform4f(this.lines.uniform("uColor"), 1, 1, 1, 0.16);
      gl.bindVertexArray(this.lineVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.lineData, 0, nLines * 3);
      gl.drawArrays(gl.LINES, 0, nLines);
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
    }

    if (!this.textures.sync(f.history) || span <= 0) return this.mvp;
    const map = this.rowMap.ensure(SLOTS);
    // Each vertex row is a sample point; its slice is centred on it.
    const dt = f.depthMs / (SLOTS - 1);
    f.history.buildRowMap(f.endAt + dt / 2, dt * SLOTS, SLOTS, map);
    this.rowMap.upload();
    this.lut.set(colormapRgba(f.colormap));

    gl.useProgram(this.surface.program);
    bindSpectrumTextures(gl, this.surface, this.textures, this.rowMap, this.lut);
    const u = this.surface.uniform;
    gl.uniform2f(u("uView"), f.viewLowHz - this.textures.refHz, span);
    gl.uniform2f(u("uLevel"), f.loDb, 1 / Math.max(1e-3, f.rangeDb));
    gl.uniform2f(u("uGrid"), COLUMNS - 1, SLOTS - 1);
    gl.uniform1f(u("uHeight"), BASE_HEIGHT * f.heightScale);
    gl.uniform2f(u("uExtent"), HALF_WIDTH, HALF_DEPTH);
    gl.uniformMatrix4fv(u("uMVP"), false, this.mvp);
    const l = Math.hypot(-0.35, 0.85, 0.45);
    gl.uniform3f(u("uLight"), -0.35 / l, 0.85 / l, 0.45 / l);
    gl.bindVertexArray(this.surfaceVao);
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
    return this.mvp;
  }

  dispose(): void {
    const gl = this.gl;
    if (gl.isContextLost()) return;
    this.textures.dispose();
    this.rowMap.dispose();
    this.lut.dispose();
    gl.deleteBuffer(this.uvBuffer);
    gl.deleteBuffer(this.indexBuffer);
    gl.deleteBuffer(this.lineBuffer);
    gl.deleteVertexArray(this.surfaceVao);
    gl.deleteVertexArray(this.lineVao);
    gl.deleteProgram(this.surface.program);
    gl.deleteProgram(this.lines.program);
  }

  /** Base grid and edge ticks, a hair below the surface so data covers them. Returns vertex count. */
  private buildLines(f: Waterfall3DFrame, span: number): number {
    const d = this.lineData;
    let n = 0;
    const y = -0.002;
    const push = (x0: number, z0: number, x1: number, z1: number) => {
      if (n + 2 > MAX_LINE_VERTICES) return;
      d[n * 3] = x0;
      d[n * 3 + 1] = y;
      d[n * 3 + 2] = z0;
      d[n * 3 + 3] = x1;
      d[n * 3 + 4] = y;
      d[n * 3 + 5] = z1;
      n += 2;
    };
    // Outline.
    push(-HALF_WIDTH, HALF_DEPTH, HALF_WIDTH, HALF_DEPTH);
    push(-HALF_WIDTH, -HALF_DEPTH, HALF_WIDTH, -HALF_DEPTH);
    push(-HALF_WIDTH, -HALF_DEPTH, -HALF_WIDTH, HALF_DEPTH);
    push(HALF_WIDTH, -HALF_DEPTH, HALF_WIDTH, HALF_DEPTH);
    if (span > 0) {
      for (const hz of f.freqTicks) {
        const x = ((hz - f.viewLowHz) / span) * 2 * HALF_WIDTH - HALF_WIDTH;
        if (x < -HALF_WIDTH || x > HALF_WIDTH) continue;
        push(x, -HALF_DEPTH, x, HALF_DEPTH + 0.06);
      }
    }
    for (let i = 0; i < f.timeTickCount; i++) {
      const ago = f.timeTicks[i]!;
      if (ago < 0 || ago > f.depthMs) continue;
      const z = HALF_DEPTH - (ago / f.depthMs) * 2 * HALF_DEPTH;
      push(-HALF_WIDTH, z, HALF_WIDTH + 0.06, z);
    }
    return n;
  }
}
