// What setting would read this RTTY signal? Measured from its timing.
//
// An RTTY signal with the tones on it but the wrong speed or the wrong polarity reads as
// junk - the operator found one on 14.085 and could only guess. The waterfall cannot tell
// you: 45.45 and 75 baud look the same at 5.9 Hz a column, and so do the two polarities.
// Decoding at every setting does not settle it either - tried first, and a 50 baud signal
// read at 45.45 frames perfectly well, because a 10% clock error over seven and a half
// bits still lands every stop bit on mark; it just reads the wrong letters.
//
// The signal's own timing does settle it. Every run of one tone lasts a whole number of
// bits - or, on the mark side, a whole number and a half, because the stop bit is one and
// a half bits long and always mark. So:
//
//   SPEED. Measure the runs between tone changes with a short filter that does not assume
//   a speed. At the right baud every run is a multiple of half a bit; at a wrong one they
//   scatter. A run that fits 50 baud also fits 100 (half of 240 is 120), so the answer is
//   the SLOWEST speed the runs fit.
//
//   POLARITY. With the speed known, half-bit runs appear only on the mark side. If the tone
//   the decoder calls space is the one with the half-bit runs, the station is the other
//   way round.
//
// Nothing changes on its own: the panel offers the suggestion and the operator applies it.

export const RTTY_BAUDS = [45.45, 50, 75, 100] as const;

export interface RttySuggestion {
  baud: number;
  /** Swap mark and space relative to what the decoder is using now. */
  swap: boolean;
  /** How many tone runs the suggestion rests on. */
  runs: number;
  /** How well the runs fit the suggested speed's half-bit grid: 0 perfect, 0.5 random. */
  fit: number;
}

/** A sliding single-tone filter, magnitude squared: the RTTY demodulator's, shorter. */
class Tone {
  private readonly bufI: Float64Array;
  private readonly bufQ: Float64Array;
  private sumI = 0;
  private sumQ = 0;
  private head = 0;
  private phase = 0;
  private readonly dphi: number;
  constructor(fs: number, hz: number, private readonly len: number) {
    this.bufI = new Float64Array(len);
    this.bufQ = new Float64Array(len);
    this.dphi = (2 * Math.PI * hz) / fs;
  }
  step(x: number): number {
    const i = x * Math.cos(this.phase);
    const q = -x * Math.sin(this.phase);
    this.phase += this.dphi;
    if (this.phase > 2 * Math.PI) this.phase -= 2 * Math.PI;
    this.sumI += i - this.bufI[this.head]!;
    this.sumQ += q - this.bufQ[this.head]!;
    this.bufI[this.head] = i;
    this.bufQ[this.head] = q;
    this.head = (this.head + 1) % this.len;
    return this.sumI * this.sumI + this.sumQ * this.sumQ;
  }
}

interface Run {
  /** +1: the tone the decoder calls mark; -1: the one it calls space. */
  side: 1 | -1;
  samples: number;
}

/** Runs kept: about thirty characters' worth. */
const MAX_RUNS = 240;
/** Fewer runs than this and nothing is said. */
const MIN_RUNS = 60;
/** A grid fit at or under this is a fit; random lengths average 0.25. */
const FIT_OK = 0.1;
/** |decision| a run must hold on average to count: a run of noise does not. */
const RUN_CONFIDENCE = 0.75;

export class RttyProbe {
  private readonly fs: number;
  private readonly mark: Tone;
  private readonly space: Tone;
  private side: 1 | -1 | 0 = 0;
  private runLen = 0;
  private runConf = 0;
  private readonly runs: Run[] = [];

  constructor(
    sampleRate: number,
    markHz: number,
    spaceHz: number,
    private readonly currentBaud: number,
  ) {
    this.fs = sampleRate;
    // One over the shift: a boxcar that long has its first null exactly on the other tone,
    // so each filter hears its own and not its neighbour, and at 170 Hz that is 5.9 ms -
    // well under the shortest bit on offer (10 ms at 100 baud), so every transition shows.
    const shift = Math.max(20, Math.abs(markHz - spaceHz));
    const len = Math.max(8, Math.round(sampleRate / shift));
    this.mark = new Tone(sampleRate, markHz, len);
    this.space = new Tone(sampleRate, spaceHz, len);
  }

  feed(samples: ArrayLike<number>): void {
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i]!;
      const m = this.mark.step(x);
      const s = this.space.step(x);
      const d = m + s > 0 ? (m - s) / (m + s) : 0;
      // Hysteresis: a side changes only when the other tone clearly takes over.
      let next = this.side;
      if (d > 0.3) next = 1;
      else if (d < -0.3) next = -1;
      if (next !== this.side) {
        if (this.side !== 0 && this.runLen > 0 && this.runConf / this.runLen >= RUN_CONFIDENCE) {
          this.runs.push({ side: this.side, samples: this.runLen });
          if (this.runs.length > MAX_RUNS) this.runs.shift();
        }
        this.side = next;
        this.runLen = 0;
        this.runConf = 0;
      }
      this.runLen++;
      this.runConf += Math.abs(d);
    }
  }

  /** How well the runs sit on a half-bit grid at `baud`: mean distance to the nearest step, in steps. */
  private fit(baud: number): number {
    const half = this.fs / (baud === 45.45 ? 1000 / 22 : baud) / 2;
    let err = 0;
    let n = 0;
    for (const r of this.runs) {
      const k = r.samples / half;
      // One bit to about eight: shorter is a glitch, longer is idle carrier.
      if (k < 1.6 || k > 17) continue;
      err += Math.abs(k - Math.round(k));
      n++;
    }
    return n >= MIN_RUNS ? err / n : 1;
  }

  /** The share of a side's runs that are an odd number of half bits: the stop bit's mark. */
  private halfBitShare(side: 1 | -1, baud: number): number {
    const half = this.fs / (baud === 45.45 ? 1000 / 22 : baud) / 2;
    let odd = 0;
    let n = 0;
    for (const r of this.runs) {
      if (r.side !== side) continue;
      const k = Math.round(r.samples / half);
      if (k < 2 || k > 17) continue;
      if (k % 2 === 1) odd++;
      n++;
    }
    return n > 0 ? odd / n : 0;
  }

  /** The speed and polarity the signal's timing says, when that differs from what the decoder uses. */
  suggestion(): RttySuggestion | null {
    if (this.runs.length < MIN_RUNS) return null;
    let baud: number | null = null;
    let fit = 1;
    for (const b of RTTY_BAUDS) {
      const f = this.fit(b);
      if (f <= FIT_OK) {
        baud = b;
        fit = f;
        break;
      }
    }
    if (baud === null) return null;
    const markOdd = this.halfBitShare(1, baud);
    const spaceOdd = this.halfBitShare(-1, baud);
    const swap = spaceOdd > markOdd + 0.1;
    if (!swap && Math.abs(baud - this.currentBaud) < 0.01) return null;
    return { baud, swap, runs: this.runs.length, fit: Math.round(fit * 100) / 100 };
  }
}
