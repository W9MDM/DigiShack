// WEFAX (HF radiofax): the parameters, the picture geometry, and a test signal.
//
// Weather fax is how the US Coast Guard, the US Navy, Environment Canada and other met
// services send surface analyses, forecasts, wave charts, ice charts and satellite
// pictures to ships: one long black-and-white picture, a line at a time, as a frequency
// between 1500 Hz (black) and 2300 Hz (white) - a carrier at 1900 Hz deviated +/-400 Hz.
// It is receive-only by nature; amateurs do not send it, and DigiShack has no transmitter
// for it. The decoder is lib/digital/wefaxdemod.ts; this file is what it reads with.
//
// The receiver follows fldigi 4.2.13 (src/wefax/wefax.cxx, itself adapted from HamFax by
// Christof Schmitt and from ACfax), and the numbers below are fldigi's:
//
// THE CARRIER. Centre 1900 Hz, shift 800 Hz (progdefaults.WEFAX_Center and WEFAX_Shift,
// include/configuration.h:2490-2495), so black is 1500 Hz and white 2300 Hz. fldigi's
// modulator puts a level v in 0..1 on carrier + 2 (v - 0.5) * 400 Hz (wefax.cxx:1994),
// and its demodulator maps the phase step back to 255 (0.5 - ratio * arg) with
// ratio = (rate / shift) / 2 pi (wefax.cxx:1323, 1968): 0 black, 255 white.
//
// THE INDEX OF COOPERATION (IOC) fixes the picture's shape: a line is pi * IOC pixels
// wide, because the IOC was defined for drum recorders as drum diameter over line pitch.
// IOC 576 is what almost everything uses; 288 is the old half-resolution standard, still
// heard now and then. fldigi computes the width as `ioc * M_PI` truncated to an int
// (ioc_to_width, wefax.cxx:262-265): 1809 pixels for 576, 904 for 288.
//
// THE APT TONES. A transmission starts with five seconds of the "start" signal - the
// carrier switched between black and white 300 times a second for IOC 576, 675 times for
// IOC 288 - and ends with five seconds of the same at 450 Hz, the "stop" signal
// (m_apt_start_freq / m_apt_stop_freq, wefax.cxx:1260, 1278, 1283; m_start_duration and
// m_stop_duration, 1263-1264). They are named for the Automatic Picture Transmission
// recorders they start and stop. Note that fldigi's own transmitter sends them as a plain
// audio tone at 300/675/450 Hz (wefax.cxx:2051, 2129), which no station does and which
// fldigi's own receiver, counting black-white transitions (decode_apt, wefax.cxx:1385),
// would not read as such; the generator below sends the real thing, the carrier keyed
// black-white at the APT rate.
//
// THE PHASING SIGNAL, after the start tone: lines that are black except for a white
// pulse 5% of a line long straddling the line boundary - white for the first 2.5% of the
// line and the last 2.5% (fldigi's transmitter, wefax.cxx:2061-2066; its receiver's
// comment at 1678-1683; "or inverted", which fldigi never found on the air,
// m_phase_inverted, wefax.cxx:317). fldigi sends 20 of them (m_tx_phasing_lin,
// wefax.cxx:1262) and then one all-white line (ENDPHASING, 2072-2080); stations send
// about 30 seconds' worth. The receiver times the pulses to find where each line begins
// - the left edge of the picture - and how long a line is, which gives the lines per
// minute and the sound card's clock error.
//
// LINES PER MINUTE: 120 is by far the most common; fldigi offers 240, 120, 90 and 60
// (all_lpm_values, wefax-pic.cxx:208-213), and snaps a measured rate to the nearest of
// them within 3 (normalize_lpm, wefax-pic.cxx:262-273). fldigi's default is 120 for IOC
// 576 and 60 for IOC 288 (wefax_lpm_576 / wefax_lpm_288, configuration.h:2524-2529);
// NOAA's IOC 288 charts actually go out at 120, so the receiver here prefers what the
// phasing says and falls back to 120.

/** Centre of the signal, Hz: fldigi's WEFAX_Center (configuration.h:2493). */
export const WEFAX_CARRIER_HZ = 1900;
/** Deviation either side of the centre, Hz: half of fldigi's WEFAX_Shift, 800 (configuration.h:2490). */
export const WEFAX_DEVIATION_HZ = 400;
export const WEFAX_BLACK_HZ = WEFAX_CARRIER_HZ - WEFAX_DEVIATION_HZ;
export const WEFAX_WHITE_HZ = WEFAX_CARRIER_HZ + WEFAX_DEVIATION_HZ;

export type WefaxIoc = 576 | 288;
export const WEFAX_IOCS: readonly WefaxIoc[] = [576, 288];

/** Lines per minute fldigi offers (all_lpm_values, wefax-pic.cxx:208-213). */
export const WEFAX_LPMS: readonly number[] = [240, 120, 90, 60];
export const WEFAX_DEFAULT_LPM = 120;

/** APT start tone by IOC, Hz (wefax.cxx:1278, 1283). */
export const WEFAX_APT_START_HZ: Readonly<Record<WefaxIoc, number>> = { 576: 300, 288: 675 };
/** APT stop tone, Hz, both IOCs (wefax.cxx:1260). */
export const WEFAX_APT_STOP_HZ = 450;
/** Seconds of start and of stop tone fldigi sends (wefax.cxx:1263-1264). */
export const WEFAX_APT_SECONDS = 5;
/** Phasing lines fldigi sends (wefax.cxx:1262). */
export const WEFAX_PHASING_LINES = 20;
/** The phasing pulse: white for this share of the line at each end (wefax.cxx:2062). */
export const WEFAX_PHASING_EDGE = 0.025;
/** Rows a received picture may run to before it is ended and kept. fldigi's limit is 4000 (WEFAX_MaxRows, configuration.h:2496); 3000 is 25 minutes at 120 LPM and keeps a picture under 17 MB. */
export const WEFAX_MAX_LINES = 3000;

/** Pixels in a line: pi * IOC, truncated as fldigi does (ioc_to_width, wefax.cxx:262-265). */
export function wefaxWidth(ioc: number): number {
  return Math.floor(ioc * Math.PI);
}

/** Samples in one line at a rate (lpm_to_samples, wefax.cxx:464-466, but not truncated to an int). */
export function wefaxSamplesPerLine(sampleRate: number, lpm: number): number {
  return (sampleRate * 60) / lpm;
}

/** The standard LPM nearest a measured one, if within 3 of it (normalize_lpm, wefax-pic.cxx:262-273). */
export function wefaxNormalizeLpm(lpm: number): number | null {
  for (const v of WEFAX_LPMS) if (Math.abs(lpm - v) < 3) return v;
  return null;
}

/** A picture: RGB bytes, row by row (the same shape as an SSTV picture). WEFAX is grey, written into all three. */
export interface WefaxImage {
  width: number;
  height: number;
  rgb: Uint8ClampedArray;
}

/**
 * A test chart, `width` x `height`: a white left margin (5%), vertical bars in four greys
 * (black, white, dark and light grey, 90 pixels each) whose order flips every 40 rows,
 * a left-to-right gradient from black to white, and a black right margin (5%). The bars'
 * flat middles check the grey levels, their edges check the left-edge alignment and the
 * slant, the 40-row flips check the row count, and the gradient checks the transfer curve.
 */
export function wefaxTestPattern(width: number, height: number): WefaxImage {
  const rgb = new Uint8ClampedArray(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = wefaxTestPixel(x, y, width);
      const i = (y * width + x) * 3;
      rgb[i] = rgb[i + 1] = rgb[i + 2] = v;
    }
  }
  return { width, height, rgb };
}

/** Geometry of wefaxTestPattern, for the checks. */
export const WEFAX_TEST_BAR_PX = 90;
const BAR_LEVELS = [0, 255, 64, 192];
export function wefaxTestRegions(width: number): { barsFrom: number; barsTo: number; gradFrom: number; gradTo: number } {
  const barsFrom = Math.round(width * 0.05);
  const bars = Math.floor((width * 0.4) / WEFAX_TEST_BAR_PX);
  const barsTo = barsFrom + bars * WEFAX_TEST_BAR_PX;
  return { barsFrom, barsTo, gradFrom: barsTo, gradTo: Math.round(width * 0.95) };
}

export function wefaxTestPixel(x: number, y: number, width: number): number {
  const r = wefaxTestRegions(width);
  if (x < r.barsFrom) return 255;
  if (x < r.barsTo) {
    const k = Math.floor((x - r.barsFrom) / WEFAX_TEST_BAR_PX);
    const flip = Math.floor(y / 40) % 2;
    return BAR_LEVELS[(k + flip * 2) % 4]!;
  }
  if (x < r.gradTo) return Math.round((255 * (x - r.gradFrom)) / (r.gradTo - r.gradFrom - 1));
  return 0;
}

export interface WefaxWaveformOptions {
  sampleRate: number;
  ioc: WefaxIoc;
  lpm: number;
  /** Centre frequency, Hz (default 1900). */
  carrierHz?: number;
  /** Send the start and stop tones (default true). */
  withApt?: boolean;
  /** Phasing lines before the picture (default fldigi's 20). */
  phasingLines?: number;
  /** Follow the phasing with one white line, as fldigi does (default true). */
  endPhasingLine?: boolean;
  /** Phasing pulse black on white instead of white on black (default false). */
  invertedPhasing?: boolean;
  /**
   * The sending clock's error as the receiver sees it, parts per million: +200 makes
   * every line 200 ppm longer in the receiver's samples, as a receiving sound card running
   * 200 ppm fast would.
   */
  ppmError?: number;
  /** Silence before and after, seconds (default 0.5). */
  leadSeconds?: number;
  /** Peak amplitude (default 0.8). */
  amplitude?: number;
}

/**
 * TEST GENERATOR ONLY. WEFAX is receive-only in DigiShack; this exists so the decoder can
 * be checked without a radio, and nothing in the app transmits it.
 *
 * Audio for a picture as a station sends it: start tone, phasing, (fldigi's white line),
 * the picture, stop tone. The picture is resampled to the IOC's width if it is not already
 * that wide (fldigi stretches it the same way, wefax.cxx:2088-2103) and read as grey
 * (luma). `img` null sends only the tones and the phasing. Phase-continuous FM, a level v
 * in 0..1 on carrier + (2v - 1) * 400 Hz as fldigi's modulator does (wefax.cxx:1994).
 */
export function wefaxWaveform(img: WefaxImage | null, opts: WefaxWaveformOptions): Float32Array {
  const fs = opts.sampleRate;
  const carrier = opts.carrierHz ?? WEFAX_CARRIER_HZ;
  const apt = opts.withApt ?? true;
  const phasing = opts.phasingLines ?? WEFAX_PHASING_LINES;
  const endLine = opts.endPhasingLine ?? true;
  const inv = opts.invertedPhasing ?? false;
  const stretch = 1 + (opts.ppmError ?? 0) * 1e-6;
  const lead = opts.leadSeconds ?? 0.5;
  const amp = opts.amplitude ?? 0.8;
  const W = wefaxWidth(opts.ioc);
  const lineS = 60 / opts.lpm;
  const rows = img ? img.height : 0;
  const grey = img ? greyRows(img, W) : null;

  // The schedule in the sender's seconds.
  const tStart = lead;
  const tPhase = tStart + (apt ? WEFAX_APT_SECONDS : 0);
  const tEnd = tPhase + phasing * lineS;
  const tImg = tEnd + (endLine ? lineS : 0);
  const tStop = tImg + rows * lineS;
  const tTail = tStop + (apt ? WEFAX_APT_SECONDS : 0);
  const tAll = tTail + lead;
  const startHz = WEFAX_APT_START_HZ[opts.ioc];

  const n = Math.ceil(tAll * stretch * fs);
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    // The sender's time at the middle of this receiver sample: at the sample instants
    // themselves the line boundaries fall exactly on samples at 12 kHz, and rounding would
    // decide edge by edge which side a boundary sample belongs to.
    const t = (i + 0.5) / fs / stretch;
    let v: number | null;
    if (t < tStart || t >= tTail) v = null;
    else if (t < tPhase) v = (t - tStart) * startHz % 1 < 0.5 ? 1 : 0;
    else if (t < tEnd) {
      const p = ((t - tPhase) / lineS) % 1;
      const pulse = p < WEFAX_PHASING_EDGE || p >= 1 - WEFAX_PHASING_EDGE;
      v = pulse !== inv ? 1 : 0;
    } else if (t < tImg) v = inv ? 0 : 1;
    else if (t < tStop) {
      const lt = (t - tImg) / lineS;
      const row = Math.min(rows - 1, Math.floor(lt));
      const col = Math.min(W - 1, Math.floor((lt - row) * W));
      v = grey![row * W + col]! / 255;
    } else v = (t - tStop) * WEFAX_APT_STOP_HZ % 1 < 0.5 ? 1 : 0;
    if (v === null) continue;
    const hz = carrier + (2 * v - 1) * WEFAX_DEVIATION_HZ;
    phase += (2 * Math.PI * hz) / fs;
    if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
    out[i] = amp * Math.sin(phase);
  }
  return out;
}

/** The picture as grey rows of exactly `W` pixels, nearest-neighbour resampled. */
function greyRows(img: WefaxImage, W: number): Uint8Array {
  const out = new Uint8Array(W * img.height);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < W; x++) {
      const sx = Math.min(img.width - 1, Math.floor((x * img.width) / W));
      const i = (y * img.width + sx) * 3;
      out[y * W + x] = Math.round(0.299 * img.rgb[i]! + 0.587 * img.rgb[i + 1]! + 0.114 * img.rgb[i + 2]!);
    }
  }
  return out;
}
