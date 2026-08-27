import type { AntennaPorts } from "@/lib/radio/receiver-controls";

// Which antenna port the radio is using, on a radio that has more than one.
//
// Every FLEX-6000 has at least ANT1 and ANT2, and the bigger ones add receive-only
// BNCs (RX_A, RX_B) and a transverter port. DigiShack hardcoded `ant=ANT1` in the two
// places it creates a slice — lib/flex/dax.ts and lib/flex/tx.ts — and never read the
// antenna back, so an operator whose HF wire is on ANT2 got a bridge that listened to
// a bare socket and, worse, would have transmitted into one.
//
// THE RADIO REPORTS ITS OWN PORTS, so nothing here is a table to maintain. Measured on
// a FLEX-6400, from logs/bridge-out.log on 3 August 2026:
//
//   slice 0 txant=ANT1 rxant=ANT1 loopa=0 loopb=0
//           ant_list=ANT1,ANT2,RX_A,XVTA tx_ant_list=ANT1,ANT2,XVTA
//
// Two lists, not one, and the difference is the point: RX_A is a receive-only BNC and
// appears in `ant_list` but not in `tx_ant_list`. A single list would have let the UI
// offer a transmit port that cannot transmit. Note also that the radio's spelling is
// XVTA, not the XVTR the SmartSDR documentation uses — one more reason to take the
// names from the radio rather than from a constant.
//
// The panadapter carries its OWN antenna, on the same measured evidence:
//
//   display pan 0x40000000 rxant=ANT1 ant_list=ANT1,ANT2,RX_A,XVTA wide=1
//
// which is why lib/flex/panadapter.ts has to be told the antenna too. A slice moved to
// ANT2 with the panadapter left on ANT1 draws a confident spectrum of a different
// antenna, and nothing about the display says so.
//
// WHAT IS MEASURED HERE AND WHAT IS NOT. The lists, the field names and the spellings are
// all read off a real radio, and the refusals below were exercised against the live bridge
// (see the 1.119.1 changelog entry). The WRITE side — `slice set <n> rxant=… txant=…` and
// `display pan set … rxant=` — has not been run on hardware: the only opportunity to test
// it was on a station with transmit armed and the auto operator hunting, where the test
// itself risked keying into an unconnected socket. The commands are the radio's own
// vocabulary, taken from status lines it sent us; that it accepts them is inference.

/** No ports reported. The honest starting point, and what a single-port radio leaves. */
export const NO_ANTENNA_PORTS: AntennaPorts = { rx: [], tx: [] };

/**
 * Antenna lists off a `slice` or `display pan` status line.
 *
 * Merged with what is already known rather than replacing it: a status line carries
 * only the fields that changed, and the vast majority of slice statuses mention no
 * antenna at all. Replacing would blank the list on the next `mode=` update, and a UI
 * that draws its antenna picker from a list would flicker empty for every filter change.
 */
export function mergeAntennaPorts(
  fields: Record<string, string>,
  existing: AntennaPorts = NO_ANTENNA_PORTS,
): AntennaPorts {
  const rx = fields.ant_list !== undefined ? splitList(fields.ant_list) : existing.rx;
  // `tx_ant_list` is what the radio says can transmit. When it is absent — an older
  // SmartSDR, or a status line that carried only the RX list — the transmit list is
  // derived by dropping the receive-only ports, which are named RX_* by the hardware
  // (the 6600's RX A and RX B BNCs). Derived, and said so: it is the one inference in
  // this file, and it is only ever a fallback for a list the radio normally supplies.
  const tx =
    fields.tx_ant_list !== undefined
      ? splitList(fields.tx_ant_list)
      : fields.ant_list !== undefined
        ? rx.filter((a) => !/^RX[_-]?/i.test(a))
        : existing.tx;
  return { rx, tx };
}

function splitList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Does this radio have a choice to offer at all? */
export function hasAntennaChoice(ports: AntennaPorts): boolean {
  return ports.rx.length > 1 || ports.tx.length > 1;
}

export interface AntennaChoice {
  /**
   * The port to send to the radio, in the radio's own spelling. Null means send
   * nothing — either nothing was asked for, or what was asked for does not exist.
   */
  ant: string | null;
  /** Why nothing is being sent, when something was asked for. Null when all is well. */
  refused: string | null;
}

/**
 * Turn what the operator configured into a port name this radio will accept.
 *
 * Matched loosely on purpose. The setting is a free-text field — the settings registry
 * has no enum type — so `ant2`, `ANT 2`, `ant-2` and a bare `2` all have to reach the
 * same port, or the feature works only for operators who guess the radio's exact
 * spelling. The RADIO'S spelling is what comes back out, so the command sent is always in
 * the vocabulary the radio answered in.
 *
 * Loosely, but not by GUESSING AT SYNONYMS. The measured radio calls its transverter port
 * XVTA where the SmartSDR documentation says XVTR, and it would be easy to map one to the
 * other — that mapping is not made, because it is an assumption about hardware naming
 * across models nobody here has seen, and the refusal it replaces is a good one: "XVTR is
 * not a receive port on this radio. It has ANT1, ANT2, RX_A, XVTA" tells the operator
 * exactly what to type. Guessing would be right until the first radio that reports both.
 *
 * An unknown port is REFUSED rather than silently falling back to ANT1. Falling back is
 * how this whole class of fault starts: the operator sets an antenna, the radio uses a
 * different one, and nothing anywhere says so. The refusal names what the radio does
 * have, because "ANT3 is not a port on this radio" is only half an answer.
 *
 * An empty `available` means the radio has not reported its list yet, and there the
 * request is passed through unvalidated — uppercased and nothing else. Refusing because
 * we could not check would leave DigiShack using ANT1 against an explicit instruction
 * not to, which is the exact bug being fixed.
 */
export function resolveAntenna(
  requested: string | null | undefined,
  available: readonly string[],
  role: "receive" | "transmit" = "receive",
): AntennaChoice {
  const want = (requested ?? "").trim();
  if (!want) return { ant: null, refused: null };

  if (available.length === 0) return { ant: want.toUpperCase(), refused: null };

  const key = antennaKey(want);
  const hit = available.find((a) => antennaKey(a) === key);
  if (hit) return { ant: hit, refused: null };

  return {
    ant: null,
    refused:
      `"${want}" is not a ${role} port on this radio. It has ${available.join(", ")}.` +
      // The one case where "not a port" would be a lie: RX_A and RX_B are ports, they
      // simply cannot transmit, and an operator who put a receive antenna in the
      // transmit setting needs to be told which of the two mistakes they made.
      (role === "transmit" && /^RX[_-]?/i.test(want)
        ? " That one is a receive-only socket — put it in the receive antenna setting instead."
        : ""),
  };
}

/**
 * Comparison form: case, spaces, underscores and hyphens all discarded, and a bare
 * number read as an ANT socket.
 *
 * `2` becoming `ANT2` rather than staying `2` is deliberate: an operator writing the
 * number of the socket on the back of the radio means the socket, and RX_A and XVTA are
 * not numbered so there is nothing for it to collide with.
 */
function antennaKey(name: string): string {
  const bare = name.trim().toUpperCase().replace(/[\s_-]/g, "");
  return /^\d+$/.test(bare) ? `ANT${bare}` : bare;
}
