// What mode a spotted station is probably in.
//
// A spot carries a frequency and, sometimes, a comment that says. The comment wins whenever
// it names a mode — a DX station in Europe works SSB on 7.080, which the US band plan calls a
// data segment, and the spotter heard it. Without one the frequency is the only evidence, and
// a guess from it is marked as a guess (`source` is "frequency" or "band-plan") so the page
// can say so rather than present it as fact.

import { isChannelised, segmentAt } from "@/lib/ham/band-plan";
import { freqToBand } from "@/lib/ham/bands";
import { DIGITAL_FREQUENCIES } from "@/lib/ham/digital-freqs";

import type { ModeCategory, ModeSource } from "@/lib/cluster/types";

/**
 * Mode -> the category the mode-slot badge counts in.
 *
 * Also used for the LOG's modes, so the names here include what an ADIF import leaves in
 * `Qso.mode` (USB, LSB, PSK, MFSK, CONTESTI). Image modes sit with phone because they share
 * the phone sub-bands (see lib/radio/sstv-licence.ts); that is this page's grouping, not a
 * statement of any award programme's rules.
 */
const CATEGORY: Record<string, ModeCategory> = {
  CW: "CW",
  SSB: "PHONE",
  USB: "PHONE",
  LSB: "PHONE",
  AM: "PHONE",
  FM: "PHONE",
  DIGITALVOICE: "PHONE",
  SSTV: "PHONE",
  FT8: "DIGITAL",
  FT4: "DIGITAL",
  FT2: "DIGITAL",
  MFSK: "DIGITAL",
  JS8: "DIGITAL",
  RTTY: "DIGITAL",
  PSK: "DIGITAL",
  PSK31: "DIGITAL",
  PSK63: "DIGITAL",
  PSK125: "DIGITAL",
  OLIVIA: "DIGITAL",
  CONTESTI: "DIGITAL",
  HELL: "DIGITAL",
  JT65: "DIGITAL",
  JT9: "DIGITAL",
  MSK144: "DIGITAL",
  Q65: "DIGITAL",
  FST4: "DIGITAL",
  WSPR: "DIGITAL",
  JTTY: "DIGITAL",
};

export function modeCategory(mode: string | null | undefined): ModeCategory | null {
  if (!mode) return null;
  return CATEGORY[mode.trim().toUpperCase()] ?? null;
}

/**
 * Mode words a spotter types, in the spelling this log stores them.
 *
 * AM and FM are matched only in capitals: as lower-case words they are ordinary English in
 * a comment ("am QRV later"). Word boundaries keep FM18 — a grid square — from reading as FM.
 */
const COMMENT_MODES: [RegExp, string][] = [
  [/\bFT8\b/i, "FT8"],
  [/\bFT4\b/i, "FT4"],
  [/\bFT2\b/i, "FT2"],
  [/\bJS8(?:CALL)?\b/i, "JS8"],
  [/\bRTTY\b/i, "RTTY"],
  [/\bB?PSK(?:31|63|125)?\b/i, "PSK31"],
  [/\bOLIVIA\b/i, "OLIVIA"],
  [/\bSSTV\b/i, "SSTV"],
  [/\bMSK144\b/i, "MSK144"],
  [/\bQ65\b/i, "Q65"],
  [/\bJT65\b/i, "JT65"],
  [/\bJT9\b/i, "JT9"],
  [/\bFST4W?\b/i, "FST4"],
  [/\b(?:FELD\s?)?HELL\b/i, "HELL"],
  [/\bCW\b/i, "CW"],
  [/\b(?:SSB|USB|LSB)\b/i, "SSB"],
  [/\bAM\b/, "AM"],
  [/\bFM\b/, "FM"],
];

/** The first mode the comment names, by position — "CW, SSB later" is a CW spot. */
export function modeFromComment(comment: string): string | null {
  let best: { at: number; mode: string } | null = null;
  for (const [re, mode] of COMMENT_MODES) {
    const m = re.exec(comment);
    if (m && (best === null || m.index < best.at)) best = { at: m.index, mode };
  }
  return best?.mode ?? null;
}

/**
 * The watering holes a frequency can be recognised by: FT8, FT4, JS8 and PSK31.
 *
 * DIGITAL_FREQUENCIES lists DIAL frequencies, and a spot gives the signal's own frequency,
 * which sits up to ~3 kHz above the dial — or the dial itself, depending on who spotted it.
 * So the window is the dial to 3.2 kHz above it, with 200 Hz of slack below.
 *
 * Left out on purpose:
 *   * RTTY and CW, whose entries are segment CENTRES the mode button tunes to, not places
 *     a signal can be recognised by.
 *   * WSPR — never spotted on a cluster, and its 7.0386 dial puts 7.040 CW inside its window.
 *   * FT2, Olivia, Hell, JTTY and SSTV — rarely spotted, and each sits where a commoner
 *     mode is more likely (FT2's 14.084 is RTTY territory, SSTV's 14.230 is phone).
 *   * Entries with an ITU region (PSK31 on 40 m). The spotted station's region is not known
 *     here, and Region 1's 7.035 PSK31 dial is where Region 2 works CW.
 */
const HOLES = DIGITAL_FREQUENCIES.filter(
  (f) => ["FT8", "FT4", "JS8", "PSK31"].includes(f.mode) && f.region === undefined,
);

function wateringHole(freqHz: number): string | null {
  // Of the holes whose window holds the spot, the one whose dial is highest: a signal at
  // 14.0805 is 500 Hz above FT4's dial and 2.5 kHz above JS8's, and is FT4.
  let best: { dial: number; mode: string } | null = null;
  for (const f of HOLES) {
    if (freqHz < f.hz - 200 || freqHz > f.hz + 3200) continue;
    if (best === null || f.hz > best.dial) best = { dial: f.hz, mode: f.mode };
  }
  return best?.mode ?? null;
}

export interface ModeGuess {
  mode: string | null;
  category: ModeCategory | null;
  source: ModeSource | null;
}

function guess(mode: string | null, source: ModeSource | null): ModeGuess {
  return { mode, category: modeCategory(mode), source: mode ? source : null };
}

/**
 * Comment first, then a watering hole, then the band plan.
 *
 * The band-plan step reads lib/ham/band-plan.ts (US Part 97) and turns its segments into the
 * mode most often SPOTTED there, which is not the same as what the segment permits:
 *
 *   * CW and DATA segments read as CW. A data segment is "CW and data" in the rules, and
 *     away from the digital watering holes caught above, the spots there are CW.
 *   * PHONE reads as SSB.
 *   * 160 m is one all-mode segment in the table, so the convention is used instead: CW
 *     below 1.843 MHz, SSB above. The table is right about the law and silent on practice.
 *   * 60 m is channels, and VHF and up permit every mode in one segment: no guess at all.
 */
export function inferSpotMode(
  freqHz: number,
  comment: string,
  skimmerMode: string | null,
): ModeGuess {
  if (skimmerMode) {
    const m = skimmerMode.toUpperCase();
    return guess(m === "USB" || m === "LSB" ? "SSB" : m.startsWith("BPSK") ? "PSK31" : m, "comment");
  }
  const stated = modeFromComment(comment);
  if (stated) return guess(stated, "comment");

  const hole = wateringHole(freqHz);
  if (hole) return guess(hole, "frequency");

  const band = freqToBand(freqHz);
  if (band === "160M") return guess(freqHz < 1_843_000 ? "CW" : "SSB", "band-plan");
  if (isChannelised(freqHz)) return guess(null, null);
  // The plan now covers VHF and up too (1.230.0), but there one segment permits every mode,
  // so it says nothing about what is being spotted. HF only.
  if (freqHz >= 30_000_000) return guess(null, null);

  const seg = segmentAt(freqHz);
  if (!seg) return guess(null, null);
  return guess(seg.mode === "PHONE" ? "SSB" : "CW", "band-plan");
}
