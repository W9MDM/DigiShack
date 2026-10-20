// The header's view of whether this station can transmit.
//
// Every page polls it, so it is the handful of fields the header shows rather than the
// bridge's whole /status payload (which carries recent decodes, telemetry and memory).
// Shared by the API route that builds it and the client hook that reads it.

export type GateSource = "flex" | "icom" | "wsjtx";

export interface StationGate {
  /** False when no bridge answered — the radio service is not running. */
  running: boolean;
  /** The bridge is attached to its radio. */
  connected: boolean;
  /** FT-0 is engaged: the radio is released and nothing transmits until it is resumed. */
  ft0: boolean;
  /** The selected radio's transmit gate is open (and voice mode is not holding it). */
  armed: boolean;
  /** Why the gate is closed, when it is. */
  offReason: string | null;
  /** RF is on the air right now. */
  transmitting: boolean;
  /** Voice mode owns the transmitter. */
  voice: boolean;
  source: GateSource | null;
  /** "FLEX-6400", "IC-7300" — what the radio says it is, when it has said. */
  radioModel: string | null;
  /** RF power as the radio reports it, percent. */
  rfPowerPct: number | null;
}

export const GATE_OFFLINE: StationGate = {
  running: false,
  connected: false,
  ft0: false,
  armed: false,
  offReason: null,
  transmitting: false,
  voice: false,
  source: null,
  radioModel: null,
  rfPowerPct: null,
};

/** Map the bridge's status object (`/status` → `.status`) to the header's view. */
export function toStationGate(status: unknown): StationGate {
  if (!status || typeof status !== "object") return { ...GATE_OFFLINE, running: true };
  const s = status as Record<string, unknown>;
  const radio = s.radio && typeof s.radio === "object" ? (s.radio as Record<string, unknown>) : null;
  const voice = s.voice && typeof s.voice === "object" ? (s.voice as Record<string, unknown>) : null;
  const source = s.source === "flex" || s.source === "icom" || s.source === "wsjtx" ? s.source : null;
  const power = typeof s.rfPower === "number" && Number.isFinite(s.rfPower) ? Math.round(s.rfPower) : null;
  return {
    running: true,
    connected: s.connected === true,
    ft0: s.ft0 === true,
    armed: s.allowTransmit === true,
    offReason: typeof s.transmitOffReason === "string" ? s.transmitOffReason : null,
    transmitting: s.transmitting === true,
    voice: voice?.active === true,
    source,
    radioModel: typeof radio?.model === "string" && radio.model ? radio.model : null,
    rfPowerPct: power,
  };
}

/** The radio's name for a confirmation line: "FLEX-6400", or the source when it has not said. */
export function gateRadioLabel(g: StationGate): string {
  if (g.radioModel) return g.radioModel;
  if (g.source === "icom") return "the Icom";
  if (g.source === "flex" || g.source === "wsjtx") return "the FlexRadio";
  return "the radio";
}
