// WebGL2 plumbing shared by the spectrogram and the 3D waterfall.
//
// The history goes to the GPU as dB in an R16F texture, one row per history row, with a
// second texture holding each row's frequency axis. Only rows that changed since the last
// draw are uploaded, straight out of the history's own Float32Array (no copies), so a
// steady 4–15 frames a second costs one or two texSubImage2D calls per draw. A context
// loss, a reallocation or a cleared history re-uploads everything from the CPU copy.

import type { SpectrumHistory } from "@/lib/spectrum/history";

export function createGl(canvas: HTMLCanvasElement): WebGL2RenderingContext | null {
  try {
    return canvas.getContext("webgl2", {
      alpha: false,
      antialias: true,
      depth: true,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: "low-power",
    });
  } catch {
    return null;
  }
}

export interface Program {
  program: WebGLProgram;
  uniform: (name: string) => WebGLUniformLocation | null;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("could not create a shader");
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    const log = gl.getShaderInfoLog(shader) ?? "";
    gl.deleteShader(shader);
    throw new Error(`${type === gl.VERTEX_SHADER ? "vertex" : "fragment"} shader: ${log}`);
  }
  return shader;
}

export function createProgram(gl: WebGL2RenderingContext, vs: string, fs: string): Program {
  const program = gl.createProgram();
  if (!program) throw new Error("could not create a program");
  const v = compile(gl, gl.VERTEX_SHADER, vs);
  const f = compile(gl, gl.FRAGMENT_SHADER, fs);
  gl.attachShader(program, v);
  gl.attachShader(program, f);
  gl.linkProgram(program);
  gl.deleteShader(v);
  gl.deleteShader(f);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
    const log = gl.getProgramInfoLog(program) ?? "";
    gl.deleteProgram(program);
    throw new Error(`link: ${log}`);
  }
  const cache = new Map<string, WebGLUniformLocation | null>();
  return {
    program,
    uniform(name) {
      let loc = cache.get(name);
      if (loc === undefined) {
        loc = gl.getUniformLocation(program, name);
        cache.set(name, loc);
      }
      return loc;
    },
  };
}

/** A texture sampled with texelFetch or nearest filtering: no mipmaps, clamped. */
export function dataTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error("could not create a texture");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  // A mipmapping MIN_FILTER would leave a one-level texture incomplete, and texelFetch on
  // an incomplete texture reads zeros: a black display with no error anywhere.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

/** The colour map as a 256x1 texture, linearly filtered between entries. */
export class LutTexture {
  readonly tex: WebGLTexture;
  private current: Uint8Array | null = null;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.tex = dataTexture(gl);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, 256, 1);
  }

  set(rgba: Uint8Array): void {
    if (rgba === this.current) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    this.current = rgba;
  }

  dispose(): void {
    this.gl.deleteTexture(this.tex);
  }
}

/** Per-slot [first row, row count] for one draw, as an RG32F texture `slots` wide. */
export class RowMapTexture {
  readonly tex: WebGLTexture;
  data = new Float32Array(0);
  slots = 0;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.tex = dataTexture(gl);
  }

  /** Make room for `slots` entries. Returns the array to fill. */
  ensure(slots: number): Float32Array {
    if (slots !== this.slots) {
      const gl = this.gl;
      this.slots = slots;
      this.data = new Float32Array(slots * 2);
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, slots, 1, 0, gl.RG, gl.FLOAT, null);
    }
    return this.data;
  }

  upload(): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.slots, 1, gl.RG, gl.FLOAT, this.data, 0);
  }

  dispose(): void {
    this.gl.deleteTexture(this.tex);
  }
}

/** Rows decimated per upload chunk when the texture is narrower than the history. */
const CHUNK_ROWS = 64;

/**
 * The GPU copy of a SpectrumHistory.
 *
 *   hist: R16F, `cols` x capacity — dB, one row per history row. Half floats hold a dB value
 *         to within 1/16 dB over the range in use, far finer than the wire's byte.
 *   meta: RGBA32F, capacity x 1 — per row (low edge - refHz, Hz per column, columns, 1).
 *
 * `maxCols` narrows the texture (the 3D mesh needs far fewer columns than a 4096-bin
 * panadapter has); columns are then reduced by MAXIMUM, never by averaging.
 */
export class HistoryTextures {
  readonly hist: WebGLTexture;
  readonly meta: WebGLTexture;
  cols = 0;
  capacity = 0;
  decim = 1;
  /** refHz of the history at the last sync: view frequencies are passed relative to it. */
  refHz = 0;
  private source: SpectrumHistory | null = null;
  private epoch = -1;
  private metaEpoch = -1;
  private lastSeq = 0;
  private lastRevision = -1;
  private metaScratch = new Float32Array(0);
  private rowScratch = new Float32Array(0);
  private readonly maxTexture: number;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly maxCols = 1 << 30,
  ) {
    this.hist = dataTexture(gl);
    this.meta = dataTexture(gl);
    this.maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  }

  /** Bring the GPU copy up to date. False when this history cannot be held (too many rows). */
  sync(h: SpectrumHistory): boolean {
    if (h.capacity === 0 || h.width === 0) return false;
    if (h.capacity > this.maxTexture) return false;
    const decim = Math.max(1, Math.ceil(h.width / Math.min(this.maxCols, this.maxTexture)));
    const cols = Math.ceil(h.width / decim);
    if (
      this.source !== h ||
      this.epoch !== h.epoch ||
      this.capacity !== h.capacity ||
      this.cols !== cols ||
      this.decim !== decim
    ) {
      this.allocate(h, cols, decim);
      this.uploadSeq(h, h.seq - h.size, h.seq);
      this.writeMeta(h, h.seq - h.size, h.seq, true);
      this.finish(h);
      return true;
    }
    if (h.revision === this.lastRevision && h.metaEpoch === this.metaEpoch) return true;
    // From the previously newest row: it may have absorbed merged frames since.
    const from = Math.max(h.seq - h.size, this.lastSeq - 1);
    this.uploadSeq(h, from, h.seq);
    this.writeMeta(h, from, h.seq, this.metaEpoch !== h.metaEpoch);
    this.finish(h);
    return true;
  }

  dispose(): void {
    this.gl.deleteTexture(this.hist);
    this.gl.deleteTexture(this.meta);
  }

  private finish(h: SpectrumHistory): void {
    this.lastSeq = h.seq;
    this.lastRevision = h.revision;
    this.epoch = h.epoch;
    this.metaEpoch = h.metaEpoch;
    this.refHz = h.refHz;
  }

  private allocate(h: SpectrumHistory, cols: number, decim: number): void {
    const gl = this.gl;
    this.source = h;
    this.cols = cols;
    this.decim = decim;
    this.capacity = h.capacity;
    gl.bindTexture(gl.TEXTURE_2D, this.hist);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, cols, h.capacity, 0, gl.RED, gl.HALF_FLOAT, null);
    gl.bindTexture(gl.TEXTURE_2D, this.meta);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, h.capacity, 1, 0, gl.RGBA, gl.FLOAT, null);
    this.metaScratch = new Float32Array(h.capacity * 4);
    this.rowScratch = decim > 1 ? new Float32Array(cols * CHUNK_ROWS) : new Float32Array(0);
  }

  /** Upload history rows with sequence numbers [a, b). */
  private uploadSeq(h: SpectrumHistory, a: number, b: number): void {
    if (b - a >= h.capacity) a = b - h.capacity;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.hist);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    while (a < b) {
      const p0 = a % h.capacity;
      const n = Math.min(b - a, h.capacity - p0);
      if (this.decim === 1) {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, p0, this.cols, n, gl.RED, gl.FLOAT, h.data, p0 * h.width);
      } else {
        for (let c = 0; c < n; c += CHUNK_ROWS) {
          const rows = Math.min(CHUNK_ROWS, n - c);
          this.decimate(h, p0 + c, rows);
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, p0 + c, this.cols, rows, gl.RED, gl.FLOAT, this.rowScratch, 0);
        }
      }
      a += n;
    }
  }

  /** Peak-reduce `rows` physical rows from `p0` into rowScratch. */
  private decimate(h: SpectrumHistory, p0: number, rows: number): void {
    const k = this.decim;
    const cols = this.cols;
    const out = this.rowScratch;
    for (let r = 0; r < rows; r++) {
      const p = p0 + r;
      const count = h.count[p]!;
      const base = p * h.width;
      for (let c = 0; c < cols; c++) {
        const b0 = c * k;
        const b1 = Math.min(b0 + k, count);
        let peak = -1e4;
        for (let b = b0; b < b1; b++) {
          const v = h.data[base + b]!;
          if (v > peak) peak = v;
        }
        out[r * cols + c] = peak;
      }
    }
  }

  /** Per-row axis for rows [a, b) — or every held row when `all`. */
  private writeMeta(h: SpectrumHistory, a: number, b: number, all: boolean): void {
    if (all) {
      a = h.seq - h.size;
      b = h.seq;
    }
    if (b - a >= h.capacity) a = b - h.capacity;
    const m = this.metaScratch;
    const k = this.decim;
    for (let s = a; s < b; s++) {
      const p = s % h.capacity;
      m[p * 4] = h.lowHz[p]! - h.refHz;
      m[p * 4 + 1] = h.binHz[p]! * k;
      m[p * 4 + 2] = Math.ceil(h.count[p]! / k);
      m[p * 4 + 3] = 1;
    }
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.meta);
    while (a < b) {
      const p0 = a % h.capacity;
      const n = Math.min(b - a, h.capacity - p0);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, p0, 0, n, 1, gl.RGBA, gl.FLOAT, m, p0 * 4);
      a += n;
    }
  }
}

/**
 * GLSL shared by both views: the peak level a sample covers.
 *
 * Walks the rows the row map assigned to `slot` and, in each, the bins under [f0, f1)
 * (frequencies relative to refHz), keeping the maximum. Rows and bins beyond the loop caps
 * are strided rather than dropped from the end, so a sample spanning many bins still sees
 * the whole of its width. Returns false when no row has data there.
 */
export function peakGlsl(maxRows: number, maxBins: number): string {
  return `
uniform highp sampler2D uHist;
uniform highp sampler2D uMeta;
uniform highp sampler2D uRowMap;
uniform int uCap;

bool peakAt(int slot, float f0, float f1, out float peak) {
  vec2 rm = texelFetch(uRowMap, ivec2(slot, 0), 0).rg;
  int start = int(rm.x + 0.5);
  int count = int(rm.y + 0.5);
  peak = -1.0e30;
  bool found = false;
  int rstep = max(1, (count + ${maxRows - 1}) / ${maxRows});
  for (int k = 0; k < ${maxRows}; k++) {
    int kk = k * rstep;
    if (kk >= count) break;
    int r = (start + kk) % uCap;
    vec4 m = texelFetch(uMeta, ivec2(r, 0), 0);
    if (m.z < 0.5) continue;
    float v0 = (f0 - m.x) / m.y;
    float v1 = (f1 - m.x) / m.y;
    int b0 = int(floor(v0 + 1.0e-3));
    int b1 = int(ceil(v1 - 1.0e-3)) - 1;
    if (b1 < b0) b1 = b0;
    int last = int(m.z + 0.5) - 1;
    b0 = max(b0, 0);
    b1 = min(b1, last);
    if (b1 < b0) continue;
    int bstep = max(1, (b1 - b0 + ${maxBins}) / ${maxBins});
    for (int j = 0; j < ${maxBins}; j++) {
      int b = b0 + j * bstep;
      if (b > b1) break;
      peak = max(peak, texelFetch(uHist, ivec2(b, r), 0).r);
      found = true;
    }
  }
  return found;
}
`;
}

/** Bind the history, meta, row-map and colour textures to units 0..3 and set the samplers. */
export function bindSpectrumTextures(
  gl: WebGL2RenderingContext,
  prog: Program,
  textures: HistoryTextures,
  rowMap: RowMapTexture,
  lut: LutTexture,
): void {
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, textures.hist);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, textures.meta);
  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, rowMap.tex);
  gl.activeTexture(gl.TEXTURE3);
  gl.bindTexture(gl.TEXTURE_2D, lut.tex);
  gl.uniform1i(prog.uniform("uHist"), 0);
  gl.uniform1i(prog.uniform("uMeta"), 1);
  gl.uniform1i(prog.uniform("uRowMap"), 2);
  gl.uniform1i(prog.uniform("uLut"), 3);
  gl.uniform1i(prog.uniform("uCap"), textures.capacity);
}
