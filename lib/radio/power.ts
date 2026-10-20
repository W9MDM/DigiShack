// What the radio actually put out, in watts.
//
// NOT the power slider. The slider is a request — a percentage of the radio's rated
// output that the operator asked for — and it says nothing about what left the
// antenna socket. An ATU mid-tune, a hot PA backing itself off, a rig that never
// reached the setting: all of them read 100 % on the slider. The FlexRadio has a
// real forward-power meter (`src=TX-`, `nam=FWDPWR`) and that is what this reads.
//
// The meter reports dBm. The conversion is the standard one, and the codebase
// already carried a live verification of the scaling: FWDPWR raw 6342 = 49.5 dBm,
// which this makes 89 W — the figure observed at the time. See lib/flex/dax.ts.

/** dBm to watts. 30 dBm = 1 W, 50 dBm = 100 W. */
export function dbmToWatts(dbm: number): number {
  return 10 ** ((dbm - 30) / 10);
}

/**
 * Round a wattage the way an operator writes it on a QSL.
 *
 * Whole watts above 10, one decimal below — a QRP contact at 2.5 W rounded to 3
 * loses the entire point of the contact, while "87.3 W" on a card is false
 * precision about a meter that is not calibrated to a tenth.
 */
export function roundWatts(w: number): number {
  return w >= 10 ? Math.round(w) : Math.round(w * 10) / 10;
}

/**
 * Anything above this is a misread, not a transmitter.
 *
 * The meter is a raw int16 scaled by 128, so a corrupt or misidentified packet can
 * decode to an enormous dBm. A legal amateur station runs 1.5 kW at the very most;
 * treating 10 kW as real would put a fabricated number on a QSL card and, worse,
 * one that suggests an illegal station.
 */
const MAX_PLAUSIBLE_WATTS = 2_000;

/**
 * Below this a reading is a transmitter that is off, not one that is on.
 *
 * The FlexRadio FWDPWR meter does not go quiet on receive: it keeps reporting, at 0.0 dBm
 * (1 mW) - measured on the K9XYZ FLEX-6400, alongside 49.1 dBm (81 W) while keyed. So "any
 * reading at all" would be satisfied by silence. 0.05 W is 17 dBm, well clear of that floor
 * and well under any real QRP station.
 */
const RF_FLOOR_W = 0.05;

/**
 * Follows forward power across one contact.
 *
 * PEAK rather than mean, because FT8 and FT4 are constant-envelope: the transmitter
 * sits at full output for the whole 12.6 s of a transmission, and the only reason a
 * sample reads low is that it caught the key-up or key-down ramp. Averaging those in
 * would under-report every contact by a few watts. The peak of a flat-topped signal
 * IS its steady-state output.
 *
 * Samples are only offered while the radio is actually transmitting — the source
 * emits `fwdDbm: null` on receive precisely so a stale reading cannot be mistaken
 * for a live one.
 */
export class TxPowerTracker {
  private peak: number | null = null;

  /** Feed one meter reading. Nulls (i.e. not transmitting) are ignored. */
  sample(fwdDbm: number | null | undefined): void {
    if (fwdDbm === null || fwdDbm === undefined || !Number.isFinite(fwdDbm)) return;
    const w = dbmToWatts(fwdDbm);
    // A transmitter that is off reads a very low dBm rather than nothing, so a
    // floor is needed as well as a ceiling: without it, the ramp at the end of a
    // transmission would register as a 0.01 W contact.
    if (w <= RF_FLOOR_W || w > MAX_PLAUSIBLE_WATTS) return;
    if (this.peak === null || w > this.peak) this.peak = w;
  }

  /** The contact's transmit power, rounded, or null if nothing was ever measured. */
  watts(): number | null {
    return this.peak === null ? null : roundWatts(this.peak);
  }

  /** Start a new contact. */
  reset(): void {
    this.peak = null;
  }
}

/** Shorter than this, a keying is a blip or an ATU relay click and is not judged. */
const MIN_JUDGED_MS = 2_000;
/**
 * How long before the radio reports the key a Tune or ATU request may have been sent and
 * still be what keyed it. The request goes out first and the interlock status comes back
 * after it, so the note always precedes the key by about one command round trip.
 */
const CARRIER_LEAD_MS = 2_000;

/** The text every no-power alarm carries, so a later verdict can find and replace it. */
export const NO_POWER_TAG = "NO POWER OUT";
/** The text the quieter "could not tell" note carries, for the same reason. */
export const UNMETERED_TAG = "power out was not measured";

/** What one keyed span says about whether anything came out. */
export type NoPowerVerdict =
  /** Forward power was seen. Proof the transmit chain works, whatever came before. */
  | { kind: "powered"; heldMs: number; carrier: boolean }
  /** Too short to have been metered fairly. */
  | { kind: "short"; heldMs: number; carrier: boolean }
  /** The meter never reported while keyed, so nothing can be said either way. */
  | { kind: "unmetered"; heldMs: number; carrier: boolean }
  /** The meter reported throughout and every reading was a transmitter that is off. */
  | { kind: "no-power"; heldMs: number; carrier: boolean; readings: number };

/**
 * Keyed, and did anything come out?
 *
 * Fed by the radio's own transmit transitions and its forward-power meter, which are the
 * two things that cannot go stale or be misconfigured. Both radios' meter handlers and the
 * Flex transmit handler live in different places, which is why this is an object rather
 * than a flag set from three closures.
 *
 * "NO READING" IS NOT "NO POWER". A meter that never reported while keyed - no FWDPWR id
 * found in `meter list`, or a meter stream that stopped with the DAX stream - used to be
 * judged exactly as a meter reading zero, so a station with no meter at all would have
 * raised the alarm on every transmission. It is now `unmetered`: not an alarm that says the
 * transmitter is broken, but not silence either. On 2026-10-20 at 11:49 the radio's whole
 * UDP feed stopped (receive audio, panadapter and meters together) while the hunt kept
 * transmitting, and "we are keying blind" is still something the operator should see.
 *
 * A Tune carrier or an ATU cycle is judged like anything else that keys the radio - one
 * that makes power is fine, one that makes none is as much a fault as an FT8 transmission
 * that makes none - but it is marked, so the alarm can name the right suspects. DAX audio
 * plays no part in a tune carrier.
 */
export class NoPowerWatch {
  private keyedAt: number | null = null;
  private readings = 0;
  private powered = false;
  private carrierAt: number | null = null;

  /** The radio reports it is transmitting. */
  keyed(at: number): void {
    this.keyedAt = at;
    this.readings = 0;
    this.powered = false;
  }

  /** DigiShack asked for a tune carrier or an ATU cycle, which is about to key the radio. */
  carrier(at: number): void {
    this.carrierAt = at;
  }

  /** One forward-power reading in dBm. Ignored unless keyed; null means no fresh reading. */
  sample(fwdDbm: number | null | undefined): void {
    if (this.keyedAt === null) return;
    if (fwdDbm === null || fwdDbm === undefined || !Number.isFinite(fwdDbm)) return;
    const w = dbmToWatts(fwdDbm);
    // A corrupt packet is not a reading of anything, high or low.
    if (w > MAX_PLAUSIBLE_WATTS) return;
    this.readings++;
    if (w > RF_FLOOR_W) this.powered = true;
  }

  /** The radio reports it has stopped. Null when no key was seen to judge against. */
  unkeyed(at: number): NoPowerVerdict | null {
    if (this.keyedAt === null) return null;
    const heldMs = at - this.keyedAt;
    const carrier =
      this.carrierAt !== null && this.carrierAt >= this.keyedAt - CARRIER_LEAD_MS && this.carrierAt <= at;
    this.keyedAt = null;
    if (carrier) this.carrierAt = null;
    if (this.powered) return { kind: "powered", heldMs, carrier };
    if (heldMs <= MIN_JUDGED_MS) return { kind: "short", heldMs, carrier };
    if (this.readings === 0) return { kind: "unmetered", heldMs, carrier };
    return { kind: "no-power", heldMs, carrier, readings: this.readings };
  }
}

/**
 * The transmit warnings after a verdict. `line` is the warning for this verdict: the alarm
 * for `no-power`, the note for `unmetered`, ignored otherwise.
 *
 * A no-power alarm replaces any earlier one. A transmission that DID make power clears it:
 * before this nothing ever did, so one bad stretch left "NO POWER OUT" on the Rig page for
 * as long as the bridge ran - on 2026-10-20 the station was back on the air at 15:45:45,
 * PSKReporter spots and all, and the alarm from 15:45:38 was still showing at the 15:59
 * restart. An unmeasured transmission adds its quieter note, but never replaces or clears
 * a real alarm: it proves nothing either way. Anything else leaves the list as it was, and
 * returns the same array so the caller can tell nothing changed.
 */
export function applyNoPowerVerdict(
  warnings: string[],
  verdict: NoPowerVerdict | null,
  line: string,
): string[] {
  if (!verdict) return warnings;
  const ours = (w: string) => w.includes(NO_POWER_TAG) || w.includes(UNMETERED_TAG);
  const others = () => warnings.filter((w) => !ours(w));
  if (verdict.kind === "no-power") return [line, ...others()];
  if (verdict.kind === "unmetered" && !warnings.some((w) => w.includes(NO_POWER_TAG))) {
    return [line, ...others()];
  }
  if (verdict.kind === "powered" && warnings.some(ours)) return others();
  return warnings;
}
