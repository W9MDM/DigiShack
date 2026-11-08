// A PSK31 demodulator: audio in, text out, as a stream.
//
// The signal is BPSK at 31.25 baud (or 62.5, 125, 250, 500) on one carrier, or QPSK at the
// same rates. The decoder mixes the audio down with a local oscillator at the carrier,
// sums the result over a symbol (the matched filter for a rectangular-ish pulse; good
// enough for the G3PLX cosine envelope), and reads each symbol as the difference from the
// one before: the product of a symbol's sum with the conjugate of the previous one points
// along the real axis, forward for a 1 and back for a 0, however the absolute phase
// drifts. (QPSK: one of four directions, which go to a Viterbi decoder; see below.) Three
// things have to be tracked:
//
//   SYMBOL TIMING. The summed magnitude is largest when the sum spans one symbol centred,
//   and smallest when it straddles a reversal. The decoder keeps the magnitude of the sum
//   at every one of sixteen phases per symbol, averaged over the last few dozen symbols,
//   and samples at the phase with the largest - an idle line, with a reversal every
//   symbol, teaches it in a second, and a long run of 1s is flat and teaches it nothing
//   but does not mislead it either. Sixteen when the samples a symbol divide into sixteen
//   equal steps; otherwise the most, up to sixteen, they divide into evenly - BPSK500 at
//   12 kHz is 24 samples a symbol, read as twelve phases of two (see decimation()).
//
//   FREQUENCY. A carrier off the oscillator by df turns the differential product by
//   2 pi df T per symbol, on top of 0 or pi. Squaring the normalised product folds the
//   0-or-pi away and leaves 4 pi df T, so the angle of the squared products, averaged,
//   is the error; the oscillator follows it a little at a time while the signal is
//   trusted. Capture range is a quarter of the baud rate each way - about 8 Hz at 31.25.
//   QPSK's four phases need the fourth power, not the square, and so an eighth of the baud.
//
//   WHETHER THERE IS A SIGNAL. The same squared products, averaged as unit vectors, have
//   a magnitude near 1 for a signal (every symbol is 0 or pi) and near 0 for noise (every
//   angle is as likely as any other). That is the quality - fldigi's metric, the average
//   of cos and sin of n times the phase with n = 2 for BPSK and 4 for QPSK (psk/psk.cxx
//   rx_symbol) - and the squelch is a floor on it: below the floor the bits are still
//   clocked, so the oscillator and the timing keep tracking, but no character is
//   printed, which is what keeps an empty channel quiet. fldigi also reads two patterns
//   in the symbols themselves (rx_symbol's dcdshreg): sixteen reversals in a row (a BPSK
//   preamble) opens the squelch at once, and a steady carrier (the BPSK postamble) closes
//   it after 21 symbols (16 at QPSK), so the noise after an over prints nothing while the
//   average is still falling. Both are here, on a copy of the average that only the
//   squelch reads: the quality reported, and the AFC, are left as measured.
//
// QPSK. The differential product, turned back by 180 degrees, is near 90 d degrees for
// the encoder's dibit d (lib/digital/qpsk.ts has the mapping and where it comes from). How
// near each of the four it is goes to a K=5 Viterbi decoder as soft metrics, and the bits
// it decides go to the Varicode decoder as BPSK's do. The decoder decides each bit 30
// symbols late; whether the squelch was open is remembered for as long, so a character
// prints when the squelch was open while it was on the air, not 30 symbols afterwards.
//
// PSK-R. The symbols are BPSK's, read the same way, but each one's product along the real
// axis, scaled by the average symbol strength, goes on as a soft decision (0 a sure
// reversal, 255 a sure no-change, 128 nothing known) to lib/digital/pskr.ts, which runs
// fldigi's two de-interleavers and K=7 decoders and its vote between them. The quality is
// BPSK's, the squared phase averaged, but over far longer, as fldigi does for PSK-R (ten
// times its BPSK decay, psk.cxx:1572-1576): a signal the code still copies has a phase
// average of 0.2 to 0.3, which noise reaches over a few dozen symbols but not over a
// hundred. The decoder's own fit was tried and is no use: noise fits a rate-1/2 code at
// 0.84, better than a signal at the copy threshold does. pskr.ts holds the squelch's
// verdict for as long as the decoder takes, and fldigi's BPSK DCD patterns are off here, as
// fldigi has them for PSK-R (psk.cxx:1620-1660); pskr.ts has its own. A symbol of exact
// silence still clocks the decoders, with no information, so the end of a line comes out
// of them when the audio stops dead rather than waiting in the interleaver.
//
// Chunks of any size give the same text as one call; nothing here depends on a chunk
// boundary. scripts/check-psk31.ts and scripts/check-pskx.ts run it clean, offset, in
// noise and on noise alone.

import { Psk31VaricodeDecoder, pskBaud, type AnyPskSpeed } from "@/lib/digital/psk31";
import { QPSK_TRACEBACK, QpskViterbi } from "@/lib/digital/qpsk";
import { PskrReceiver, isPskrSpeed, pskrDcdBits, pskrDepth } from "@/lib/digital/pskr";

export interface Psk31DemodOptions {
  sampleRate: number;
  centreHz: number;
  speed?: AnyPskSpeed;
  /** QPSK rather than BPSK. Default false. */
  qpsk?: boolean;
  /** QPSK only: fldigi's "reverse", for a sender whose phase changes are mirrored. Default false. */
  reverse?: boolean;
  /** PSK-R (lib/digital/pskr.ts) rather than plain BPSK: speeds 63, 125, 250, 500; 31 throws. Default false. */
  pskr?: boolean;
  /** PSK-R only: the interleaver depth, default fldigi's for the speed. 0 at speed 63 is fldigi's PSK63F. */
  pskrDepth?: number;
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
  /** 0 to 1: how consistently the symbols read as 0 or pi (QPSK, PSK-R: how well they fit the code). */
  quality: number;
  /** Where the oscillator sits relative to the centre asked for, Hz. */
  afcHz: number;
  /** The symbol-sum magnitude at the last symbol, linear, for a level display. */
  level: number;
  /** Whether the last symbol was printed (quality over the squelch). */
  open: boolean;
}

/** The usual sampling phases per symbol: the timing resolution, and the decimated rate in symbols. */
const PHASES = 16;
/** The quality average: a few dozen symbols, so a lost signal closes the squelch in about a second. */
const QUALITY_ALPHA = 1 / 24;
/** Timing average over the same order of time. */
const TIMING_ALPHA = 1 / 32;
/** AFC step per symbol, as a fraction of the measured error. */
const AFC_GAIN = 0.08;
/** Coarse pull per symbol, as a fraction of its error. */
const COARSE_GAIN = 0.25;
/** Reversals in a row that open the squelch: fldigi's 0xAAAAAAAA, sixteen two-bit symbols. */
const DCD_ON_RUN = 16;
/**
 * Steady-carrier symbols in a row before the closing pattern is seen: fldigi's 0x00000000,
 * sixteen two-bit symbols for BPSK, eleven three-bit ones for QPSK (dcdshreg shifts by
 * symbits + 1). It has to be seen six times running before the squelch closes.
 */
const DCD_OFF_RUN_BPSK = 16;
const DCD_OFF_RUN_QPSK = 11;
const DCD_OFF_REPEATS = 6;
/** QPSK: symbols of the same turn in a row before the coarse AFC is believed (its average is two symbols long). */
const QPSK_COARSE_RUN = 8;
/** Symbols trusted in a row before the AFC may move. */
const TRUST_RUN = 8;
/** QPSK's coarse AFC: the average of the turn over a run of the same turn, symbols. */
const TURN_ALPHA = 1 / 4;
/** The QPSK soft metric's amplitude average, symbols. */
const SOFT_ALPHA = 1 / 32;
/** QPSK: the decoder fit that noise sits at, which reads as quality 0. See fitQuality. */
const QPSK_FIT_FLOOR = 0.8;
/**
 * PSK-R's soft decision: 128 plus this times the product along the real axis over the
 * average symbol strength, so a clean symbol reads 128 +/- 64 and a noise peak twice the
 * average still fits in 0 to 255. The decoder's metric is linear in it; the scale only
 * decides where the clipping falls.
 */
const PSKR_SOFT_SCALE = 64;
/**
 * PSK-R's phase average reads 1 on this or more. At the copy threshold (about 3 dB per
 * symbol) it sits at 0.25 to 0.4; a minute of noise, averaged over 128 symbols, never
 * passed 0.17. So the default squelch, 0.5, sits at 0.2.
 */
const PSKR_PHASE_FULL = 0.4;
/**
 * PSK-R's fine AFC moves this many times the phase average's weight, per symbol, of the
 * error it reads: a time constant of half the average's, quick enough to follow a drifting
 * rig and slow enough not to chase the average's own lag round in a circle.
 */
const PSKR_AFC_GAIN = 2;
/** A differential product below this is silence (see symbol()). */
const PSKR_SILENCE = 1e-18;
/**
 * The short phase average (24 symbols) PSK-R's coarse AFC needs before it pulls. BPSK's
 * 0.5 is what PSK-R sees on a weak signal dead on frequency, and there the coarse reading is
 * noise. A click well off frequency on a signal this strong is what the coarse AFC is for.
 */
const PSKR_COARSE_QUALITY = 0.75;

/**
 * Input samples per decimated sample, and decimated samples per symbol. Sixteen phases
 * wherever the symbol divides into sixteen whole steps, which is every speed at 12, 24
 * and 48 kHz but 500 baud at 12 kHz: 24 samples a symbol, where a step of one and a half
 * samples is no step. There the most phases up to sixteen that divide it evenly - twelve
 * steps of two samples. Not 24 of one: more phases than sixteen let noise read as a
 * signal, a minute of it reaching a quality of 0.6 against 0.45 at twelve, which opened
 * the AFC to it and walked the oscillator 80 Hz. A symbol that is not a whole number of
 * samples falls back to sixteen phases of a rounded step.
 */
function decimation(fs: number, baud: number): { decim: number; phases: number } {
  const sps = fs / baud;
  const whole = Math.round(sps);
  if (Math.abs(sps - whole) > 1e-9) return { decim: Math.max(1, Math.round(sps / PHASES)), phases: PHASES };
  for (let p = Math.min(PHASES, whole); p >= 8; p--) {
    if (whole % p === 0) return { decim: whole / p, phases: p };
  }
  return { decim: Math.max(1, Math.round(sps / PHASES)), phases: PHASES };
}

export class Psk31Demodulator {
  private readonly fs: number;
  private readonly baud: number;
  /** Input samples per decimated sample: the decimated rate is `phases` per symbol. */
  private readonly decim: number;
  private readonly phases: number;
  /**
   * The coarse AFC's average, per decimated sample: about two symbols. The fine AFC measures
   * the error from symbol to symbol, which wraps at a quarter of the baud (7.8 Hz at
   * PSK31): a click 10 Hz off read as 5 Hz the other way and the loop ran off to its limit.
   * The coarse one measures it from one decimated sample to the next, unambiguous to about
   * the baud, and pulls in until the fine one can take over.
   */
  private readonly coarseAlpha: number;
  private centreHz: number;
  private readonly squelch: number;
  private readonly afc: boolean;
  private readonly qpsk: boolean;
  private readonly reverse: boolean;
  /** 2 for BPSK, 4 for QPSK: the power that folds the modulation out of the phase. */
  private readonly order: number;
  private readonly varicode = new Psk31VaricodeDecoder();

  private lo = 0;
  private loPhase = 0;
  private accI = 0;
  private accQ = 0;
  private accN = 0;

  // The last `phases` decimated samples: the symbol sum is their total.
  private readonly ringI: Float64Array;
  private readonly ringQ: Float64Array;
  private ringHead = 0;
  private sumI = 0;
  private sumQ = 0;
  private filled = 0;

  private readonly timing: Float64Array;
  private phaseIndex = 0;
  private samplePhase = 0;
  /** Decimated samples since the last symbol was taken; see feed(). */
  private sinceSymbol = Infinity;

  private prevI = 1;
  private prevQ = 0;
  private qualI = 0;
  private qualQ = 0;
  // The squelch's copy of the quality average, which fldigi's DCD patterns may set.
  private gateI = 0;
  private gateQ = 0;
  private reversalRun = 0;
  private carrierRun = 0;
  private trustedRun = 0;
  private sameTurnRun = 0;
  private prevDI = 0;
  private prevDQ = 0;
  private turnI = 0;
  private turnQ = 0;
  private offSeen = 0;
  // The coarse AFC: the matched filter's output squared (the modulation gone), its
  // rotation from one decimated sample to the next, averaged; and its power, to tell a
  // carrier from noise.
  private prevWI = 0;
  private prevWQ = 0;
  private coarseI = 0;
  private coarseQ = 0;
  private coarsePow = 0;

  // QPSK: the decoder, the soft metrics' scale, and the squelch state for the bits it has not decided yet.
  private readonly viterbi: QpskViterbi | null;
  /** QPSK's matched-filter weights, oldest sample first; null for BPSK's plain sum. */
  private readonly window: Float64Array | null = null;
  private softAmp = 0;
  // The decoder fit, averaged; it starts where noise sits so a signal opens the squelch within the preamble.
  private fitAvg = QPSK_FIT_FLOOR;
  private readonly met = new Float64Array(4);
  private readonly openLine = new Uint8Array(QPSK_TRACEBACK);
  private openHead = 0;
  // PSK-R: everything after the soft decision.
  private readonly pskr: PskrReceiver | null;
  /** PSK-R's phase average: its weight per symbol, and the average. */
  private readonly pskrAlpha: number = 0;
  private pskrQI = 0;
  private pskrQQ = 0;

  private readonly stats: Psk31DemodStats = { chars: 0, errors: 0, quality: 0, afcHz: 0, level: 0, open: false };

  constructor(opts: Psk31DemodOptions) {
    this.fs = opts.sampleRate;
    this.baud = pskBaud(opts.speed ?? 31);
    const { decim, phases } = decimation(this.fs, this.baud);
    this.decim = decim;
    this.phases = phases;
    this.coarseAlpha = 1 / (2 * phases);
    this.ringI = new Float64Array(phases);
    this.ringQ = new Float64Array(phases);
    this.timing = new Float64Array(phases);
    this.centreHz = opts.centreHz;
    this.lo = opts.centreHz;
    this.squelch = Math.max(0, Math.min(1, opts.squelch ?? 0.5));
    this.afc = opts.afc ?? true;
    this.qpsk = opts.qpsk ?? false;
    this.reverse = opts.reverse ?? false;
    this.order = this.qpsk ? 4 : 2;
    this.viterbi = this.qpsk ? new QpskViterbi() : null;
    if (opts.pskr && this.qpsk) throw new RangeError("PSK-R is BPSK: pskr and qpsk together are no mode");
    if (opts.pskr && !isPskrSpeed(opts.speed ?? 31)) throw new RangeError(`PSK-R has no ${opts.speed ?? 31}-baud mode (63, 125, 250 or 500)`);
    this.pskr = opts.pskr ? new PskrReceiver(opts.pskrDepth ?? pskrDepth(opts.speed ?? 31)) : null;
    // 128 symbols, or dcdbits where that is longer (256 and 512 at PSK250R and 500R): about
    // a second, never more than half the preamble.
    if (this.pskr) this.pskrAlpha = 1 / Math.max(128, pskrDcdBits(opts.speed ?? 31));
    if (this.qpsk) {
      // Scaled so a steady carrier sums to the same as the plain sum would.
      const w = new Float64Array(phases);
      let total = 0;
      for (let j = 0; j < phases; j++) total += w[j] = Math.sin((Math.PI * (j + 0.5)) / phases);
      for (let j = 0; j < phases; j++) w[j]! *= phases / total;
      this.window = w;
    }
  }

  /** Move the carrier while running. The AFC offset is dropped: the operator chose a new centre. */
  retune(centreHz: number): void {
    this.centreHz = centreHz;
    this.lo = centreHz;
    this.stats.afcHz = 0;
    this.coarseI = 0;
    this.coarseQ = 0;
    this.coarsePow = 0;
  }

  get statistics(): Readonly<Psk31DemodStats> {
    return this.stats;
  }

  reset(): void {
    this.varicode.reset();
    this.qualI = 0;
    this.qualQ = 0;
    this.gateI = 0;
    this.gateQ = 0;
    this.reversalRun = 0;
    this.carrierRun = 0;
    this.offSeen = 0;
    this.timing.fill(0);
    this.filled = 0;
    this.lo = this.centreHz;
    this.stats.afcHz = 0;
    this.stats.quality = 0;
    this.stats.open = false;
    this.viterbi?.reset();
    this.softAmp = 0;
    this.fitAvg = QPSK_FIT_FLOOR;
    this.openLine.fill(0);
    this.pskr?.reset();
    this.pskrQI = 0;
    this.pskrQQ = 0;
    // Everything else that remembers the audio, so a reset is as good as a new decoder. An
    // RSID burst left the coarse AFC, the trust count and the matched filter full of its
    // tones, and after a reset that kept them BPSK500 lost the first word of the line.
    this.trustedRun = 0;
    this.sameTurnRun = 0;
    this.prevDI = 0;
    this.prevDQ = 0;
    this.turnI = 0;
    this.turnQ = 0;
    this.prevWI = 0;
    this.prevWQ = 0;
    this.coarseI = 0;
    this.coarseQ = 0;
    this.coarsePow = 0;
    this.accI = 0;
    this.accQ = 0;
    this.accN = 0;
    this.ringI.fill(0);
    this.ringQ.fill(0);
    this.ringHead = 0;
    this.sumI = 0;
    this.sumQ = 0;
    this.phaseIndex = 0;
    this.samplePhase = 0;
    this.sinceSymbol = Infinity;
    this.prevI = 1;
    this.prevQ = 0;
    this.openHead = 0;
  }

  feed(samples: ArrayLike<number>): string {
    let out = "";
    const dphi0 = (2 * Math.PI) / this.fs;
    const phases = this.phases;
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i]!;
      // Mix down: the oscillator's frequency is the centre plus whatever the AFC found.
      this.accI += x * Math.cos(this.loPhase);
      this.accQ -= x * Math.sin(this.loPhase);
      this.loPhase += dphi0 * this.lo;
      if (this.loPhase > 2 * Math.PI) this.loPhase -= 2 * Math.PI;
      if (++this.accN < this.decim) continue;
      // One decimated sample, `phases` per symbol.
      const dI = this.accI / this.decim;
      const dQ = this.accQ / this.decim;
      this.accI = 0;
      this.accQ = 0;
      this.accN = 0;
      if (!this.window) {
        // BPSK: the plain sum, kept running.
        this.sumI += dI - this.ringI[this.ringHead]!;
        this.sumQ += dQ - this.ringQ[this.ringHead]!;
      }
      this.ringI[this.ringHead] = dI;
      this.ringQ[this.ringHead] = dQ;
      this.ringHead = (this.ringHead + 1) % phases;
      if (this.filled < phases) {
        this.filled++;
        continue;
      }
      // QPSK: the weighted sum, from the ring each time.
      if (this.window) this.windowedSum();
      // BPSK only: QPSK reads its coarse error from the turn (see symbol).
      if (this.afc && !this.qpsk) this.coarseStep();
      // Timing: the magnitude of the symbol sum at this phase, averaged.
      const mag = this.sumI * this.sumI + this.sumQ * this.sumQ;
      const t = this.timing[this.phaseIndex] ?? 0;
      this.timing[this.phaseIndex] = t + TIMING_ALPHA * (mag - t);
      const thisPhase = this.phaseIndex;
      this.phaseIndex = (this.phaseIndex + 1) % phases;
      this.sinceSymbol++;
      // At the sampling phase: one symbol - but never twice in one symbol's time. A step of
      // the sampling phase forward (below) names the phase the very next decimated sample
      // is at, and that sample was being taken as a second symbol one step after the first:
      // a spurious no-change bit, one wrong character at BPSK, and at PSK-R a pairing knocked
      // out of step that garbled the next second or two. The step now lands a symbol and one
      // decimated sample later, as a step back lands a symbol less one.
      if (thisPhase !== this.samplePhase || this.sinceSymbol < phases / 2) continue;
      this.sinceSymbol = 0;
      out += this.symbol(this.sumI, this.sumQ);
      // Re-pick the sampling phase for the next symbol from the averaged magnitudes - one
      // step at a time, towards the best, and only when the best is clearly better. In a
      // run of 1s every phase reads the same and the best is noise; a jump of half a
      // symbol then slips a bit, and one slipped bit is a line of junk.
      let best = 0;
      for (let p = 1; p < phases; p++) if (this.timing[p]! > this.timing[best]!) best = p;
      const cur = this.samplePhase;
      if (best !== cur && this.timing[best]! > this.timing[cur]! * 1.05) {
        const forward = (best - cur + phases) % phases;
        this.samplePhase = forward <= phases / 2 ? (cur + 1) % phases : (cur + phases - 1) % phases;
      }
    }
    return out;
  }

  /**
   * QPSK's matched filter: the last symbol's decimated samples weighted by a half cosine,
   * oldest first, in place of the plain sum. The G3PLX envelope moves from one symbol to
   * the next over a whole symbol, so a plain sum centred on a symbol takes in 11% of each
   * neighbour. For BPSK that only shortens the vector; for QPSK a neighbour a quarter turn
   * away twists it by up to 12 degrees, and the fourth-power phase average read a clean
   * signal as 0.77. The half cosine takes in 6%, for 0.15 dB less signal against noise.
   */
  private windowedSum(): void {
    const n = this.phases;
    const w = this.window!;
    let sI = 0;
    let sQ = 0;
    let k = this.ringHead;
    for (let j = 0; j < n; j++) {
      sI += w[j]! * this.ringI[k]!;
      sQ += w[j]! * this.ringQ[k]!;
      if (++k === n) k = 0;
    }
    this.sumI = sI;
    this.sumQ = sQ;
  }

  /** One decimated sample of the coarse AFC. */
  private coarseStep(): void {
    const wI = this.sumI * this.sumI - this.sumQ * this.sumQ;
    const wQ = 2 * this.sumI * this.sumQ;
    // w times the conjugate of the last w: its angle is 4 pi df over one decimated sample.
    const cI = wI * this.prevWI + wQ * this.prevWQ;
    const cQ = wQ * this.prevWI - wI * this.prevWQ;
    const pow = Math.hypot(wI, wQ) * Math.hypot(this.prevWI, this.prevWQ);
    this.prevWI = wI;
    this.prevWQ = wQ;
    this.coarseI += this.coarseAlpha * (cI - this.coarseI);
    this.coarseQ += this.coarseAlpha * (cQ - this.coarseQ);
    this.coarsePow += this.coarseAlpha * (pow - this.coarsePow);
  }

  /** The coarse frequency error, Hz, or null when what is there is not a steady carrier. */
  private coarseHz(): number | null {
    if (this.coarsePow <= 0) return null;
    // Noise rotates every which way and averages towards 0; a carrier keeps its rotation.
    if (Math.hypot(this.coarseI, this.coarseQ) < 0.6 * this.coarsePow) return null;
    const fsd = this.fs / this.decim;
    return (Math.atan2(this.coarseQ, this.coarseI) * fsd) / (4 * Math.PI);
  }

  /** Hold the oscillator within one baud of where the operator put it, as fldigi does. */
  private clampLo(): void {
    const limit = this.baud;
    const off = this.lo - this.centreHz;
    if (off > limit) this.lo = this.centreHz + limit;
    if (off < -limit) this.lo = this.centreHz - limit;
    this.stats.afcHz = this.lo - this.centreHz;
  }

  private symbol(zI: number, zQ: number): string {
    // Differential: this symbol against the last.
    const dI = zI * this.prevI + zQ * this.prevQ;
    const dQ = zQ * this.prevI - zI * this.prevQ;
    this.prevI = zI;
    this.prevQ = zQ;
    const dm = Math.hypot(dI, dQ);
    this.stats.level = Math.sqrt(Math.hypot(zI, zQ) / this.phases);
    // PSK-R: silence is still a symbol, one the decoders learn nothing from (see the header).
    // PSK-R also counts as silence what the running sum leaves of it: rounding residue near
    // 1e-14 a sample, which is the same every symbol and so read as a perfect steady
    // carrier, quality 1 into the silence. 1e-18 is far below any real audio: one step of
    // 24-bit audio summed over a symbol gives a product near 1e-12.
    if (dm === 0 || (this.pskr && dm < PSKR_SILENCE)) {
      if (!this.pskr) return "";
      // Nothing there: the phase average falls as it would on noise, and the quality with it.
      this.pskrQI -= this.pskrAlpha * this.pskrQI;
      this.pskrQQ -= this.pskrAlpha * this.pskrQQ;
      this.stats.quality = Math.min(1, Math.hypot(this.pskrQI, this.pskrQQ) / PSKR_PHASE_FULL);
      return this.pskrDeliver(128, false);
    }
    const uI = dI / dm;
    const uQ = dQ / dm;
    // Squared unit product: 0 and pi both land at angle 0; the frequency error is what is
    // left. QPSK squares again, so the quarter turns land there too.
    let sI = uI * uI - uQ * uQ;
    let sQ = 2 * uI * uQ;
    if (this.qpsk) {
      const tI = sI * sI - sQ * sQ;
      sQ = 2 * sI * sQ;
      sI = tI;
    }
    this.qualI += QUALITY_ALPHA * (sI - this.qualI);
    this.qualQ += QUALITY_ALPHA * (sQ - this.qualQ);
    let bit: number;
    let soft = 128;
    if (this.viterbi) {
      bit = this.qpskDecide(dI, dQ, dm);
      this.fitAvg += QUALITY_ALPHA * (this.viterbi.fit - this.fitAvg);
    } else if (this.pskr) {
      bit = dI >= 0 ? 1 : 0;
      this.softAmp += SOFT_ALPHA * (dm - this.softAmp);
      soft = this.softAmp > 0 ? 128 + (PSKR_SOFT_SCALE * dI) / this.softAmp : 128;
      this.pskrQI += this.pskrAlpha * (sI - this.pskrQI);
      this.pskrQQ += this.pskrAlpha * (sQ - this.pskrQQ);
    } else {
      bit = dI >= 0 ? 1 : 0;
      this.gateI += QUALITY_ALPHA * (sI - this.gateI);
      this.gateQ += QUALITY_ALPHA * (sQ - this.gateQ);
    }
    // fldigi turns its BPSK DCD patterns off for PSK-R: its preamble is not reversals.
    if (!this.pskr) this.dcdPatterns(dI, dQ);
    const coded = this.qpsk || this.pskr !== null;
    const quality = this.qpsk
      ? this.fitQuality()
      : this.pskr
        ? Math.min(1, Math.hypot(this.pskrQI, this.pskrQQ) / PSKR_PHASE_FULL)
        : Math.hypot(this.qualI, this.qualQ);
    const gate = coded ? quality : Math.hypot(this.gateI, this.gateQ);
    this.stats.quality = quality;
    // The AFC follows only what the squelch would print: quality measures how consistent
    // the symbols are, not how far off the carrier is, so a signal 5 Hz off still reads
    // near 1 and is followed, while noise at 0.1 to 0.3 leaves the oscillator alone.
    const open = this.squelch === 0 || gate >= this.squelch;
    // QPSK: the AFC reads its error from the fourth-power average, so that average's own
    // length says whether the error is worth following. On a signal the decoder still
    // copies at -10 dB it is short, the angle is noise, and following it lost the signal.
    const phaseQuality = coded ? Math.hypot(this.qualI, this.qualQ) : quality;
    const trusted = quality >= Math.max(0.5, this.squelch) && phaseQuality >= 0.5;
    this.trustedRun = trusted ? this.trustedRun + 1 : 0;
    // The same turn as the symbol before, within 30 degrees: the preamble's reversals (or
    // a steady carrier) however far off frequency, since the offset adds the same to each.
    const tI = dI * this.prevDI + dQ * this.prevDQ;
    const tQ = dQ * this.prevDI - dI * this.prevDQ;
    this.prevDI = dI;
    this.prevDQ = dQ;
    const same = tI > 0.866 * Math.hypot(tI, tQ);
    this.sameTurnRun = same ? this.sameTurnRun + 1 : 0;
    if (this.qpsk) {
      // The turn, less the reversal, averaged over the last few symbols.
      this.turnI += TURN_ALPHA * (-dI / dm - this.turnI);
      this.turnQ += TURN_ALPHA * (-dQ / dm - this.turnQ);
    }
    // Both AFCs move only on a signal trusted for a few symbols running - not one symbol's
    // worth, which a minute of noise at 500 baud offers now and then: one pull moved the
    // oscillator 70 Hz.
    const steady = trusted && this.trustedRun >= TRUST_RUN;
    // The coarse reading. BPSK: from the decimated samples (coarseHz). QPSK: on a run of the
    // same turn only, and from the turn itself. The fourth power of the decimated samples
    // will not do: as the matched filter slides across a quarter turn it spins a whole
    // turn, and even across the preamble's reversals, 20 Hz off at 125 baud, the window
    // spans a radian of rotation and the reading came out 5 Hz short and stalled outside
    // the fine AFC's reach. A run of the same turn is the preamble (reversals; QPSK has no
    // long steady carrier, as the text never holds a long run of 1s), and every turn in it
    // is pi + 2 pi df T: unambiguous to half the baud, where the fine AFC's fourth power
    // wraps at an eighth. The decoder's fit is not asked: a signal far enough off to need
    // this does not fit the code.
    let coarse: number | null = null;
    if (this.afc && this.qpsk && phaseQuality >= 0.5 && this.sameTurnRun >= QPSK_COARSE_RUN) {
      coarse = (Math.atan2(this.turnQ, this.turnI) * this.baud) / (2 * Math.PI);
    } else if (this.afc && !this.qpsk && steady && (!this.pskr || phaseQuality >= PSKR_COARSE_QUALITY)) {
      coarse = this.coarseHz();
    }
    // The fine AFC wraps at a quarter of the baud for BPSK, an eighth for QPSK; hand over
    // to the coarse one at half that.
    if (coarse !== null && Math.abs(coarse) > this.baud / (4 * this.order)) {
      // Further off than the fine AFC can measure: pull in on the coarse reading. Only on
      // a signal the squelch trusts: neighbouring matched-filter sums share most of their
      // samples, so noise too looks like a carrier for a moment.
      this.lo += COARSE_GAIN * coarse;
      this.clampLo();
    } else if (this.afc && this.pskr) {
      // PSK-R: from the long phase average, at its own pace, whenever the squelch trusts it.
      // The short average steers BPSK, which never copies where it is noise; PSK-R copies at
      // 3 dB a symbol, where a 24-symbol angle wanders by several Hz and the AFC followed it
      // 30 Hz off a signal that was dead on frequency.
      if (quality >= Math.max(0.5, this.squelch)) {
        const angle = Math.atan2(this.pskrQQ, this.pskrQI);
        this.lo += this.pskrAlpha * PSKR_AFC_GAIN * ((angle * this.baud) / (4 * Math.PI));
        this.clampLo();
      }
    } else if (this.afc && steady) {
      // The averaged angle is 2 pi df T times the order (4 pi df T for BPSK).
      const angle = Math.atan2(this.qualQ, this.qualI);
      const dfHz = (angle * this.baud) / (2 * Math.PI * this.order);
      this.lo += AFC_GAIN * dfHz;
      this.clampLo();
    }
    this.stats.open = open;
    if (this.pskr) return this.pskrDeliver(soft, open);
    if (!this.viterbi) return this.deliver(bit, open);
    // QPSK: the bit just decided went out QPSK_TRACEBACK symbols ago; print it if the
    // squelch was open then.
    const wasOpen = this.openLine[this.openHead] === 1;
    this.openLine[this.openHead] = open ? 1 : 0;
    this.openHead = (this.openHead + 1) % this.openLine.length;
    return bit < 0 ? "" : this.deliver(bit, wasOpen);
  }

  /**
   * QPSK's quality, from the decoder rather than the phases. The fourth power of the phase
   * (fldigi's metric for QPSK) falls so fast in noise that at -9 dB, where the code still
   * copies every character, it reads 0.3 to 0.4, and noise alone reads up to 0.3: no
   * squelch setting tells them apart. The decoder's fit (QpskViterbi.fit, averaged as the
   * quality is) does: 0.96 and over on a signal at -10 dB, 0.80 on noise and never above
   * 0.89 in a minute of it. Mapped so 0.8 is 0 and 1 is 1, it reads on the same scale as
   * BPSK's quality and the same squelch setting means the same thing.
   */
  private fitQuality(): number {
    return Math.max(0, Math.min(1, (this.fitAvg - QPSK_FIT_FLOOR) / (1 - QPSK_FIT_FLOOR)));
  }

  /**
   * fldigi's DCD patterns (psk/psk.cxx rx_symbol, the dcdshreg switch). BPSK: sixteen
   * reversals in a row sets the squelch's average to full (fldigi sets quality to 1; the
   * angle is kept here, as the AFC's own average is separate). Both: a steady carrier,
   * seen six times running once it fills the register, empties it. QPSK has no opening
   * pattern: its preamble and postamble are the same reversals.
   */
  private dcdPatterns(dI: number, dQ: number): void {
    const reversal = this.qpsk ? -dI > Math.abs(dQ) : dI < 0;
    const carrier = this.qpsk ? dI > Math.abs(dQ) : dI >= 0;
    this.reversalRun = reversal ? this.reversalRun + 1 : 0;
    this.carrierRun = carrier ? this.carrierRun + 1 : 0;
    if (!this.qpsk && this.reversalRun >= DCD_ON_RUN) {
      const g = Math.hypot(this.gateI, this.gateQ);
      if (g > 0) {
        this.gateI /= g;
        this.gateQ /= g;
      } else {
        this.gateI = 1;
        this.gateQ = 0;
      }
      this.offSeen = 0;
      return;
    }
    if (this.carrierRun >= (this.qpsk ? DCD_OFF_RUN_QPSK : DCD_OFF_RUN_BPSK)) {
      if (++this.offSeen >= DCD_OFF_REPEATS) {
        this.offSeen = 0;
        this.gateI = 0;
        this.gateQ = 0;
        this.fitAvg = QPSK_FIT_FLOOR;
      }
      return;
    }
    if (this.offSeen > 0) this.offSeen--;
  }

  /** One QPSK symbol's soft metrics to the Viterbi decoder: the bit it decides, or -1. */
  private qpskDecide(dI: number, dQ: number, dm: number): number {
    // The product's angle is the audio's turn, 180 + 90 d (180 - 90 d reversed). Negated it
    // is 90 d, or -90 d reversed, which the conjugate brings back to 90 d.
    const qI = -dI;
    const qQ = this.reverse ? dQ : -dQ;
    this.softAmp += SOFT_ALPHA * (dm - this.softAmp);
    const scale = this.softAmp > 0 ? 1 / this.softAmp : 0;
    // Correlation with each of the four: a symbol weighs by its own strength.
    this.met[0] = qI * scale;
    this.met[1] = qQ * scale;
    this.met[2] = -qI * scale;
    this.met[3] = -qQ * scale;
    return this.viterbi!.step(this.met);
  }

  /**
   * One PSK-R soft symbol through the decoders, with the squelch's verdict on it; pskr.ts
   * applies that verdict to the characters whose bits these are, when they come out. With
   * the squelch off nothing is held back, not even after a postamble.
   */
  private pskrDeliver(soft: number, open: boolean): string {
    const rx = this.pskr!;
    const before = rx.errors;
    const text = rx.push(soft, open, this.squelch > 0);
    this.stats.errors += rx.errors - before;
    this.stats.open = rx.open;
    // Characters, not UTF-16 units, as deliver() counts them.
    this.stats.chars += Array.from(text).length;
    return text;
  }

  private deliver(bit: number, open: boolean): string {
    const before = this.varicode.errors;
    const ch = this.varicode.pushBit(bit);
    // Unread codes are counted only while the squelch is open: with it closed the bits
    // are noise and every one of them is a code no character has, which is not a fault.
    if (open) this.stats.errors += this.varicode.errors - before;
    if (!ch || !open) return "";
    this.stats.chars++;
    return ch;
  }
}
