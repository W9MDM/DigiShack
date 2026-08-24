// US HF band plan — which part of the band is CW, which is phone, and who may use it.
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
//   * UNITED STATES ONLY, FCC Part 97.301 and 97.305. A operator elsewhere has different
//     edges and this strip would be confidently wrong for them — see `BAND_PLAN_REGION`.
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

/** What may be transmitted in a segment. CW is permitted everywhere it says DATA. */
export type SegmentMode = "CW" | "DATA" | "PHONE";

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
   * 7.030 may key a straight key and may not send FT8.
   */
  cwOnly?: LicenseClass[];
}

/**
 * The segments, low to high.
 *
 * Phone segments also permit CW and image; they are labelled by the mode an operator
 * actually goes there for. Where a band has no phone allocation at all — 30 m — none is
 * invented.
 */
export const US_BAND_PLAN: readonly PlanSegment[] = [
  // 160 m. One allocation, all modes, no Technician privileges at all.
  { startHz: 1_800_000, endHz: 2_000_000, mode: "PHONE", classes: ["E", "A", "G"] },

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

  // 60 m is five fixed CHANNELS rather than a band, so it is deliberately absent: drawing
  // it as a continuous segment would say an operator may work anywhere across 5.3 MHz,
  // which is exactly wrong. See CHANNELISED_BANDS.

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
  { startHz: 28_300_000, endHz: 28_500_000, mode: "PHONE", classes: ["E", "A", "G", "T"] },
  { startHz: 28_500_000, endHz: 29_700_000, mode: "PHONE", classes: ["E", "A", "G"] },

  // 6 m. Technicians have the whole band.
  { startHz: 50_000_000, endHz: 50_100_000, mode: "CW", classes: ["E", "A", "G", "T"] },
  { startHz: 50_100_000, endHz: 54_000_000, mode: "PHONE", classes: ["E", "A", "G", "T"] },
];

/**
 * Bands that are channels rather than ranges, and so cannot be drawn as segments.
 *
 * 60 m is five discrete 2.8 kHz channels; shading the span between them would tell an
 * operator the whole range is theirs, which is the one error this strip must not make.
 * The display says so in words instead.
 */
export const CHANNELISED_BANDS: readonly { name: string; lowHz: number; highHz: number }[] =
  [{ name: "60M", lowHz: 5_060_000, highHz: 5_450_000 }];

export function isChannelised(hz: number): boolean {
  return CHANNELISED_BANDS.some((b) => hz >= b.lowHz && hz <= b.highHz);
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

/** May this class transmit `mode` here? The question the display is really answering. */
export function permitted(
  s: PlanSegment | null,
  cls: LicenseClass,
  mode: SegmentMode,
): boolean {
  if (!s) return false;
  if (!s.classes.includes(cls)) return false;
  // CW is permitted wherever anything is. The restriction only bites on data and phone.
  if (mode === "CW") return true;
  if (s.cwOnly?.includes(cls)) return false;
  // A phone segment permits phone and CW; a data segment does not permit phone.
  if (mode === "PHONE") return s.mode === "PHONE";
  return true;
}
