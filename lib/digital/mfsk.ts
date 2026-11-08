// MFSK16 and its family: the code and the waveform.
//
// MFSK16 (Nino Porcino IZ8BLY and Murray Greenman ZL1BPU, 2000) sends one of sixteen tones
// at a time, 15.625 Hz apart at 15.625 baud, so each tone is orthogonal to the others over
// a symbol and the whole signal is 234 Hz wide. Each symbol carries four bits. The text is
// MFSK Varicode (lib/digital/mfsk-varicode.ts), protected by the NASA K=7 rate-1/2
// convolutional code and spread by a diagonal interleaver (lib/digital/fec.ts), so a
// symbol lost to a crash of static costs scattered bits the Viterbi decoder puts back.
// The tones are Gray coded: the receiver's likeliest mistake, a neighbouring tone, is
// one bit wrong. The tone is changed with its phase continuous, so the keying is clean.
//
// The family, as fldigi defines it (src/mfsk/mfsk.cxx, mfsk::mfsk(), W1HKJ after gMFSK by
// Tomi Manninen OH2BNS): the same engine with the symbol stretched or shortened and, at
// MFSK8, 32 tones. fldigi works at 8000 or 11025 samples a second and quotes each mode as
// a symbol length there; this port keeps those figures, runs the symbol clock at the
// rate it is given, and so puts the same tones at the same times at 12, 24 or 48 kHz.
//
// What goes on the air, per fldigi's tx_process(): a preamble of 0 bits (one tone, the
// lowest, for a second or so), then CR STX CR, the text, CR EOT CR, then a 1 and a long
// run of 0s to flush the far end's interleaver and Viterbi decoder, and a few more 0s
// while the level fades. The tone set is centred on the operator's frequency: fldigi's
// sendsymbol() puts tone 0 at the carrier minus half the bandwidth.
//
// The decoder is lib/digital/mfskdemod.ts; scripts/check-mfsk.ts runs one through the
// other and checks the first tones against a sequence worked out by hand from fldigi.

import { ConvEncoder, Interleaver, NASA_K, NASA_POLY1, NASA_POLY2 } from "@/lib/digital/fec";
import { mfskTextBytes, mfskVaricodeFor } from "@/lib/digital/mfsk-varicode";

export type MfskModeName = "MFSK8" | "MFSK11" | "MFSK16" | "MFSK22" | "MFSK32";

export interface MfskMode {
  name: MfskModeName;
  /** fldigi's sample rate for the mode: the symbol length below is quoted at it. */
  refRate: number;
  /** Samples a symbol at refRate. */
  symlen: number;
  /** Bits a symbol: log2 of the tones. */
  symbits: number;
  tones: number;
  /** Interleaver stages. */
  depth: number;
  /** Preamble length in fldigi's units (bit pairs pushed through the interleaver; a third of it is sent). */
  preamble: number;
  /** Symbols a second; also the tone spacing in Hz. */
  baud: number;
  toneSpacingHz: number;
  /** From the lowest tone to the highest, Hz: fldigi's `bandwidth`. The signal is about one spacing wider. */
  bandwidthHz: number;
}

function mode(name: MfskModeName, refRate: number, symlen: number, symbits: number, depth: number): MfskMode {
  const tones = 1 << symbits;
  const baud = refRate / symlen;
  return {
    name,
    refRate,
    symlen,
    symbits,
    tones,
    depth,
    preamble: 107,
    baud,
    toneSpacingHz: baud,
    bandwidthHz: (tones - 1) * baud,
  };
}

/**
 * The modes, from fldigi's mfsk::mfsk() constructor (src/mfsk/mfsk.cxx): samplerate,
 * symlen, symbits, depth and preamble as set there for each case. MFSK8 is the odd one,
 * 32 tones and an interleaver half as deep.
 */
export const MFSK_MODES: Readonly<Record<MfskModeName, MfskMode>> = {
  MFSK8: mode("MFSK8", 8000, 1024, 5, 5),
  MFSK11: mode("MFSK11", 11025, 1024, 4, 10),
  MFSK16: mode("MFSK16", 8000, 512, 4, 10),
  MFSK22: mode("MFSK22", 11025, 512, 4, 10),
  MFSK32: mode("MFSK32", 8000, 256, 4, 10),
};

export function mfskMode(name: MfskModeName = "MFSK16"): MfskMode {
  return MFSK_MODES[name];
}

/** The audio centre the mode chip tunes to by default: 1500 Hz, fldigi's sweet spot. */
export const MFSK_CENTRE_HZ = 1500;
/** fldigi's SoftStart default: the level rises and falls over 100 ms (raised cosine). */
export const MFSK_SOFT_START_MS = 100;

/**
 * fldigi's grayencode() (src/misc/misc.cxx): the running exclusive-or of the bits from
 * the top down. Its comments note the names are the other way round from the textbook -
 * this is the inverse of x ^ (x >> 1) - but it is what picks the tone, so it is what is
 * used here: tone = mfskGrayEncode(data).
 */
export function mfskGrayEncode(data: number): number {
  let bits = data & 0xff;
  for (let s = 1; s < 8; s++) bits ^= (data & 0xff) >> s;
  return bits;
}

/** fldigi's graydecode(): data = tone ^ (tone >> 1). */
export function mfskGrayDecode(tone: number): number {
  return (tone ^ (tone >> 1)) & 0xff;
}

/** The audio frequency of tone `tone` (0 lowest) for a signal centred on `centreHz`. */
export function mfskToneHz(m: MfskMode, centreHz: number, tone: number): number {
  return centreHz - m.bandwidthHz / 2 + tone * m.toneSpacingHz;
}

/**
 * fldigi's transmit state machine with the audio left out: data bits in, tone numbers
 * out. sendbit() encodes a bit and collects the two code bits, first polynomial first,
 * into a symbol; a full symbol goes through the interleaver and is Gray coded to a tone.
 */
class MfskSymbolWriter {
  private readonly enc = new ConvEncoder(NASA_K, NASA_POLY1, NASA_POLY2);
  private readonly inlv: Interleaver;
  private bitshreg = 0;
  private bitstate = 0;
  readonly tones: number[] = [];
  /** Where the flush's trailing 0s start, as a symbol index: the level fades from there. */
  tailStart = 0;

  constructor(private readonly m: MfskMode) {
    this.inlv = new Interleaver(m.symbits, m.depth, "fwd");
  }

  private pushCoded(data: number, emit: boolean): void {
    for (let i = 0; i < 2; i++) {
      this.bitshreg = ((this.bitshreg << 1) | ((data >> i) & 1)) >>> 0;
      this.bitstate++;
      if (this.bitstate === this.m.symbits) {
        const sym = this.inlv.bits(this.bitshreg & (this.m.tones - 1));
        if (emit) this.tones.push(mfskGrayEncode(sym & (this.m.tones - 1)));
        this.bitstate = 0;
        this.bitshreg = 0;
      }
    }
  }

  sendbit(bit: number): void {
    this.pushCoded(this.enc.encode(bit), true);
  }

  sendchar(byte: number): void {
    for (const c of mfskVaricodeFor(byte)) this.sendbit(c === "1" ? 1 : 0);
  }

  /**
   * clearbits(): the encoder's output for one 0, pushed `preamble` times through the
   * interleaver without being sent - it fills the interleaver with 0s and, because 214
   * is not a whole number of symbols, leaves a part symbol of 0s that the first sent
   * bits complete.
   */
  clearbits(): void {
    const data = this.enc.encode(0);
    for (let k = 0; k < this.m.preamble; k++) {
      for (let i = 0; i < 2; i++) {
        this.bitshreg = ((this.bitshreg << 1) | ((data >> i) & 1)) >>> 0;
        this.bitstate++;
        if (this.bitstate === this.m.symbits) {
          this.inlv.bits(this.bitshreg & (this.m.tones - 1));
          this.bitstate = 0;
          this.bitshreg = 0;
        }
      }
    }
  }

  /** flushtx(): a 1 to end the last character at the far end, then 0s; a part symbol is dropped. */
  flushtx(nbits: number): void {
    this.sendbit(1);
    for (let i = 0; i < nbits; i++) this.sendbit(0);
    this.bitstate = 0;
  }
}

export interface MfskSymbolOptions {
  mode?: MfskModeName;
}

/**
 * The tones a line sends, as fldigi's tx_process() sends an over: the preamble (a third
 * of `preamble` 0 bits after clearbits), CR STX CR, the text, CR EOT CR, the flush (a 1
 * and `preamble` 0s) and the soft-start tail (pairs of 0 bits for SoftStart ms, rounded
 * as fldigi's integer arithmetic rounds them). Tone 0 is the lowest.
 */
export function mfskSymbols(text: string, opts: MfskSymbolOptions = {}): { tones: Uint8Array; tailStart: number } {
  const m = mfskMode(opts.mode);
  const w = new MfskSymbolWriter(m);
  // TX_STATE_PREAMBLE
  w.clearbits();
  for (let i = 0; i < Math.floor(m.preamble / 3); i++) w.sendbit(0);
  // TX_STATE_START
  w.sendchar(13);
  w.sendchar(2);
  w.sendchar(13);
  // TX_STATE_DATA
  for (const b of mfskTextBytes(text)) w.sendchar(b);
  // TX_STATE_FLUSH
  w.sendchar(13);
  w.sendchar(4);
  w.sendchar(13);
  w.flushtx(m.preamble);
  w.tailStart = w.tones.length;
  const tailPairs = Math.floor(Math.floor((m.refRate * MFSK_SOFT_START_MS) / 1000) / m.symlen) + 1;
  for (let n = 0; n < tailPairs; n++) {
    w.sendbit(0);
    w.sendbit(0);
  }
  return { tones: Uint8Array.from(w.tones), tailStart: w.tailStart };
}

export interface MfskWaveformOptions {
  sampleRate: number;
  /** Centre of the tone set, Hz audio: the operator's frequency in fldigi. Default 1500. */
  centreHz?: number;
  mode?: MfskModeName;
  /** Peak amplitude. Default 1. */
  amplitude?: number;
}

/** Where symbol `s` starts, in samples at `fs`: rounded per symbol so a fractional length never drifts. */
function symbolStart(m: MfskMode, fs: number, s: number): number {
  return Math.round((s * m.symlen * fs) / m.refRate);
}

/**
 * The audio for a line of text: each symbol its tone, the phase carried across every
 * change (fldigi keeps one oscillator and changes its rate), the first and last 100 ms
 * raised-cosine shaped as fldigi's soft start shapes them, so the carrier neither starts
 * nor stops with a click.
 */
export function mfskWaveform(text: string, opts: MfskWaveformOptions): Float32Array {
  const m = mfskMode(opts.mode);
  const fs = opts.sampleRate;
  const centre = opts.centreHz ?? MFSK_CENTRE_HZ;
  const amp = opts.amplitude ?? 1;
  const { tones, tailStart } = mfskSymbols(text, { mode: m.name });
  const total = symbolStart(m, fs, tones.length);
  const out = new Float32Array(total);
  const ramp = Math.max(1, Math.round((fs * MFSK_SOFT_START_MS) / 1000));
  // The fade starts where fldigi's does, at the tail, or earlier if the tail is shorter
  // than the fade (MFSK8's rounds to nothing), so it always reaches zero.
  const fadeStart = Math.max(0, Math.min(symbolStart(m, fs, tailStart), total - ramp));
  let phase = 0;
  for (let s = 0; s < tones.length; s++) {
    const dphi = (2 * Math.PI * mfskToneHz(m, centre, tones[s]!)) / fs;
    const end = symbolStart(m, fs, s + 1);
    for (let i = symbolStart(m, fs, s); i < end; i++) {
      let g = 1;
      if (i < ramp) g = 0.5 * (1 - Math.cos((Math.PI * i) / ramp));
      if (i >= fadeStart) {
        const t = i - fadeStart;
        g *= t >= ramp ? 0 : 1 - 0.5 * (1 - Math.cos((Math.PI * t) / ramp));
      }
      out[i] = amp * g * Math.cos(phase);
      phase += dphi;
      if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
    }
  }
  return out;
}

/** How long a line takes on the air, ms. Takes the waveform's options; only the mode matters. */
export function mfskDurationMs(text: string, opts: Partial<MfskWaveformOptions> = {}): number {
  const m = mfskMode(opts.mode);
  const { tones } = mfskSymbols(text, { mode: m.name });
  return ((tones.length * m.symlen) / m.refRate) * 1000;
}
