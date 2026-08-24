// A panadapter row on its way to a browser.
//
// Deliberately NOT `kind: "spectrum"`. The brief in docs/panadapter.md is explicit
// about why, and it is the same reasoning that runs through the whole per-radio
// profile argument: the audio waterfall's message is `{binHz, maxHz}` — offsets
// within a 3 kHz passband, relative to a dial frequency the row never states. A
// panadapter row is `{centerHz, spanHz}` — absolute RF. The two are the same shape
// and mean entirely different things, and a display that cannot tell 3 kHz of audio
// from 100 kHz of band will eventually draw one as the other. Given that this project
// has already shipped `status.mode` meaning two things and one radio's AGC shown next
// to another, that is not a hypothetical.
//
// So: a different `kind`, a different message, and a UI that has to say which it wants.

/**
 * Bounds on the colour ramp's height, in dB above the tracked floor.
 *
 * The ramp is NOT a fixed height, unlike the audio waterfall's 40 dB. It was, at 60 dB,
 * and the result on a real band was a display that was almost entirely black next to
 * the audio waterfall's vivid one — because a 100 kHz slice of 40 m has its strongest
 * signal about 16 dB above the noise, so every station landed in the bottom quarter of
 * the ramp, which is dark blue by design.
 *
 * That is not a palette problem and it is not a gain problem. An audio passband is one
 * signal filling the display; a panadapter is mostly noise with narrow signals in it,
 * and the distance from noise to the strongest station varies by tens of dB between a
 * quiet band and a local station. So the top of the ramp is tracked too.
 *
 * The floor on the span matters as much as the ceiling: without it, a genuinely empty
 * band stretches its own noise across the whole palette and paints the display in
 * full colour, which reads as a band full of signals.
 */
/**
 * The absolute floor on the ramp height.
 *
 * Was 12, which on a real 40 m evening capped the display at byte 136 of 255: the band's
 * strongest bin sat 6.4 dB above the drawn floor and a forced 12 dB ramp could never let
 * it past the middle colour, so voice traces that the reference clients show as broad
 * orange blobs came out as faint blue smudges.
 *
 * 6 dB is a guard against a degenerate frame — a flat-lined receiver, a muted antenna —
 * rather than a scaling decision. The scaling is done by the two terms that follow, and
 * both of them measure the band rather than assuming it.
 */
const MIN_SPAN_DB = 6;
const MAX_SPAN_DB = 70;

/*
 * WHY THERE IS A NOISE-RELATIVE TERM AT ALL.
 *
 * An unaveraged FFT bin containing only noise has exponentially distributed POWER, so in
 * dB it has an intrinsic spread that no band condition changes. From p25 to p99.5 that
 * spread is
 *
 *     10 * log10( ln(1/0.005) / ln(1/0.75) )  =  12.65 dB
 *
 * against a `MIN_SPAN_DB` of 12 — so on a quiet unaveraged band essentially the whole
 * palette went on rendering the difference between one noise sample and another. That was
 * the 20 m display reported as a full-colour confetti with no signal visible in it.
 *
 * The primary fix for that turned out to be `flex.panadapterAverage`, which narrows the
 * distribution at source. This term is the backstop for when averaging is off or the noise
 * is wide anyway, and it is deliberately gentle: see NOISE_MEDIAN_FRACTION and the second
 * rejected-attempt note, which is what an over-aggressive version of it did to a live
 * display.
 */

/*
 * A SECOND NOTE ON WHAT WAS TRIED AND REJECTED, because this one shipped and blanked the
 * display on a live radio.
 *
 * The first version of this term multiplied the noise width by 3.31 — the ratio of a
 * theoretical exponential distribution's p25-to-p99.5 spread to its p25-to-p50 spread —
 * and then required THAT to fit inside the bottom fifth of the ramp. Two mistakes
 * compounding:
 *
 *   1. The rule being enforced was wrong. The property this display needs, and the one
 *      the tests had always asserted, is that the noise MEDIAN is dark. The code demanded
 *      the noise's 99.5th PERCENTILE be dark, which is a far stronger claim and inflates
 *      the ramp about threefold.
 *   2. The constant was derived for UNAVERAGED bins and shipped in the same release that
 *      turned the radio's frame averaging on, which narrows the distribution it was
 *      derived from. The two changes fought.
 *
 * Measured on air afterwards, on 40 m: the band held 12.55 dB from p25 to its strongest
 * bin, and the scaler drew a 45 dB ramp for it. The loudest bin on the display rendered
 * at byte 60 of 255 and every other pixel below that — reported, correctly, as "waterfall
 * is blank like its not hearing".
 *
 * The lesson is not "pick a better constant". It is that the confetti this was written to
 * fix was mostly an AVERAGING problem, already solved by `flex.panadapterAverage`, and
 * that a scaler term added on top of it was solving a problem that no longer existed. So
 * the term stays, because a genuinely wide noise distribution still has to be handled, but
 * it enforces the median rule and nothing more.
 */

/**
 * Where the noise's MEDIAN is allowed to sit on the ramp.
 *
 * The bottom fifth — byte 51 of 255, which is dark blue. This is the same threshold the
 * scaler's tests have asserted since the palette work, now enforced by construction
 * rather than hoped for.
 *
 * It binds rarely and that is correct. On a normal band the noise median sits a decibel
 * or two above the drawn floor and the signal term is taller anyway; the guard only takes
 * over when the noise is genuinely wide, which is what an unaveraged frame on a quiet band
 * looks like.
 */
const NOISE_MEDIAN_FRACTION = 0.2;

/*
 * A NOTE ON WHAT WAS TRIED AND REJECTED, because it is an easy mistake to repeat.
 *
 * The span floor was 20 dB and the ceiling reserved 6 dB above the strongest signal.
 * Measured on air, that pinned `ceiling - floor` at exactly 20.0 dB on every row, kept
 * byte values below 210, and left the top three sixteenths of the palette unused — so
 * the strongest station on 40 m rendered green where SmartSDR showed it red.
 *
 * The first attempt at a fix made it worse: requiring the span to be a multiple of the
 * noise spread, estimated as p25 - p05. Span went to 40 dB and peaks fell to byte 78.
 * The reason is that **p05 is below the drawn floor and already clips to zero** — it
 * measures the part of the distribution the display never shows, so it inflated the
 * span with invisible data. Any future noise-relative term has to be measured from the
 * floor UPWARD, not from the bottom tail.
 */

/**
 * Where the palette starts, as a FRACTION OF THE NOISE'S OWN WIDTH above the measured
 * floor.
 *
 * It used to be a flat 2 dB, for the reason `lib/radio/spectrum.ts` gives: starting below
 * the floor means the noise occupies the bottom of the ramp and the display washes out.
 * That reason still holds; the constant did not.
 *
 * Measured on 40 m with the radio's frame averaging on, the noise is **2.69 dB** wide from
 * p25 to p50. A flat 2 dB offset therefore put the drawn floor almost at the noise MEDIAN,
 * so more than half of every frame clipped to byte 0 and the waterfall came out sparse and
 * mostly black with signals reaching only half the palette. Averaging narrowed the
 * distribution and the fixed offset did not follow it.
 *
 * Half the noise width keeps the original intent — the floor sits inside the noise, not
 * under it — at whatever width the noise actually has. Unaveraged, where p50 - p25 is
 * about 3.8 dB, this lands on 1.9 dB and reproduces the old behaviour almost exactly; the
 * constant was right once, for the only distribution that existed when it was written.
 */
const FLOOR_OFFSET_FRACTION = 0.5;

/** Bounds on that offset, so a degenerate frame cannot place the floor absurdly. */
const MIN_FLOOR_OFFSET_DB = 0.3;
const MAX_FLOOR_OFFSET_DB = 3;

/** Above this step, jump to the new floor rather than smoothing toward it. */
const FLOOR_SNAP_DB = 15;

/** A frequency window a spectrum display is drawn against. */
export interface SpectrumAxis {
  lowHz: number;
  spanHz: number;
}

/**
 * Where the existing pixels should be redrawn when the axis moves.
 *
 * Returns the source rectangle in the OLD image and the destination rectangle in the new
 * one, both in pixels across a `widthPx`-wide canvas — or null when the two windows share
 * no frequency at all and the display should simply blank.
 *
 * This is what lets a re-centre slide the waterfall instead of wiping it. Reported as
 * "everytime i click to the side the waterfall re renders — it should only re render the
 * missing part and continue scrolling up", which is also how every hardware panadapter
 * behaves.
 *
 * Extracted from the drawing code so the arithmetic can be asserted. It is a few lines of
 * algebra with two easy ways to be wrong — the sign of the shift, and clipping the
 * destination in the same proportion as the source — and either mistake produces a
 * plausible-looking waterfall with signals on the wrong frequency, which is the one thing
 * this display must never do.
 */
export function remapAxis(
  was: SpectrumAxis,
  now: SpectrumAxis,
  widthPx: number,
): { srcX0: number; srcX1: number; dstX0: number; dstX1: number } | null {
  if (was.spanHz <= 0 || now.spanHz <= 0 || widthPx <= 0) return null;

  // The new window expressed in the old image's pixel coordinates. Tuning up moves the
  // content left, hence a positive offset for an increasing lowHz.
  const sx = ((now.lowHz - was.lowHz) / was.spanHz) * widthPx;
  const sw = (now.spanHz / was.spanHz) * widthPx;

  let srcX0 = sx;
  let srcX1 = sx + sw;
  let dstX0 = 0;
  let dstX1 = widthPx;

  // Clip to the old image, and clip the destination by the SAME linear map, so a
  // frequency still lands on its own pixel: dst = (src - sx) / sw * widthPx.
  if (srcX0 < 0) {
    dstX0 = ((0 - sx) / sw) * widthPx;
    srcX0 = 0;
  }
  if (srcX1 > widthPx) {
    dstX1 = ((widthPx - sx) / sw) * widthPx;
    srcX1 = widthPx;
  }

  if (srcX1 <= srcX0) return null;
  return { srcX0, srcX1, dstX0, dstX1 };
}

export interface PanadapterRow {
  /** One byte per bin, 0-255 across `floorDb`..`ceilingDb`. */
  bins: Uint8Array;
  centerHz: number;
  spanHz: number;
  binHz: number;
  floorDb: number;
  ceilingDb: number;
  at: number;
}

/**
 * Turns a radio's raw bins into a display row, tracking the noise floor.
 *
 * The floor is measured per frame rather than fixed, exactly as the audio analyser
 * does it and for exactly the same reason: band noise varies by 30 dB between 10 m at
 * midday and 40 m at night, and a hardcoded window either saturates to solid colour or
 * blanks the display. Both of those happened to the audio waterfall before it was
 * adaptive, so there is no reason to relearn it here.
 *
 * It also means the panadapter does not depend on the FlexRadio's dBm calibration
 * being right — which is fortunate, because it has not been verified. See
 * `PAN_MIN_DBM` in lib/flex/panadapter.ts.
 */
export class PanadapterScaler {
  private floorDb: number | null = null;
  private peakDb: number | null = null;
  /** Smoothed p50 - p25, the noise's own width. See NOISE_REACH. */
  private noiseWidthDb: number | null = null;

  /**
   * @param toDb converts one raw bin to dB. Per radio: the FlexRadio's bins are y
   *   pixel indices over a dBm window, and the Icom's scope will be something else
   *   again. Passing the conversion in is what keeps this class shared.
   */
  constructor(private readonly toDb: (raw: number) => number) {}

  row(
    bins: ArrayLike<number>,
    centerHz: number,
    spanHz: number,
    at = Date.now(),
  ): PanadapterRow {
    const n = bins.length;
    const db = new Float32Array(n);
    for (let i = 0; i < n; i++) db[i] = this.toDb(bins[i] as number);

    // 25th percentile, not the median: on a busy band a good fraction of the span is
    // occupied and the median is dragged up by the signals themselves. The minimum is
    // too twitchy to smooth.
    const sorted = Float32Array.from(db).sort();
    const frameFloor = sorted[Math.floor(n * 0.25)] ?? -120;
    // The median, used ONLY to measure how wide the noise is — never to place the floor.
    // See NOISE_REACH: p25 and p50 are the two percentiles a band full of signals still
    // leaves in the noise, which is what makes the width measurable while signals are
    // present.
    const frameMedian = sorted[Math.floor(n * 0.5)] ?? frameFloor;
    // Not the maximum: a single spurious bin — a birdie, a spike from the ADC — would
    // then set the scale for the whole display and push every real signal down into
    // the dark. The 99.5th percentile ignores a handful of outliers and still sits
    // above every genuine carrier.
    const framePeak =
      sorted[Math.min(n - 1, Math.floor(n * 0.995))] ?? frameFloor;

    const tracked = this.floorDb;
    if (tracked === null || Math.abs(frameFloor - tracked) > FLOOR_SNAP_DB) {
      // Snap across a large step — a band change, or the attenuator moving. Smoothing
      // through it just means a slow wrong scale, which on a band change is the whole
      // display saturated for several seconds.
      this.floorDb = frameFloor;
    } else {
      this.floorDb = tracked * 0.9 + frameFloor * 0.1;
    }

    // The ceiling follows the strongest signal, but SLOWLY DOWNWARD and quickly up.
    // A station that stops transmitting should not make the rest of the band brighten
    // over the next frame — the display would pulse with every transmission on it.
    const trackedPeak = this.peakDb;
    if (trackedPeak === null || framePeak > trackedPeak) {
      this.peakDb = framePeak;
    } else {
      this.peakDb = trackedPeak * 0.98 + framePeak * 0.02;
    }

    // The noise's own width, smoothed. Measured BEFORE the floor is placed, because the
    // floor is now derived from it — a fixed offset put the drawn floor above the noise
    // median once averaging narrowed the distribution, and clipped half of every frame to
    // black. See FLOOR_OFFSET_FRACTION.
    const noiseWidth = Math.max(0, frameMedian - frameFloor);
    this.noiseWidthDb =
      this.noiseWidthDb === null
        ? noiseWidth
        : this.noiseWidthDb * 0.9 + noiseWidth * 0.1;
    const width = this.noiseWidthDb ?? noiseWidth;

    const floorOffset = Math.min(
      MAX_FLOOR_OFFSET_DB,
      Math.max(MIN_FLOOR_OFFSET_DB, width * FLOOR_OFFSET_FRACTION),
    );
    const floor = (this.floorDb ?? frameFloor) + floorOffset;

    // The 99.5th percentile maps to the TOP of the ramp, with nothing held back. It is
    // already a percentile rather than the maximum, so the handful of bins above it
    // clip to red — which is what a peak should look like. Reserving headroom above a
    // value that was chosen to exclude outliers meant the strongest genuine carrier on
    // the band could never reach the top of the palette.
    const signalSpan = (this.peakDb ?? framePeak) - floor;

    // How far the noise's MEDIAN sits above the DRAWN floor, and the ramp that puts it in
    // the bottom fifth. Not the noise's upper tail — see the second rejected-attempt note
    // above; demanding p99.5 be dark rather than p50 is what blanked a live display.
    const noiseSpan = Math.max(0, width - floorOffset) / NOISE_MEDIAN_FRACTION;

    // The taller of the two demands. The signal term keeps a strong carrier from
    // clipping; the noise term keeps the noise dark. Neither alone is sufficient: on a
    // quiet band the signal term collapses to the noise itself, and on a band with a
    // local station the noise term alone would let that station saturate half the
    // display.
    const span = Math.min(
      MAX_SPAN_DB,
      Math.max(MIN_SPAN_DB, signalSpan, noiseSpan),
    );
    const ceiling = floor + span;

    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const norm = ((db[i] as number) - floor) / span;
      out[i] = Math.max(0, Math.min(255, Math.round(norm * 255)));
    }

    return {
      bins: out,
      centerHz,
      spanHz,
      binHz: spanHz / n,
      floorDb: floor,
      ceilingDb: ceiling,
      at,
    };
  }
}

/**
 * The wire message.
 *
 * Base64 rather than a JSON number array, for the reason the audio spectrum message
 * already found the hard way: 4096 bins is about 23 kB as numbers against 5.5 kB
 * encoded, fifteen times a second, to every connected page. A Uint8Array also
 * JSON-serialises to `{"0":12,"1":45,…}` rather than to an array, which is what left
 * the Icom's first waterfall saying "waiting for spectrum…" while data was arriving.
 */
export interface PanadapterMessage {
  kind: "panadapter";
  bins: string;
  centerHz: number;
  spanHz: number;
  binHz: number;
  floorDb: number;
  ceilingDb: number;
  at: number;
  /** Which radio produced it, so the display can say so rather than imply it. */
  radio: string;
}

export function panadapterMessage(
  row: PanadapterRow,
  radio: string,
): PanadapterMessage {
  return {
    kind: "panadapter",
    bins: Buffer.from(row.bins).toString("base64"),
    centerHz: row.centerHz,
    spanHz: row.spanHz,
    binHz: row.binHz,
    floorDb: row.floorDb,
    ceilingDb: row.ceilingDb,
    at: row.at,
    radio,
  };
}
