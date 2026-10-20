// US amateur band plan — which part of the band is CW, data or phone, and who may use it.
//
// SEPARATE FROM lib/ham/bands.ts ON PURPOSE, and the reason is written at the top of that
// file: its edges are the ADIF band boundaries, the widest allocation across IARU regions,
// because a LOGBOOK must be able to record a DX station operating outside your own
// allocation. This file is the opposite question — not "is that a valid 40 m frequency"
// but "may I transmit here, and in what mode". Merging them would make one of the two
// wrong, and the one that went wrong would be the legal one.
//
// SCOPE AND STANDING, because this shades a display an operator will act on:
//
//   * UNITED STATES ONLY, FCC Part 97: who may use which frequencies is §97.301, which
//     emissions go where is §97.305(c), and the Novice/Technician and 60 m limits are
//     §97.303(h) and §97.307(f)(9), (10) and (14). Read against the rules in force on
//     13 Feb 2026, the day FCC 25-60 rewrote 60 m. Power (§97.313) is not here; it is in
//     lib/ham/tools/privileges.ts, which answers "how much" on top of this file's "what".
//   * 2200 m to 23 cm. Nothing above 1300 MHz is modelled.
//   * The mainland: ITU Region 2, north of 20° N and east of 130° W. §97.305(c) note
//     (f)(11) also gives phone and image on 7.075–7.100 MHz to stations west of 130° W or
//     south of 20° N — Hawaii, most of Alaska, Puerto Rico — and that is NOT in the table.
//     An operator elsewhere has different edges and this would be confidently wrong for
//     them — see `BAND_PLAN_REGION`.
//   * INFORMATIONAL. It is a reading of the rules as they stood when written, not a
//     transmit interlock. The station licensee remains responsible for where they key,
//     and the actual gate on transmitting lives in the transmit-gate code, not here.
//   * Edges are the licence-class boundaries, not the voluntary ARRL band plan. The
//     gentlemen's agreements about where FT8 or SSTV live are a different kind of fact
//     and are not encoded here.

/** Which country's rules the segments below describe. */
export const BAND_PLAN_REGION = "US";

/**
 * Licence classes, in order of privilege.
 *
 * Advanced and Novice have not been issued for decades but remain valid and renewable, so
 * both are still here — a display that quietly dropped them would tell an Advanced
 * licensee they cannot use 3.700 MHz, which they can.
 */
export type LicenseClass = "E" | "A" | "G" | "T" | "N";

export const LICENSE_NAMES: Record<LicenseClass, string> = {
  E: "Extra",
  A: "Advanced",
  G: "General",
  T: "Tech",
  N: "Novice",
};

/**
 * The mode a segment is LABELLED by: what an operator actually goes there for.
 *
 * Not the whole of what may be sent there — 160 m is labelled phone and carries data too.
 * `segmentEmissions` is the answer to "what may I transmit", and `permitted` applies it.
 */
export type SegmentMode = "CW" | "DATA" | "PHONE";

/** The emission types §97.305(c) distinguishes, as far as an operator needs them. */
export type Emission = "CW" | "DATA" | "PHONE" | "IMAGE";

export interface PlanSegment {
  startHz: number;
  endHz: number;
  mode: SegmentMode;
  /** Every class permitted here. Ordered widest privilege first. */
  classes: LicenseClass[];
  /**
   * Classes restricted to CW in a segment that otherwise allows data.
   *
   * The Novice/Technician HF privileges are CW-only inside the digital sub-bands, which
   * is a distinction a single mode field cannot carry and which matters: a Technician on
   * 7.030 may key a straight key and may not send FT8. §97.307(f)(9).
   */
  cwOnly?: LicenseClass[];
  /**
   * Classes limited to CW and SSB voice (J3E/R3E) here — no image, no AM or FM, no data.
   * §97.307(f)(10), which binds Novices and Technicians on 28.3–28.5 MHz.
   */
  ssbOnly?: LicenseClass[];
  /**
   * What §97.305(c) authorises here, where it is not the default for the mode.
   *
   * The defaults are the HF pattern: a CW or DATA segment carries CW, RTTY and data, a
   * PHONE segment carries CW, phone and image — and NOT data, which on 80 through 10 m
   * belongs below the phone edge. The exceptions are the bands where one range carries
   * everything (2200, 630 and 160 m, 6 m and up), 60 m (no image), and the CW-only floors
   * of 6 m and 2 m.
   */
  emissions?: readonly Emission[];
}

const ALL_MODES: readonly Emission[] = ["CW", "DATA", "PHONE", "IMAGE"];
/** §97.305(c) and §97.307(f)(14)(i): phone, RTTY, data and CW on 60 m — image is not listed. */
const SIXTY_METRE_MODES: readonly Emission[] = ["CW", "DATA", "PHONE"];

/**
 * The segments, low to high.
 *
 * Phone segments also permit CW and image; they are labelled by the mode an operator
 * actually goes there for. Where a band has no phone allocation at all — 30 m — none is
 * invented.
 */
export const US_BAND_PLAN: readonly PlanSegment[] = [
  // 2200 m and 630 m: General and up (§97.301(b)–(d)), every emission in the one range
  // (§97.305(c)). Fixed stations only, after notifying UTC (§97.303(g)).
  { startHz: 135_700, endHz: 137_800, mode: "PHONE", classes: ["E", "A", "G"], emissions: ALL_MODES },
  { startHz: 472_000, endHz: 479_000, mode: "PHONE", classes: ["E", "A", "G"], emissions: ALL_MODES },

  // 160 m. One allocation, all modes, no Technician privileges at all.
  {
    startHz: 1_800_000,
    endHz: 2_000_000,
    mode: "PHONE",
    classes: ["E", "A", "G"],
    emissions: ALL_MODES,
  },

  // 80 / 75 m.
  { startHz: 3_500_000, endHz: 3_525_000, mode: "CW", classes: ["E"] },
  {
    startHz: 3_525_000,
    endHz: 3_600_000,
    mode: "DATA",
    classes: ["E", "A", "G", "T", "N"],
    cwOnly: ["T", "N"],
  },
  { startHz: 3_600_000, endHz: 3_700_000, mode: "PHONE", classes: ["E"] },
  { startHz: 3_700_000, endHz: 3_800_000, mode: "PHONE", classes: ["E", "A"] },
  { startHz: 3_800_000, endHz: 4_000_000, mode: "PHONE", classes: ["E", "A", "G"] },

  // 60 m, General and up. Since FCC 25-60 (in force 13 Feb 2026) it is four channels plus
  // one 15 kHz range (§97.303(h)); the range swallowed the old 5358.5 kHz channel. Each
  // channel is drawn as the 2.8 kHz its signal may occupy, centred on the channel centre —
  // NOT the span between them, which is the one thing a strip here must never shade. See
  // US_60M_CHANNELS for the carrier (dial) frequencies, which sit 100 Hz below these edges.
  { startHz: 5_330_600, endHz: 5_333_400, mode: "PHONE", classes: ["E", "A", "G"], emissions: SIXTY_METRE_MODES },
  { startHz: 5_346_600, endHz: 5_349_400, mode: "PHONE", classes: ["E", "A", "G"], emissions: SIXTY_METRE_MODES },
  { startHz: 5_351_500, endHz: 5_366_500, mode: "PHONE", classes: ["E", "A", "G"], emissions: SIXTY_METRE_MODES },
  { startHz: 5_371_600, endHz: 5_374_400, mode: "PHONE", classes: ["E", "A", "G"], emissions: SIXTY_METRE_MODES },
  { startHz: 5_403_600, endHz: 5_406_400, mode: "PHONE", classes: ["E", "A", "G"], emissions: SIXTY_METRE_MODES },

  // 40 m.
  { startHz: 7_000_000, endHz: 7_025_000, mode: "CW", classes: ["E"] },
  {
    startHz: 7_025_000,
    endHz: 7_125_000,
    mode: "DATA",
    classes: ["E", "A", "G", "T", "N"],
    cwOnly: ["T", "N"],
  },
  { startHz: 7_125_000, endHz: 7_175_000, mode: "PHONE", classes: ["E", "A"] },
  { startHz: 7_175_000, endHz: 7_300_000, mode: "PHONE", classes: ["E", "A", "G"] },

  // 30 m — CW and data only. There is no phone allocation, anywhere, for anyone.
  { startHz: 10_100_000, endHz: 10_150_000, mode: "DATA", classes: ["E", "A", "G"] },

  // 20 m. No Novice or Technician privileges.
  { startHz: 14_000_000, endHz: 14_025_000, mode: "CW", classes: ["E"] },
  { startHz: 14_025_000, endHz: 14_150_000, mode: "DATA", classes: ["E", "A", "G"] },
  { startHz: 14_150_000, endHz: 14_175_000, mode: "PHONE", classes: ["E"] },
  { startHz: 14_175_000, endHz: 14_225_000, mode: "PHONE", classes: ["E", "A"] },
  { startHz: 14_225_000, endHz: 14_350_000, mode: "PHONE", classes: ["E", "A", "G"] },

  // 17 m — no sub-division by class.
  { startHz: 18_068_000, endHz: 18_110_000, mode: "DATA", classes: ["E", "A", "G"] },
  { startHz: 18_110_000, endHz: 18_168_000, mode: "PHONE", classes: ["E", "A", "G"] },

  // 15 m.
  { startHz: 21_000_000, endHz: 21_025_000, mode: "CW", classes: ["E"] },
  {
    startHz: 21_025_000,
    endHz: 21_200_000,
    mode: "DATA",
    classes: ["E", "A", "G", "T", "N"],
    cwOnly: ["T", "N"],
  },
  { startHz: 21_200_000, endHz: 21_225_000, mode: "PHONE", classes: ["E"] },
  { startHz: 21_225_000, endHz: 21_275_000, mode: "PHONE", classes: ["E", "A"] },
  { startHz: 21_275_000, endHz: 21_450_000, mode: "PHONE", classes: ["E", "A", "G"] },

  // 12 m.
  { startHz: 24_890_000, endHz: 24_930_000, mode: "DATA", classes: ["E", "A", "G"] },
  { startHz: 24_930_000, endHz: 24_990_000, mode: "PHONE", classes: ["E", "A", "G"] },

  // 10 m — the one HF band where a Technician has phone, and the reason many of them
  // discover HF at all.
  // NO cwOnly here, and that is the point: 10 m is the one HF band where Part 97.301(e)
  // grants Technicians RTTY and data as well as CW. On 80, 40 and 15 the same licence is
  // CW-only in the equivalent segment. Getting this wrong in the obvious direction — by
  // pattern-matching the other three bands — tells a Technician they may not run FT8 on
  // 28.074, which is very likely the first HF digital contact they will ever make.
  {
    startHz: 28_000_000,
    endHz: 28_300_000,
    mode: "DATA",
    classes: ["E", "A", "G", "T", "N"],
  },
  // Novices are here too: §97.301(e) gives Novice and Technician the same 28.0–28.5 MHz.
  // Both are held to CW and SSB voice by §97.307(f)(10) — so no SSTV for either.
  {
    startHz: 28_300_000,
    endHz: 28_500_000,
    mode: "PHONE",
    classes: ["E", "A", "G", "T", "N"],
    ssbOnly: ["T", "N"],
  },
  { startHz: 28_500_000, endHz: 29_700_000, mode: "PHONE", classes: ["E", "A", "G"] },

  // 6 m. Technicians have the whole band. §97.305(c) authorises nothing but CW below
  // 50.1 MHz, so data is NOT permitted there — the HF "CW" segments carry data, this
  // one does not.
  { startHz: 50_000_000, endHz: 50_100_000, mode: "CW", classes: ["E", "A", "G", "T"], emissions: ["CW"] },
  {
    startHz: 50_100_000,
    endHz: 54_000_000,
    mode: "PHONE",
    classes: ["E", "A", "G", "T"],
    emissions: ALL_MODES,
  },

  // 2 m, Technician and up (§97.301(a)); CW-only below 144.1 as on 6 m.
  { startHz: 144_000_000, endHz: 144_100_000, mode: "CW", classes: ["E", "A", "G", "T"], emissions: ["CW"] },
  { startHz: 144_100_000, endHz: 148_000_000, mode: "PHONE", classes: ["E", "A", "G", "T"], emissions: ALL_MODES },

  // 1.25 m. 219–220 MHz is point-to-point digital message forwarding and nothing else
  // (§97.303(l), §97.305(c)); 222–225 MHz is open to Novices as well (§97.301(e)).
  { startHz: 219_000_000, endHz: 220_000_000, mode: "DATA", classes: ["E", "A", "G", "T"], emissions: ["DATA"] },
  { startHz: 222_000_000, endHz: 225_000_000, mode: "PHONE", classes: ["E", "A", "G", "T", "N"], emissions: ALL_MODES },

  // 70 cm and 33 cm: Technician and up, every emission.
  { startHz: 420_000_000, endHz: 450_000_000, mode: "PHONE", classes: ["E", "A", "G", "T"], emissions: ALL_MODES },
  { startHz: 902_000_000, endHz: 928_000_000, mode: "PHONE", classes: ["E", "A", "G", "T"], emissions: ALL_MODES },

  // 23 cm. Split only because Novices hold 1270–1295 MHz (§97.301(e)).
  { startHz: 1_240_000_000, endHz: 1_270_000_000, mode: "PHONE", classes: ["E", "A", "G", "T"], emissions: ALL_MODES },
  { startHz: 1_270_000_000, endHz: 1_295_000_000, mode: "PHONE", classes: ["E", "A", "G", "T", "N"], emissions: ALL_MODES },
  { startHz: 1_295_000_000, endHz: 1_300_000_000, mode: "PHONE", classes: ["E", "A", "G", "T"], emissions: ALL_MODES },
];

/**
 * Bands whose US allocation is not one continuous range.
 *
 * Only 60 m: four 2.8 kHz channels and one 15 kHz range inside a 390 kHz ADIF band.
 * Shading the span between them would tell an operator the whole range is theirs, which
 * is the one error this strip must not make — the channels and the range are drawn, the
 * gaps are not.
 */
export const CHANNELISED_BANDS: readonly { name: string; lowHz: number; highHz: number }[] =
  [{ name: "60M", lowHz: 5_060_000, highHz: 5_450_000 }];

export function isChannelised(hz: number): boolean {
  return CHANNELISED_BANDS.some((b) => hz >= b.lowHz && hz <= b.highHz);
}

/**
 * The four 60 m channels, §97.303(h).
 *
 * `carrierHz` is the dial: phone (USB), RTTY and data put the carrier 1.5 kHz below the
 * centre; CW goes on the centre itself. Every emission must stay within 2.8 kHz.
 */
export const US_60M_CHANNELS: readonly { channel: number; centreHz: number; carrierHz: number }[] = [
  { channel: 1, centreHz: 5_332_000, carrierHz: 5_330_500 },
  { channel: 2, centreHz: 5_348_000, carrierHz: 5_346_500 },
  { channel: 4, centreHz: 5_373_000, carrierHz: 5_371_500 },
  { channel: 5, centreHz: 5_405_000, carrierHz: 5_403_500 },
];

/** The 60 m range opened by FCC 25-60, §97.303(h). */
export const US_60M_RANGE = { lowHz: 5_351_500, highHz: 5_366_500 } as const;

/**
 * The 60 m channel a frequency belongs to: anywhere from its USB dial (carrier) frequency
 * to the top of the 2.8 kHz it occupies. The dial is 100 Hz below the occupied channel,
 * and it is the number an operator types.
 */
export function sixtyMetreChannelAt(
  hz: number,
): (typeof US_60M_CHANNELS)[number] | null {
  return US_60M_CHANNELS.find((c) => hz >= c.carrierHz && hz <= c.centreHz + 1_400) ?? null;
}

/** The segment a frequency falls in, or null outside every US allocation. */
export function segmentAt(hz: number): PlanSegment | null {
  return US_BAND_PLAN.find((s) => hz >= s.startHz && hz < s.endHz) ?? null;
}

/**
 * The segments overlapping a display window, CLIPPED to it.
 *
 * Clipped rather than filtered so a strip can be drawn straight from the result: a
 * segment running off both edges of a 5 kHz span still needs to paint the whole width,
 * and one that starts halfway across must start halfway across.
 */
export function segmentsIn(lowHz: number, highHz: number): PlanSegment[] {
  const out: PlanSegment[] = [];
  for (const s of US_BAND_PLAN) {
    if (s.endHz <= lowHz || s.startHz >= highHz) continue;
    out.push({
      ...s,
      startHz: Math.max(s.startHz, lowHz),
      endHz: Math.min(s.endHz, highHz),
    });
  }
  return out;
}

/**
 * The short label a strip shows: the mode, and the LOWEST class that may use it.
 *
 * The lowest rather than a list, because that is the fact an operator is checking. "Phone
 * General" says everyone from General up may talk here; the segment below it reading
 * "Phone Extra" is what makes the boundary mean something. This is the same form Aether
 * uses — "PHONE Extra", "PHONE General", "DATA Tech".
 */
export function segmentLabel(s: PlanSegment): string {
  const order: LicenseClass[] = ["N", "T", "G", "A", "E"];
  const lowest = order.find((c) => s.classes.includes(c));
  const mode = s.mode === "DATA" ? "Data" : s.mode === "CW" ? "CW" : "Phone";
  return lowest ? `${mode} ${LICENSE_NAMES[lowest]}` : mode;
}

/** Every emission §97.305(c) authorises in this segment, for the classes allowed in it. */
export function segmentEmissions(s: PlanSegment): readonly Emission[] {
  if (s.emissions) return s.emissions;
  return s.mode === "PHONE" ? ["CW", "PHONE", "IMAGE"] : ["CW", "DATA"];
}

/** May this class transmit `mode` here? The question the display is really answering. */
export function permitted(
  s: PlanSegment | null,
  cls: LicenseClass,
  mode: Emission,
): boolean {
  if (!s) return false;
  if (!s.classes.includes(cls)) return false;
  const allowed = segmentEmissions(s);
  // CW is permitted wherever the class may transmit at all (§97.305(a)) — except on
  // 219–220 MHz, which carries message forwarding and nothing else.
  if (mode === "CW") return allowed.includes("CW");
  if (s.cwOnly?.includes(cls)) return false;
  if (s.ssbOnly?.includes(cls)) return mode === "PHONE";
  return allowed.includes(mode);
}
