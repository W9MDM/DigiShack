// A WEFAX (HF radiofax) receiver: audio in, pictures out, as a stream.
//
// A port of fldigi 4.2.13's receiver (src/wefax/wefax.cxx, after HamFax and ACfax), with
// the picture geometry and the test generator in lib/digital/wefax.ts. It presents itself
// to the decode pipeline the way the SSTV decoder (lib/digital/sstv.ts) does - a start,
// rows as they finish, a finished picture - so the SSTV plumbing and page can carry it.
//
// THE FRONT END is fldigi's (rx_new_samples, wefax.cxx:1949-1974): the audio is mixed to
// complex baseband at the 1900 Hz centre, low-passed by one of ACfax's three 65-tap FIR
// filters (input_filters, wefax.cxx:89-138; "Narrow" is fldigi's default, wefax_filter,
// configuration.h:2481), and the frequency is the phase step between consecutive samples,
// scaled so 1500 Hz reads 0 (black) and 2300 Hz 255 (white). Where the baseband has no
// amplitude at all, two samples running, the level is white, as fldigi's CLIP test makes
// it (wefax.cxx:1963-1965) - so digital silence is a blank page, not noise. The filters
// were designed for 11025 Hz, fldigi's only WEFAX rate (wefax.cxx:2264); here the audio is
// first decimated by a whole number to between 11025 and 22049 Hz (12000 for the 12, 24
// and 48 kHz rates the radios give), by a box average whose nulls sit on the images, and
// the same taps run at that rate. At 12000 Hz their cutoffs are 9% higher than fldigi's:
// Narrow is -3 dB at about 440 Hz there instead of 400.
//
// THE APT TONES are found as fldigi finds them (decode_apt, wefax.cxx:1385-1500): count
// black-to-white transitions, with hysteresis (above 215, then below 40, wefax.cxx:
// 1393-1398), for half a second, and the count gives the keying rate. Two half-seconds in
// a row within 8 Hz of a start rate (300 Hz for IOC 576, 675 Hz for IOC 288) start the
// phasing hunt (1430-1438); while a picture is coming in, three in a row within 5 Hz start
// a new one (1455-1479) and two within 6 Hz of the 450 Hz stop rate end it (1483-1500).
// Where fldigi is one mode per IOC, this listens for both start tones at once and takes
// the IOC from whichever it hears. And it adds one test fldigi lacks: the intervals
// between transitions must be regular (60% of them within 30% of the tone's period),
// because noise through the FM discriminator also swings black-white a few hundred times
// a second - at a random rate that sometimes averages out at 300 for a second, but never
// at regular intervals.
//
// THE PHASING SIGNAL - black lines with a white pulse 5% of a line wide across the line
// boundary - is found differently. fldigi (decode_phasing, wefax.cxx:1684-1820) smooths
// the level over 16 samples, measures each line between white-to-black edges, accepts a
// line 4% white and 94% black and at least 0.4 s long, and after four such lines starts
// the picture at the next line, 2.5% after the last edge (1755-1766), at the LPM chosen
// in the GUI. Here the same smoothing (1.5 ms) and edges are used, timed to a fraction of
// a sample by interpolating where the level crossed mid-grey, and a phasing line is an
// edge one standard line length (240, 120, 90 or 60 LPM, within 0.3% plus 2 ms) after an
// earlier edge, with 2-15% of the samples between them white and 80% black. Consecutive
// phasing lines make a run; the run is read when it ends (a line goes by with no phasing
// edge), and a straight line fitted through its edge times gives three things: the LPM
// (the nearest standard), where each line starts (the picture's left edge), and how long
// a line really is in this sound card's samples - which is the automatic slant
// correction. Twenty phasing lines time the line length to a few parts per million, so a
// sound card a few hundred ppm off draws straight. fldigi has only the manual slant
// control (wefax_cb_pic_ratio, wefax-pic.cxx:629-640), which here is `slantPpm`, used when
// there was no phasing to measure. Inverted phasing (a black pulse on white,
// m_phase_inverted, wefax.cxx:317) is accepted too. The picture starts on the line after
// the last phasing line, so fldigi's own white "end of phasing" line is its first row.
//
// After a start tone, four phasing lines are enough (fldigi's count, wefax.cxx:1742); with
// no start tone heard - tuned in late - eight are wanted before a picture is started on
// phasing alone, and eight while a picture is in progress start a new one (fldigi does
// the same, skip_phasing_to_image_save, wefax.cxx:1873-1893). If a start tone is heard and
// no phasing follows within twelve seconds, the picture starts anyway, unaligned, at the
// default LPM, as fldigi does after 20 lines (wefax.cxx:1796-1818).
//
// THE PICTURE. Each row is the samples from its start to the next row's start, cut into
// pi * IOC equal pixels, each the average of the level over its span (fldigi averages the
// samples falling in each column, decode_image, wefax.cxx:1832-1846; here the spans' ends
// are fractional, so no column is a sample wider than its neighbour). A picture ends on
// the stop tone, on a new start tone or phasing, at 3000 rows (fldigi's limit is 4000,
// WEFAX_MaxRows), after ten seconds of digital silence, or when the line-to-line
// correlation - the thing fldigi uses to judge whether a picture is worth saving
// (correlation_from_index, wefax.cxx:846-876; min_max_correlation 0.20, 1613) - has been
// below 0.08 for 40 rows: the station went off without a stop tone and this is noise.
// Rows at the end that are the stop or start tone (keyed at its rate) are trimmed off.
//
// NOT PORTED: fldigi's AFC (process_afc, wefax.cxx:1095-1248; tune the radio instead -
// the picture is 800 Hz wide and a 25 Hz error shifts the greys by 8 levels), its manual
// mode, its horizontal auto-centring by the blank margin (estimate_rx_image_center,
// wefax-pic.cxx:303-361; the phasing does that job here), its noise removal and binary
// display filters, and its rules for not saving a picture (save_automatic, wefax.cxx:
// 1590-1656) - every picture is handed over, and the caller decides.

import {
  WEFAX_APT_START_HZ,
  WEFAX_APT_STOP_HZ,
  WEFAX_CARRIER_HZ,
  WEFAX_DEFAULT_LPM,
  WEFAX_DEVIATION_HZ,
  WEFAX_LPMS,
  WEFAX_MAX_LINES,
  WEFAX_PHASING_EDGE,
  wefaxNormalizeLpm,
  wefaxWidth,
  type WefaxImage,
  type WefaxIoc,
} from "@/lib/digital/wefax";

// ACfax's low-pass filters as fldigi carries them (input_filters, wefax.cxx:89-138).
const FIR_NARROW = [
  0.000495, 0.000684, 0.000885, 0.00109, 0.00128, 0.00141, 0.00142, 0.00124, 0.000793, 2.94e-5,
  -0.00108, -0.00251, -0.0042, -0.00602, -0.00778, -0.00925, -0.0101, -0.0102, -0.00909, -0.00664,
  -0.00267, 0.00289, 0.01, 0.0185, 0.0281, 0.0383, 0.0488, 0.059, 0.0682, 0.0761,
  0.0821, 0.0858, 0.0871, 0.0858, 0.0821, 0.0761, 0.0682, 0.059, 0.0488, 0.0383,
  0.0281, 0.0185, 0.01, 0.00289, -0.00267, -0.00664, -0.00909, -0.0102, -0.0101, -0.00925,
  -0.00778, -0.00602, -0.0042, -0.00251, -0.00108, 2.94e-5, 0.000793, 0.00124, 0.00142, 0.00141,
  0.00128, 0.00109, 0.000885, 0.000684, 0.000495,
];
const FIR_MEDIUM = [
  -0.000795, -0.000779, -0.000698, -0.000517, -0.000195, 0.000303, 0.000982, 0.0018, 0.00267, 0.00343,
  0.00389, 0.00383, 0.00306, 0.00144, -0.00102, -0.0042, -0.0078, -0.0114, -0.0143, -0.0159,
  -0.0156, -0.0127, -0.00695, 0.00188, 0.0136, 0.0277, 0.0434, 0.0596, 0.0752, 0.0889,
  0.0997, 0.106, 0.109, 0.106, 0.0997, 0.0889, 0.0752, 0.0596, 0.0434, 0.0277,
  0.0136, 0.00188, -0.00695, -0.0127, -0.0156, -0.0159, -0.0143, -0.0114, -0.0078, -0.0042,
  -0.00102, 0.00144, 0.00306, 0.00383, 0.00389, 0.00343, 0.00267, 0.0018, 0.000982, 0.000303,
  -0.000195, -0.000517, -0.000698, -0.000779, -0.000795,
];
const FIR_WIDE = [
  0.000716, 0.000844, 0.000845, 0.000668, 0.000259, -0.000402, -0.00126, -0.00216, -0.00284, -0.003,
  -0.00234, -0.00073, 0.00175, 0.0047, 0.00747, 0.00922, 0.00911, 0.00655, 0.00143, -0.00575,
  -0.0138, -0.0209, -0.025, -0.0241, -0.0167, -0.00203, 0.0193, 0.0457, 0.0743, 0.102,
  0.125, 0.14, 0.145, 0.14, 0.125, 0.102, 0.0743, 0.0457, 0.0193, -0.00203,
  -0.0167, -0.0241, -0.025, -0.0209, -0.0138, -0.00575, 0.00143, 0.00655, 0.00911, 0.00922,
  0.00747, 0.0047, 0.00175, -0.00073, -0.00234, -0.003, -0.00284, -0.00216, -0.00126, -0.000402,
  0.000259, 0.000668, 0.000845, 0.000844, 0.000716,
];

export type WefaxFilter = "narrow" | "medium" | "wide";
const FILTERS: Record<WefaxFilter, number[]> = { narrow: FIR_NARROW, medium: FIR_MEDIUM, wide: FIR_WIDE };

/** fldigi's CLIP (wefax.cxx:1948) is 0.001 on the baseband; DigiShack's audio can sit far below -60 dBFS on a quiet radio, so only true silence counts here. */
const CLIP = 1e-6;
/** APT transition hysteresis, 0..255 (wefax.cxx:1393, 1397). */
const APT_HIGH = 215;
const APT_LOW = 40;
/** Phasing edge hysteresis and the white/black counting levels (wefax.cxx:1709-1710). */
const EDGE_HIGH = 188;
const EDGE_LOW = 68;
/** Seconds after a start tone ends to wait for phasing before starting unaligned (fldigi: 20 lines, wefax.cxx:1806). */
const PHASING_WAIT_S = 12;
/** Auto slant is believed up to this far off nominal; beyond it the phasing is not a standard LPM. */
const MAX_AUTO_PPM = 3000;

export interface WefaxInfo {
  ioc: WefaxIoc;
  lpm: number;
  /** Pixels in a row: pi * IOC, truncated (1809 or 904). */
  width: number;
  /** Date.now() when the picture started. */
  at: number;
  /** A start tone was heard before it. */
  apt: boolean;
  /** The left edge was found from phasing lines (else the picture starts where it happened to). */
  aligned: boolean;
  /** Line length correction applied, ppm (positive: lines longer than nominal in this sound card's samples). */
  ppm: number;
  /** Where `ppm` came from: measured from the phasing, the manual setting, or none. */
  slant: "phasing" | "manual" | "none";
  /** Phasing lines the alignment was fitted to (0 if unaligned). */
  phasingLines: number;
}

export type WefaxEndReason = "stop" | "apt" | "phasing" | "max" | "silence" | "lost";

export interface WefaxEndInfo extends WefaxInfo {
  lines: number;
  reason: WefaxEndReason;
}

export interface WefaxDecodeEvents {
  /** A picture is starting: the first row is about to arrive. */
  onStart?: (info: WefaxInfo) => void;
  /** Rows finished, from `fromRow` up to but not including `toRow`. `img` grows; its rgb covers exactly `height` rows. */
  onRows?: (img: WefaxImage, fromRow: number, toRow: number) => void;
  /** The picture is finished (its own copy of the pixels). */
  onImage?: (img: WefaxImage, info: WefaxEndInfo) => void;
  /** Reception ended (after onImage). */
  onStop?: () => void;
}

export interface WefaxDecoderOptions {
  /** Centre frequency, Hz (default 1900). */
  carrierHz?: number;
  /** fldigi's input filter (default "narrow", as fldigi). */
  filter?: WefaxFilter;
  /** Manual slant, ppm of line length, for pictures without phasing (fldigi's slant control). */
  slantPpm?: number;
  /** Measure the slant from the phasing lines (default true). */
  autoSlant?: boolean;
  /** LPM when there is no phasing to measure (default 120). */
  lpm?: number;
  /** IOC when a picture starts on phasing alone, with no start tone (default 576). */
  ioc?: WefaxIoc;
  /** Rows before a picture is ended (default 3000). */
  maxLines?: number;
}

export interface WefaxStatistics {
  receiving: boolean;
  lines: number;
  pictures: number;
  aptHeard: number;
  levelDb: number;
}

type State = "idle" | "phasing" | "image";

interface PhasingRun {
  inverted: boolean;
  lpm: number;
  /** Nominal line length, internal samples. */
  period: number;
  idx: number[];
  t: number[];
}

/** One half-second APT window: the rate and how regular the transitions were per tone. */
interface AptWindow {
  hz: number;
  regular: Record<number, number>;
  /** Rate from the regular intervals alone, per tone (0 if none). */
  regHz: Record<number, number>;
}

export class WefaxDecoder {
  // Front end.
  private readonly decim: number;
  /** Internal (decimated) rate. */
  readonly rate: number;
  private readonly taps: Float64Array;
  private readonly firI: Float64Array;
  private readonly firQ: Float64Array;
  private firPos = 0;
  private oscC = 1;
  private oscS = 0;
  private readonly rotC: number;
  private readonly rotS: number;
  private oscN = 0;
  private accI = 0;
  private accQ = 0;
  private accN = 0;
  private prevI = 0;
  private prevQ = 0;
  private prevMag2 = 0;
  private readonly aptTaps: Float64Array;
  private prevAI = 0;
  private prevAQ = 0;
  private readonly hzToLevel: number;
  private power = 0;
  private readonly powerAlpha: number;

  // Per internal sample: the level, and running sums of it and of the white, black,
  // APT-transition and silent counts, in rings indexed by absolute sample number.
  private readonly mask: number;
  private readonly lvl: Float32Array;
  private readonly cumLvl: Float64Array;
  private readonly cumHigh: Int32Array;
  private readonly cumLow: Int32Array;
  private readonly cumTrans: Int32Array;
  private readonly cumSilent: Int32Array;
  private n = 0;

  // APT.
  private aptHigh = false;
  private aptLastTrans = -1;
  private aptCount = 0;
  private aptTrans = 0;
  private readonly aptRegular: Record<number, number> = {};
  /** Sum of the regular intervals per tone, internal samples, for the rate they give. */
  private readonly aptRegSum: Record<number, number> = {};
  private readonly aptTones: number[];
  private aptHist: AptWindow[] = [];
  private aptLast = 0;

  // Phasing edges.
  private readonly smLen: number;
  private readonly smBuf: Float32Array;
  private smPos = 0;
  private smSum = 0;
  private smPrev = 128;
  private edgeHi: boolean | null = null;
  private lastDown = 0;
  private lastUp = 0;
  private fallEdges: number[] = [];
  private riseEdges: number[] = [];
  private run: PhasingRun | null = null;

  // Picture.
  private state: State = "idle";
  private ioc: WefaxIoc = 576;
  private apt = false;
  private info: WefaxInfo | null = null;
  private origin = 0;
  private period = 0;
  private width = 0;
  private row = 0;
  private buf: Uint8ClampedArray | null = null;
  private img: WefaxImage | null = null;
  private pendingFrom = -1;
  private prevRow: Float32Array | null = null;
  private corrHist: number[] = [];
  private silentRows = 0;
  private bounds: Float64Array = new Float64Array(0);

  private stats = { pictures: 0, aptHeard: 0, lines: 0 };
  private readonly opts: Required<Omit<WefaxDecoderOptions, "carrierHz" | "filter">>;

  constructor(
    private readonly fs: number,
    private readonly events: WefaxDecodeEvents = {},
    options: WefaxDecoderOptions = {},
  ) {
    this.decim = Math.max(1, Math.floor(fs / 11025));
    this.rate = fs / this.decim;
    const taps = FILTERS[options.filter ?? "narrow"];
    let sum = 0;
    for (const v of taps) sum += v;
    this.taps = Float64Array.from(taps, (v) => v / sum);
    this.aptTaps = aptFilter(this.rate, taps.length);
    this.firI = new Float64Array(taps.length * 2);
    this.firQ = new Float64Array(taps.length * 2);
    const w = (2 * Math.PI * (options.carrierHz ?? WEFAX_CARRIER_HZ)) / fs;
    this.rotC = Math.cos(w);
    this.rotS = Math.sin(w);
    this.hzToLevel = (255 / (2 * WEFAX_DEVIATION_HZ)) * (this.rate / (2 * Math.PI));
    this.powerAlpha = 1 / (0.5 * fs);
    this.opts = {
      slantPpm: options.slantPpm ?? 0,
      autoSlant: options.autoSlant ?? true,
      lpm: options.lpm ?? WEFAX_DEFAULT_LPM,
      ioc: options.ioc ?? 576,
      maxLines: Math.max(1, Math.min(options.maxLines ?? WEFAX_MAX_LINES, 20000)),
    };
    // Eight seconds of history: a 60 LPM line, the wait before a run is read, and the
    // last few seconds of rows the end-of-picture trimming looks at, with room to spare.
    let size = 1;
    while (size < this.rate * 8) size *= 2;
    this.mask = size - 1;
    this.lvl = new Float32Array(size);
    this.cumLvl = new Float64Array(size);
    this.cumHigh = new Int32Array(size);
    this.cumLow = new Int32Array(size);
    this.cumTrans = new Int32Array(size);
    this.cumSilent = new Int32Array(size);
    this.aptTones = [WEFAX_APT_START_HZ[576], WEFAX_APT_START_HZ[288], WEFAX_APT_STOP_HZ];
    for (const f of this.aptTones) this.aptRegular[f] = this.aptRegSum[f] = 0;
    this.smLen = Math.max(2, Math.round(this.rate * 0.0015));
    this.smBuf = new Float32Array(this.smLen);
  }

  get statistics(): Readonly<WefaxStatistics> {
    return {
      receiving: this.state !== "idle",
      lines: this.stats.lines,
      pictures: this.stats.pictures,
      aptHeard: this.stats.aptHeard,
      levelDb: this.power > 0 ? 10 * Math.log10(this.power) : -120,
    };
  }

  /** Clear everything: any picture in progress is dropped (not handed over), and the counts restart. */
  reset(): void {
    this.firI.fill(0);
    this.firQ.fill(0);
    this.firPos = 0;
    this.oscC = 1;
    this.oscS = 0;
    this.oscN = 0;
    this.accI = this.accQ = 0;
    this.accN = 0;
    this.prevI = this.prevQ = this.prevMag2 = 0;
    this.prevAI = this.prevAQ = 0;
    this.power = 0;
    this.lvl.fill(0);
    this.cumLvl.fill(0);
    this.cumHigh.fill(0);
    this.cumLow.fill(0);
    this.cumTrans.fill(0);
    this.cumSilent.fill(0);
    this.n = 0;
    this.aptHigh = false;
    this.aptLastTrans = -1;
    this.aptCount = this.aptTrans = 0;
    for (const f of this.aptTones) this.aptRegular[f] = this.aptRegSum[f] = 0;
    this.aptHist = [];
    this.aptLast = 0;
    this.smBuf.fill(0);
    this.smPos = 0;
    this.smSum = 0;
    this.smPrev = 128;
    this.edgeHi = null;
    this.fallEdges = [];
    this.riseEdges = [];
    this.run = null;
    this.state = "idle";
    this.apt = false;
    this.info = null;
    this.dropPicture();
    this.stats = { pictures: 0, aptHeard: 0, lines: 0 };
  }

  feed(samples: ArrayLike<number>): void {
    const k = this.decim;
    for (let j = 0; j < samples.length; j++) {
      const x = samples[j]!;
      this.power += (x * x - this.power) * this.powerAlpha;
      this.accI += x * this.oscC;
      this.accQ -= x * this.oscS;
      const c = this.oscC * this.rotC - this.oscS * this.rotS;
      this.oscS = this.oscS * this.rotC + this.oscC * this.rotS;
      this.oscC = c;
      if (++this.oscN === 4096) {
        // Keep the recursive oscillator on the unit circle.
        this.oscN = 0;
        const m = 1 / Math.hypot(this.oscC, this.oscS);
        this.oscC *= m;
        this.oscS *= m;
      }
      if (++this.accN === k) {
        this.baseband(this.accI / k, this.accQ / k);
        this.accI = this.accQ = 0;
        this.accN = 0;
      }
    }
    this.flushRows();
  }

  /** One decimated baseband sample: filter, discriminate, and on to the level. */
  private baseband(zi: number, zq: number): void {
    const N = this.taps.length;
    const p = this.firPos;
    this.firI[p] = this.firI[p + N] = zi;
    this.firQ[p] = this.firQ[p + N] = zq;
    this.firPos = p + 1 === N ? 0 : p + 1;
    // Oldest first from firPos; the taps are symmetric, so the order does not matter.
    let yi = 0;
    let yq = 0;
    const base = this.firPos;
    for (let i = 0; i < N; i++) {
      const t = this.taps[i]!;
      yi += t * this.firI[base + i]!;
      yq += t * this.firQ[base + i]!;
    }
    // The APT path: the same samples through a wider filter (see aptFilter).
    let ai = 0;
    let aq = 0;
    for (let i = 0; i < N; i++) {
      const t = this.aptTaps[i]!;
      ai += t * this.firI[base + i]!;
      aq += t * this.firQ[base + i]!;
    }
    let aptLevel = 127.5 + Math.atan2(aq * this.prevAI - ai * this.prevAQ, ai * this.prevAI + aq * this.prevAQ) * this.hzToLevel;
    aptLevel = aptLevel < 0 ? 0 : aptLevel > 255 ? 255 : aptLevel;
    this.prevAI = ai;
    this.prevAQ = aq;
    const mag2 = yi * yi + yq * yq;
    let level: number;
    const silent = mag2 <= CLIP * CLIP && this.prevMag2 <= CLIP * CLIP;
    if (silent) level = 255;
    else {
      const re = yi * this.prevI + yq * this.prevQ;
      const im = yq * this.prevI - yi * this.prevQ;
      level = 127.5 + Math.atan2(im, re) * this.hzToLevel;
      level = level < 0 ? 0 : level > 255 ? 255 : level;
    }
    this.prevI = yi;
    this.prevQ = yq;
    this.prevMag2 = mag2;
    this.step(level, silent ? 255 : aptLevel, silent);
  }

  /** S(x): the sum of the level over [0, x), x fractional, from the ring. */
  private sumTo(x: number): number {
    const i = Math.floor(x);
    return this.cumLvl[i & this.mask]! + (x - i) * this.lvl[i & this.mask]!;
  }

  private step(level: number, aptLevel: number, silent: boolean): void {
    const n = this.n;
    const m = this.mask;
    const i0 = n & m;
    const i1 = (n + 1) & m;
    this.lvl[i0] = level;
    this.cumLvl[i1] = this.cumLvl[i0]! + level;
    this.cumHigh[i1] = this.cumHigh[i0]! + (level > EDGE_HIGH ? 1 : 0);
    this.cumLow[i1] = this.cumLow[i0]! + (level < EDGE_LOW ? 1 : 0);
    this.cumSilent[i1] = this.cumSilent[i0]! + (silent ? 1 : 0);

    // APT: black-to-white transitions (decode_apt, wefax.cxx:1393-1400).
    let trans = 0;
    if (aptLevel > APT_HIGH && !this.aptHigh) {
      this.aptHigh = true;
      trans = 1;
      this.aptTrans++;
      if (this.aptLastTrans >= 0) {
        const d = n - this.aptLastTrans;
        for (const f of this.aptTones) {
          if (Math.abs((d * f) / this.rate - 1) < 0.3) {
            this.aptRegular[f]!++;
            this.aptRegSum[f]! += d;
          }
        }
      }
      this.aptLastTrans = n;
    } else if (aptLevel < APT_LOW && this.aptHigh) this.aptHigh = false;
    this.cumTrans[i1] = this.cumTrans[i0]! + trans;
    if (++this.aptCount >= this.rate / 2) this.aptWindow();

    this.edges(level);
    this.n = n + 1;

    // A phasing run is read once a line has gone by without its next edge.
    const run = this.run;
    if (run && this.n > run.t[run.t.length - 1]! + 1.3 * run.period + this.smLen) this.finishRun();
    else if (run && run.t.length > 80) this.finishRun();

    if (this.state === "phasing" && !this.run && this.n > this.aptLast + PHASING_WAIT_S * this.rate) {
      // A start tone, and no phasing after it: start where we are (wefax.cxx:1806-1816).
      const lpm = this.opts.lpm;
      const ppm = this.opts.slantPpm;
      this.startPicture(this.n, ((this.rate * 60) / lpm) * (1 + ppm * 1e-6), lpm, ppm, ppm !== 0 ? "manual" : "none", 0);
    }

    if (this.state === "image") {
      while (this.state === "image" && this.origin + (this.row + 1) * this.period < this.n) this.renderRow();
    }
  }

  /** Half a second of APT counting is in: the rate, and what it means in this state. */
  private aptWindow(): void {
    const w: AptWindow = { hz: (this.rate * this.aptTrans) / this.aptCount, regular: {}, regHz: {} };
    for (const f of this.aptTones) {
      w.regular[f] = this.aptTrans > 0 ? this.aptRegular[f]! / this.aptTrans : 0;
      w.regHz[f] = this.aptRegSum[f]! > 0 ? (this.rate * this.aptRegular[f]!) / this.aptRegSum[f]! : 0;
      this.aptRegular[f] = this.aptRegSum[f] = 0;
    }
    this.aptCount = this.aptTrans = 0;
    this.aptHist.unshift(w);
    if (this.aptHist.length > 4) this.aptHist.pop();

    const heard = (f: number, tol: number, windows: number): boolean => {
      if (this.aptHist.length < windows) return false;
      for (let i = 0; i < windows; i++) {
        const h = this.aptHist[i]!;
        if (Math.abs(h.regHz[f]! - f) > tol || Math.abs(h.hz - f) > 0.15 * f || h.regular[f]! < 0.6) return false;
      }
      return true;
    };
    const startIoc = (tol: number, windows: number): WefaxIoc | null =>
      heard(WEFAX_APT_START_HZ[576], tol, windows) ? 576 : heard(WEFAX_APT_START_HZ[288], tol, windows) ? 288 : null;

    if (this.state === "idle") {
      const ioc = startIoc(8, 2); // wefax.cxx:1431-1432
      if (ioc) {
        this.stats.aptHeard++;
        this.enterPhasing(ioc);
      }
    } else if (this.state === "phasing") {
      if (startIoc(8, 1) === this.ioc) this.aptLast = this.n;
      else if (heard(WEFAX_APT_STOP_HZ, 6, 2)) this.toIdle();
    } else {
      const ioc = startIoc(5, 3); // wefax.cxx:1456-1464
      if (ioc) {
        this.endPicture("apt");
        this.stats.aptHeard++;
        this.enterPhasing(ioc);
      } else if (heard(WEFAX_APT_STOP_HZ, 6, 2)) {
        this.endPicture("stop"); // wefax.cxx:1483-1500
        this.toIdle();
      }
    }
  }

  private enterPhasing(ioc: WefaxIoc): void {
    this.state = "phasing";
    this.ioc = ioc;
    this.apt = true;
    this.aptLast = this.n;
    this.run = null;
  }

  private toIdle(): void {
    this.state = "idle";
    this.apt = false;
    this.run = null;
  }

  /** Smoothed level, mid-grey crossings timed to a fraction of a sample, and edges with hysteresis. */
  private edges(level: number): void {
    this.smSum += level - this.smBuf[this.smPos]!;
    this.smBuf[this.smPos] = level;
    this.smPos = this.smPos + 1 === this.smLen ? 0 : this.smPos + 1;
    const s = this.smSum / this.smLen;
    const prev = this.smPrev;
    this.smPrev = s;
    // The box average delays by (len - 1) / 2; take that off so edges and pixels agree.
    const delay = (this.smLen - 1) / 2;
    if (prev >= 128 && s < 128) this.lastDown = this.n - 1 + (prev - 128) / (prev - s) - delay;
    else if (prev < 128 && s >= 128) this.lastUp = this.n - 1 + (128 - prev) / (s - prev) - delay;
    if (s > EDGE_HIGH && this.edgeHi !== true) {
      const was = this.edgeHi;
      this.edgeHi = true;
      if (was === false) this.edge(this.lastUp, true);
    } else if (s < EDGE_LOW && this.edgeHi !== false) {
      const was = this.edgeHi;
      this.edgeHi = false;
      if (was === true) this.edge(this.lastDown, false);
    }
  }

  /**
   * An edge at `t`: rising (black to white) or falling. A falling edge one standard line
   * after an earlier one, with the line between them mostly black and about 5% white, is
   * a phasing line; rising edges likewise for inverted phasing.
   */
  private edge(t: number, rising: boolean): void {
    const list = rising ? this.riseEdges : this.fallEdges;
    const inverted = rising;
    const maxBack = this.rate * 1.02 + 0.002 * this.rate;
    while (list.length > 0 && (t - list[0]! > maxBack || list.length > 512)) list.shift();
    for (let j = list.length - 1; j >= 0; j--) {
      const t0 = list[j]!;
      const d = t - t0;
      for (const lpm of WEFAX_LPMS) {
        const P = (this.rate * 60) / lpm;
        if (Math.abs(d - P) > P * 0.003 + 0.002 * this.rate) continue;
        const a = Math.floor(t0);
        const b = Math.floor(t);
        if (b - a < 2 || this.n - a > this.mask) continue;
        const hi = (this.cumHigh[b & this.mask]! - this.cumHigh[a & this.mask]!) / (b - a);
        const lo = (this.cumLow[b & this.mask]! - this.cumLow[a & this.mask]!) / (b - a);
        const pulse = inverted ? lo : hi;
        const body = inverted ? hi : lo;
        if (pulse >= 0.02 && pulse <= 0.15 && body >= 0.8) {
          this.phasingLine(t0, t, lpm, P, inverted);
          list.push(t);
          return;
        }
      }
    }
    list.push(t);
  }

  private phasingLine(t0: number, t: number, lpm: number, P: number, inverted: boolean): void {
    const run = this.run;
    const tol = P * 0.003 + 0.002 * this.rate;
    if (run && run.inverted === inverted && run.lpm === lpm) {
      const last = run.t[run.t.length - 1]!;
      const gap = Math.round((t0 - last) / P);
      if (gap >= 0 && gap <= 3 && Math.abs(t0 - last - gap * P) < tol * (gap + 1)) {
        const base = run.idx[run.idx.length - 1]! + gap;
        if (gap > 0) {
          run.idx.push(base);
          run.t.push(t0);
        }
        run.idx.push(base + 1);
        run.t.push(t);
        return;
      }
    }
    // A run already three lines long is not displaced by a stray line elsewhere.
    if (run && run.t.length >= 4) return;
    this.run = { inverted, lpm, period: P, idx: [0, 1], t: [t0, t] };
  }

  /** The run of phasing lines has ended: fit it, and start a picture if it was long enough. */
  private finishRun(): void {
    const run = this.run!;
    this.run = null;
    const lines = run.t.length - 1;
    const need = this.state === "phasing" ? 4 : 8;
    if (lines < need) return;
    // Least squares, edge time against line number.
    const k = run.t.length;
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < k; i++) {
      sx += run.idx[i]!;
      sy += run.t[i]!;
    }
    const mx = sx / k;
    const my = sy / k;
    let sxx = 0;
    let sxy = 0;
    for (let i = 0; i < k; i++) {
      const dx = run.idx[i]! - mx;
      sxx += dx * dx;
      sxy += dx * (run.t[i]! - my);
    }
    const fitted = sxy / sxx;
    const lpm = wefaxNormalizeLpm((this.rate * 60) / fitted) ?? run.lpm;
    const nominal = (this.rate * 60) / lpm;
    const measuredPpm = (fitted / nominal - 1) * 1e6;
    let period: number;
    let ppm: number;
    let slant: WefaxInfo["slant"];
    if (this.opts.autoSlant && Math.abs(measuredPpm) <= MAX_AUTO_PPM) {
      period = fitted;
      ppm = measuredPpm;
      slant = "phasing";
    } else {
      ppm = this.opts.slantPpm;
      period = nominal * (1 + ppm * 1e-6);
      slant = ppm !== 0 ? "manual" : "none";
    }
    const lastIdx = run.idx[k - 1]!;
    const lastEdge = my + (lastIdx - mx) * fitted;
    // The edge is 2.5% into its line; the picture starts on the line after it.
    const origin = lastEdge - WEFAX_PHASING_EDGE * period + period;
    if (this.state === "image") {
      // Phasing in the middle of a picture: that picture ended where the phasing began.
      // The new one keeps its IOC; no start tone was heard for it.
      const firstLine = run.t[0]! - WEFAX_PHASING_EDGE * period;
      const keep = Math.max(0, Math.min(this.row, Math.floor((firstLine - this.origin) / this.period)));
      this.endPicture("phasing", keep);
      this.apt = false;
    } else if (this.state === "idle") {
      // Tuned in during the phasing: no start tone, so the IOC is the configured one.
      this.apt = false;
      this.ioc = this.opts.ioc;
    }
    this.startPicture(origin, period, lpm, ppm, slant, lines);
  }

  private startPicture(origin: number, period: number, lpm: number, ppm: number, slant: WefaxInfo["slant"], phasingLines: number): void {
    this.state = "image";
    this.run = null;
    this.origin = origin;
    this.period = period;
    this.width = wefaxWidth(this.ioc);
    this.row = 0;
    this.buf = new Uint8ClampedArray(this.width * 3 * 256);
    this.img = { width: this.width, height: 0, rgb: this.buf.subarray(0, 0) };
    this.pendingFrom = -1;
    this.prevRow = null;
    this.corrHist = [];
    this.silentRows = 0;
    this.bounds = new Float64Array(this.width + 1);
    this.stats.lines = 0;
    this.info = {
      ioc: this.ioc,
      lpm,
      width: this.width,
      at: Date.now(),
      apt: this.apt,
      aligned: phasingLines > 0,
      ppm,
      slant,
      phasingLines,
    };
    this.events.onStart?.({ ...this.info });
  }

  /** The next row is all in: cut it into pixels and check whether the picture goes on. */
  private renderRow(): void {
    const W = this.width;
    const P = this.period;
    const s0 = this.origin + this.row * P;
    const q = P / W;
    const b = this.bounds;
    for (let c = 0; c <= W; c++) b[c] = this.sumTo(s0 + c * q);
    const need = (this.row + 1) * W * 3;
    if (need > this.buf!.length) {
      const grown = new Uint8ClampedArray(Math.min(this.buf!.length * 2, this.opts.maxLines * W * 3));
      grown.set(this.buf!);
      this.buf = grown;
    }
    const rgb = this.buf!;
    const cur = new Float32Array(W);
    let o = this.row * W * 3;
    for (let c = 0; c < W; c++) {
      const v = (b[c + 1]! - b[c]!) / q;
      cur[c] = v;
      rgb[o] = rgb[o + 1] = rgb[o + 2] = v;
      o += 3;
    }
    // Silence across the row?
    const a = Math.floor(s0);
    const e = Math.floor(s0 + P);
    const silent = (this.cumSilent[e & this.mask]! - this.cumSilent[a & this.mask]!) / Math.max(1, e - a);
    this.silentRows = silent > 0.9 ? this.silentRows + 1 : 0;
    // Line-to-line correlation (correlation_from_index, wefax.cxx:846-876), ignoring flat rows.
    if (this.prevRow) {
      const r = correlation(this.prevRow, cur);
      if (r !== null) {
        this.corrHist.push(r);
        if (this.corrHist.length > 40) this.corrHist.shift();
      }
    }
    this.prevRow = cur;
    if (this.pendingFrom < 0) this.pendingFrom = this.row;
    this.row++;
    this.stats.lines = this.row;
    this.img = { width: W, height: this.row, rgb: rgb.subarray(0, this.row * W * 3) };

    if (this.row >= this.opts.maxLines) {
      this.endPicture("max");
      this.toIdle();
    } else if (this.silentRows * P >= 10 * this.rate) {
      this.endPicture("silence", this.row - this.silentRows);
      this.toIdle();
    } else if (this.row >= 60 && this.corrHist.length >= 40) {
      let s = 0;
      for (const v of this.corrHist) s += v;
      if (s / this.corrHist.length < 0.08) {
        this.endPicture("lost", this.row - 40);
        this.toIdle();
      }
    }
  }

  /** Hand on the rows finished since the last call. */
  private flushRows(): void {
    if (this.pendingFrom >= 0 && this.img && this.row > this.pendingFrom) {
      this.events.onRows?.(this.img, this.pendingFrom, this.row);
    }
    this.pendingFrom = -1;
  }

  /**
   * The picture is over. `keep` rows of it are kept (all by default), less any at the end
   * that are the stop or start tone: rows whose transitions come at an APT rate.
   */
  private endPicture(reason: WefaxEndReason, keep = this.row): void {
    if (!this.info || !this.buf) return;
    let h = Math.max(0, Math.min(keep, this.row));
    const P = this.period;
    const oldest = this.n - this.mask + 1;
    const limit = Math.max(0, h - Math.ceil((3 * this.rate) / P));
    while (h > limit) {
      const a = Math.floor(this.origin + (h - 1) * P);
      const e = Math.floor(this.origin + h * P);
      if (a < oldest || e > this.n) break;
      const hz = ((this.cumTrans[e & this.mask]! - this.cumTrans[a & this.mask]!) * this.rate) / (e - a);
      if (!this.aptTones.some((f) => Math.abs(hz - f) < 0.2 * f)) break;
      h--;
    }
    // Rows already rendered but not yet handed on go first, up to the kept height.
    if (this.pendingFrom >= 0 && this.img && h > this.pendingFrom) {
      this.events.onRows?.({ width: this.width, height: h, rgb: this.buf.subarray(0, h * this.width * 3) }, this.pendingFrom, h);
    }
    this.pendingFrom = -1;
    const img: WefaxImage = { width: this.width, height: h, rgb: this.buf.slice(0, h * this.width * 3) };
    const info: WefaxEndInfo = { ...this.info, lines: h, reason };
    this.stats.lines = h;
    if (h > 0) this.stats.pictures++;
    this.dropPicture();
    this.state = "idle";
    this.events.onImage?.(img, info);
    this.events.onStop?.();
  }

  private dropPicture(): void {
    this.info = null;
    this.buf = null;
    this.img = null;
    this.prevRow = null;
    this.corrHist = [];
    this.pendingFrom = -1;
    this.row = 0;
  }
}

/**
 * The APT detector's own low-pass: windowed sinc (Blackman), cut off at 1300 Hz. fldigi
 * counts the APT transitions on the picture's level (decode_apt is fed the same samples
 * as decode_image, wefax.cxx:1355), through its Narrow filter by default - which is down
 * 20 dB at 675 Hz, so the IOC 288 start tone, keyed black-white 675 times a second, comes
 * out of it as a ripple that never reaches the 215/40 thresholds. Run beside the picture's
 * filter on the same samples, a wide filter here hears both start tones and the stop
 * tone at full swing whichever filter the picture uses.
 */
function aptFilter(rate: number, n: number): Float64Array {
  const fc = 1300 / rate;
  const out = new Float64Array(n);
  const mid = (n - 1) / 2;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const x = i - mid;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (n - 1));
    out[i] = sinc * w;
    sum += out[i]!;
  }
  for (let i = 0; i < n; i++) out[i]! /= sum;
  return out;
}

/** |Pearson correlation| of two rows on every other pixel, or null if either is flat. */
function correlation(a: Float32Array, b: Float32Array): number | null {
  let sa = 0;
  let sb = 0;
  let n = 0;
  for (let i = 0; i < a.length; i += 2) {
    sa += a[i]!;
    sb += b[i]!;
    n++;
  }
  const ma = sa / n;
  const mb = sb / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i += 2) {
    const x = a[i]! - ma;
    const y = b[i]! - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  if (da < n || db < n) return null; // flat: less than one grey level of variation
  return Math.abs(num / Math.sqrt(da * db));
}
