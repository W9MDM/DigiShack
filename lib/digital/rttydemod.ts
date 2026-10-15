// RTTY demodulator: a continuous stream of audio in, characters out.
//
// NOT A WINDOW DECODER. FT8, FT4, FT2 and WSPR are all decoded from a buffer of one T/R
// period, because their transmissions are aligned to the clock. RTTY has no period: a
// station types, the line idles on mark between keystrokes, and a decoder has to run the
// whole time, keeping its state - filter history, bit clock, shift - across whatever size
// of audio chunk it is handed. So this is a class with `feed()`, not a function over a
// window, and it is cheap enough (two oscillators and four running sums per sample) to
// live on the main thread beside the DAX socket.
//
// HOW. Each tone is detected with a complex mixer and a boxcar integrator one bit long -
// the matched filter for a rectangular bit. The two magnitudes become one decision signal
// d = (mark - space) / (mark + space), which is +1 on a clean mark, -1 on a clean space,
// and independent of signal level, so no AGC is needed and the two tones may differ in
// strength (they do, through a filter edge). The character clock is the UART's: wait on
// mark for the mark-to-space edge of a start bit, confirm it half a bit later (a noise
// glitch does not last that long), sample the five data bits at edge + 1.5, 2.5 ... 5.5
// bits, and demand mark at edge + 6.5 (the stop bit). A bad stop is a framing error: the
// character is dropped and the search for the next start bit begins at once, which is how
// the decoder re-locks after a fade without ever having been "in sync" to begin with.
//
// The matched filter's group delay is half a bit; it shifts the edge and every sample
// instant equally, so the schedule above holds in filtered time with no correction.
//
// BAUD AND FREQUENCY ERRORS. The clock restarts at every start bit, so a 1 % speed error
// costs 0.075 bits by the stop bit and nothing accumulates. The one-bit boxcar has its
// first null 45 Hz from the tone, so a signal 20 Hz off is still well inside the main
// lobe; past about 60 Hz it is time to retune, and the tone levels this exposes are how a
// page shows the operator that.
//
// It knows nothing of ITA2 beyond the frame: codes go to Ita2Decoder, which owns the
// shift state.

import { Ita2Decoder, RTTY_BAUD, RTTY_DATA_BITS, type RttyCodeOptions } from "@/lib/digital/rtty";

export interface RttyDemodOptions extends RttyCodeOptions {
  sampleRate: number;
  markHz: number;
  spaceHz: number;
  baud?: number;
}

export interface RttyDemodStats {
  /** Characters delivered, including spaces and newlines. */
  chars: number;
  /** Start bits that were followed by a bad stop bit. */
  framingErrors: number;
  /** Tone magnitudes at the last sample, linear, for a tuning display. */
  mark: number;
  space: number;
  /** Decision signal at the last sample, -1 (space) to +1 (mark). */
  decision: number;
}

/** A one-bit boxcar integrator of a complex mixer: the matched filter for one tone. */
class ToneFilter {
  private readonly bufI: Float64Array;
  private readonly bufQ: Float64Array;
  private sumI = 0;
  private sumQ = 0;
  private head = 0;
  private phase = 0;
  private dphi: number;

  constructor(
    private readonly sampleRate: number,
    hz: number,
    private readonly length: number,
  ) {
    this.bufI = new Float64Array(length);
    this.bufQ = new Float64Array(length);
    this.dphi = (2 * Math.PI * hz) / sampleRate;
  }

  retune(hz: number): void {
    this.dphi = (2 * Math.PI * hz) / this.sampleRate;
  }

  /** Feed one sample, get the filter's output magnitude squared. */
  step(x: number): number {
    const i = x * Math.cos(this.phase);
    const q = -x * Math.sin(this.phase);
    this.phase += this.dphi;
    if (this.phase > 2 * Math.PI) this.phase -= 2 * Math.PI;
    this.sumI += i - this.bufI[this.head]!;
    this.sumQ += q - this.bufQ[this.head]!;
    this.bufI[this.head] = i;
    this.bufQ[this.head] = q;
    this.head++;
    if (this.head === this.length) this.head = 0;
    return this.sumI * this.sumI + this.sumQ * this.sumQ;
  }
}

export class RttyDemodulator {
  private readonly fs: number;
  private readonly samplesPerBit: number;
  private readonly mark: ToneFilter;
  private readonly space: ToneFilter;
  private readonly ita2: Ita2Decoder;

  // The character clock, in samples since the detected start edge.
  private state: "idle" | "confirm" | "data" = "idle";
  private sinceEdge = 0;
  private nextSampleAt = 0;
  private bitIndex = 0;
  private code = 0;
  private lastDecision = 1;

  private readonly stats: RttyDemodStats = { chars: 0, framingErrors: 0, mark: 0, space: 0, decision: 1 };

  constructor(opts: RttyDemodOptions) {
    this.fs = opts.sampleRate;
    this.samplesPerBit = opts.sampleRate / (opts.baud ?? RTTY_BAUD);
    const len = Math.max(4, Math.round(this.samplesPerBit));
    this.mark = new ToneFilter(opts.sampleRate, opts.markHz, len);
    this.space = new ToneFilter(opts.sampleRate, opts.spaceHz, len);
    this.ita2 = new Ita2Decoder(opts);
  }

  /** Move the tone pair while running. Filter history is kept; it is a bit long and flushes itself. */
  retune(markHz: number, spaceHz: number): void {
    this.mark.retune(markHz);
    this.space.retune(spaceHz);
  }

  get statistics(): Readonly<RttyDemodStats> {
    return this.stats;
  }

  /** Forget the character clock and the shift. The next start bit begins again. */
  reset(): void {
    this.state = "idle";
    this.ita2.reset();
  }

  /**
   * Feed audio; get whatever text completed inside it. Chunks of any size, including one
   * sample, give the same text as one large call.
   */
  feed(samples: ArrayLike<number>): string {
    let out = "";
    const spb = this.samplesPerBit;
    for (let n = 0; n < samples.length; n++) {
      const x = samples[n] as number;
      const m = this.mark.step(x);
      const s = this.space.step(x);
      const d = (m - s) / (m + s + 1e-12);
      this.stats.mark = Math.sqrt(m);
      this.stats.space = Math.sqrt(s);
      this.stats.decision = d;

      switch (this.state) {
        case "idle":
          // The start bit's leading edge: mark to space.
          if (this.lastDecision >= 0 && d < 0) {
            this.state = "confirm";
            this.sinceEdge = 0;
            this.nextSampleAt = 0.5 * spb;
          }
          break;
        case "confirm":
          this.sinceEdge++;
          if (this.sinceEdge >= this.nextSampleAt) {
            if (d < 0) {
              // A real start bit. Data bits at 1.5, 2.5, ... bits from the edge.
              this.state = "data";
              this.bitIndex = 0;
              this.code = 0;
              this.nextSampleAt = 1.5 * spb;
            } else {
              this.state = "idle";
            }
          }
          break;
        case "data":
          this.sinceEdge++;
          if (this.sinceEdge >= this.nextSampleAt) {
            if (this.bitIndex < RTTY_DATA_BITS) {
              if (d >= 0) this.code |= 1 << this.bitIndex;
              this.bitIndex++;
              this.nextSampleAt = (1.5 + this.bitIndex) * spb;
            } else {
              // The stop bit, at edge + 6.5 bits. Mark, or the frame was not one.
              if (d >= 0) {
                const text = this.ita2.push(this.code);
                if (text) {
                  out += text;
                  this.stats.chars += text.length;
                }
              } else {
                this.stats.framingErrors++;
              }
              // Back to the idle mark. The next start edge is at least half a bit away
              // (the rest of the 1.5-bit stop), and the edge detector needs to see mark
              // first, which it will.
              this.state = "idle";
            }
          }
          break;
      }
      this.lastDecision = d;
    }
    return out;
  }
}
