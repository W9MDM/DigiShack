// What "mode" means on a radio, and what it should be for a given frequency.
//
// Two words are doing one job in this codebase and it has already cost real bugs. The
// MODULATION is what the radio does with the audio — USB, LSB, CW, AM, FM. The DIGITAL MODE
// is which protocol the decoder is running — FT8, FT4, FT2. `status.mode` has historically
// held whichever of the two the source felt like reporting: the slice's modulation on a
// FlexRadio and the digital mode on an Icom. So the rig page's modulation picker showed
// "FT8", which is in no list of modulations and could not be selected back; and voice mode
// recorded "FT8" as the modulation to restore.
//
// Nothing here fixes the naming. What it does is give one place to ask the two questions
// that actually get asked: how do I set this modulation on this radio, and which modulation
// should I be in on this frequency.

import { DIGITAL_FREQUENCIES } from "@/lib/ham/digital-freqs";

/** Modulations the UI offers, and the only strings this module accepts. */
export const MODULATIONS = [
  "USB",
  "LSB",
  "USB-D",
  "LSB-D",
  "CW",
  "AM",
  "FM",
  "RTTY",
] as const;

export type Modulation = (typeof MODULATIONS)[number];

/**
 * A modulation as the Icom's CI-V wants it: a base mode plus the data flag.
 *
 * The data flag is not cosmetic. With it on, modulation comes from the network or USB codec
 * and the microphone is ignored; with it off, the opposite. Getting it wrong produces a radio
 * that keys and transmits silence, which is this project's most expensive recurring fault.
 */
export function toCivMode(m: string): { mode: "USB" | "LSB" | "CW" | "AM" | "FM" | "RTTY"; data: boolean } | null {
  const u = m.trim().toUpperCase();
  switch (u) {
    // SmartSDR's names for the data modes, accepted so one picker drives both radios.
    case "DIGU":
    case "USB-D":
    case "PKTUSB":
      return { mode: "USB", data: true };
    case "DIGL":
    case "LSB-D":
    case "PKTLSB":
      return { mode: "LSB", data: true };
    case "USB":
      return { mode: "USB", data: false };
    case "LSB":
      return { mode: "LSB", data: false };
    case "CW":
    case "CWU":
    case "CWL":
      return { mode: "CW", data: false };
    case "AM":
      return { mode: "AM", data: false };
    case "FM":
    case "NFM":
      return { mode: "FM", data: false };
    case "RTTY":
    case "DIGITALL":
      return { mode: "RTTY", data: false };
    default:
      return null;
  }
}

/** How a base mode and data flag read back as one name. */
export function fromCivMode(mode: string, data: boolean): string {
  const u = mode.toUpperCase();
  if (!data) return u;
  if (u === "USB") return "USB-D";
  if (u === "LSB") return "LSB-D";
  return u;
}

/**
 * A modulation in SmartSDR's vocabulary.
 *
 * The FlexRadio calls the data modes DIGU and DIGL; the Icom expresses the same thing as a
 * sideband plus a data flag, which this project writes as USB-D and LSB-D. One picker drives
 * both radios, so it uses one vocabulary and translates at the edges.
 *
 * Sending `USB-D` to a FlexRadio does nothing at all — worse, the endpoint's own validation
 * rejected it before the radio ever saw it, because the pattern allowed only letters. So the
 * modulation picker silently did nothing on the Flex for every data mode.
 */
export function toFlexMode(m: string): string | null {
  const civ = toCivMode(m);
  if (!civ) return null;
  if (civ.data) return civ.mode === "LSB" ? "DIGL" : "DIGU";
  return civ.mode;
}

/**
 * SmartSDR's name for a modulation, as this project writes it.
 *
 * Without this the CAT panel showed `DIGU` — a value in none of its own options, so the
 * picker fell through to its disabled placeholder and looked broken on the FlexRadio while
 * working on the Icom.
 */
export function fromFlexMode(m: string | null): string | null {
  if (!m) return null;
  const u = m.trim().toUpperCase();
  if (u === "DIGU") return "USB-D";
  if (u === "DIGL") return "LSB-D";
  return u;
}

/** True for the modulations where the transmitter takes audio from the data path. */
export function isDataModulation(m: string): boolean {
  const civ = toCivMode(m);
  return civ?.data === true;
}

/**
 * How far from a digital calling frequency still counts as being on it.
 *
 * FT8 occupies roughly 3 kHz above the dial frequency and operators do sit a little off, so
 * this is generous on the high side of the exact watering hole and tight below it.
 */
const DIGITAL_SLOP_HZ = 4_000;

/**
 * Is this frequency a digital watering hole?
 *
 * Asked before an automatic mode is allowed to start. This project transmitted FT8 on
 * 7.200 MHz once — a voice frequency — because a test left the dial there and CQ mode was
 * enabled without anybody checking where the radio was pointing. Nothing refused it: the
 * transmit gate was open, the guards were happy, the band was legal, and FT8 went out in the
 * middle of a phone segment.
 *
 * Returns the calling frequency it matched, so a refusal can name where the operator probably
 * meant to be.
 */
export function digitalCallingFrequency(
  hz: number,
  mode: "FT8" | "FT4" | "FT2" = "FT8",
): number | null {
  if (!Number.isFinite(hz)) return null;
  for (const entry of DIGITAL_FREQUENCIES) {
    if (entry.mode !== mode) continue;
    if (hz >= entry.hz - 500 && hz <= entry.hz + DIGITAL_SLOP_HZ) return entry.hz;
  }
  return null;
}

/** The nearest digital calling frequency for a mode, for a message that suggests one. */
export function nearestDigitalFrequency(
  hz: number,
  mode: "FT8" | "FT4" | "FT2" = "FT8",
): number | null {
  let best: number | null = null;
  let bestGap = Infinity;
  for (const entry of DIGITAL_FREQUENCIES) {
    if (entry.mode !== mode) continue;
    const gap = Math.abs(entry.hz - hz);
    if (gap < bestGap) {
      best = entry.hz;
      bestGap = gap;
    }
  }
  return best;
}

/**
 * The modulation to use on a frequency, when the operator has not said.
 *
 * Three rules, in order:
 *
 *   1. On a digital watering hole, a data mode — tuning to 14.074 and being put in plain USB
 *      is a radio that hears FT8 perfectly and cannot transmit it.
 *   2. Below 10 MHz, lower sideband. Above, upper. A convention rather than a rule, but it is
 *      what every other station on the band is using, and the wrong sideband is not
 *      unconventional — it is inaudible.
 *   3. Nothing at all for a frequency outside any amateur band, so a mistyped number does not
 *      also change the mode.
 */
export function modulationForFrequency(hz: number, mode: "FT8" | "FT4" | "FT2" = "FT8"): Modulation | null {
  if (!Number.isFinite(hz) || hz < 1_000_000 || hz > 1_300_000_000) return null;

  // Every digital calling frequency for this mode, whatever band or region. A watering hole
  // is a watering hole even if the operator is outside the region it was listed for.
  //
  // Always USB-D. The below-10-MHz-LSB rule a few lines down is a VOICE convention and it
  // does not apply to data: FT8 is upper sideband on every band, 160 m included. Applying
  // the voice rule here put the radio in DIGL when voice mode was switched off on 40 m —
  // spectrally inverted audio, so the waterfall still showed signals while the decoder
  // produced nothing, on every band until someone noticed the mode.
  for (const entry of DIGITAL_FREQUENCIES) {
    if (entry.mode !== mode) continue;
    if (hz >= entry.hz - 500 && hz <= entry.hz + DIGITAL_SLOP_HZ) {
      return "USB-D";
    }
  }

  return hz < 10_000_000 ? "LSB" : "USB";
}
