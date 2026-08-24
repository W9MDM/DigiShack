// What each radio actually has, so the UI can ask instead of assuming.
//
// This is the "capability profile per radio" the roadmap argues for, built at the
// size the evidence justifies rather than as a framework. Every field here exists
// because a control on /rig was lying about one of the radios:
//
//   * The band buttons were `BANDS.filter(b => b.hf)`, and `hf` is a propagation
//     property, not a tuning range — it is true for 2190M, 630M and 560M. So the
//     panel offered 137 kHz. Meanwhile the FT8 row offered 2M, 70CM and 23CM to a
//     FLEX-6400 that stops at 54 MHz. Neither list ever asked the radio.
//   * The AGC picker offered off / slow / med / fast on both radios. These Icoms have
//     no AGC-OFF in this command set at all — `lib/icom/civ.ts` refuses it BY NAME
//     rather than quietly mapping it to fast, and the panel then offered the operator
//     a setting guaranteed to be refused.
//   * The filter-width buttons send `filterLo`/`filterHi` in Hz. The Icom selects
//     FIL1/2/3, whose widths live in the radio's menu, so there is no honest mapping
//     and the endpoint refuses them — four buttons that could only ever produce an
//     error toast.
//
// The rule this file follows: a capability is listed when it changes what the UI
// should OFFER. Anything the UI would treat identically either way does not belong
// here, or this becomes the one-shape-for-both-radios problem in a new place.

import { BANDS, type Band } from "@/lib/ham/bands";

export type RadioSourceName = "flex" | "icom" | "wsjtx" | null;

export interface RadioCapabilities {
  /** What to call it in a sentence. */
  label: string;
  /**
   * Receiver tuning range.
   *
   * Bands are filtered by overlap with this rather than by a hand-kept list, so a
   * third radio needs two numbers and not a new table to maintain.
   */
  tuneLowHz: number;
  tuneHighHz: number;
  /** AGC settings this radio's command set actually has. Empty when unknown. */
  agc: readonly string[];
  /** Whether filter edges can be set in Hz. */
  filterEdgesHz: boolean;
  /** Shown to the operator when `filterEdgesHz` is false. */
  filterNote: string | null;
  /** Whether an RF panadapter is available from this radio today. */
  panadapter: boolean;
  /** Shown when `panadapter` is false, so "missing" and "not built yet" differ. */
  panadapterNote: string | null;
}

/**
 * The unknown radio.
 *
 * An external decoder over the WSJT-X protocol is not a radio we control, so nothing
 * is claimed. Offering everything would be worse than offering nothing: a control
 * that silently does nothing is the failure mode this whole file exists to remove.
 */
const UNKNOWN: RadioCapabilities = {
  label: "the radio",
  tuneLowHz: 0,
  tuneHighHz: Number.POSITIVE_INFINITY,
  agc: [],
  filterEdgesHz: false,
  filterNote: "DigiShack is reading an external decoder, so it does not control the radio.",
  panadapter: false,
  panadapterNote:
    "An external decoder gives DigiShack no access to the radio's spectrum.",
};

const FLEX: RadioCapabilities = {
  label: "the FlexRadio",
  // FLEX-6000 series: 30 kHz to 54 MHz.
  tuneLowHz: 30_000,
  tuneHighHz: 54_000_000,
  agc: ["off", "slow", "med", "fast"],
  filterEdgesHz: true,
  filterNote: null,
  panadapter: true,
  panadapterNote: null,
};

const ICOM: RadioCapabilities = {
  label: "the Icom",
  // IC-7300: receives 30 kHz to 74.8 MHz.
  tuneLowHz: 30_000,
  tuneHighHz: 74_800_000,
  // No AGC-OFF in this command set. See setAgc in lib/icom/civ.ts.
  agc: ["slow", "mid", "fast"],
  filterEdgesHz: false,
  filterNote:
    "This radio selects FIL1/2/3, whose widths live in its own menu — there is no honest mapping from a passband in Hz, so DigiShack will not guess one.",
  // The scope exists and the commands are written, but what it costs the CI-V stream
  // it shares with the frequency poll and the meters has not been measured yet. See
  // docs/panadapter.md.
  panadapter: false,
  panadapterNote:
    "The IC-7300's scope is not enabled yet: what it costs the CI-V stream it shares with the frequency poll and the meters has not been measured.",
};

export function radioCapabilities(source: RadioSourceName): RadioCapabilities {
  if (source === "flex") return FLEX;
  if (source === "icom") return ICOM;
  return UNKNOWN;
}

/**
 * The bands this radio can actually reach.
 *
 * Overlap, not containment: 60 m is a set of channels inside a wider ADIF band and a
 * radio that reaches part of a band can be tuned into it.
 */
export function bandsFor(caps: RadioCapabilities): Band[] {
  return BANDS.filter((b) => b.highHz >= caps.tuneLowHz && b.lowHz <= caps.tuneHighHz);
}

/** Whether a dial frequency is one this radio can reach at all. */
export function canTune(caps: RadioCapabilities, hz: number): boolean {
  return hz >= caps.tuneLowHz && hz <= caps.tuneHighHz;
}
