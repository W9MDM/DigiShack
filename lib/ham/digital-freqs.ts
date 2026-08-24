// Standard FT8 and FT4 dial frequencies, and inferring which mode is in use from
// the radio's dial.
//
// Needed because a data slice cannot tell you the mode: SmartSDR reports DIGU,
// which is just "upper-sideband data". FT8 and FT4 sound nothing alike to a
// decoder — they have different symbol rates and, critically, different window
// lengths (15 s vs 7.5 s) — so decoding one as the other yields nothing at all.
//
// The dial frequency is the reliable discriminator: the two modes use distinct,
// well-established watering holes on every band.

export type DigitalMode = "FT8" | "FT4" | "FT2";


export interface DigitalFrequency {
  hz: number;
  mode: DigitalMode;
  band: string;
  /** ITU region the band exists in; undefined = worldwide. */
  region?: 1 | 2 | 3;
}

/**
 * FT8 calling frequencies, from the WSJT-X 2.7 defaults.
 *
 * The frequencies themselves are worldwide — FT8's whole model depends on
 * everyone listening in the same 3 kHz — so regional differences are about which
 * BANDS exist, not where the mode sits in them. Entries carry an ITU region only
 * when the band is missing elsewhere: 4 m is Region 1 only, 1.25 m (222 MHz) is
 * Region 2 only.
 */
const FT8: [number, string, (1 | 2 | 3)?][] = [
  [1_840_000, "160M"],
  [3_573_000, "80M"],
  [5_357_000, "60M"],
  [7_074_000, "40M"],
  [10_136_000, "30M"],
  [14_074_000, "20M"],
  [18_100_000, "17M"],
  [21_074_000, "15M"],
  [24_915_000, "12M"],
  [28_074_000, "10M"],
  [50_313_000, "6M"],
  [50_323_000, "6M"],
  [70_154_000, "4M", 1],
  [144_174_000, "2M"],
  [222_065_000, "1.25M", 2],
  [432_174_000, "70CM"],
  [1_296_174_000, "23CM"],
];

/** FT4 calling frequencies (WSJT-X 2.7 defaults). */
const FT4: [number, string, (1 | 2 | 3)?][] = [
  [3_575_000, "80M"],
  [7_047_500, "40M"],
  [10_140_000, "30M"],
  [14_080_000, "20M"],
  [18_104_000, "17M"],
  [21_140_000, "15M"],
  [24_919_000, "12M"],
  [28_180_000, "10M"],
  [50_318_000, "6M"],
  [144_170_000, "2M"],
];

/**
 * FT2 calling frequencies, from `models/FrequencyList.cpp` in wsjt-x_improved
 * 3.1.0, where every one is commented `// provisional`.
 *
 * An earlier revision of this file asserted FT2 had no published allocation, on
 * the strength of `fMHz=7.074` hard-coded in `ft2_decode.f90`. That file is part
 * of K1JT's standalone development harness — it ships its own portaudio and an
 * `ft2.ini` reading "K1JT FN20" — and its placeholder says nothing about the
 * integrated mode. The real table was one directory away.
 *
 * The pattern is FT4 + 4 kHz on most bands (14.080 -> 14.084, 21.140 -> 21.144,
 * 28.180 -> 28.184). 60 m is the exception: FT2 shares 5.357 MHz with FT4, so a
 * dial there is ambiguous and `inferDigitalMode` resolves it to FT4 — see the note
 * on that function.
 */
const FT2: [number, string, (1 | 2 | 3)?][] = [
  [1_843_000, "160M"],
  [3_578_000, "80M", 3],
  [5_357_000, "60M"],
  [7_052_000, "40M"],
  [10_144_000, "30M"],
  [14_084_000, "20M"],
  [18_108_000, "17M"],
  [21_144_000, "15M"],
  [24_923_000, "12M"],
  [28_184_000, "10M"],
  [50_320_000, "6M"],
  [144_177_000, "2M"],
];


export const DIGITAL_FREQUENCIES: readonly DigitalFrequency[] = [
  ...FT8.map(([hz, band, region]): DigitalFrequency => ({ hz, mode: "FT8", band, region })),
  ...FT4.map(([hz, band, region]): DigitalFrequency => ({ hz, mode: "FT4", band, region })),
  // FT2 last, so that where it collides with FT4 (60 m, both on 5.357) the
  // nearest-match search in inferDigitalMode keeps the FT4 answer: `delta <
  // bestDelta` is strict, so an equal-distance later entry does not displace an
  // earlier one. FT4 is overwhelmingly the more likely occupant of a shared
  // frequency, and guessing FT2 there would stop FT4 decoding entirely.
  ...FT2.map(([hz, band, region]): DigitalFrequency => ({ hz, mode: "FT2", band, region })),
];

/**
 * Rough ITU region from a Maidenhead grid square.
 *
 * Only the longitude matters, and only coarsely — this gates which bands are
 * offered, nothing more. Boundaries: the Americas (Region 2) end at 20° W;
 * Europe/Africa/Middle East (Region 1) run to 60° E; everything east is Region 3.
 * Border cases (Greenland is Region 1 but sits west of 20° W) are accepted — an
 * operator there sees one extra or missing band button, not a wrong frequency.
 */
export function ituRegionFromGrid(grid: string | null | undefined): 1 | 2 | 3 | null {
  if (!grid || grid.length < 2) return null;
  const field = grid.charAt(0).toUpperCase();
  if (field < "A" || field > "R") return null;
  const lonWest = (field.charCodeAt(0) - 65) * 20 - 180;
  const lonCentre = lonWest + 10;
  if (lonCentre < -20) return 2;
  if (lonCentre < 60) return 1;
  return 3;
}

/** The frequency list, limited to bands that exist in the given region. */
export function frequenciesForRegion(
  region: 1 | 2 | 3 | null,
): readonly DigitalFrequency[] {
  if (region === null) return DIGITAL_FREQUENCIES;
  return DIGITAL_FREQUENCIES.filter(
    (f) => f.region === undefined || f.region === region,
  );
}

/**
 * How far the dial may sit from a listed frequency and still count as that mode.
 *
 * 500 Hz rather than something generous: FT8 on 30 m is 10.136 and FT4 is 10.140,
 * only 4 kHz apart, and being wrong means decoding with the wrong window length
 * and getting nothing.
 */
const TOLERANCE_HZ = 500;

export interface ModeGuess {
  mode: DigitalMode;
  /** True when the dial matched a known calling frequency. */
  certain: boolean;
  /** The matched frequency, when there was one. */
  matched: DigitalFrequency | null;
}

/**
 * Infer the digital mode from a dial frequency.
 *
 * Falls back to FT8 when nothing matches — it is far more widely used, so it is
 * the better guess for an unlisted frequency — but reports `certain: false` so a
 * caller can say so rather than implying it knows.
 */
/**
 * Which digital mode a dial frequency implies.
 *
 * One frequency is genuinely ambiguous: 5.357 MHz carries both FT4 and FT2 in
 * WSJT-X's own provisional table. Ties resolve to FT4, because the comparison is
 * strict and FT4 is listed first — the right answer, since FT4 is far more likely
 * to be what is actually on a shared frequency, and choosing FT2 there would put
 * the decoder on a 3.75 s window and stop FT4 decoding altogether.
 */
export function inferDigitalMode(dialHz: number | null): ModeGuess {
  if (!dialHz || dialHz <= 0) {
    return { mode: "FT8", certain: false, matched: null };
  }

  let best: DigitalFrequency | null = null;
  let bestDelta = Infinity;

  for (const f of DIGITAL_FREQUENCIES) {
    const delta = Math.abs(f.hz - dialHz);
    if (delta <= TOLERANCE_HZ && delta < bestDelta) {
      best = f;
      bestDelta = delta;
    }
  }

  return best
    ? { mode: best.mode, certain: true, matched: best }
    : { mode: "FT8", certain: false, matched: null };
}

/**
 * Window length per mode.
 *
 * A lookup rather than a chain of ternaries: as written, `mode === "FT4" ? 7500 :
 * 15000` silently returned 15 s for FT2 the moment FT2 joined `DigitalMode`, and
 * a decoder cutting 15 s windows on a 2.5 s mode would decode nothing while
 * looking healthy. A record forces every new mode to be answered here.
 */
const PERIOD_MS: Record<DigitalMode, number> = {
  FT8: 15_000,
  FT4: 7_500,
  FT2: 3_750,
};

export function periodMsFor(mode: DigitalMode): number {
  return PERIOD_MS[mode];
}
