// "Where can I operate?" — a frequency's privileges for every US licence class, and a
// class's privileges across every band.
//
// WHO and WHAT come from lib/ham/band-plan.ts (§97.301, §97.305, §97.307(f)). This adds
// HOW MUCH — §97.313, read against the text in force on 13 Feb 2026 — and the notes an
// operator needs beside the answer. Informational, like the band plan: not a transmit gate.

import {
  isChannelised,
  permitted,
  segmentAt,
  segmentLabel,
  sixtyMetreChannelAt,
  US_60M_RANGE,
  US_BAND_PLAN,
  type Emission,
  type LicenseClass,
  type PlanSegment,
} from "@/lib/ham/band-plan";
import { freqToBand } from "@/lib/ham/bands";
import { bandLabel } from "@/lib/ham/tools/wave";
import { parseLicenceClass } from "@/lib/radio/sstv-licence";

export const CLASS_ORDER: readonly LicenseClass[] = ["E", "A", "G", "T", "N"];

export const CLASS_NAMES: Record<LicenseClass, string> = {
  E: "Extra",
  A: "Advanced",
  G: "General",
  T: "Technician",
  N: "Novice",
};

export const EMISSION_NAMES: Record<Emission, string> = {
  CW: "CW",
  DATA: "RTTY/data",
  PHONE: "phone",
  IMAGE: "image",
};

/**
 * The station's `station.licenceClass` setting as a band-plan class.
 *
 * The setting has no Novice (HamDB maps N to us-technician); "other" is a licence outside
 * the US, which these rules do not describe.
 */
export function classFromSetting(raw: string | null | undefined): {
  cls: LicenseClass | null;
  status: "set" | "unset" | "other";
} {
  const v = parseLicenceClass(raw);
  if (!v) return { cls: null, status: "unset" };
  if (v === "other") return { cls: null, status: "other" };
  const map = { "us-extra": "E", "us-advanced": "A", "us-general": "G", "us-technician": "T" } as const;
  return { cls: map[v], status: "set" };
}

export interface PowerLimit {
  /** "1,500 W PEP" */
  label: string;
  watts: number;
  measure: "PEP" | "ERP" | "EIRP";
  cite: string;
}

const inRange = (hz: number, lo: number, hi: number): boolean => hz >= lo && hz < hi;

/** §97.313(c)(2): Novice and Technician, 200 W PEP in their HF segments. */
const NOVICE_TECH_200W: readonly [number, number][] = [
  [3_525_000, 3_600_000],
  [7_025_000, 7_125_000],
  [21_025_000, 21_200_000],
  [28_000_000, 28_500_000],
];

/** The power ceiling for a class at a frequency, assuming it may transmit there at all. */
export function powerLimit(hz: number, cls: LicenseClass): PowerLimit {
  const pep = (watts: number, cite: string): PowerLimit => ({
    label: `${watts.toLocaleString("en-US")} W PEP`,
    watts,
    measure: "PEP",
    cite,
  });
  if (inRange(hz, 135_700, 137_801)) return { label: "1 W EIRP", watts: 1, measure: "EIRP", cite: "§97.313(k)" };
  if (inRange(hz, 472_000, 479_001)) return { label: "5 W EIRP", watts: 5, measure: "EIRP", cite: "§97.313(l)" };
  if (sixtyMetreChannelAt(hz)) return { label: "100 W ERP", watts: 100, measure: "ERP", cite: "§97.313(i)" };
  if (inRange(hz, US_60M_RANGE.lowHz, US_60M_RANGE.highHz + 1)) {
    return { label: "9.15 W ERP", watts: 9.15, measure: "ERP", cite: "§97.313(i)" };
  }
  if (inRange(hz, 10_100_000, 10_150_001)) return pep(200, "§97.313(c)(1)");
  if ((cls === "N" || cls === "T") && NOVICE_TECH_200W.some(([lo, hi]) => inRange(hz, lo, hi))) {
    return pep(200, "§97.313(c)(2)");
  }
  if (cls === "N" && inRange(hz, 222_000_000, 225_000_001)) return pep(25, "§97.313(d)");
  if (cls === "N" && inRange(hz, 1_270_000_000, 1_295_000_001)) return pep(5, "§97.313(e)");
  if (inRange(hz, 219_000_000, 220_000_001)) return pep(50, "§97.313(h)");
  return pep(1500, "§97.313(b)");
}

export interface ClassAnswer {
  cls: LicenseClass;
  emissions: Emission[];
  /** "SSB only" for Novice/Technician on 10 m, "USB" on 60 m. */
  phoneNote: string | null;
  /** Null when this class may not transmit here at all. */
  power: PowerLimit | null;
}

export interface FrequencyAnswer {
  hz: number;
  band: string | null;
  segment: PlanSegment | null;
  /** "14.025–14.150 MHz" */
  range: string | null;
  /** The band plan's label: "Data General". */
  label: string | null;
  channel: { channel: number; centreHz: number; carrierHz: number } | null;
  classes: ClassAnswer[];
  notes: string[];
  /** Why nobody may transmit here, when nobody may. */
  outside: string | null;
}

/** US band extents, for naming a frequency and for the per-band chart. */
export const US_BANDS: readonly { label: string; lowHz: number; highHz: number }[] = [
  { label: "2200 m", lowHz: 135_700, highHz: 137_800 },
  { label: "630 m", lowHz: 472_000, highHz: 479_000 },
  { label: "160 m", lowHz: 1_800_000, highHz: 2_000_000 },
  { label: "80 m", lowHz: 3_500_000, highHz: 4_000_000 },
  { label: "60 m", lowHz: 5_330_500, highHz: 5_406_400 },
  { label: "40 m", lowHz: 7_000_000, highHz: 7_300_000 },
  { label: "30 m", lowHz: 10_100_000, highHz: 10_150_000 },
  { label: "20 m", lowHz: 14_000_000, highHz: 14_350_000 },
  { label: "17 m", lowHz: 18_068_000, highHz: 18_168_000 },
  { label: "15 m", lowHz: 21_000_000, highHz: 21_450_000 },
  { label: "12 m", lowHz: 24_890_000, highHz: 24_990_000 },
  { label: "10 m", lowHz: 28_000_000, highHz: 29_700_000 },
  { label: "6 m", lowHz: 50_000_000, highHz: 54_000_000 },
  { label: "2 m", lowHz: 144_000_000, highHz: 148_000_000 },
  { label: "1.25 m", lowHz: 219_000_000, highHz: 225_000_000 },
  { label: "70 cm", lowHz: 420_000_000, highHz: 450_000_000 },
  { label: "33 cm", lowHz: 902_000_000, highHz: 928_000_000 },
  { label: "23 cm", lowHz: 1_240_000_000, highHz: 1_300_000_000 },
];

export function bandNameAt(hz: number): string | null {
  const us = US_BANDS.find((b) => hz >= b.lowHz && hz <= b.highHz);
  if (us) return us.label;
  const adif = freqToBand(hz);
  return adif ? bandLabel(adif) : null;
}

/** Trim to at least `min` decimals. */
function trimmed(n: number, max: number, min: number): string {
  let s = n.toFixed(max);
  if (s.includes(".")) s = s.replace(/0+$/, "");
  const [whole, frac = ""] = s.split(".");
  return `${whole}.${frac.padEnd(min, "0")}`.replace(/\.$/, "");
}

/** A frequency the way a band chart writes it: kHz below 1 MHz and on 60 m, MHz above. */
export function formatHz(hz: number): string {
  if (hz < 1_000_000 || isChannelised(hz)) return `${trimmed(hz / 1e3, 1, 0)} kHz`;
  if (hz < 30_000_000) return `${(hz / 1e6).toFixed(3)} MHz`;
  return `${trimmed(hz / 1e6, 3, 1)} MHz`;
}

export function formatRange(lowHz: number, highHz: number): string {
  const lo = formatHz(lowHz);
  const hi = formatHz(highHz);
  const unit = hi.split(" ")[1];
  return `${lo.split(" ")[0]}–${hi.split(" ")[0]} ${unit}`;
}

function answerFor(seg: PlanSegment, hz: number, cls: LicenseClass): ClassAnswer {
  const emissions = (["CW", "DATA", "PHONE", "IMAGE"] as const).filter((e) => permitted(seg, cls, e));
  let phoneNote: string | null = null;
  if (emissions.includes("PHONE")) {
    if (seg.ssbOnly?.includes(cls)) phoneNote = "SSB only";
    else if (isChannelised(hz)) phoneNote = "USB";
  }
  return { cls, emissions, phoneNote, power: emissions.length > 0 ? powerLimit(hz, cls) : null };
}

function notesFor(hz: number, seg: PlanSegment, channel: FrequencyAnswer["channel"]): string[] {
  const notes: string[] = [];
  if (inRange(hz, 135_700, 479_001)) {
    notes.push(
      "Fixed stations only, after notifying the Utilities Technology Council 30 days ahead, and not within 1 km of a power-line-carrier line (§97.303(g)).",
    );
    notes.push(
      hz < 200_000
        ? "1 W EIRP is radiated power; the transmitter itself may run up to 1,500 W PEP (§97.313(k))."
        : "5 W EIRP is radiated power, 1 W EIRP in Alaska within 800 km of Russia; the transmitter may run up to 500 W PEP (§97.313(l)).",
    );
  }
  if (channel) {
    notes.push(
      `60 m channel ${channel.channel}: USB dial ${(channel.carrierHz / 1e3).toFixed(1)} kHz. Phone, RTTY and data put the carrier 1.5 kHz below the centre (${(channel.centreHz / 1e3).toFixed(1)} kHz); CW goes on the centre. No signal wider than 2.8 kHz (§97.303(h)).`,
    );
  } else if (isChannelised(hz)) {
    notes.push("Anywhere in 5351.5–5366.5 kHz, no signal wider than 2.8 kHz (§97.303(h)).");
  }
  if (isChannelised(hz)) {
    notes.push(
      "ERP is transmitter PEP times antenna gain over a half-wave dipole; a dipole counts as 1 (§97.313(i)). No image modes on 60 m.",
    );
  }
  if (inRange(hz, 10_100_000, 10_150_001)) notes.push("200 W PEP for every class, and no phone on 30 m (§97.313(c)(1), §97.305(c)).");
  if (seg.cwOnly?.length && hz < 30_000_000) {
    notes.push("Novice and Technician: CW only here (§97.307(f)(9)), 200 W PEP (§97.313(c)(2)).");
  }
  if (inRange(hz, 28_000_000, 28_300_000)) notes.push("Novice and Technician: CW, RTTY and data at 200 W PEP (§97.313(c)(2)).");
  if (seg.ssbOnly?.length) {
    notes.push("Novice and Technician: CW and SSB voice only — no image, AM or FM (§97.307(f)(10)) — at 200 W PEP (§97.313(c)(2)).");
  }
  if (inRange(hz, 7_075_000, 7_100_000)) {
    notes.push("Stations west of 130° W or south of 20° N (Hawaii, most of Alaska, Puerto Rico) may also use phone and image on 7.075–7.100 MHz (§97.305(c)). Not shown above.");
  }
  if (seg.mode === "PHONE" && !seg.emissions && hz < 30_000_000) {
    notes.push("RTTY and data belong below the phone edge on this band (§97.305(c)).");
  }
  if (inRange(hz, 50_000_000, 50_100_000) || inRange(hz, 144_000_000, 144_100_000)) {
    notes.push("CW only: §97.305(c) authorises other emissions from 50.1 MHz on 6 m and 144.1 MHz on 2 m.");
  }
  if (inRange(hz, 219_000_000, 220_000_001)) {
    notes.push("Fixed point-to-point digital message forwarding only, after notifying the ARRL 30 days ahead (§97.303(l)); 50 W PEP (§97.313(h)).");
  }
  if (inRange(hz, 222_000_000, 225_000_001)) notes.push("Novices: 25 W PEP (§97.313(d)).");
  if (inRange(hz, 420_000_000, 450_000_001)) {
    notes.push("No transmitting north of Line A on 420–430 MHz (§97.303(m)); 50 W PEP in areas near certain military radars (§97.313(f)).");
  }
  if (inRange(hz, 902_000_000, 928_000_001)) notes.push("50 W PEP within 241 km of White Sands Missile Range (§97.313(g)).");
  if (inRange(hz, 1_270_000_000, 1_295_000_001)) notes.push("Novices: 5 W PEP (§97.313(e)).");
  return notes;
}

/** Everything the tool says about one frequency. */
export function lookupFrequency(hz: number): FrequencyAnswer {
  const channel = sixtyMetreChannelAt(hz);
  // A 60 m dial frequency sits 100 Hz below the channel it puts a signal in.
  const segment = segmentAt(hz) ?? (channel ? segmentAt(channel.centreHz) : null);
  const band = bandNameAt(hz);
  if (!segment) {
    let outside: string;
    if (isChannelised(hz)) {
      outside =
        "Between the 60 m channels. US stations may use only the four channels (USB dial 5330.5, 5346.5, 5371.5 and 5403.5 kHz) and 5351.5–5366.5 kHz (§97.303(h)).";
    } else if (band) {
      outside = `${band} is not a US amateur allocation at this frequency.`;
    } else if (hz > 1_300_000_000) {
      outside = "Above 23 cm, which this chart does not cover.";
    } else {
      outside = "Not a US amateur frequency.";
    }
    return {
      hz,
      band,
      segment: null,
      range: null,
      label: null,
      channel: null,
      classes: CLASS_ORDER.map((cls) => ({ cls, emissions: [], phoneNote: null, power: null })),
      notes: [],
      outside,
    };
  }
  return {
    hz,
    band,
    segment,
    range: formatRange(segment.startHz, segment.endHz),
    label: segmentLabel(segment),
    channel,
    classes: CLASS_ORDER.map((cls) => answerFor(segment, hz, cls)),
    notes: notesFor(hz, segment, channel),
    outside: null,
  };
}

/** "CW, RTTY/data and phone (SSB only)" */
export function describeEmissions(a: ClassAnswer): string {
  const names = a.emissions.map((e) =>
    e === "PHONE" && a.phoneNote ? `phone (${a.phoneNote})` : EMISSION_NAMES[e],
  );
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The headline for one class: may they, what, and how much. */
export function verdict(answer: FrequencyAnswer, cls: LicenseClass): { allowed: boolean; text: string } {
  const mine = answer.classes.find((c) => c.cls === cls);
  if (mine && mine.power) {
    return {
      allowed: true,
      text: `${CLASS_NAMES[cls]}: ${describeEmissions(mine)}, up to ${mine.power.label}.`,
    };
  }
  if (answer.outside) return { allowed: false, text: answer.outside };
  const who = answer.classes.filter((c) => c.power).map((c) => CLASS_NAMES[c.cls]);
  return {
    allowed: false,
    text: `${CLASS_NAMES[cls]}: not permitted here. ${who.length ? `Open to ${who.join(", ")}.` : ""}`.trim(),
  };
}

export interface ChartSegment {
  startHz: number;
  endHz: number;
  /** What this class may send; empty when none. */
  emissions: Emission[];
}

export interface ChartRange {
  startHz: number;
  endHz: number;
  text: string;
  emissions: Emission[];
  phoneNote: string | null;
  power: PowerLimit;
}

export interface BandChartRow {
  band: string;
  lowHz: number;
  highHz: number;
  segments: ChartSegment[];
  /** Contiguous stretches with the same privileges, merged. */
  ranges: ChartRange[];
}

/** A 60 m channel is quoted by its dial, the number on the radio; anything else by its edges. */
function rangeText(lowHz: number, highHz: number): string {
  const ch = sixtyMetreChannelAt(lowHz);
  if (ch && highHz - lowHz < 3_000) return `Channel ${ch.channel}, USB dial ${(ch.carrierHz / 1e3).toFixed(1)} kHz`;
  return formatRange(lowHz, highHz);
}

/** A class's privileges on every band, merged into the stretches an operator would quote. */
export function bandChart(cls: LicenseClass): BandChartRow[] {
  return US_BANDS.map((band) => {
    const segs = US_BAND_PLAN.filter((s) => s.startHz >= band.lowHz && s.endHz <= band.highHz);
    const segments: ChartSegment[] = [];
    const ranges: ChartRange[] = [];
    for (const s of segs) {
      const mid = Math.round((s.startHz + s.endHz) / 2);
      const a = answerFor(s, mid, cls);
      segments.push({ startHz: s.startHz, endHz: s.endHz, emissions: a.emissions });
      if (!a.power) continue;
      const prev = ranges[ranges.length - 1];
      if (
        prev &&
        prev.endHz === s.startHz &&
        prev.emissions.join() === a.emissions.join() &&
        prev.phoneNote === a.phoneNote &&
        prev.power.label === a.power.label
      ) {
        prev.endHz = s.endHz;
        prev.text = rangeText(prev.startHz, prev.endHz);
        continue;
      }
      ranges.push({
        startHz: s.startHz,
        endHz: s.endHz,
        text: rangeText(s.startHz, s.endHz),
        emissions: a.emissions,
        phoneNote: a.phoneNote,
        power: a.power,
      });
    }
    return { band: band.label, lowHz: band.lowHz, highHz: band.highHz, segments, ranges };
  });
}
