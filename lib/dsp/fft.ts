// Radix-2 in-place FFT.
//
// Hand-rolled rather than pulled in: this is one well-understood function, it runs
// several times a second in the bridge, and the alternative is a dependency in the
// hot path of a process that also has to finish decoding inside a 2.4-second gap.
//
// Real input only, which is what audio is. `transform` expects power-of-two length.

/** Precomputed twiddle factors and bit-reversal table for one transform size. */
export class FftPlan {
  readonly size: number;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  private readonly rev: Uint32Array;
  private readonly window: Float64Array;

  /** Scratch, reused across calls so a per-frame FFT allocates nothing. */
  private readonly re: Float64Array;
  private readonly im: Float64Array;

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) {
      throw new Error(`FFT size must be a power of two, got ${size}`);
    }
    this.size = size;

    const half = size >> 1;
    this.cos = new Float64Array(half);
    this.sin = new Float64Array(half);
    for (let i = 0; i < half; i++) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / size);
      this.sin[i] = Math.sin((-2 * Math.PI * i) / size);
    }

    // Bit-reversal permutation.
    this.rev = new Uint32Array(size);
    const bits = Math.log2(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
      this.rev[i] = r;
    }

    // Hann window. Without it, a tone that doesn't land exactly on a bin smears
    // across the whole spectrum — which on a waterfall looks like a wall of noise
    // rather than a signal.
    this.window = new Float64Array(size);
    for (let i = 0; i < size; i++) {
      this.window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
    }

    this.re = new Float64Array(size);
    this.im = new Float64Array(size);
  }

  /**
   * Magnitude spectrum of `input` in dB, written into `out`.
   *
   * `out.length` bins are returned, covering the low end of the spectrum — for
   * audio that is all anyone wants, since FT8/FT4 live below 3 kHz.
   */
  magnitudeDb(input: ArrayLike<number>, out: Float32Array, offset = 0): void {
    const n = this.size;
    const { re, im, rev, cos, sin, window } = this;

    // Load bit-reversed and windowed in one pass.
    for (let i = 0; i < n; i++) {
      const src = offset + i;
      const v = src < input.length ? (input[src] as number) : 0;
      re[rev[i]!] = v * window[i]!;
      im[rev[i]!] = 0;
    }

    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let j = 0; j < half; j++) {
          const k = j * step;
          const c = cos[k]!;
          const s = sin[k]!;
          const a = i + j;
          const b = a + half;
          const tre = re[b]! * c - im[b]! * s;
          const tim = re[b]! * s + im[b]! * c;
          re[b] = re[a]! - tre;
          im[b] = im[a]! - tim;
          re[a] = re[a]! + tre;
          im[a] = im[a]! + tim;
        }
      }
    }

    // Normalise to dBFS so the numbers mean something absolute: a full-scale
    // sinusoid reads ~0 dB regardless of FFT size.
    //
    // For a real input, single-sided amplitude = 2|X| / (N * coherentGain), and
    // Hann's coherent gain is 0.5 — hence 4|X|/N. Skipping this is what produced a
    // waterfall that saturated to solid white: the raw magnitudes scale with N and
    // with input level, so any hardcoded display window is guesswork.
    const scale = 4 / n;
    const bins = Math.min(out.length, n >> 1);
    for (let i = 0; i < bins; i++) {
      const mag = Math.sqrt(re[i]! * re[i]! + im[i]! * im[i]!) * scale;
      // Floor rather than -Infinity: a silent bin must still be a drawable number.
      out[i] = 20 * Math.log10(mag + 1e-12);
    }
  }

  /** Hz per bin for a given sample rate. */
  binHz(sampleRate: number): number {
    return sampleRate / this.size;
  }
}
