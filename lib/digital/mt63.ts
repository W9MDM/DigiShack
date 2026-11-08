// MT63: the code and the waveform.
//
// MT63 (Pawel Jalocha SP9VRC, 1998) is 64 carriers at once, each one differential BPSK at a
// slow 5, 10 or 20 baud, with a forward error correction strong enough that a third of the
// bits can be lost and the text still prints. Every character is 7 bits. It becomes one of
// 128 Walsh functions - a row of the 64-point Hadamard matrix, inverted for the upper 64
// codes - so each character is 64 bits, one per carrier. Those bits are not sent together:
// each carrier's bit is held back by its own delay, up to 32 symbols (short interleave) or
// 64 (long), so a burst of noise or a fade a few seconds long takes one bit from each of
// many characters rather than all of one. The receiver puts the delays back, takes the
// fast Hadamard transform of the 64 soft bits and reads the character off the peak.
//
// Ported from fldigi 4.2.13's src/mt63 (Pawel Jalocha's MT63 code, GPL, as carried in fldigi
// by W1HKJ): mt63base.cxx (encoder, decoder, transmitter, receiver), symbol.dat (the symbol
// shape), mt63intl.dat (the interleave patterns) and the helpers in dsp.cxx / dsp.h. The
// arithmetic that decides what goes on the air is the reference's, line for line.
//
// THE SIGNAL. fldigi works at 8000 Hz and splits it into a complex baseband at 8000 divided
// by 8, 4 or 2 (1000, 2000 or 4000 Hz for MT63-500, -1000 and -2000; mt63base.cxx:104-119).
// Everything after that - the 512-point FFT, the 512-sample symbol shape, symbols 200
// samples apart, carriers 4 FFT bins apart (symbol.dat:24-26) - is the same in every mode;
// the mode only changes how fast that baseband runs. So:
//
//   mode      baseband   FFT bin     carrier spacing   baud   width (64 carriers)
//   500       1000 Hz    1.953 Hz     7.8125 Hz          5     500 Hz
//   1000      2000 Hz    3.906 Hz    15.625 Hz          10    1000 Hz
//   2000      4000 Hz    7.812 Hz    31.25 Hz           20    2000 Hz
//
// One character per symbol: 5, 10 or 20 characters a second.
//
// The odd carriers are sent half a symbol after the even ones (mt63base.cxx:311, two
// IFFTs a half-symbol apart), so the 64 carriers never all change phase at the same
// instant, and the symbol shape is 2.56 symbols long, overlapping its neighbours.
//
// WHERE IT SITS. fldigi's cursor frequency is the nominal centre: the first carrier is
// placed at the FFT bin nearest cursor - bandwidth / 2 (mt63base.cxx:106,111,116), and the
// 64th is 63 spacings above, at cursor + 31/64 of the bandwidth. The carriers' own centre is
// half a spacing below the cursor (7.8 Hz in MT63-1000). fldigi's "transmit lowest tone at
// 500 Hz" puts the cursor at 500 + bandwidth / 2 (mt63.cxx:329-331), so the band starts at
// 500 Hz; "centred at 1500 Hz" (the SHARES setting) puts the cursor at 1500. NBEMS nets
// mostly run MT63-1000/2000 with the cursor at 1500. centreHz below is fldigi's cursor.
//
// RATES. DigiShack's audio is 12, 24 or 48 kHz, and every one of those is a whole multiple
// of every baseband rate above. So instead of resampling to 8000 Hz and repeating fldigi's
// front end, the transmitter interpolates the baseband straight up by that whole factor
// with a windowed-sinc filter, and the receiver mixes and decimates straight down to it.
// The baseband - and so every bit, phase and timing decision - is the reference's exactly;
// only the filter that gets between it and the audio differs.
//
// Not in the reference and therefore not here: a scrambler. MT63 has none (CarrMarkCode in
// mt63base.cxx:127 is set and never used). The nearest thing is the starting phase of each
// carrier, which rises quadratically across the band (mt63base.cxx:168-172) so the 64
// carriers do not all add up at once.

import { fht, ifht } from "@/lib/digital/olivia";

export type Mt63Mode = "500S" | "500L" | "1000S" | "1000L" | "2000S" | "2000L";
export type Mt63Bandwidth = 500 | 1000 | 2000;

/** fldigi's internal rate (mt63.cxx:386). */
export const MT63_REF_RATE = 8000;
export const MT63_CARRIERS = 64;
/** The symbol shape's length and the FFT length (symbol.dat:24). */
export const MT63_SYMBOL_LEN = 512;
/** Baseband samples from one symbol to the next on a carrier (symbol.dat:25). */
export const MT63_SYMBOL_SEPAR = 200;
/** Carriers are 4 FFT bins apart (symbol.dat:26). */
export const MT63_CARRIER_SEPAR = 4;

export const MT63_MODES: readonly Mt63Mode[] = ["500S", "500L", "1000S", "1000L", "2000S", "2000L"];

export interface Mt63Params {
  mode: Mt63Mode;
  bandwidth: Mt63Bandwidth;
  /** Interleave depth in symbols: 32 short, 64 long (mt63base.cxx:130-137). */
  interleave: 32 | 64;
  /** fldigi's DecimateRatio: 8, 4 or 2 (mt63base.cxx:104-119). */
  decimate: number;
  /** The complex baseband rate the reference works at: 8000 / decimate. */
  basebandRate: number;
  /** One FFT bin, Hz. */
  binHz: number;
  carrierSpacingHz: number;
  baud: number;
  charactersPerSecond: number;
}

export function mt63Params(mode: Mt63Mode): Mt63Params {
  const bandwidth = Number(mode.slice(0, -1)) as Mt63Bandwidth;
  const interleave = mode.endsWith("L") ? 64 : 32;
  const decimate = bandwidth === 500 ? 8 : bandwidth === 1000 ? 4 : 2;
  const basebandRate = MT63_REF_RATE / decimate;
  const binHz = basebandRate / MT63_SYMBOL_LEN;
  const baud = basebandRate / MT63_SYMBOL_SEPAR;
  return {
    mode,
    bandwidth,
    interleave,
    decimate,
    basebandRate,
    binHz,
    carrierSpacingHz: binHz * MT63_CARRIER_SEPAR,
    baud,
    charactersPerSecond: baud,
  };
}

/**
 * The first carrier's FFT bin (at the baseband rate) for a cursor at `centreHz`, as fldigi
 * computes FirstDataCarr: the bin nearest centre - bandwidth / 2 (mt63base.cxx:106-116).
 */
export function mt63FirstCarrierBin(params: Mt63Params, centreHz: number): number {
  return Math.floor((centreHz - params.bandwidth / 2) / params.binHz + 0.5);
}

/** The audio frequency of carrier `i` (0..63) for a cursor at `centreHz`. */
export function mt63CarrierHz(params: Mt63Params, centreHz: number, i: number): number {
  return (mt63FirstCarrierBin(params, centreHz) + MT63_CARRIER_SEPAR * i) * params.binHz;
}

/**
 * How far each carrier's bit is held back, as a step pattern (mt63intl.dat:24-47). The
 * delay of carrier i is the running sum of the steps before it, modulo the depth.
 */
export const MT63_SHORT_INTERLEAVE: readonly number[] = Array.from({ length: 64 }, (_, i) => 4 + (i & 3));
export const MT63_LONG_INTERLEAVE: readonly number[] = Array.from({ length: 64 }, (_, i) => (i + 1) & 63);

export function mt63InterleavePattern(interleave: 32 | 64): readonly number[] {
  return interleave === 64 ? MT63_LONG_INTERLEAVE : MT63_SHORT_INTERLEAVE;
}

// symbol.dat: the symbol shape from Jalocha's MT63ASC for the EVM56K, 512 points. It is
// exactly symmetric (shape[i] === shape[512 - i]), so the first 257 are kept and mirrored.
const HALF_SHAPE = [
  0.00000000, 0.00000665, 0.00002657, 0.00005975, 0.00010613, 0.00016562, 0.00023810, 0.00032341,
  0.00042134, 0.00053162, 0.00065389, 0.00078773, 0.00093261, 0.00108789, 0.00125283, 0.00142653,
  0.00160798, 0.00179599, 0.00198926, 0.00218628, 0.00238542, 0.00258487, 0.00278264, 0.00297662,
  0.00316452, 0.00334394, 0.00351232, 0.00366701, 0.00380526, 0.00392424, 0.00402109, 0.00409288,
  0.00413671, 0.00414969, 0.00412898, 0.00407182, 0.00397555, 0.00383764, 0.00365574, 0.00342767,
  0.00315145, 0.00282534, 0.00244787, 0.00201781, 0.00153424, 0.00099653, 0.00040435, -0.00024231,
  -0.00094314, -0.00169753, -0.00250453, -0.00336293, -0.00427118, -0.00522749, -0.00622977, -0.00727569,
  -0.00836272, -0.00948809, -0.01064886, -0.01184193, -0.01306405, -0.01431189, -0.01558198, -0.01687083,
  -0.01817486, -0.01949051, -0.02081416, -0.02214223, -0.02347113, -0.02479733, -0.02611728, -0.02742752,
  -0.02872457, -0.03000504, -0.03126551, -0.03250262, -0.03371298, -0.03489320, -0.03603988, -0.03714954,
  -0.03821868, -0.03924367, -0.04022079, -0.04114620, -0.04201589, -0.04282570, -0.04357126, -0.04424801,
  -0.04485118, -0.04537575, -0.04581648, -0.04616787, -0.04642421, -0.04657955, -0.04662769, -0.04656225,
  -0.04637665, -0.04606414, -0.04561786, -0.04503082, -0.04429599, -0.04340631, -0.04235475, -0.04113436,
  -0.03973834, -0.03816006, -0.03639316, -0.03443155, -0.03226956, -0.02990192, -0.02732385, -0.02453112,
  -0.02152012, -0.01828789, -0.01483216, -0.01115146, -0.00724508, -0.00311317, 0.00124328, 0.00582236,
  0.01062127, 0.01563627, 0.02086273, 0.02629504, 0.03192674, 0.03775043, 0.04375787, 0.04993995,
  0.05628681, 0.06278780, 0.06943159, 0.07620621, 0.08309914, 0.09009732, 0.09718730, 0.10435526,
  0.11158715, 0.11886870, 0.12618560, 0.13352351, 0.14086819, 0.14820561, 0.15552198, 0.16280389,
  0.17003841, 0.17721311, 0.18431620, 0.19133661, 0.19826401, 0.20508896, 0.21180289, 0.21839823,
  0.22486845, 0.23120806, 0.23741270, 0.24347919, 0.24940549, 0.25519079, 0.26083547, 0.26634116,
  0.27171067, 0.27694807, 0.28205857, 0.28704860, 0.29192571, 0.29669855, 0.30137684, 0.30597130,
  0.31049362, 0.31495636, 0.31937292, 0.32375741, 0.32812465, 0.33249001, 0.33686936, 0.34127898,
  0.34573545, 0.35025554, 0.35485613, 0.35955412, 0.36436627, 0.36930915, 0.37439902, 0.37965170,
  0.38508250, 0.39070609, 0.39653642, 0.40258662, 0.40886890, 0.41539446, 0.42217341, 0.42921470,
  0.43652603, 0.44411383, 0.45198311, 0.46013753, 0.46857925, 0.47730896, 0.48632585, 0.49562756,
  0.50521021, 0.51506840, 0.52519520, 0.53558220, 0.54621950, 0.55709582, 0.56819849, 0.57951351,
  0.59102568, 0.60271860, 0.61457478, 0.62657574, 0.63870210, 0.65093366, 0.66324951, 0.67562817,
  0.68804763, 0.70048553, 0.71291922, 0.72532590, 0.73768272, 0.74996688, 0.76215572, 0.77422687,
  0.78615828, 0.79792836, 0.80951602, 0.82090079, 0.83206287, 0.84298315, 0.85364335, 0.86402598,
  0.87411443, 0.88389296, 0.89334677, 0.90246195, 0.91122553, 0.91962547, 0.92765062, 0.93529073,
  0.94253642, 0.94937916, 0.95581122, 0.96182562, 0.96741616, 0.97257728, 0.97730410, 0.98159233,
  0.98543825, 0.98883864, 0.99179079, 0.99429241, 0.99634163, 0.99793696, 0.99907728, 0.99976178,
  0.99999000,
];

/** The transmit and receive window: the symbol shape (symbol.dat). */
export const MT63_SYMBOL_SHAPE: Float64Array = (() => {
  const s = new Float64Array(MT63_SYMBOL_LEN);
  for (let i = 0; i <= 256; i++) s[i] = HALF_SHAPE[i]!;
  for (let i = 257; i < MT63_SYMBOL_LEN; i++) s[i] = HALF_SHAPE[MT63_SYMBOL_LEN - i]!;
  return s;
})();

// ---------------------------------------------------------------------------------------
// The FFT

/**
 * A radix-2 complex FFT of one power-of-two size, forward (e^-j), in place. The twiddle
 * table is exported the way dsp_r2FFT keeps it - Twiddle[k] = e^(+j 2 pi k / N), dsp.cxx:2105
 * - because the reference indexes it directly for its phase corrections.
 */
export class Mt63Fft {
  readonly size: number;
  readonly mask: number;
  readonly twRe: Float64Array;
  readonly twIm: Float64Array;
  readonly bitRev: Int32Array;

  constructor(size = MT63_SYMBOL_LEN) {
    this.size = size;
    this.mask = size - 1;
    this.twRe = new Float64Array(size);
    this.twIm = new Float64Array(size);
    for (let k = 0; k < size; k++) {
      this.twRe[k] = Math.cos((2 * Math.PI * k) / size);
      this.twIm[k] = Math.sin((2 * Math.PI * k) / size);
    }
    this.bitRev = new Int32Array(size);
    const bits = Math.log2(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
      this.bitRev[i] = r;
    }
  }

  /** Forward transform of data already placed in bit-reversed order (dsp_r2FFT::CoreProc). */
  coreProc(re: Float64Array, im: Float64Array): void {
    const n = this.size;
    for (let half = 1; half < n; half <<= 1) {
      const stride = n / (2 * half);
      for (let start = 0; start < n; start += 2 * half) {
        for (let j = 0, t = 0; j < half; j++, t += stride) {
          const a = start + j;
          const b = a + half;
          // x1 * conj(W): the reference's butterfly (dsp.cxx:2036).
          const wr = this.twRe[t]!;
          const wi = this.twIm[t]!;
          const xr = re[b]! * wr + im[b]! * wi;
          const xi = im[b]! * wr - re[b]! * wi;
          re[b] = re[a]! - xr;
          im[b] = im[a]! - xi;
          re[a] = re[a]! + xr;
          im[a] = im[a]! + xi;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------------------
// The code: Walsh functions and the interleave

/**
 * The character encoder and block interleaver (MT63encoder, mt63base.cxx:369-432). Each
 * call takes one 7-bit code and returns the 64 bits to send on the carriers now: 1 means
 * the carrier keeps its phase, 0 that it flips.
 */
export class Mt63Encoder {
  readonly output = new Uint8Array(MT63_CARRIERS);
  private readonly intlvLen: number;
  private readonly intlvSize: number;
  private readonly intlvPatt = new Int32Array(MT63_CARRIERS);
  private readonly intlvPipe: Uint8Array;
  private intlvPtr = 0;
  private readonly walsh = new Float64Array(MT63_CARRIERS);

  /**
   * `prefill` fills the interleaver with random bits first, as fldigi's transmitter does
   * (mt63base.cxx:147, :379-381), so the first symbols are not a give-away pattern of zeros.
   */
  constructor(interleave: 32 | 64, prefill?: () => number) {
    const n = MT63_CARRIERS;
    this.intlvLen = interleave;
    this.intlvSize = interleave * n;
    this.intlvPipe = new Uint8Array(this.intlvSize);
    if (prefill) for (let i = 0; i < this.intlvSize; i++) this.intlvPipe[i] = prefill() & 1;
    const pattern = mt63InterleavePattern(interleave);
    for (let p = 0, i = 0; i < n; i++) {
      this.intlvPatt[i] = p * n;
      p += pattern[i]!;
      if (p >= this.intlvLen) p -= this.intlvLen;
    }
  }

  process(code: number): Uint8Array {
    const n = MT63_CARRIERS;
    code &= 2 * n - 1;
    this.walsh.fill(0);
    if (code < n) this.walsh[code] = 1;
    else this.walsh[code - n] = -1;
    ifht(this.walsh, n);
    for (let i = 0; i < n; i++) this.intlvPipe[this.intlvPtr + i] = this.walsh[i]! < 0 ? 1 : 0;
    for (let i = 0; i < n; i++) {
      let k = this.intlvPtr + this.intlvPatt[i]!;
      if (k >= this.intlvSize) k -= this.intlvSize;
      this.output[i] = this.intlvPipe[k + i]!;
    }
    this.intlvPtr += n;
    if (this.intlvPtr >= this.intlvSize) this.intlvPtr -= this.intlvSize;
    return this.output;
  }
}

/**
 * The deinterleaver and FEC decoder (MT63decoder, mt63base.cxx:475-579). It is fed, once a
 * symbol, a soft bit for each of 64 + 2 x margin carriers (+1 keep, -1 flip), because the
 * receiver is not sure which carrier is the first: it decodes at every carrier offset in the
 * margin, smooths each offset's signal-to-noise, and reports the character at the best one.
 */
export class Mt63FecDecoder {
  /** The character decided this symbol (from integ / 2 symbols back). */
  output = 0;
  /** The smoothed FEC signal-to-noise at the best offset. */
  signalToNoise = 0;
  /** The best offset, in carriers, from the nominal first carrier. */
  carrOfs = 0;

  readonly scanLen: number;
  readonly scanSize: number;
  private readonly intlvSize: number;
  private readonly intlvPatt = new Int32Array(MT63_CARRIERS);
  private readonly intlvPipe: Float64Array;
  private intlvPtr = 0;
  private readonly walsh = new Float64Array(MT63_CARRIERS);
  private readonly w1: number;
  private readonly w2: number;
  private readonly w5: number;
  private readonly snrMid: Float64Array;
  private readonly snrOut: Float64Array;
  private readonly decodePipe: Int16Array;
  private readonly decodeSize: number;
  private decodePtr = 0;

  constructor(interleave: 32 | 64, margin: number, integ: number) {
    const n = MT63_CARRIERS;
    this.scanLen = 2 * margin + 1;
    this.scanSize = n + 2 * margin;
    this.w1 = 1 / integ;
    this.w2 = 2 / integ;
    this.w5 = 5 / integ;
    const decodeLen = Math.floor(integ / 2);
    this.decodeSize = decodeLen * this.scanLen;
    this.decodePipe = new Int16Array(this.decodeSize);
    const pattern = mt63InterleavePattern(interleave);
    for (let p = 0, i = 0; i < n; i++) {
      this.intlvPatt[i] = p * this.scanSize;
      p += pattern[i]!;
      if (p >= interleave) p -= interleave;
    }
    this.intlvSize = (interleave + 1) * this.scanSize;
    this.intlvPipe = new Float64Array(this.intlvSize);
    this.snrMid = new Float64Array(this.scanLen);
    this.snrOut = new Float64Array(this.scanLen);
  }

  process(data: ArrayLike<number>): number {
    const n = MT63_CARRIERS;
    const size = this.scanSize;
    for (let i = 0; i < size; i++) this.intlvPipe[this.intlvPtr + i] = data[i]!;
    for (let s = 0; s < this.scanLen; s++) {
      for (let i = 0; i < n; i++) {
        let k = this.intlvPtr - size - this.intlvPatt[i]!;
        if (k < 0) k += this.intlvSize;
        // An odd offset swaps which carriers came from the even and the odd half-symbol,
        // so an odd carrier's bit is one row later (mt63base.cxx:535-538).
        if (s & 1 && i & 1) {
          k += size;
          if (k >= this.intlvSize) k -= this.intlvSize;
        }
        this.walsh[i] = this.intlvPipe[k + s + i]!;
      }
      fht(this.walsh, n);
      let min = this.walsh[0]!;
      let max = min;
      let minPos = 0;
      let maxPos = 0;
      for (let i = 1; i < n; i++) {
        const v = this.walsh[i]!;
        if (v < min) {
          min = v;
          minPos = i;
        }
        if (v > max) {
          max = v;
          maxPos = i;
        }
      }
      let code: number;
      let sig: number;
      if (Math.abs(max) > Math.abs(min)) {
        code = maxPos + n;
        sig = Math.abs(max);
        this.walsh[maxPos] = 0;
      } else {
        code = minPos;
        sig = Math.abs(min);
        this.walsh[minPos] = 0;
      }
      let pw = 0;
      for (let i = 0; i < n; i++) pw += this.walsh[i]! * this.walsh[i]!;
      const noise = Math.sqrt(pw / n);
      // The reference reads a noiseless peak as 0 (mt63base.cxx:556-558): a perfect signal
      // would close its own squelch. Here it reads as the cap instead.
      const snr = noise > 0 ? Math.min(100, sig / noise) : sig > 0 ? 100 : 0;
      lowPass2(snr, this.snrMid, this.snrOut, s, this.w1, this.w2, this.w5);
      this.decodePipe[this.decodePtr + s] = code;
    }
    this.intlvPtr += size;
    if (this.intlvPtr >= this.intlvSize) this.intlvPtr = 0;
    this.decodePtr += this.scanLen;
    if (this.decodePtr >= this.decodeSize) this.decodePtr = 0;
    let best = this.snrOut[0]!;
    let bestPos = 0;
    for (let s = 1; s < this.scanLen; s++) {
      if (this.snrOut[s]! > best) {
        best = this.snrOut[s]!;
        bestPos = s;
      }
    }
    this.output = this.decodePipe[this.decodePtr + bestPos]!;
    this.signalToNoise = best;
    this.carrOfs = bestPos - (this.scanLen - 1) / 2;
    return this.output;
  }

  reset(): void {
    this.intlvPipe.fill(0);
    this.intlvPtr = 0;
    this.snrMid.fill(0);
    this.snrOut.fill(0);
    this.decodePipe.fill(0);
    this.decodePtr = 0;
    this.output = 0;
    this.signalToNoise = 0;
    this.carrOfs = 0;
  }
}

/** The reference's two-stage IIR low pass (dspLowPass2, dsp.h:722-735), on element `i`. */
export function lowPass2(inp: number, mid: Float64Array, out: Float64Array, i: number, w1: number, w2: number, w5: number): void {
  const sum = mid[i]! + out[i]!;
  const diff = mid[i]! - out[i]!;
  mid[i] = mid[i]! + w2 * inp - w1 * sum;
  out[i] = out[i]! + w5 * diff;
}

// ---------------------------------------------------------------------------------------
// Text

const UTF8 = new TextEncoder();

/**
 * Text to the codes sent, as fldigi sends them with its default 8-bit setting
 * (configuration.h MT638BIT true; mt63.cxx:133-150): UTF-8 bytes; a byte over 127 goes as
 * the escape code 127 followed by its low seven bits. A newline goes as CR LF. Other
 * control characters, and DEL (which would read as the escape), are dropped. With
 * `eightBit` off, as fldigi does then, a byte over 127 goes as a full stop.
 */
export function mt63TextToCodes(text: string, eightBit = true): number[] {
  const out: number[] = [];
  for (const ch of text) {
    if (ch === "\r") continue;
    if (ch === "\n") {
      out.push(13, 10);
      continue;
    }
    for (const b of UTF8.encode(ch)) {
      if (b < 32 || b === 127) continue;
      if (b < 128) out.push(b);
      else if (eightBit) out.push(127, b & 127);
      else out.push(46);
    }
  }
  return out;
}

/**
 * Codes back to text, as fldigi's receive does (mt63.cxx:205-222): idle (0) and the other
 * codes below 8 are dropped unless escaped; 127 escapes the next code into the upper half;
 * the bytes are UTF-8. CR is silent and LF is the newline. Anything else that is not
 * printable is counted in `errors`: with the squelch open that is a misread character.
 */
export class Mt63TextDecoder {
  errors = 0;
  private escape = false;
  private utf8 = new TextDecoder("utf-8");

  constructor(private readonly eightBit = true) {}

  push(code: number): string {
    let c = code & 127;
    if (this.eightBit) {
      if (c < 8 && !this.escape) return "";
      if (c === 127) {
        this.escape = true;
        return "";
      }
      if (this.escape) {
        c += 128;
        this.escape = false;
      }
    } else if (c === 0) return "";
    if (c === 13 || c === 8) return "";
    if (c === 10) return "\n";
    if (c === 9) return " ";
    if (c < 32 || c === 127) {
      this.errors++;
      return "";
    }
    const s = this.utf8.decode(Uint8Array.of(c), { stream: true });
    if (s.includes("�")) {
      this.errors++;
      return s.replace(/�/g, "");
    }
    return s;
  }

  reset(): void {
    this.escape = false;
    this.utf8 = new TextDecoder("utf-8");
  }
}

// ---------------------------------------------------------------------------------------
// Between the baseband and the audio

/**
 * The interpolation / decimation filter between the reference's baseband and the audio
 * rate: a windowed-sinc low pass cut at half the baseband rate, `32 * factor + 1` taps under
 * fldigi's own window, the 4-term Blackman-Harris (dspWindowBlackman3, dsp.cxx:168). The
 * window's main lobe makes the transition an eighth of the baseband rate either side of
 * the cut, so the band is flat to 3/8 of it (750 Hz in MT63-1000, where the carriers and an
 * 8-carrier search margin need 617) and better than 90 dB down from 5/8, which is all that
 * can fold back onto the signal. fldigi's own filter passes the same +-750 Hz
 * (mt63base.cxx:93). Unity gain at DC; an odd length so the delay is whole samples.
 */
export function mt63RateFilter(factor: number): Float64Array {
  const len = 32 * factor + 1;
  const centre = (len - 1) / 2;
  const fc = 0.5 / factor;
  const h = new Float64Array(len);
  let sum = 0;
  for (let n = 0; n < len; n++) {
    const t = n - centre;
    const sinc = t === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * t) / (Math.PI * t);
    const x = (2 * Math.PI * n) / (len - 1);
    const w = 0.35875 - 0.48829 * Math.cos(x) + 0.14128 * Math.cos(2 * x) - 0.01168 * Math.cos(3 * x);
    h[n] = sinc * w;
    sum += h[n]!;
  }
  for (let n = 0; n < len; n++) h[n] = h[n]! / sum;
  return h;
}

/** Audio samples per baseband sample, or an error naming the rates that work. */
export function mt63RateFactor(params: Mt63Params, sampleRate: number): number {
  const factor = sampleRate / params.basebandRate;
  if (!Number.isInteger(factor) || factor < 1) {
    throw new Error(
      `MT63-${params.bandwidth} needs a sample rate that is a whole multiple of ${params.basebandRate} Hz (8000, 12000, 16000, 24000, 48000 all are): ${sampleRate} is not`,
    );
  }
  return factor;
}

/**
 * Where the baseband sits in the audio. The mixer is put at the middle of the 64 carriers,
 * 126 bins above the first, so they land at -126..+126 bins around zero and the search
 * margin either side stays far inside the baseband. fldigi instead leaves the carriers
 * where they alias to (mt63base.cxx:188-192); either way a carrier's phase on the air is
 * the same continuous tone, which is all the far end sees.
 */
export const MT63_MIX_BIN_ABOVE_FIRST = 126;

/** A table of the mixer, one period long: 512 x factor audio samples is a whole number of its cycles. */
export function mt63MixerTable(mixBin: number, factor: number): { cos: Float64Array; sin: Float64Array } {
  const len = MT63_SYMBOL_LEN * factor;
  const cos = new Float64Array(len);
  const sin = new Float64Array(len);
  for (let n = 0; n < len; n++) {
    const k = (((mixBin * n) % len) + len) % len;
    const ph = (2 * Math.PI * k) / len;
    cos[n] = Math.cos(ph);
    sin[n] = Math.sin(ph);
  }
  return { cos, sin };
}

// ---------------------------------------------------------------------------------------
// The transmitter

/** A small seeded generator for the interleaver prefill and the jamming symbol, so a waveform is reproducible. */
function lcg(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return s >>> 16;
  };
}

export interface Mt63WaveformOptions {
  sampleRate: number;
  /** fldigi's cursor frequency, Hz audio: the first carrier is half the bandwidth below. */
  centreHz: number;
  mode: Mt63Mode;
  /** Peak level of the MT63 part, 0..1. Default 1. */
  amplitude?: number;
  /**
   * Seconds of tuning tone before the MT63 (fldigi's "transmit lower start tone", on by
   * default there for 4 s, mt63.cxx:74-94). Default 0: the receiver does not need it.
   */
  toneSeconds?: number;
  /** With the tone, a second one at the top carrier (fldigi's default). Default true. */
  twoTones?: boolean;
  /** 8-bit characters as fldigi's default (escape code 127). Default true. */
  eightBit?: boolean;
  /** Seed for the interleaver prefill and the jamming symbol. */
  seed?: number;
}

/**
 * The codes a transmission sends, as fldigi's tx_process does (mt63.cxx:95-130): a
 * preamble of idle (code 0) the length of the interleave, so the far end is synced and its
 * deinterleaver full before the first character; the text; then idle one short of the
 * interleave again to push the last character's held-back bits out. A jamming symbol
 * follows these (see mt63Waveform).
 */
export function mt63Codes(text: string, opts: Pick<Mt63WaveformOptions, "mode" | "eightBit">): number[] {
  const p = mt63Params(opts.mode);
  const codes: number[] = [];
  for (let i = 0; i < p.interleave; i++) codes.push(0);
  codes.push(...mt63TextToCodes(text, opts.eightBit ?? true));
  for (let i = 0; i < p.interleave - 1; i++) codes.push(0);
  return codes;
}

/**
 * The overlap after the last symbol starts: its odd half begins 100 samples in and runs
 * the shape's 512, so 412 samples past the start, which is 212 past the symbol's own 200.
 */
const TAIL = MT63_SYMBOL_SEPAR / 2 + MT63_SYMBOL_LEN - MT63_SYMBOL_SEPAR;

function toneSamples(opts: Mt63WaveformOptions): number {
  return Math.round(Math.max(0, opts.toneSeconds ?? 0) * opts.sampleRate);
}

/**
 * The baseband for a run of codes, as MT63tx does it (mt63base.cxx:87-336): each carrier a
 * phase index into the 512-point twiddle table; per symbol every carrier advances by the
 * phase a continuous tone gains in 200 samples, plus half a turn when its bit is 0; the even
 * carriers go through one IFFT and the odd through another, each multiplied by the symbol
 * shape and overlap-added 100 samples after the last. The jamming symbol at the end turns
 * every carrier a random quarter turn (SendJam, mt63base.cxx:277-295), which is no
 * character at all and tells the far end's synchroniser the signal has gone.
 */
export function mt63Baseband(codes: readonly number[], p: Mt63Params, firstBin: number, seed: number): { re: Float64Array; im: Float64Array } {
  const N = MT63_SYMBOL_LEN;
  const mask = N - 1;
  const half = MT63_SYMBOL_SEPAR / 2;
  const fft = new Mt63Fft(N);
  const rnd = lcg(seed);
  const encoder = new Mt63Encoder(p.interleave, rnd);
  const txVect = new Int32Array(MT63_CARRIERS);
  const phaseCorr = new Int32Array(MT63_CARRIERS);
  for (let step = 0, ph = 0, i = 0; i < MT63_CARRIERS; i++) {
    txVect[i] = ph;
    step += 1;
    ph = (ph + step) & mask;
  }
  const incr = (MT63_SYMBOL_SEPAR * MT63_CARRIER_SEPAR) & mask;
  for (let ph = (MT63_SYMBOL_SEPAR * firstBin) & mask, i = 0; i < MT63_CARRIERS; i++) {
    phaseCorr[i] = ph;
    ph = (ph + incr) & mask;
  }
  const symbols = codes.length + 1;
  const total = symbols * MT63_SYMBOL_SEPAR + TAIL;
  const outRe = new Float64Array(total);
  const outIm = new Float64Array(total);
  const re = [new Float64Array(N), new Float64Array(N)];
  const im = [new Float64Array(N), new Float64Array(N)];
  const ampl = 4 / MT63_CARRIERS;
  const shape = MT63_SYMBOL_SHAPE;

  const emit = (start: number): void => {
    for (let h = 0; h < 2; h++) {
      re[h]!.fill(0);
      im[h]!.fill(0);
    }
    for (let i = 0, c = firstBin; i < MT63_CARRIERS; i++, c += MT63_CARRIER_SEPAR) {
      const h = i & 1;
      const r = fft.bitRev[c & mask]!;
      // Conjugated in, conjugated out: the forward FFT used as an inverse (mt63base.cxx:312-320).
      re[h]![r] = ampl * fft.twRe[txVect[i]!]!;
      im[h]![r] = -ampl * fft.twIm[txVect[i]!]!;
    }
    for (let h = 0; h < 2; h++) {
      fft.coreProc(re[h]!, im[h]!);
      const at = start + h * half;
      const rr = re[h]!;
      const ii = im[h]!;
      for (let t = 0; t < N; t++) {
        outRe[at + t] = outRe[at + t]! + rr[t]! * shape[t]!;
        outIm[at + t] = outIm[at + t]! - ii[t]! * shape[t]!;
      }
    }
  };

  const flip = N / 2;
  for (let s = 0; s < codes.length; s++) {
    const bits = encoder.process(codes[s]!);
    for (let i = 0; i < MT63_CARRIERS; i++) {
      txVect[i] = (txVect[i]! + phaseCorr[i]! + (bits[i] ? 0 : flip)) & mask;
    }
    emit(s * MT63_SYMBOL_SEPAR);
  }
  // The jamming symbol.
  for (let i = 0; i < MT63_CARRIERS; i++) {
    const turn = rnd() & 0x100 ? N / 4 : (3 * N) / 4;
    txVect[i] = (txVect[i]! + phaseCorr[i]! + turn) & mask;
  }
  emit(codes.length * MT63_SYMBOL_SEPAR);
  return { re: outRe, im: outIm };
}

/**
 * The audio for a line of text: optional tuning tones, then the preamble, the text, the
 * flush and the jamming symbol (mt63Codes), with the symbol shapes' overlap run out to
 * silence at the end rather than cut off mid-symbol as fldigi does. Scaled so the MT63 peak
 * is `amplitude`; the tones are at 0.8 of it, as fldigi's TONE_AMP (mt63.h:35).
 */
export function mt63Waveform(text: string, opts: Mt63WaveformOptions): Float32Array {
  const p = mt63Params(opts.mode);
  const fs = opts.sampleRate;
  const factor = mt63RateFactor(p, fs);
  const firstAudioBin = mt63FirstCarrierBin(p, opts.centreHz);
  const mixBin = firstAudioBin + MT63_MIX_BIN_ABOVE_FIRST;
  const codes = mt63Codes(text, opts);
  const bb = mt63Baseband(codes, p, firstAudioBin - mixBin, opts.seed ?? 1);
  const nTone = toneSamples(opts);
  const nb = bb.re.length;
  const out = new Float32Array(nTone + nb * factor);

  // Tuning tones, at fldigi's frequencies (mt63.cxx:75-76): the bottom edge, and the top carrier.
  if (nTone > 0) {
    const two = opts.twoTones ?? true;
    const a = 0.8 * (opts.amplitude ?? 1);
    const w1 = (2 * Math.PI * (opts.centreHz - p.bandwidth / 2)) / fs;
    const w2 = (2 * Math.PI * (opts.centreHz + (31 * p.bandwidth) / 64)) / fs;
    const ramp = (40 * fs) / MT63_REF_RATE;
    for (let n = 0; n < nTone; n++) {
      let v = two ? 0.5 * Math.cos(w1 * n) + 0.5 * Math.cos(w2 * n) : Math.cos(w1 * n);
      v *= (1 - Math.exp(-n / ramp)) * (1 - Math.exp(-(nTone - 1 - n) / ramp));
      out[n] = a * v;
    }
  }

  // Interpolate the baseband up by `factor` and mix it up to the carriers. The filter's
  // delay (half its length) is taken off, so the audio starts where the baseband does.
  const h = mt63RateFilter(factor);
  const L = h.length;
  const delay = (L - 1) / 2;
  const mix = mt63MixerTable(mixBin, factor);
  const period = mix.cos.length;
  const audio = new Float64Array(nb * factor);
  let peak = 0;
  for (let n = 0; n < audio.length; n++) {
    const q = n + delay;
    let k = q % factor;
    let m = (q - k) / factor;
    let sr = 0;
    let si = 0;
    for (; k < L; k += factor, m--) {
      if (m < 0) break;
      if (m >= nb) continue;
      sr += h[k]! * bb.re[m]!;
      si += h[k]! * bb.im[m]!;
    }
    const ph = n % period;
    const v = sr * mix.cos[ph]! - si * mix.sin[ph]!;
    audio[n] = v;
    if (Math.abs(v) > peak) peak = Math.abs(v);
  }
  const scale = peak > 0 ? (opts.amplitude ?? 1) / peak : 0;
  for (let n = 0; n < audio.length; n++) out[nTone + n] = audio[n]! * scale;
  return out;
}

/** How long mt63Waveform's audio for this text runs, ms. */
export function mt63DurationMs(text: string, opts: Mt63WaveformOptions): number {
  const p = mt63Params(opts.mode);
  const factor = mt63RateFactor(p, opts.sampleRate);
  const symbols = mt63Codes(text, opts).length + 1;
  const samples = toneSamples(opts) + (symbols * MT63_SYMBOL_SEPAR + TAIL) * factor;
  return (samples / opts.sampleRate) * 1000;
}
