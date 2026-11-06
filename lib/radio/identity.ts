import type { FlexRadioInfo } from "@/lib/flex/discovery";

/**
 * The radio this bridge process drives. Every install today has one bridge, radio "main";
 * extra radios will run as their own processes with their own ids. Reported in /status and
 * checked against X-Radio-Id so a request for one radio can never act on another.
 */
export const BRIDGE_RADIO_ID = "main";

// Which physical radio a bridge is about to drive.
//
// THE FAULT. With no flex.host set, startFlexSource took `found[0]` - whichever FlexRadio
// answered the discovery broadcast first. On a LAN with one Flex that is the right one. With
// two (a second operator's radio, a club station on the same network, a radio added for a
// second DigiShack) it was a coin toss on every restart, and the loser of the toss was a
// transmitter keyed under a callsign that does not belong to it. Now: pinned by serial, or
// exactly one answer, or a refusal that names what was found.

export type FlexPick = { ok: true; radio: FlexRadioInfo } | { ok: false; error: string };

function describe(r: FlexRadioInfo): string {
  return `${r.model}${r.nickname ? ` "${r.nickname}"` : ""} serial ${r.serial ?? "?"} at ${r.ip || r.address}`;
}

/**
 * Choose the discovered Flex to connect to.
 *
 * `serial` (the flex.serial setting) pins one radio and wins outright; a pinned serial that
 * did not answer is an error, never a fallback to some other radio. Unpinned, exactly one
 * answer is used and more than one is refused.
 */
export function pickDiscoveredFlex(found: FlexRadioInfo[], serial: string | null | undefined): FlexPick {
  const want = (serial ?? "").trim().toUpperCase();
  if (want) {
    const hit = found.find((r) => (r.serial ?? "").trim().toUpperCase() === want);
    if (hit) return { ok: true, radio: hit };
    return {
      ok: false,
      error:
        `The FlexRadio with serial ${want} did not answer discovery` +
        (found.length ? `; found instead: ${found.map(describe).join("; ")}.` : ", and no other radio did either.") +
        " Check it is on, or correct flex.serial.",
    };
  }
  if (found.length === 0) return { ok: false, error: "No FlexRadio answered discovery and flex.host is not set." };
  if (found.length > 1) {
    return {
      ok: false,
      error:
        `${found.length} FlexRadios answered discovery: ${found.map(describe).join("; ")}. ` +
        "Refusing to guess which to transmit with - set flex.host or flex.serial to the one this install drives.",
    };
  }
  return { ok: true, radio: found[0]! };
}
