// NAVTEX / SITOR-B demodulator: a continuous stream of audio in, characters out, and the
// completed ZCZC ... NNNN messages on the side.
//
// A port of fldigi's receiver (navtex.cxx, Remi Chateauneu F4ECW and Rik van Riel AB1KW,
// after Paul Lutus's JNX), with its front end and bit clock done differently; the code
// tables, the message format and the test generator are in lib/digital/navtex.ts.
//
// WHY NOT THE RTTY RECEIVER. lib/digital/rttydemod.ts finds each character by its start
// bit, which resets the clock every 7.5 bits. SITOR-B has no start or stop bits: it is a
// synchronous stream of 7-bit characters, 100 a second without a gap, and nothing in the
// signal marks where one character ends and the next begins except the code itself. So
// the receiver needs a bit clock that runs on its own, and a character clock found by
// looking for the place in the bit stream where the characters are valid.
//
// THE FRONT END. The audio is mixed to complex baseband at the centre and decimated to
// about 2000 samples a second (20 a bit) through two cascaded box averages, which null the
// images at every multiple of the new rate. Each tone - mark at +85 Hz, space at -85 Hz
// (navtex.cxx:987-989) - is then mixed to zero and integrated over one bit, the matched
// filter for a rectangular bit. fldigi uses an FFT filter of the same width per tone
// (rtty_filter, navtex.cxx:994-1006); a one-bit boxcar is the textbook equivalent and
// costs a running sum. The two magnitudes go through fldigi's mark/space discriminator,
// W7AY's automatic threshold correction, with fldigi's envelope and noise-floor time
// constants (navtex.cxx:1569-1623): it compares each tone against its own recent envelope
// and the shared noise floor, so a signal with one tone faded - selective fading at 518
// kHz at night, or a filter edge - still slices in the right place. The output is scaled
// by the envelopes so a clean bit reads about +1 (mark) or -1 (space) at any level.
//
// THE BIT CLOCK. fldigi samples early, prompt and late and steps the clock by the slope
// every eight bits (process_multicorrelator, navtex.cxx:1466-1505). This does the same job
// in one step: how far apart the two tone filters read, which peaks at the end of each
// bit's integration and dips to nothing midway through every transition, is averaged
// against the phase of a 100 Hz reference over the last 64 bits, and the angle of that
// average is where in the bit the peaks fall. The sampling instant is steered towards it,
// a quarter of the error each bit. It locks within the first second of phasing from any
// starting phase, rides out a burst of noise (64 bits of memory), and follows a
// transmitter whose clock is off by any amount a real one is (tested at 500 ppm). The
// sample itself is interpolated between the two nearest decimated samples.
//
// THE CHARACTER CLOCK is fldigi's, ported line for line. The last 100 soft bits are kept
// (one second, navtex.cxx:972-973). Until locked, every bit the 14 possible character
// alignments are scored - valid characters, plus characters that match their copy five
// slots back, plus alphas with a rep before them - and the best with at least 3 matches
// and a score over 8 is taken (find_alpha_characters, navtex.cxx:1120-1187). Once locked,
// every second character (the RX position) is decoded. Each clean character takes one off
// an error count and each failure adds one; over 5, the lock is dropped and the search
// begins again. Two reps in a row mean the RX and DX positions are swapped, and the phase
// steps one character (process_char, navtex.cxx:1325-1362).
//
// THE FEC. When the RX copy and the DX copy 35 bits before it are both valid and agree
// (or are alpha and rep, phasing) that is the character. Otherwise fldigi takes whichever
// copy is valid, the RX one first; if neither is, it tries the sum of the soft copies and
// then single bit flips, and gives up (process_bytes, navtex.cxx:1238-1323). Here every
// such case takes the most likely reading of the pair: the valid code that correlates
// best with the two soft copies together, or phasing if alpha-in-RX, rep-in-DX fits
// better still. With one copy valid that is the valid copy nearly always; with neither,
// or two that disagree, it is what fldigi's cascade approximates. Measured over six runs
// of the test signal at -7 dB in 2500 Hz, it took the character errors from 71 in 954 to
// 12 (with the bit clock above in both).
// fldigi's error count is kept as it is: a valid RX copy counts one off, a valid DX copy
// nothing, anything else one on.
//
// POLARITY. On LSB, or a radio that inverts, mark and space trade places and every
// character has three marks instead of four: nothing decodes. fldigi has a reverse button
// (navtex.cxx:1545-1552, 1651-1652). Here the search tries the inverted bits as well when
// the upright ones find nothing, and takes the polarity that locks, so either sideband
// works with no setting. ("normal" or "reverse" pins it.)
//
// THE SQUELCH. fldigi prints everything decoded while locked, which includes the
// characters of noise between a signal ending and the error count giving up. Here a
// character is held until it is confirmed: by a later RX character that agrees with its
// own DX copy (both valid and equal - noise does that about once in five hundred tries),
// or by phasing. Confirmation releases everything held; losing the lock drops it. Until
// the first confirmation after a lock nothing held is trusted, since it was read from
// bits older than the lock. A run of unconfirmed characters longer than HOLD_MAX is let
// through from the front while most characters lately had a readable copy (a signal with
// one copy of every character lost still prints, ten characters late), and dropped when
// they did not (the signal has gone, and the lock is about to). So the last few
// characters of a weak signal that stops dead, unconfirmed, can be lost; a real station
// ends in phasing, which confirms them. Exact digital silence (a FlexRadio's DAX between
// transmissions) reads as zero soft bits, which never make a valid character.
//
// QUALITY is a running average over 8 characters of how each read: 1 confirmed, 0.75 the
// RX copy alone, 0.5 the DX copy alone, 0.25 neither valid, 0 contradicting copies.
//
// AFC. When locked, the frequency error is read from the phase advance of the active
// tone's filter between consecutive bits of the same tone - 2 pi times the error times
// 10 ms - averaged over 16 bits, and the mixer is pulled towards it, a fiftieth a bit,
// within +/-40 Hz. fldigi does it from the waterfall's power density instead
// (process_afc, navtex.cxx:1395-1464), including a 90 Hz jump on a mark/space imbalance
// that its own comments say breaks some signals; this one does not jump.
//
// MESSAGES. In NAVTEX mode the printed characters (CR included) go through
// NavtexMessageAssembler, fldigi's ZCZC/NNNN detection, and completed messages wait in
// takeMessages(). SITOR-B mode prints the same text with no message framing
// (m_only_sitor_b, navtex.cxx:1048-1053).
//
// Not ported: the waterfall-based s/n readout (compute_metric), the ADIF and KML logging,
// and fldigi's minimum logged message length.
//
// scripts/check-navtex.ts runs it clean at 12, 24 and 48 kHz, chunked, off frequency, in
// noise down to the copy limit, inverted, against damaged copies, and on noise and silence.

import {
  CCIR476_ALPHA,
  CCIR476_BETA,
  CCIR476_BITS,
  CCIR476_CHAR32,
  CCIR476_FIGS,
  CCIR476_LTRS,
  CCIR476_REP,
  CCIR476_VALID_CODES,
  NAVTEX_BAUD,
  NAVTEX_CENTRE_HZ,
  NAVTEX_FEC_SLOTS,
  NAVTEX_SHIFT_HZ,
  NavtexMessageAssembler,
  ccir476Char,
  ccir476Valid,
  type NavtexFigures,
  type NavtexMessage,
} from "@/lib/digital/navtex";

export type NavtexSub = "NAVTEX" | "SITOR-B";

export interface NavtexDemodOptions {
  sampleRate: number;
  /** Audio centre, Hz: midway between the tones. Default 1000 (navtex.cxx:862). */
  centreHz?: number;
  /** "NAVTEX" (default) frames messages; "SITOR-B" prints the text alone. */
  sub?: NavtexSub | string;
  figures?: NavtexFigures;
  /** Which tone is mark: "auto" (default) finds out, "normal" is mark high (USB), "reverse" mark low. */
  polarity?: "auto" | "normal" | "reverse";
  /** Track the signal's frequency while locked. Default true. */
  afc?: boolean;
}

export interface NavtexDemodStats {
  /** Characters delivered, including spaces and newlines. */
  chars: number;
  /** Characters with neither copy valid (read from the two together), while locked. */
  errors: number;
  /** 0 to 1: of the characters lately, how many read cleanly (see quality in the source); 0 when not locked. */
  quality: number;
  /** Where the signal sits relative to the centre asked for, Hz (the AFC's correction plus what it still sees). */
  afcHz: number;
  /** Locked to a signal's characters. */
  open: boolean;
  /** The stronger tone's amplitude, in the input's units, for a level display. */
  level: number;
  /** Whether the tones were found swapped (LSB). */
  reversed: boolean;
  /** Messages completed (NAVTEX mode). */
  messages: number;
}

/** Decimated rate aimed at, Hz: 20 samples a bit. */
const TARGET_RATE = 2000;
/** Bits of the sync window (m_bit_values, navtex.cxx:972-973). */
const WINDOW_BITS = NAVTEX_BAUD;
/** The DX copy is this many bits before the RX copy (fec_offset, navtex.cxx:1082-1084). */
const FEC_BITS = NAVTEX_FEC_SLOTS * CCIR476_BITS;
/** The bit-timing average, bits, and the share of the timing error corrected each bit. */
const TIMING_BITS = 64;
const TIMING_GAIN = 0.25;
/** A character alignment is taken with at least this many copy matches and a score over SYNC_MIN_SCORE (navtex.cxx:1174-1186). */
const SYNC_MIN_REPS = 3;
const SYNC_MIN_SCORE = 8;
/** Error count over which the lock is dropped (navtex.cxx:1221). */
const MAX_ERRORS = 5;
/** Unconfirmed characters held before the oldest is let through. */
const HOLD_MAX = 10;
/**
 * Of the characters lately, the share with a readable copy (one valid, no contradiction)
 * under which unconfirmed characters are dropped rather than let through. Noise reads
 * about 0.4; a signal with one copy of every character destroyed reads 1.
 */
const RELEASE_GOOD_RATE = 0.7;
/** Quality average, characters. */
const QUALITY_CHARS = 8;
/** AFC: frequency estimate's memory, bits; correction per bit; range, Hz. */
const AFC_BITS = 16;
const AFC_GAIN = 0.02;
const AFC_MAX_HZ = 40;
/** AFC: the least |soft bit| it reads from, and the least quality it corrects at. */
const AFC_MIN_BIT = 0.5;
const AFC_MIN_QUALITY = 0.6;

/** fldigi's decayavg (misc.h). */
function decayavg(avg: number, input: number, weight: number): number {
  return weight <= 1 ? input : avg + (input - avg) / weight;
}

/** A running-sum box average over the last `n` complex samples. */
class Box {
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  private head = 0;
  private laps = 0;
  sumRe = 0;
  sumIm = 0;
  constructor(readonly n: number) {
    this.re = new Float64Array(n);
    this.im = new Float64Array(n);
  }
  push(re: number, im: number): void {
    this.sumRe += re - this.re[this.head]!;
    this.sumIm += im - this.im[this.head]!;
    this.re[this.head] = re;
    this.im[this.head] = im;
    if (++this.head === this.n) {
      this.head = 0;
      // Re-add the sums now and then, so rounding cannot build up over hours: digital
      // silence must read as exactly zero.
      if (++this.laps >= 4096) {
        this.laps = 0;
        let r = 0;
        let i = 0;
        for (let k = 0; k < this.n; k++) {
          r += this.re[k]!;
          i += this.im[k]!;
        }
        this.sumRe = r;
        this.sumIm = i;
      }
    }
  }
  reset(): void {
    this.re.fill(0);
    this.im.fill(0);
    this.head = 0;
    this.laps = 0;
    this.sumRe = this.sumIm = 0;
  }
}

/** How a character was read (process_bytes's return, navtex.cxx:1232-1237, plus the squelch's confirmation). */
interface CharRead {
  /** The code to act on, or -1 for none (phasing, or a rep fldigi would not act on). */
  code: number;
  /** fldigi's: 1 the RX copy valid, 0 only the DX copy, -1 neither or a contradiction. */
  success: number;
  /** Both copies valid and the same, or phasing in its places: proof of a real signal. */
  confirmed: boolean;
  /** For the quality: how cleanly it read, 0 to 1. */
  score: number;
  /** The confirmation was phasing (alpha in RX, rep in DX). */
  phasing?: boolean;
  /** Neither copy was valid. */
  error?: boolean;
}

export class NavtexDemodulator {
  private readonly fs: number;
  private readonly decim: number;
  private readonly fs2: number;
  /** Decimated samples per bit, possibly fractional. */
  private readonly spb: number;
  private readonly sitorB: boolean;
  private readonly polarityMode: "auto" | "normal" | "reverse";
  private readonly afcOn: boolean;
  private readonly variant: NavtexFigures;
  private centreHz: number;

  // Front end.
  private loPhase = 0;
  /** The mixer step, radians a sample: centre plus the AFC correction. */
  private dlo = 0;
  private cic1: Box;
  private cic2: Box;
  private decimCount = 0;
  private tonePhase = 0;
  private markBox: Box;
  private spaceBox: Box;

  // ATC discriminator state (navtex.cxx:1589-1623).
  private markEnv = 0;
  private spaceEnv = 0;
  private markNoise = 0;
  private spaceNoise = 0;

  // Bit clock.
  private n = 0;
  /** Phase of the 100 Hz reference, decimated samples, 0 to spb. */
  private refPhase = 0;
  private timRe = 0;
  private timIm = 0;
  private nextBitAt: number;
  private lastL = 0;
  // The AFC's view of the tones at the last bit.
  private lastMarkRe = 0;
  private lastMarkIm = 0;
  private lastSpaceRe = 0;
  private lastSpaceIm = 0;
  private lastBitMark: boolean | null = null;
  private afcRe = 0;
  private afcIm = 0;
  private afcOffset = 0;
  private residualHz = 0;

  // Character clock and FEC (navtex.cxx:1120-1362).
  private readonly bits = new Float64Array(WINDOW_BITS);
  private locked = false;
  private reversed = false;
  private cursor = 0;
  private alphaPhase = false;
  private errorCount = 0;
  private figures = false;
  private lastChar = 0;
  private bitCount = 0;

  // Output.
  private held: string[] = [];
  /** Locked, but nothing confirmed yet: what is held is from before the clock settled and is dropped, not let through. */
  private fresh = false;
  private quality = 0;
  /** Running share of characters with a readable copy, for the squelch. */
  private goodRate = 0;
  private readonly assembler = new NavtexMessageAssembler();
  private messages: NavtexMessage[] = [];
  private readonly stats: NavtexDemodStats = { chars: 0, errors: 0, quality: 0, afcHz: 0, open: false, level: 0, reversed: false, messages: 0 };

  constructor(opts: NavtexDemodOptions) {
    this.fs = opts.sampleRate;
    this.centreHz = opts.centreHz ?? NAVTEX_CENTRE_HZ;
    this.sitorB = /^SITOR/i.test(opts.sub ?? "NAVTEX");
    this.polarityMode = opts.polarity ?? "auto";
    this.afcOn = opts.afc ?? true;
    this.variant = opts.figures ?? "ita2";
    this.decim = Math.max(1, Math.round(this.fs / TARGET_RATE));
    this.fs2 = this.fs / this.decim;
    this.spb = this.fs2 / NAVTEX_BAUD;
    this.cic1 = new Box(this.decim);
    this.cic2 = new Box(this.decim);
    const len = Math.max(4, Math.round(this.spb));
    this.markBox = new Box(len);
    this.spaceBox = new Box(len);
    this.nextBitAt = this.spb;
    this.reversed = this.polarityMode === "reverse";
    this.stats.reversed = this.reversed;
    this.setMixer();
  }

  private setMixer(): void {
    this.dlo = (2 * Math.PI * (this.centreHz + this.afcOffset)) / this.fs;
  }

  get statistics(): Readonly<NavtexDemodStats> {
    return this.stats;
  }

  /** Completed messages since the last call, oldest first (NAVTEX mode). */
  takeMessages(): NavtexMessage[] {
    const m = this.messages;
    this.messages = [];
    return m;
  }

  /** Move the centre while running. The AFC's correction starts over from the new centre. */
  retune(centreHz: number): void {
    this.centreHz = centreHz;
    this.afcOffset = 0;
    this.afcRe = this.afcIm = 0;
    this.residualHz = 0;
    this.lastBitMark = null;
    this.stats.afcHz = 0;
    this.setMixer();
  }

  /** Forget everything: filters, clocks, lock, polarity, AFC, held text, open message, queued messages, counters. */
  reset(): void {
    this.loPhase = 0;
    this.cic1.reset();
    this.cic2.reset();
    this.decimCount = 0;
    this.tonePhase = 0;
    this.markBox.reset();
    this.spaceBox.reset();
    this.markEnv = this.spaceEnv = this.markNoise = this.spaceNoise = 0;
    this.n = 0;
    this.refPhase = 0;
    this.timRe = this.timIm = 0;
    this.nextBitAt = this.spb;
    this.lastL = 0;
    this.lastMarkRe = this.lastMarkIm = this.lastSpaceRe = this.lastSpaceIm = 0;
    this.lastBitMark = null;
    this.afcRe = this.afcIm = 0;
    this.afcOffset = 0;
    this.setMixer();
    this.residualHz = 0;
    this.bits.fill(0);
    this.locked = false;
    this.reversed = this.polarityMode === "reverse";
    this.cursor = 0;
    this.alphaPhase = false;
    this.errorCount = 0;
    this.figures = false;
    this.lastChar = 0;
    this.bitCount = 0;
    this.held = [];
    this.fresh = false;
    this.quality = 0;
    this.goodRate = 0;
    this.assembler.reset();
    this.messages = [];
    Object.assign(this.stats, { chars: 0, errors: 0, quality: 0, afcHz: 0, open: false, level: 0, reversed: this.reversed, messages: 0 });
  }

  /**
   * Feed audio; get whatever text was confirmed inside it. CRs are not returned (fldigi's
   * filter_print, navtex.cxx:1364-1371); a BEL prints as an apostrophe, as fldigi does.
   * Chunks of any size give the same text as one large call.
   */
  feed(samples: ArrayLike<number>): string {
    let out = "";
    for (let k = 0; k < samples.length; k++) {
      const x = samples[k] as number;
      const re = x * Math.cos(this.loPhase);
      const im = -x * Math.sin(this.loPhase);
      this.loPhase += this.dlo;
      if (this.loPhase > 2 * Math.PI) this.loPhase -= 2 * Math.PI;
      this.cic1.push(re, im);
      this.cic2.push(this.cic1.sumRe, this.cic1.sumIm);
      if (++this.decimCount < this.decim) continue;
      this.decimCount = 0;
      out += this.decimated(this.cic2.sumRe, this.cic2.sumIm);
    }
    return out;
  }

  /** One sample at the decimated rate. */
  private decimated(zr: number, zi: number): string {
    // Each tone mixed to zero: mark sits at +shift/2, space at -shift/2.
    const c = Math.cos(this.tonePhase);
    const s = Math.sin(this.tonePhase);
    this.tonePhase += (2 * Math.PI * (NAVTEX_SHIFT_HZ / 2)) / this.fs2;
    if (this.tonePhase > 2 * Math.PI) this.tonePhase -= 2 * Math.PI;
    // z * e^{-i phi} for mark, z * e^{+i phi} for space.
    this.markBox.push(zr * c + zi * s, zi * c - zr * s);
    this.spaceBox.push(zr * c - zi * s, zi * c + zr * s);
    const mRe = this.markBox.sumRe;
    const mIm = this.markBox.sumIm;
    const sRe = this.spaceBox.sumRe;
    const sIm = this.spaceBox.sumIm;
    const markAbs0 = Math.hypot(mRe, mIm);
    const spaceAbs0 = Math.hypot(sRe, sIm);

    // W7AY's automatic threshold correction, as fldigi has it (navtex.cxx:1569-1623).
    const spb = this.spb;
    this.markEnv = decayavg(this.markEnv, markAbs0, markAbs0 > this.markEnv ? spb / 4 : spb * 16);
    this.markNoise = decayavg(this.markNoise, markAbs0, markAbs0 < this.markNoise ? spb / 4 : spb * 48);
    this.spaceEnv = decayavg(this.spaceEnv, spaceAbs0, spaceAbs0 > this.spaceEnv ? spb / 4 : spb * 16);
    this.spaceNoise = decayavg(this.spaceNoise, spaceAbs0, spaceAbs0 < this.spaceNoise ? spb / 4 : spb * 48);
    const floor = (this.markNoise + this.spaceNoise) / 2;
    const markAbs = Math.max(Math.min(markAbs0, this.markEnv), floor);
    const spaceAbs = Math.max(Math.min(spaceAbs0, this.spaceEnv), floor);
    const me = this.markEnv - floor;
    const se = this.spaceEnv - floor;
    const logic = (markAbs - floor) * me - (spaceAbs - floor) * se - 0.5 * (me * me - se * se);
    // Scaled so a clean bit reads about +/-1 at any level.
    const norm = 0.5 * (me * me + se * se);
    let L = norm > 1e-30 ? logic / norm : 0;
    if (this.reversed) L = -L;

    // The 100 Hz reference's phase, and the timing average against it of how far apart
    // the tones are. Not |L|: the discriminator clips each tone to its envelope, which
    // flattens the dips at transitions the timing is read from; the raw difference of the
    // one-bit filters ramps straight through a transition and dips to zero midway.
    const w = (2 * Math.PI * this.refPhase) / spb;
    const a = Math.abs(markAbs0 - spaceAbs0) / (this.markEnv + this.spaceEnv + 1e-30);
    const tw = spb * TIMING_BITS;
    this.timRe += (a * Math.cos(w) - this.timRe) / tw;
    this.timIm += (a * Math.sin(w) - this.timIm) / tw;

    // The decimated gain is decim^2 (two box sums) times the tone box's length; a tone of
    // amplitude A mixes down to A/2.
    this.stats.level = (2 * Math.max(this.markEnv, this.spaceEnv)) / (this.decim * this.decim * this.markBox.n);

    let out = "";
    this.n++;
    if (this.n >= this.nextBitAt) {
      // Interpolate L at the fractional instant between the last sample and this one.
      const frac = this.n - this.nextBitAt;
      const bit = L - frac * (L - this.lastL);
      // Where in the bit this instant fell, against where the peaks are.
      const here = (((this.refPhase - frac) % spb) + spb) % spb;
      let err = 0;
      if (this.timRe !== 0 || this.timIm !== 0) {
        const target = ((Math.atan2(this.timIm, this.timRe) / (2 * Math.PI)) * spb + spb) % spb;
        err = target - here;
        if (err > spb / 2) err -= spb;
        else if (err < -spb / 2) err += spb;
      }
      this.nextBitAt += spb + TIMING_GAIN * err;
      this.afcBit(bit, mRe, mIm, sRe, sIm);
      out = this.handleBit(bit);
    }
    this.lastL = L;
    this.refPhase += 1;
    if (this.refPhase >= spb) this.refPhase -= spb;
    return out;
  }

  /** The AFC: phase advance of the active tone over one bit, when the last bit was the same tone. */
  private afcBit(bit: number, mRe: number, mIm: number, sRe: number, sIm: number): void {
    const isMark = bit > 0 !== this.reversed;
    const [re, im, pr, pi] = isMark ? [mRe, mIm, this.lastMarkRe, this.lastMarkIm] : [sRe, sIm, this.lastSpaceRe, this.lastSpaceIm];
    // Only bits that read clearly, so noise and the edges of a transmission do not pull it.
    if (this.lastBitMark === isMark && Math.abs(bit) > AFC_MIN_BIT) {
      // z * conj(previous): its angle is 2 pi times the error times one bit.
      const xr = re * pr + im * pi;
      const xi = im * pr - re * pi;
      const mag = Math.hypot(xr, xi);
      if (mag > 0) {
        this.afcRe += (xr / mag - this.afcRe) / AFC_BITS;
        this.afcIm += (xi / mag - this.afcIm) / AFC_BITS;
      }
    }
    this.lastMarkRe = mRe;
    this.lastMarkIm = mIm;
    this.lastSpaceRe = sRe;
    this.lastSpaceIm = sIm;
    this.lastBitMark = isMark;
    this.residualHz = this.afcRe !== 0 || this.afcIm !== 0 ? (Math.atan2(this.afcIm, this.afcRe) * NAVTEX_BAUD) / (2 * Math.PI) : 0;
    // The phase advance over one bit reads the error modulo 100 Hz, so near +/-50 Hz it
    // cannot tell which way; a residual that large is not acted on.
    if (this.locked && this.afcOn && this.quality >= AFC_MIN_QUALITY && Math.abs(this.residualHz) < AFC_MAX_HZ) {
      this.afcOffset = Math.max(-AFC_MAX_HZ, Math.min(AFC_MAX_HZ, this.afcOffset + AFC_GAIN * this.residualHz));
      this.setMixer();
    }
    this.stats.afcHz = this.afcOffset + (this.locked ? this.residualHz : 0);
  }

  // -------------------------------------------------------------------------
  // The character clock and the FEC: fldigi's, navtex.cxx:1080-1362.
  // -------------------------------------------------------------------------

  /**
   * The most likely reading of an RX copy and its DX copy: the valid code (other than alpha
   * and rep) that correlates best with the two soft copies together, or phasing (alpha in
   * RX, rep in DX) if that correlates better still, returned as -1, no character. The second hypothesis matters
   * in noisy phasing, where the two copies are different characters by design and a
   * reading of their sum as one character is a letter printed out of nothing.
   */
  private static mostLikely(b: Float64Array, at: number, repAt: number): number {
    let best = -1;
    let bestM = -Infinity;
    for (const c of CCIR476_VALID_CODES) {
      // Alpha or rep as a character in both slots is not something a station sends; as
      // the most likely reading it would only feed the phase repair noise.
      if (c === CCIR476_ALPHA || c === CCIR476_REP) continue;
      let m = 0;
      for (let k = 0; k < CCIR476_BITS; k++) {
        const v = b[at + k]! + b[repAt + k]!;
        m += (c >> k) & 1 ? v : -v;
      }
      if (m > bestM) {
        bestM = m;
        best = c;
      }
    }
    let ph = 0;
    for (let k = 0; k < CCIR476_BITS; k++) {
      ph += (CCIR476_ALPHA >> k) & 1 ? b[at + k]! : -b[at + k]!;
      ph += (CCIR476_REP >> k) & 1 ? b[repAt + k]! : -b[repAt + k]!;
    }
    return ph > bestM ? -1 : best;
  }

  private static isControl(code: number): boolean {
    return code === CCIR476_ALPHA || code === CCIR476_REP || code === CCIR476_CHAR32 || code === CCIR476_BETA;
  }

  /** Is there a valid character at bits[i..i+6] (valid_char_at, navtex.cxx:604-613)? */
  private static validAt(b: Float64Array, i: number): boolean {
    let n = 0;
    for (let k = 0; k < CCIR476_BITS; k++) if (b[i + k]! > 0) n++;
    return n === 4;
  }

  /** The code at bits[i..i+6], least significant first (bytes_to_code, navtex.cxx:577-584). */
  private static codeAt(b: ArrayLike<number>, i: number): number {
    let code = 0;
    for (let k = 0; k < CCIR476_BITS; k++) if ((b[i + k] as number) > 0) code |= 1 << k;
    return code;
  }

  /** The best character alignment in the window, or -1 (find_alpha_characters, navtex.cxx:1129-1187). */
  private static findAlpha(b: Float64Array): number {
    let bestOffset = 0;
    let bestScore = 0;
    const limit = b.length - CCIR476_BITS;
    for (let offset = FEC_BITS; offset < FEC_BITS + 2 * CCIR476_BITS; offset++) {
      let score = 0;
      let reps = 0;
      for (let i = offset; i < limit; i += CCIR476_BITS) {
        if (!NavtexDemodulator.validAt(b, i)) continue;
        const code = NavtexDemodulator.codeAt(b, i);
        const rep = NavtexDemodulator.codeAt(b, i - FEC_BITS);
        score++;
        if (code === rep) {
          // Alpha matching alpha five slots back means RX and DX are swapped here.
          if (code === CCIR476_ALPHA || code === CCIR476_REP) {
            score = 0;
            continue;
          }
          reps++;
        } else if (code === CCIR476_ALPHA && NavtexDemodulator.codeAt(b, i - CCIR476_BITS) === CCIR476_REP) {
          reps++;
        }
      }
      if (reps >= SYNC_MIN_REPS && score + reps > bestScore) {
        bestScore = score + reps;
        bestOffset = offset;
      }
    }
    return bestScore > SYNC_MIN_SCORE ? bestOffset : -1;
  }

  private dropLock(): void {
    this.locked = false;
    this.errorCount = 0;
    this.figures = false;
    this.held = [];
  }

  /** One soft bit (handle_bit_value, navtex.cxx:1191-1230). */
  private handleBit(v: number): string {
    const b = this.bits;
    b.copyWithin(0, 1);
    b[WINDOW_BITS - 1] = v;
    if (this.cursor > 0) this.cursor--;

    if (!this.locked) {
      let offset = NavtexDemodulator.findAlpha(b);
      if (offset < 0 && this.polarityMode === "auto") {
        // The other sideband? Try the bits inverted.
        const inv = b.map((x) => -x);
        offset = NavtexDemodulator.findAlpha(inv);
        if (offset >= 0) {
          b.set(inv);
          this.reversed = !this.reversed;
          this.stats.reversed = this.reversed;
        }
      }
      if (offset >= 0) {
        this.locked = true;
        this.fresh = true;
        this.goodRate = 0;
        this.cursor = offset;
        this.alphaPhase = true;
        this.errorCount = 0;
        this.figures = false;
      }
    }

    // The ten-minute limit on a message with no NNNN, checked once a second.
    if (!this.sitorB && ++this.bitCount % NAVTEX_BAUD === 0) {
      this.assembler.tick(this.n / this.fs2);
      this.collect();
    }

    let out = "";
    if (this.locked && this.cursor < WINDOW_BITS - CCIR476_BITS) {
      if (this.alphaPhase) {
        const r = this.processBytes(this.cursor);
        // Phasing puts the case back to letters. A station starts every message in letters
        // after phasing, and a FIGS misread in noisy phasing would otherwise print the
        // header as +:+: (ZCZC in figures). fldigi keeps the case.
        if (r.phasing) this.figures = false;
        this.quality = decayavg(this.quality, r.score, QUALITY_CHARS);
        this.goodRate = decayavg(this.goodRate, r.success >= 0 ? 1 : 0, QUALITY_CHARS);
        // Not counted before the first confirmation: those characters are read from the
        // part of the window older than the lock, often from before the signal began.
        if (r.error && !this.fresh) this.stats.errors++;
        this.errorCount -= r.success;
        let text = "";
        if (r.code >= 0) text = this.processChar(r.code);
        if (this.errorCount > MAX_ERRORS) {
          this.dropLock();
          text = "";
        } else {
          if (this.errorCount < 0) this.errorCount = 0;
          out = this.hold(text, r.confirmed);
        }
      }
      this.alphaPhase = !this.alphaPhase;
      this.cursor += CCIR476_BITS;
    }
    this.stats.open = this.locked;
    this.stats.quality = this.locked ? this.quality : 0;
    if (!this.locked) this.quality = 0;
    return out;
  }

  /** Read the RX character at `at`, falling back on its DX copy (process_bytes, navtex.cxx:1238-1323). */
  private processBytes(at: number): CharRead {
    const b = this.bits;
    const code = NavtexDemodulator.codeAt(b, at);
    const valid = ccir476Valid(code);
    const repAt = at - FEC_BITS;
    if (repAt < 0) return valid ? { code, success: 1, confirmed: false, score: 0.75 } : { code: -1, success: -1, confirmed: false, score: 0 };
    const rep = NavtexDemodulator.codeAt(b, repAt);
    const repValid = ccir476Valid(rep);
    if (valid && repValid && code === rep) return { code, success: 1, confirmed: true, score: 1 };
    if (code === CCIR476_ALPHA && rep === CCIR476_REP) return { code, success: 1, confirmed: true, score: 1, phasing: true };
    if (valid !== repValid) {
      // One copy valid. fldigi takes it (navtex.cxx:1242-1266). Here the pair goes to the
      // most likely reading as well, which is that copy nearly always - a valid copy and
      // a damaged one usually agree in six bits of seven - but not in noisy phasing, where
      // a misread alpha that happens to have four marks is set against a DX copy that is
      // still nearly rep, and is phasing, not a letter. A rep in the RX position is kept
      // as fldigi has it, for its phase repair (process_char, navtex.cxx:1328-1336).
      const ml = valid && code === CCIR476_REP ? code : NavtexDemodulator.mostLikely(b, at, repAt);
      return valid ? { code: ml, success: 1, confirmed: false, score: 0.75 } : { code: ml, success: 0, confirmed: false, score: 0.5 };
    }
    // Both copies valid and different, or neither valid. fldigi takes the RX copy blind in
    // the first case; in the second it tries the sum of the soft copies, then single bit
    // flips, and gives up (navtex.cxx:1269-1317). Here both go to the most likely reading
    // of the pair (see mostLikely). Either counts against the lock like fldigi's soft
    // failure; a contradiction counts for nothing in the quality; a pair with neither copy
    // valid is an error.
    const ml = NavtexDemodulator.mostLikely(b, at, repAt);
    return { code: ml, success: -1, confirmed: false, score: valid ? 0 : 0.25, error: !valid };
  }

  /** Act on a code: shifts, phase repair, or a character (process_char, navtex.cxx:1325-1362). */
  private processChar(code: number): string {
    let text = "";
    let last = code;
    switch (code) {
      case CCIR476_REP:
        // Two reps in RX positions: RX and DX are swapped; step a character.
        if (this.lastChar === CCIR476_REP) this.alphaPhase = false;
        break;
      case CCIR476_ALPHA:
      case CCIR476_BETA:
      case CCIR476_CHAR32:
        break;
      case CCIR476_LTRS:
        this.figures = false;
        break;
      case CCIR476_FIGS:
        this.figures = true;
        break;
      default: {
        const ch = ccir476Char(code, this.figures, this.variant);
        if (ch === null) {
          if (!this.fresh) this.stats.errors++;
        } else {
          text = ch;
          last = ch.charCodeAt(0);
        }
      }
    }
    this.lastChar = last;
    return text;
  }

  private collect(): void {
    const done = this.assembler.take();
    if (done.length) {
      this.messages.push(...done);
      this.stats.messages += done.length;
    }
  }

  /** The squelch: hold until confirmed (see the top of the file). */
  private hold(text: string, confirmed: boolean): string {
    if (text) this.held.push(text);
    let release: string[];
    if (confirmed) {
      // The first confirmation after a lock: what came before it was read while the clock
      // was still settling, from bits in the window older than the lock. Only this
      // character is trusted.
      release = this.fresh ? this.held.slice(-1).filter(() => text !== "") : this.held;
      this.fresh = false;
      this.held = [];
    } else if (this.held.length > HOLD_MAX) {
      // Too long without a confirmation. While most characters still have a readable copy
      // the oldest is let through, a few characters late; when they do not, the signal
      // has gone (or is below copy) and what is held is mostly wrong.
      if (this.goodRate < RELEASE_GOOD_RATE) {
        this.held.shift();
        return "";
      }
      release = this.held.splice(0, this.held.length - HOLD_MAX);
    } else {
      return "";
    }
    let out = "";
    const t = this.n / this.fs2;
    for (const ch of release) {
      if (!this.sitorB) {
        this.assembler.push(ch, t);
        this.collect();
      }
      if (ch === "\r") continue;
      out += ch === "\x07" ? "'" : ch;
      this.stats.chars++;
    }
    return out;
  }
}
