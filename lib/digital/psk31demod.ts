// A PSK31 demodulator: audio in, text out, as a stream.
//
// The signal is BPSK at 31.25 baud (or 62.5, or 125) on one carrier. The decoder mixes the
// audio down with a local oscillator at the carrier, sums the result over a symbol (the
// matched filter for a rectangular-ish pulse; good enough for the G3PLX cosine envelope),
// and reads each symbol as the difference from the one before: the product of a symbol's
// sum with the conjugate of the previous one points along the real axis, forward for a 1
// and back for a 0, however the absolute phase drifts. Three things have to be tracked:
//
//   SYMBOL TIMING. The summed magnitude is largest when the sum spans one symbol centred,
//   and smallest when it straddles a reversal. The decoder keeps the magnitude of the sum
//   at every one of sixteen phases per symbol, averaged over the last few dozen symbols,
//   and samples at the phase with the largest - an idle line, with a reversal every
//   symbol, teaches it in a second, and a long run of 1s is flat and teaches it nothing
//   but does not mislead it either.
//
//   FREQUENCY. A carrier off the oscillator by df turns the differential product by
//   2 pi df T per symbol, on top of 0 or pi. Squaring the normalised product folds the
//   0-or-pi away and leaves 4 pi df T, so the angle of the squared products, averaged,
//   is the error; the oscillator follows it a little at a time while the signal is
//   trusted. Capture range is a quarter of the baud rate each way - about 8 Hz at 31.25.
//
//   WHETHER THERE IS A SIGNAL. The same squared products, averaged as unit vectors, have
//   a magnitude near 1 for a signal (every symbol is 0 or pi) and near 0 for noise (every
//   angle is as likely as any other). That is the quality, and the squelch is a floor on
//   it: below the floor the bits are still clocked, so the oscillator and the timing keep
//   tracking, but no character is printed, which is what keeps an empty channel quiet.
//
// Chunks of any size give the same text as one call; nothing here depends on a chunk
// boundary. scripts/check-psk31.ts runs it clean, offset, in noise and on noise alone.

import { Psk31VaricodeDecoder, pskBaud, type PskSpeed } from "@/lib/digital/psk31";

export interface Psk31DemodOptions {
  sampleRate: number;
  centreHz: number;
  speed?: PskSpeed;
  /**
   * Squelch, 0 to 1: the quality (see above) below which characters are not printed. Noise
   * sits near 0.2 with the averaging used; a clean signal near 1; a weak one around 0.6.
   * 0 disables it. Default 0.5.
   */
  squelch?: number;
  /** Follow the carrier. Default true. */
  afc?: boolean;
}

export interface Psk31DemodStats {
  /** Characters delivered, including spaces and newlines. */
  chars: number;
  /** Varicodes dropped as unknown or too long. */
  errors: number;
  /** 0 to 1: how consistently the symbols read as 0 or pi. */
  quality: number;
  /** Where the oscillator sits relative to the centre asked for, Hz. */
  afcHz: number;
  /** The symbol-sum magnitude at the last symbol, linear, for a level display. */
  level: number;
  /** Whether the last symbol was printed (quality over the squelch). */
  open: boolean;
}

/** Sixteen sampling phases per symbol: the timing resolution, and the decimated rate in symbols. */
const PHASES = 16;
/** The quality average: a few dozen symbols, so a lost signal closes the squelch in about a second. */
const QUALITY_ALPHA = 1 / 24;
/** Timing average over the same order of time. */
const TIMING_ALPHA = 1 / 32;
/** AFC step per symbol, as a fraction of the measured error. */
const AFC_GAIN = 0.08;

export class Psk31Demodulator {
  private readonly fs: number;
  private readonly baud: number;
  /** Input samples per decimated sample: the decimated rate is PHASES per symbol. */
  private readonly decim: number;
  private centreHz: number;
  private readonly squelch: number;
  private readonly afc: boolean;
  private readonly varicode = new Psk31VaricodeDecoder();

  private lo = 0;
  private loPhase = 0;
  private accI = 0;
  private accQ = 0;
  private accN = 0;

  // The last PHASES decimated samples: the symbol sum is their total.
  private readonly ringI = new Float64Array(PHASES);
  private readonly ringQ = new Float64Array(PHASES);
  private ringHead = 0;
  private sumI = 0;
  private sumQ = 0;
  private filled = 0;

  private readonly timing = new Float64Array(PHASES);
  private phaseIndex = 0;
  private samplePhase = 0;

  private prevI = 1;
  private prevQ = 0;
  private qualI = 0;
  private qualQ = 0;

  private readonly stats: Psk31DemodStats = { chars: 0, errors: 0, quality: 0, afcHz: 0, level: 0, open: false };

  constructor(opts: Psk31DemodOptions) {
    this.fs = opts.sampleRate;
    this.baud = pskBaud(opts.speed ?? 31);
    this.decim = Math.max(1, Math.round(this.fs / (this.baud * PHASES)));
    this.centreHz = opts.centreHz;
    this.lo = opts.centreHz;
    this.squelch = Math.max(0, Math.min(1, opts.squelch ?? 0.5));
    this.afc = opts.afc ?? true;
  }

  /** Move the carrier while running. The AFC offset is dropped: the operator chose a new centre. */
  retune(centreHz: number): void {
    this.centreHz = centreHz;
    this.lo = centreHz;
    this.stats.afcHz = 0;
  }

  get statistics(): Readonly<Psk31DemodStats> {
    return this.stats;
  }

  reset(): void {
    this.varicode.reset();
    this.qualI = 0;
    this.qualQ = 0;
    this.timing.fill(0);
    this.filled = 0;
    this.lo = this.centreHz;
    this.stats.afcHz = 0;
    this.stats.quality = 0;
    this.stats.open = false;
  }

  feed(samples: ArrayLike<number>): string {
    let out = "";
    const dphi0 = (2 * Math.PI) / this.fs;
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i]!;
      // Mix down: the oscillator's frequency is the centre plus whatever the AFC found.
      this.accI += x * Math.cos(this.loPhase);
      this.accQ -= x * Math.sin(this.loPhase);
      this.loPhase += dphi0 * this.lo;
      if (this.loPhase > 2 * Math.PI) this.loPhase -= 2 * Math.PI;
      if (++this.accN < this.decim) continue;
      // One decimated sample, PHASES per symbol.
      const dI = this.accI / this.decim;
      const dQ = this.accQ / this.decim;
      this.accI = 0;
      this.accQ = 0;
      this.accN = 0;
      this.sumI += dI - this.ringI[this.ringHead]!;
      this.sumQ += dQ - this.ringQ[this.ringHead]!;
      this.ringI[this.ringHead] = dI;
      this.ringQ[this.ringHead] = dQ;
      this.ringHead = (this.ringHead + 1) % PHASES;
      if (this.filled < PHASES) {
        this.filled++;
        continue;
      }
      // Timing: the magnitude of the symbol sum at this phase, averaged.
      const mag = this.sumI * this.sumI + this.sumQ * this.sumQ;
      const t = this.timing[this.phaseIndex] ?? 0;
      this.timing[this.phaseIndex] = t + TIMING_ALPHA * (mag - t);
      const thisPhase = this.phaseIndex;
      this.phaseIndex = (this.phaseIndex + 1) % PHASES;
      if (thisPhase !== this.samplePhase) continue;
      // At the sampling phase: one symbol.
      out += this.symbol(this.sumI, this.sumQ);
      // Re-pick the sampling phase for the next symbol from the averaged magnitudes - one
      // step at a time, towards the best, and only when the best is clearly better. In a
      // run of 1s every phase reads the same and the best is noise; a jump of half a
      // symbol then slips a bit, and one slipped bit is a line of junk.
      let best = 0;
      for (let p = 1; p < PHASES; p++) if (this.timing[p]! > this.timing[best]!) best = p;
      const cur = this.samplePhase;
      if (best !== cur && this.timing[best]! > this.timing[cur]! * 1.05) {
        const forward = (best - cur + PHASES) % PHASES;
        this.samplePhase = forward <= PHASES / 2 ? (cur + 1) % PHASES : (cur + PHASES - 1) % PHASES;
      }
    }
    return out;
  }

  private symbol(zI: number, zQ: number): string {
    // Differential: this symbol against the last.
    const dI = zI * this.prevI + zQ * this.prevQ;
    const dQ = zQ * this.prevI - zI * this.prevQ;
    this.prevI = zI;
    this.prevQ = zQ;
    const dm = Math.hypot(dI, dQ);
    this.stats.level = Math.sqrt(Math.hypot(zI, zQ) / PHASES);
    if (dm === 0) return "";
    const uI = dI / dm;
    const uQ = dQ / dm;
    // Squared unit product: 0 and pi both land at angle 0; the frequency error is what is left.
    const sI = uI * uI - uQ * uQ;
    const sQ = 2 * uI * uQ;
    this.qualI += QUALITY_ALPHA * (sI - this.qualI);
    this.qualQ += QUALITY_ALPHA * (sQ - this.qualQ);
    const quality = Math.hypot(this.qualI, this.qualQ);
    this.stats.quality = quality;
    // The AFC follows only what the squelch would print: quality measures how consistent
    // the symbols are, not how far off the carrier is, so a signal 5 Hz off still reads
    // near 1 and is followed, while noise at 0.1 to 0.3 leaves the oscillator alone.
    const open = this.squelch === 0 || quality >= this.squelch;
    const trusted = quality >= Math.max(0.5, this.squelch);
    if (this.afc && trusted) {
      // The averaged angle is 4 pi df T: df = angle * baud / (4 pi).
      const angle = Math.atan2(this.qualQ, this.qualI);
      const dfHz = (angle * this.baud) / (4 * Math.PI);
      this.lo += AFC_GAIN * dfHz;
      const limit = this.baud / 4;
      const off = this.lo - this.centreHz;
      if (off > limit) this.lo = this.centreHz + limit;
      if (off < -limit) this.lo = this.centreHz - limit;
      this.stats.afcHz = this.lo - this.centreHz;
    }
    const bit = dI >= 0 ? 1 : 0;
    const before = this.varicode.errors;
    const ch = this.varicode.pushBit(bit);
    // Unread codes are counted only while the squelch is open: with it closed the bits
    // are noise and every one of them is a code no character has, which is not a fault.
    if (open) this.stats.errors += this.varicode.errors - before;
    this.stats.open = open;
    if (!ch || !open) return "";
    this.stats.chars++;
    return ch;
  }
}
