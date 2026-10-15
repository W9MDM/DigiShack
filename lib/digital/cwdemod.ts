// CW decoder: a continuous stream of audio in, best-effort text out.
//
// BEST EFFORT, and said plainly. A machine reads clean, well-spaced CW at a steady speed
// as well as an operator does; it reads a sloppy fist, a swinging bug, a station in QSB or
// two stations on one pitch worse than any operator does, and nothing here changes that.
// What it is for is "CW assist": the text of a station you are listening to, on the page,
// so a callsign or a report can be read off rather than copied, with the operator's ear
// as the authority when the two disagree.
//
// HOW. One tone filter (a complex mixer and an 8 ms boxcar, the matched filter for the
// shortest element it will meet) gives the envelope. Two slow trackers bracket it: a PEAK
// that rises at once and decays over about two seconds, and a FLOOR that follows the quiet
// between elements. The key is "down" when the envelope is above the middle of that
// bracket, with hysteresis, and only at all when the peak stands a few dB over the floor -
// an empty channel keys nothing. That gives a sequence of mark and gap lengths in
// milliseconds, and everything after is timing.
//
// THE DIT. The speed is not known and may change, so the dit is re-estimated from the
// last few marks whenever they contain both short and long ones (a ratio over 2.2 means
// dits and dahs are both present; the dits' mean is the dit). A run of marks all the same
// length - "TTT", "EEE" - keeps the previous estimate, because they cannot say which they
// are. Marks are classified at the END of the character, not as they arrive, so the
// character's own elements contribute to the estimate that reads them, and the first
// letter of a transmission at an unexpected speed still decodes.
//
// Gaps: over two dits is a character boundary, over five a word. The character is
// finished either when the next mark starts after a long enough gap, or by the clock
// when the gap simply goes on - so the last character of a transmission is read without
// waiting for the next one.

import { charForPattern, ditMsFor, wpmFor } from "@/lib/digital/cw";

export interface CwDemodOptions {
  sampleRate: number;
  /** Tone frequency, Hz audio: the radio's CW pitch. */
  pitchHz: number;
  /** Starting speed guess, WPM. Adapts from the first character. Default 20. */
  wpm?: number;
  /**
   * How far the peak must stand over the floor for a signal to be present, dB. The floor
   * is the mean of the envelope while the key is up, which on an empty channel is the
   * lower part of the noise, and noise's own maxima over a couple of seconds reach about
   * 13 dB over that; 16 dB keeps an empty channel silent and asks of a signal roughly
   * what a machine needs to read it anyway. Default 16.
   */
  thresholdDb?: number;
  /** Every accepted mark and gap, ms, as the estimator sees them. For diagnosis. */
  onElement?: (kind: "mark" | "gap", ms: number, ditMs: number) => void;
}

/**
 * Shorter than this is a click or a noise spike, never an element: the fastest contest
 * CW is 50 WPM, a 24 ms dit.
 */
const MIN_MARK_MS = 12;

export interface CwDemodStats {
  chars: number;
  /** Current dit estimate as words per minute. */
  wpm: number;
  /** Envelope peak and floor, linear, for a tuning display. */
  peak: number;
  floor: number;
  /** Whether the key is down at the last sample. */
  keyed: boolean;
  /** Patterns that matched nothing in the table. */
  unknown: number;
}

/** What an unreadable pattern prints as. Not "?", which is a letter. */
export const CW_UNKNOWN = "#";

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

  /** Feed one sample, get the envelope (magnitude, not squared). */
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
    return Math.sqrt(this.sumI * this.sumI + this.sumQ * this.sumQ) / this.length;
  }
}

/**
 * How many marks the dit estimate looks back over. Ten is two or three characters: enough
 * that a run of dahs ("OTTO") leaves some dits in view, few enough that a change of speed
 * is followed within a word.
 */
const RECENT_MARKS = 10;
/** Fewer gaps than marks: they only refine the speed shown, and must follow a change as fast as the marks do. */
const RECENT_GAPS = 4;

export class CwDemodulator {
  private readonly fs: number;
  private readonly tone: ToneFilter;
  private readonly threshold: number;

  private peak = 0;
  private floor = 0;
  private readonly peakDecay: number;
  private readonly floorRise: number;

  private primed = false;
  private age = 0;
  private readonly floorFast: number;
  private pendingState = false;
  private pendingSamples = 0;
  private readonly debounceSamples: number;
  private keyed = false;
  private runSamples = 0;
  /**
   * The dit as MARKS measure it, which is what marks are classified against. A keyer's
   * shaped edges make every mark a few milliseconds shorter at the detection threshold
   * and every gap the same amount longer, so this is a little under the true dit.
   */
  private ditMs: number;
  private readonly recent: number[] = [];
  /** Gaps inside characters, ms: one unit each, lengthened by what the marks lost. */
  private readonly recentGaps: number[] = [];
  /** Marks (ms) of the character in progress. */
  private marks: number[] = [];
  private flushed = true;
  private spaced = true;
  private readonly stats: CwDemodStats;

  private readonly onElement: CwDemodOptions["onElement"];

  constructor(opts: CwDemodOptions) {
    this.fs = opts.sampleRate;
    this.onElement = opts.onElement;
    this.tone = new ToneFilter(opts.sampleRate, opts.pitchHz, Math.max(4, Math.round(0.008 * opts.sampleRate)));
    this.threshold = Math.pow(10, (opts.thresholdDb ?? 16) / 20);
    this.ditMs = ditMsFor(opts.wpm ?? 20);
    // Per-sample coefficients for the trackers: the peak forgets in about 2 s, the floor
    // follows the between-element level with a one-second memory (a tenth of that for the
    // first second, while it is still learning what quiet sounds like here).
    this.peakDecay = Math.exp(-1 / (2 * opts.sampleRate));
    this.floorRise = 1 - Math.exp(-1 / (1 * opts.sampleRate));
    this.floorFast = 1 - Math.exp(-1 / (0.1 * opts.sampleRate));
    this.debounceSamples = Math.max(2, Math.round(0.003 * opts.sampleRate));
    this.stats = { chars: 0, wpm: wpmFor(this.ditMs), peak: 0, floor: 0, keyed: false, unknown: 0 };
  }

  /**
   * The true dit: a dit mark plus the one-unit gap after it is two units exactly, whatever
   * the edges took from one and gave to the other. Used for the speed shown, not for
   * classifying marks, which are compared with other marks.
   */
  private trueDitMs(): number {
    if (this.recentGaps.length === 0) return this.ditMs;
    let sum = 0;
    for (const g of this.recentGaps) sum += g;
    return (this.ditMs + sum / this.recentGaps.length) / 2;
  }

  retune(pitchHz: number): void {
    this.tone.retune(pitchHz);
  }

  get statistics(): Readonly<CwDemodStats> {
    this.stats.wpm = wpmFor(this.trueDitMs());
    this.stats.peak = this.peak;
    this.stats.floor = this.floor;
    this.stats.keyed = this.keyed;
    return this.stats;
  }

  reset(): void {
    this.keyed = false;
    this.runSamples = 0;
    this.marks = [];
    this.flushed = true;
    this.spaced = true;
  }

  /** Feed audio; get whatever text completed inside it. Any chunk size; state carries across calls. */
  feed(samples: ArrayLike<number>): string {
    let out = "";
    const msPerSample = 1000 / this.fs;
    for (let n = 0; n < samples.length; n++) {
      const env = this.tone.step(samples[n] as number);

      // The PEAK rises at once and decays over about two seconds; the key is read against
      // it alone, with hysteresis (down above 55 %, up below 40 %), so a weak signal keys
      // as cleanly as a strong one. The FLOOR is the mean of the envelope while the key is
      // up - the noise between elements - and only ever that: it is not part of the key
      // decision, so it cannot be pulled up by the signal it is measuring, and it learns
      // fast for the first second so a start in noise settles before anything can key.
      // A signal is PRESENT when the peak stands over the floor by the threshold; noise
      // alone keys on its own maxima all the time, and presence is what keeps that off the
      // page. Nothing keys before the first sample has primed both.
      if (!this.primed) {
        this.peak = env;
        this.floor = env;
        this.primed = true;
      }
      this.peak = env > this.peak ? env : this.peak * this.peakDecay;
      const over = this.keyed ? env > this.peak * 0.4 : env > this.peak * 0.55;
      if (!over) this.floor += (env - this.floor) * (this.age < this.fs ? this.floorFast : this.floorRise);
      this.age++;
      const present = this.peak > this.floor * this.threshold && this.peak > 1e-6;
      const wanted = over && present;

      // DEBOUNCE. On the rising edge of a mark, right at the presence threshold, noise on
      // the envelope flips the decision a few times inside a few milliseconds, and each
      // flip cut the mark and once put a 12 ms sliver of it into the dit estimate. A change
      // of state has to hold for a few milliseconds to count; both edges move by the same
      // amount, so no duration changes.
      let down = this.keyed;
      if (wanted !== this.keyed) {
        if (wanted === this.pendingState) this.pendingSamples++;
        else {
          this.pendingState = wanted;
          this.pendingSamples = 1;
        }
        if (this.pendingSamples >= this.debounceSamples) down = wanted;
      } else {
        this.pendingSamples = 0;
      }

      if (down === this.keyed) {
        this.runSamples++;
        if (!this.keyed) {
          // A gap in progress: finish the character by the clock, then the word.
          const gapMs = this.runSamples * msPerSample;
          if (!this.flushed && gapMs > 2 * this.ditMs) out += this.flushCharacter();
          if (!this.spaced && gapMs > 5 * this.ditMs) {
            out += " ";
            this.spaced = true;
          }
        }
        continue;
      }

      // An edge. Close the run that just ended.
      const runMs = this.runSamples * msPerSample;
      if (this.keyed) {
        // A mark ended. Shorter than a sixth of a dit, or than any dit there is, is a
        // click or a noise spike and must not reach the estimator.
        if (runMs >= Math.max(MIN_MARK_MS, this.ditMs / 6)) {
          this.onElement?.("mark", runMs, this.ditMs);
          this.marks.push(runMs);
          this.recent.push(runMs);
          if (this.recent.length > RECENT_MARKS) this.recent.shift();
          this.flushed = false;
          this.spaced = false;
          this.estimateDit();
        }
      } else {
        // A gap ended: a mark is starting. The gap decided whether that mark begins a new
        // character or word, unless the clock already did.
        this.onElement?.("gap", runMs, this.ditMs);
        if (runMs > 5 * this.ditMs) {
          if (!this.flushed) out += this.flushCharacter();
          if (!this.spaced) {
            out += " ";
            this.spaced = true;
          }
        } else if (runMs > 2 * this.ditMs) {
          if (!this.flushed) out += this.flushCharacter();
        } else if (this.marks.length > 0) {
          // Inside a character: one unit, as the edges left it.
          this.recentGaps.push(runMs);
          if (this.recentGaps.length > RECENT_GAPS) this.recentGaps.shift();
        }
      }
      this.keyed = down;
      this.runSamples = 1;
    }
    return out;
  }

  /** Re-estimate the dit from the recent marks when they show both lengths. */
  private estimateDit(): void {
    if (this.recent.length < 2) return;
    let shortest = Infinity;
    let longest = 0;
    for (const m of this.recent) {
      if (m < shortest) shortest = m;
      if (m > longest) longest = m;
    }
    if (longest > 2.2 * shortest) {
      let sum = 0;
      let count = 0;
      for (const m of this.recent) {
        if (m < 2 * shortest) {
          sum += m;
          count++;
        }
      }
      if (count > 0) this.ditMs = sum / count;
    }
  }

  /** Read the character in progress with the current dit, and start the next. */
  private flushCharacter(): string {
    this.flushed = true;
    if (this.marks.length === 0) return "";
    let pattern = "";
    for (const m of this.marks) pattern += m > 2 * this.ditMs ? "-" : ".";
    this.marks = [];
    const ch = charForPattern(pattern);
    if (ch === null) {
      this.stats.unknown++;
      return CW_UNKNOWN;
    }
    this.stats.chars++;
    return ch;
  }
}
