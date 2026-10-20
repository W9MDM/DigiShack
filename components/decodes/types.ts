// What the bridge sends the Digital page, shared by the page and its panels.

import type { Js8SendState } from "@/components/digital/Js8Panel";

export interface RigStatus {
  /** The RTTY tone pair while listening to RTTY. */
  rtty?: {
    centreHz: number;
    shiftHz: number;
    sideband: "USB" | "LSB";
    markHz: number;
    spaceHz: number;
    reverse?: boolean;
    baud?: number;
  } | null;
  /** The CW pitch and sending speed while on CW. */
  cw?: { pitchHz: number; wpm: number; pitchFromRadio: boolean } | null;
  /** The PSK31 carrier and speed while on PSK31. */
  psk?: { centreHz: number; speed: 31 | 63 | 125 } | null;
  /** The Olivia centre, size and code while on Olivia. */
  olivia?: { centreHz: number; tones: number; bandwidth: number; code?: "olivia" | "contestia" } | null;
  /** The Feld Hell carrier while on Hell. */
  hell?: { centreHz: number } | null;
  /** Where JTTY transmits while on JTTY. */
  jtty?: { txHz: number } | null;
  /** A JS8 message going out, or the last one. */
  js8?: Js8SendState | null;
  js8Speed?: "normal" | "fast" | "turbo" | "slow";
  connected: boolean;
  /** Bridge→radio liveness: epoch ms of the last heartbeat from the radio, or null. */
  lastHeartbeat?: number | null;
  /** The last reason the radio failed to connect or dropped. Null while connected. */
  connectionError?: string | null;
  /** Which startup/reconnect attempt the bridge is on. 0 while connected. */
  connectAttempt?: number;
  dialFrequency: number | null;
  band: string | null;
  mode: string | null;
  subMode: string | null;
  deCall: string | null;
  deGrid: string | null;
  transmitting: boolean;
  decoding: boolean;
  txEnabled: boolean;
  /** flex.allowTransmit — the master gate. See services/radio/index.ts. */
  allowTransmit?: boolean;
  /** Why the gate is shut, when it is. */
  transmitOffReason?: string | null;
  rxDF: number | null;
  txDF: number | null;
  rfPower: number | null;
  commandChannel: boolean;
  /** Which radio the bridge is driving, as the radio itself reports it. */
  radio?: { vendor: string; model: string; host: string } | null;
  /** Which source is SELECTED, connected or not. The picker reads this. */
  source?: "flex" | "icom" | "wsjtx";
  /**
   * Network transit to the radio, measured by the bridge. A non-zero `oneWayMs` is what
   * keying and decode windows are already being shifted by. See lib/radio/link-latency.ts.
   */
  link?: { rttMs: number; oneWayMs: number } | null;
  /** The operating schedule's current decision. Null when no schedule is enabled. */
  schedule?: { mode: string; reason: string; suppressed: boolean } | null;
}

export interface DecodeEvent {
  kind: "decode";
  timestamp: string;
  snr: number;
  deltaTime: number;
  freqOffset: number;
  mode: string;
  band: string | null;
  message: string;
  callsign: string | null;
  lowConfidence: boolean;
}

/** What the bridge measured against a time server. See lib/time/clock.ts. */
export interface ClockSync {
  /** Correction in force, milliseconds. Positive means the OS clock is slow. */
  offsetMs: number;
  /** What the last measurement said, applied or not. */
  measuredMs: number | null;
  delayMs: number | null;
  source: string | null;
  at: number | null;
  /** Why a measurement was not applied, when it was not. */
  refused: string | null;
}

export interface Telemetry {
  paTempC: number | null;
  swr: number | null;
  voltsPa: number | null;
  fanRpm: number | null;
  reflectedDbm: number | null;
  at: number;
}

export interface AutoState {
  mode: "off" | "cq" | "hunt" | "hunt-pota" | "pota-chase";
  cqParity: 0 | 1 | null;
  cqOffsetHz: number | null;
  warmup: number;
  pausedReason: string | null;
  lastAction: string | null;
  /** Stations that called us mid-QSO, oldest first — the call-back queue. */
  waiting?: string[];
}

export interface QsoState {
  active: boolean;
  theirCall: string | null;
  state: string | null;
  lastSent: string | null;
  /** The whole exchange so far, both directions. */
  transcript?: {
    at: number;
    dir: "tx" | "rx";
    message: string;
    snr?: number | null;
    offsetHz?: number | null;
    refused?: string | null;
  }[];
  txParity: 0 | 1 | null;
  txOffsetHz: number | null;
  pausedReason: string | null;
}

export interface SMeterReading {
  dbm: number;
  fwdDbm: number | null;
  at: number;
}
