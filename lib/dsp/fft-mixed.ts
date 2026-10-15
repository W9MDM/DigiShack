// A complex FFT for any length, mixed radix.
//
// lib/dsp/fft.ts is radix-2 and that is right for the waterfall. The JS8 decoder follows
// WSJT-X's sizes, which are not powers of two: a 3840-point spectrogram (two symbols at
// 1920 samples), a 192000-point downconversion (the whole 15 s period at a hundred samples
// per... symbol-count), a 3200-point inverse. All factor into 2, 3 and 5, and a
// decimation-in-time recursion over the smallest prime factor handles those - and, more
// slowly, any other length. Allocations are per level; the sizes here are small enough
// that this costs tens of milliseconds a period, which is what it has to be.
//
// Forward is exp(-i), inverse exp(+i) without the 1/N, as FFTW and WSJT-X's four2a do.

function smallestFactor(n: number): number {
  if (n % 2 === 0) return 2;
  for (let p = 3; p * p <= n; p += 2) if (n % p === 0) return p;
  return n;
}

/** In place. `re`/`im` are length n. `sign` is -1 forward, +1 inverse. */
export function fftMixed(re: Float64Array, im: Float64Array, sign: -1 | 1 = -1): void {
  const n = re.length;
  if (n <= 1) return;
  const p = smallestFactor(n);
  const m = n / p;
  if (p === n) {
    // A prime length: the direct transform.
    const outRe = new Float64Array(n);
    const outIm = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      let sr = 0;
      let si = 0;
      for (let t = 0; t < n; t++) {
        const ang = (sign * 2 * Math.PI * ((k * t) % n)) / n;
        const c = Math.cos(ang);
        const s = Math.sin(ang);
        sr += re[t]! * c - im[t]! * s;
        si += re[t]! * s + im[t]! * c;
      }
      outRe[k] = sr;
      outIm[k] = si;
    }
    re.set(outRe);
    im.set(outIm);
    return;
  }
  // Split into p interleaved sequences, transform each, combine with twiddles.
  const subRe: Float64Array[] = [];
  const subIm: Float64Array[] = [];
  for (let r = 0; r < p; r++) {
    const sr = new Float64Array(m);
    const si = new Float64Array(m);
    for (let j = 0; j < m; j++) {
      sr[j] = re[j * p + r]!;
      si[j] = im[j * p + r]!;
    }
    fftMixed(sr, si, sign);
    subRe.push(sr);
    subIm.push(si);
  }
  for (let k = 0; k < n; k++) {
    const kk = k % m;
    let sr = 0;
    let si = 0;
    for (let r = 0; r < p; r++) {
      const ang = (sign * 2 * Math.PI * ((r * k) % n)) / n;
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      const xr = subRe[r]![kk]!;
      const xi = subIm[r]![kk]!;
      sr += xr * c - xi * s;
      si += xr * s + xi * c;
    }
    re[k] = sr;
    im[k] = si;
  }
}

/** Forward transform of real samples; returns the full complex spectrum (n bins). */
export function fftReal(x: ArrayLike<number>): { re: Float64Array; im: Float64Array } {
  const re = Float64Array.from(x as ArrayLike<number>);
  const im = new Float64Array(re.length);
  fftMixed(re, im, -1);
  return { re, im };
}
