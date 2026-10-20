import type { ReceiverControls } from "@/lib/radio/receiver-controls";

// The slice of the bridge's /status payload the Rig page reads. Declared here rather than
// imported from services/radio, which is server code the page bundle must not pull in.

export interface Telemetry {
  paTempC: number | null;
  swr: number | null;
  voltsPa: number | null;
  fanRpm: number | null;
  reflectedDbm: number | null;
  at: number;
}

export interface VoiceState {
  active: boolean;
  mode: string | null;
  since: number | null;
}

export interface RigStatus {
  connected: boolean;
  /** Why the last connection attempt failed or dropped. Null while connected. */
  connectionError?: string | null;
  dialFrequency: number | null;
  band: string | null;
  /** The digital mode on the Icom path, the slice's modulation on the FlexRadio. */
  mode: string | null;
  /** The digital mode the FlexRadio path is decoding. Null on the Icom. */
  subMode?: string | null;
  deCall: string | null;
  deGrid: string | null;
  transmitting: boolean;
  rfPower: number | null;
  commandChannel: boolean;
  /**
   * Conditions the radio reports that make transmitting impossible or wrong.
   *
   * Computed by the bridge since the transmit path was written and displayed nowhere until
   * an evening was lost to "DAX is not selected as the transmit source": the station keyed
   * for hours at 0.0 W and the only place either fact appeared was a server log.
   */
  txBlockers?: string[];
  txWarnings?: string[];
  /** The master transmit gate, and why it is shut. The radio service is the authority. */
  allowTransmit?: boolean;
  transmitOffReason?: string | null;
  /** Which radio the bridge is driving. */
  source: "flex" | "icom" | "wsjtx" | null;
  /** What answered on the wire: "FLEX-6400", "IC-7300MK2". Null on the external decoder. */
  radio?: { vendor: string; model: string; host: string } | null;
  /** The radio's MODULATION — USB, LSB-D, CW. See `mode` for why this is separate. */
  radioMode: string | null;
  /** AGC / NB / NR / filter as the RADIO reports them. Null means not read yet, not "off". */
  receiver?: ReceiverControls;
  voice?: VoiceState;
}

/**
 * Where a failed command's message is shown: beside the control that sent it.
 *
 * One banner at the top of the page was out of sight for everything below the spectrum,
 * so a refused filter change looked like a button that did nothing.
 */
export type RigArea = "top" | "dial" | "tune" | "receiver" | "transmitter";

/** Posts `{ action: "rig", ...body }`, reports a refusal in `area`, resolves true if it took. */
export type RigSend = (
  body: Record<string, unknown>,
  label: string,
  area: RigArea,
) => Promise<boolean>;
