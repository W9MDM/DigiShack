// The DigiShack bridge — the process that owns the radio.
//
// Called the "omega bridge" until 1.5.0, after wsjtx-omega, which is one program it can
// take decodes FROM and has nothing to do with the two radios it drives itself. The
// settings are `bridge.*` now, and the external-decoder ones `wsjtx.*`.
//
//   npm run radio           (tsx services/radio/index.ts)
//   pm2 start ecosystem.config.js   (enable the digishack-bridge app)
//
// Runs as its OWN process, not inside Next.js, for a concrete reason: it binds a
// UDP socket, and a bound UDP socket cannot be shared across cluster workers.
// Keeping it separate is what lets the web tier scale.
//
// Responsibilities:
//   * listen for an external decoder's UDP broadcasts, in the WSJT-X protocol
//     (Heartbeat / Status / Decode / QSOLogged)
//   * persist Decode rows to DigitalDecode
//   * auto-log QSOLogged to Qso, when enabled
//   * broadcast everything to browsers over WebSocket
//   * expose a token-guarded control API so the web app can send Reply / HaltTx /
//     HighlightCallsign back to the decoder

import { randomBytes } from "node:crypto";
import dgram from "node:dgram";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

import { WebSocketServer, type WebSocket } from "ws";

import { prisma } from "@/lib/db/prisma";
import { pruneDecodes } from "@/lib/db/retention";
import { type OperatingGuards, parseMessage } from "@/lib/digital/qso";
import { FlexDaxTransmitter, RF_POWER_WARN_PCT } from "@/lib/flex/tx";
import type { QsoController } from "./qso-controller";
import { buildOperating, callingFrequencyHz } from "./operating";
import { runAutoQsl } from "@/lib/qsl/auto";
import { getLotwCredentials, syncLotwConfirmations } from "@/lib/integrations/lotw";
import type { AutoOperator, AutoMode } from "./auto-operator";
import { isAutoMode } from "@/lib/radio/auto-mode";
import { FlexClient } from "@/lib/flex/client";
import { resolveAntenna } from "@/lib/flex/antennas";
import { LivenessWatchdog, windowTimeoutMs } from "@/lib/radio/watchdog";
import {
  isTransmitArmed,
  setDigitalTransmitHold,
  transmitGate,
  transmitGateKey,
  type RadioKind,
} from "@/lib/radio/transmit-gate";
import type { DigitalTransmitter } from "@/lib/radio/types";
import { icomTarget, startIcomSource } from "@/services/radio/icom-source";
import type { IcomSource } from "@/lib/icom/rig";
import { float32ToS16le } from "@/lib/icom/audio-stream";
import {
  digitalCallingFrequency,
  fromFlexMode,
  modulationForFrequency,
  nearestDigitalFrequency,
  toFlexMode,
} from "@/lib/radio/modes";
import { spectrumMessage } from "@/lib/radio/spectrum";
import { panadapterMessage } from "@/lib/radio/panadapter";
import { AUDIO_STALL_MS } from "@/lib/flex/panadapter";
import {
  conventionalSideband,
  idleVoiceState,
  isVoiceCapableMode,
  VOICE_REFUSAL,
  type VoiceState,
} from "@/lib/radio/voice";
import { DecodeCsvLog } from "@/lib/radio/decode-log";
import { applyMeasurement, clearCorrection, clockState, describe } from "@/lib/time/clock";
import { querySntp } from "@/lib/time/sntp";
import {
  PaDutyTracker,
  parseRange,
  parseSchedule,
  type ScheduleConfig,
} from "@/lib/radio/schedule";
import { startScheduleRunner } from "@/lib/radio/schedule-runner";
import { FlexDaxSource } from "@/lib/flex/dax";
import { discoverRadios } from "@/lib/flex/discovery";
import { freqToBand } from "@/lib/ham/bands";
import { inferDigitalMode, type DigitalMode } from "@/lib/ham/digital-freqs";
import { clearAlert, raiseAlert } from "@/lib/alerts";
import { guardFaultsCleared, watchGuardFaults } from "./guard-alerts";
import { TxPowerTracker } from "@/lib/radio/power";
import { NoiseFloor } from "@/lib/radio/noise";
import { UNREAD_RECEIVER, type ReceiverControls } from "@/lib/radio/receiver-controls";
import { getEqslCredentials, syncEqslInbox } from "@/lib/integrations/eqsl";
import { reconcileLotwSent } from "@/lib/integrations/lotw-reconcile";
import { runUploads } from "@/lib/integrations/upload-runner";
import { collectReceptionReports } from "@/lib/pskreporter/collect";
import { MIN_QUERY_INTERVAL_MS } from "@/lib/pskreporter/retrieve";
import type { PskReporterUploader } from "@/lib/pskreporter/upload";
import {
  getBooleanSetting,
  getNumberSetting,
  getSetting,
  invalidateSettingsCache,
  writeSettings,
} from "@/lib/settings";
import {
  WsjtxType,
  callsignFromMessage,
  decodePacket,
  decodeTimeToDate,
  encodeClear,
  encodeFreeText,
  encodeHaltTx,
  encodeHighlightCallsign,
  encodeReplay,
  encodeReply,
  type DecodeMsg,
  type QSOLoggedMsg,
  type StatusMsg,
} from "@/lib/wsjtx/protocol";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface RigStatus {
  connected: boolean;
  lastHeartbeat: number | null;
  dialFrequency: number | null;
  band: string | null;
  mode: string | null;
  subMode: string | null;
  dxCall: string | null;
  deCall: string | null;
  deGrid: string | null;
  transmitting: boolean;
  decoding: boolean;
  /**
   * WSJT-X's own "Enable Tx" flag, from its status datagram.
   *
   * ONLY meaningful on the external-decoder path. Nothing sets it when decoding from
   * a Flex, so it is permanently false there — a UI badge bound to this would read
   * "transmit off" while the station is transmitting. Use `allowTransmit`.
   */
  txEnabled: boolean;
  /**
   * `flex.allowTransmit` — the master gate, and the one an operator needs to see.
   *
   * Off by default, cleared by FT-0, and re-read before every transmission. It
   * appeared nowhere in the UI, so the commonest way to lose an evening was to have
   * it off and get no indication of that anywhere.
   */
  allowTransmit: boolean;
  txMessage: string | null;
  rxDF: number | null;
  txDF: number | null;
  /** RF power, percent, as the radio reports it. Native flex path only. */
  rfPower: number | null;
  /**
   * Whether the radio's TCP command channel is up.
   *
   * Tracked separately from `connected` on purpose: DAX audio is UDP, so decodes
   * keep arriving after the command channel dies. Without this, a session with a
   * dead command channel looks completely healthy right up until something tries
   * to key, tune or change power — which is exactly how it was found.
   */
  commandChannel: boolean;
  /** From preflight() at attach: conditions that make keying wrong. */
  txBlockers: string[];
  /** From preflight(): unusual but not disqualifying. */
  txWarnings: string[];
  /**
   * The radio's MODULATION — USB, LSB-D, CW. Distinct from `mode`, which is the digital mode
   * on the Icom path and the slice's modulation on the FlexRadio: one field meaning two
   * things is why the CAT panel's modulation picker used to display "FT8".
   */
  radioMode: string | null;
  /**
   * AGC, noise blanker and noise reduction as the RADIO reports them.
   *
   * Null means not read yet, which is not the same as off — a panel showing "off" for a radio
   * with the noise blanker on is worse than one showing nothing.
   */
  receiver: ReceiverControls;
  /** Voice mode: digital is closed and the radio is in a microphone mode. */
  voice?: { active: boolean; mode: string | null; since: number | null };
  /**
   * FT-0 engaged: everything stopped, nothing connected, nothing transmitting.
   *
   * Named for the joke mode at ft-0.com — 0 baud, 0 Hz bandwidth, a 100% success
   * rate, and "when all else fails: nothing". The joke is the name; the behaviour
   * is a real kill switch, and it is the one control that should always work.
   */
  ft0: boolean;
  /**
   * Which source is selected, whether or not it has connected.
   *
   * Distinct from `radio` below, which is what a connected radio said it was. The
   * picker needs to show the current choice even when the radio is unreachable, and
   * "no radio answered" and "no radio selected" are different problems.
   */
  source: "flex" | "icom" | "wsjtx";
  /**
   * Which radio this is, as the radio itself reports it.
   *
   * Not the `Rig` table, which is operator-entered inventory that nothing in this
   * path reads. This is what answered on the wire: "FLEX-6400", "IC-7300MK2". Null on
   * the external-decoder path, which never says what it is driving.
   */
  radio: { vendor: string; model: string; host: string } | null;
  /** The decoder's instance id, needed on every outbound message. */
  decoderId: string | null;
  /** Where the decoder's packets came from, so replies go back to it. */
  peer: { address: string; port: number } | null;
  /**
   * Network transit to the radio, when it is measurable and matters.
   *
   * The SNTP clock line answers "is my machine's time right"; this answers "how far
   * away is the radio". Null on the external-decoder path (WSJT-X owns that timing)
   * and before the first measurement. See lib/radio/link-latency.ts.
   */
  link: { rttMs: number; oneWayMs: number } | null;
  /**
   * The operating schedule's current decision, when a schedule is enabled.
   *
   * On the status object because the schedule runs whether or not anyone is
   * watching: a browser opened mid-block gets the picture with its first status
   * message, instead of an Auto operate row that says what mode is running but
   * not who chose it or when it ends. Null when schedule.enabled is off.
   */
  schedule: { mode: AutoMode; reason: string; suppressed: boolean } | null;
}

const status: RigStatus = {
  connected: false,
  lastHeartbeat: null,
  dialFrequency: null,
  band: null,
  mode: null,
  subMode: null,
  dxCall: null,
  deCall: null,
  deGrid: null,
  transmitting: false,
  decoding: false,
  txEnabled: false,
  allowTransmit: false,
  txMessage: null,
  rxDF: null,
  txDF: null,
  rfPower: null,
  commandChannel: false,
  txBlockers: [],
  txWarnings: [],
  radioMode: null,
  receiver: { ...UNREAD_RECEIVER },
  voice: { active: false, mode: null, since: null },
  ft0: false,
  source: "wsjtx",
  radio: null,
  decoderId: null,
  peer: null,
  link: null,
  schedule: null,
};

/**
 * Refresh status.link from whichever radio is measuring.
 *
 * Called lazily wherever status is about to leave the process, rather than on its own
 * timer — the estimate only moves when a probe lands, and a stale-by-one-broadcast
 * number here is a display nicety, not a timing input. The transmitters and decode
 * pipelines read the LinkLatency instances directly.
 */
function refreshLinkStatus(): void {
  const s = flexSource?.link.state() ?? icomSource?.linkState() ?? null;
  status.link = s ? { rttMs: s.rttMs, oneWayMs: s.oneWayMs } : null;
}

/** Recent decodes, newest last. Kept so a browser connecting mid-cycle sees context. */
const recentDecodes: unknown[] = [];
const RECENT_LIMIT = 200;

/**
 * Most recent waterfall row, so a browser that connects between FFT frames gets
 * scale information immediately rather than an unlabelled blank canvas.
 */
let lastSpectrum: unknown = null;
/**
 * The last RF panadapter row, replayed to a page that connects mid-stream.
 *
 * Held separately from `lastSpectrum` rather than sharing one slot: a page showing
 * both would otherwise get whichever arrived last and lose the other entirely.
 */
let lastPanadapter: unknown = null;

const clients = new Set<WebSocket>();

/**
 * Which radio this process is driving, from `digital.source`.
 *
 * The transmit gate is per radio (lib/radio/transmit-gate.ts), so every check in the
 * control API has to ask about THIS one. Reading `flex.allowTransmit` unconditionally is
 * what made the Icom refuse every automatic mode while its own gate was armed.
 *
 * The external-decoder path leaves it at flex, which is what it has always read.
 */
let activeRadio: RadioKind = "flex";

/** Is transmit armed for the radio we are actually driving? */
/**
 * Voice mode. Runtime state, deliberately not a stored setting.
 *
 * A restart must come back as a digital station with automatic operation off, because the
 * radio itself comes back in whatever mode this process last set — and resuming "voice" on
 * a radio nobody has looked at, with a browser that is no longer connected, is a state with
 * nothing good in it.
 */
let voice: VoiceState = idleVoiceState();

/**
 * The digital transmit gate.
 *
 * Voice mode closes it here rather than at each caller, because this one function is what
 * the auto operator, the QSO controller, the tune button and the ATU all consult — so a
 * path added later is covered by construction rather than by remembering.
 */
const transmitArmed = async (): Promise<boolean> => {
  if (voice.active) return false;
  return isTransmitArmed(activeRadio);
};

/** Why transmit is closed, for a message that sends the operator to the right place. */
const transmitRefusal = (): string =>
  voice.active ? VOICE_REFUSAL : `Enable Allow transmit on the ${gateSettingsTab()} tab`;

/** Where an operator turns it on, named so the message can say. */
const gateSettingsTab = (): string => (activeRadio === "icom" ? "Icom (network)" : "FlexRadio");

/**
 * Receiver audio to any browser that asked for it.
 *
 * Set by main() once the socket server exists; the radio sources call it for every audio
 * frame they receive, on both radios, so it must be cheap when nobody is listening.
 */
let sendAudio: (samples: Float32Array) => void = () => {};

/**
 * The sample rate the current source produces.
 *
 * The two radios differ — 48 kHz on the Icom's network stream, 24 kHz off FlexRadio DAX —
 * and this is the number a listener is told once, at connect, rather than a guess baked
 * into the browser.
 */
function audioSampleRate(): number {
  if (status.source === "icom") return 48_000;
  if (status.source === "flex") return 24_000;
  return 0;
}

/** Set when a source attaches its operating layer; the control API reaches it here. */
let activeQso: () => QsoController | null = () => null;

/**
 * How to tear the native source down. Module-level because the supervisor
 * replaces it after each rebuild, and main()'s shutdown path needs the current
 * one, not the one from startup.
 */
let flexTeardown: (() => Promise<void>) | null = null;

/** Slice the native path owns, for rig-control commands. */
let flexSliceIndex: number | null = null;

/**
 * The live Icom source, for the control actions that are CI-V rather than SmartSDR.
 *
 * The Flex equivalents are `flexGuiClient` and `flexRig`. Only /atu uses this so far —
 * /power and /rig are still SmartSDR commands and answer 503 on this path.
 */
let icomSource: IcomSource | null = null;

/**
 * The live FlexRadio source, for the few things that reach past the operating layer.
 *
 * Only the waterfall's profile switch needs it today. Module-level for the same reason
 * `icomSource` is: the control API runs outside the function that built the source.
 */
let flexSource: FlexDaxSource | null = null;

/** Reports our decodes to PSKReporter, when enabled. */
let pskUploader: PskReporterUploader | null = null;

/**
 * Every decode to a CSV per UTC day, when `digital.decodeCsvDir` is set.
 *
 * Separate from the database on purpose. `DigitalDecode` is pruned after thirty days
 * because it is a table the application queries and 42,000 rows a day is 3.7 GB a year;
 * this is the raw feed kept for its own sake, in a format that outlives the schema.
 */
let decodeCsv: DecodeCsvLog | null = null;

/** Latest radio health, included in /status for a fresh page load. */
let lastTelemetry: unknown = null;

/** The active guard set, so telemetry can feed it. */
let activeGuards: OperatingGuards | null = null;
/**
 * The active power tracker, so the meter stream can feed it.
 *
 * Module-level for the same reason `activeGuards` is: the source's meter handler is
 * wired up before the operating layer exists, and both are replaced on every
 * reconnect.
 */
let activeTxPower: TxPowerTracker | null = null;
/**
 * The receive noise floor, per running session.
 *
 * Fed from the same meter stream as transmit power and reset whenever the band
 * changes — a floor measured on 40 m says nothing about 20 m.
 */
const noiseFloor = new NoiseFloor();
/**
 * The live transmitter, so FT-0 can unkey without going through the sequencer.
 *
 * Typed to the narrow interface rather than to either driver: FT-0 wants the radio to
 * stop, and both radios stop the same way.
 */
let activeTx: DigitalTransmitter | null = null;
/**
 * Auto mode to restore after a radio reconnect, and the run it belonged to.
 *
 * A dropped command channel forces auto off — transmitting is impossible with it
 * down — but nothing used to turn it back on, so an outage silently ended the
 * session and the operator found it stopped hours later. These survive the source
 * rebuild so the mode can be resumed.
 *
 * The run start is carried forward deliberately: resetting it on every resume would
 * let a flapping radio extend an unattended session indefinitely, each outage
 * granting a fresh watchdog window.
 */
/** Settings keys backing resume-after-restart. */
const KEY_AUTO_MODE = "auto.resumeMode";
const KEY_AUTO_RUN_STARTED = "auto.runStartedAt";
/**
 * The schedule's last applied answer, so a restart is not a fresh "change".
 *
 * Without this the first tick after every restart re-stamped the block's mode over
 * whatever the operator chose mid-block — and the bridge restarts on its own
 * (deploys, the liveness watchdog), so hunt-pota kept silently reverting to the
 * scheduled hunt. State, not configuration: like the two keys above it is written
 * directly and never appears on the Settings page.
 */
const KEY_SCHED_LAST = "schedule.lastApplied";

/**
 * Write the running mode to the database so a restart can pick it up.
 *
 * The run start goes with it: a resumed session must not get a fresh wall-clock
 * budget, or a crash loop would extend an unattended run indefinitely — exactly the
 * reasoning the reconnect path already uses.
 */
async function persistAutoMode(mode: AutoMode): Promise<void> {
  // Written straight to the table rather than through writeSettings().
  //
  // That helper requires a user id for its audit trail, and this is the bridge
  // recording its own runtime state — there is no user, and inventing one would put
  // a fictional name against a change nobody made. These two keys are deliberately
  // NOT in the settings registry either, so they never appear on the Settings page:
  // they are state, not configuration.
  const put = async (key: string, value: string) => {
    await prisma.setting.upsert({
      where: { key },
      create: { key, value, encrypted: false },
      update: { value },
    });
  };
  try {
    if (mode === "off") {
      await put(KEY_AUTO_MODE, "");
      await put(KEY_AUTO_RUN_STARTED, "");
      invalidateSettingsCache();
      return;
    }
    const existing = await getSetting(KEY_AUTO_RUN_STARTED);
    await put(KEY_AUTO_MODE, mode);
    // Only stamp a new run when there was not one already, so switching between
    // modes mid-session does not reset the wall-clock watchdog.
    if (!existing) await put(KEY_AUTO_RUN_STARTED, new Date().toISOString());
    invalidateSettingsCache();
  } catch (err) {
    console.error(`[radio] could not persist auto mode: ${err instanceof Error ? err.message : err}`);
  }
}

/** Record the schedule's applied answer — same direct write, same reasoning. */
async function persistScheduleApplied(mode: AutoMode): Promise<void> {
  try {
    await prisma.setting.upsert({
      where: { key: KEY_SCHED_LAST },
      create: { key: KEY_SCHED_LAST, value: mode, encrypted: false },
      update: { value: mode },
    });
    invalidateSettingsCache();
  } catch (err) {
    console.error(
      `[radio] could not persist schedule state: ${err instanceof Error ? err.message : err}`,
    );
  }
}

let autoResumeMode: AutoMode | null = null;
let autoRunStartedAt: number | null = null;
let autoQsosThisRun = 0;

/**
 * Put the running automatic mode aside while the radio is rebuilt.
 *
 * Transmitting is impossible with the radio gone, so a mode left running would spend the
 * outage failing. The run it belonged to is carried with it: resetting the wall clock on
 * every reconnect would let a flapping radio extend an unattended session indefinitely,
 * each outage granting a fresh watchdog window.
 */
function holdAutoMode(): void {
  const auto = activeAuto();
  if (!auto || auto.state.mode === "off") return;
  autoResumeMode = auto.state.mode;
  const rs = activeGuards?.runState;
  autoRunStartedAt = rs?.minutes != null ? Date.now() - rs.minutes * 60_000 : Date.now();
  autoQsosThisRun = rs?.qsos ?? 0;
  console.log(`[radio] auto mode "${autoResumeMode}" held for resume after reconnect`);
  auto.setMode("off");
}

/**
 * Put it back, if the operator still allows transmitting.
 *
 * The gate is re-read rather than trusted from before the outage: somebody may well have
 * turned it off while the radio was down, and that decision must win.
 *
 * Written once and used by both radios' supervisors. It was inline in the FlexRadio's
 * and would otherwise have been copied verbatim into the Icom's, which is how two
 * resume paths drift apart and only one of them gets the next fix.
 */
async function resumeHeldAutoMode(): Promise<void> {
  const resume = autoResumeMode;
  if (!resume || resume === "off") return;
  autoResumeMode = null;

  if (!(await transmitArmed())) {
    console.log(`[radio] not resuming auto "${resume}": ${transmitGateKey(activeRadio)} is off`);
    return;
  }
  const a = activeAuto();
  if (!a) return;
  a.setMode(resume);
  // Carry the original run forward so the wall-clock watchdog still bounds the whole
  // session across the outage.
  activeGuards?.beginRun(autoRunStartedAt ?? undefined, autoQsosThisRun);
  console.log(
    `[radio] resumed auto "${resume}" (run continues from ${
      autoRunStartedAt ? new Date(autoRunStartedAt).toISOString() : "now"
    }, ${autoQsosThisRun} QSOs so far)`,
  );
}

/** The flex rig-control connection, for settings like RF power. */
let flexRig: FlexClient | null = null;

/** Set by startFlexSource alongside the QSO controller. */
let activeAuto: () => AutoOperator | null = () => null;

/**
 * The GUI-client connection (the decode path's). Radio-changing commands go
 * through THIS one: the radio silently ignores several settings from non-GUI
 * clients — rfpower among them — exactly as it silently discarded TX audio.
 */
let flexGuiClient: FlexClient | null = null;

function broadcast(event: unknown): void {
  // Every status leaving the process carries the current link measurement. Done here,
  // at the one door status messages go through, rather than at each of the dozen call
  // sites that broadcast a status — one forgotten site would show a link stuck at
  // whatever it was when that code path last ran.
  if ((event as { kind?: string })?.kind === "status") refreshLinkStatus();
  const payload = JSON.stringify(event);
  for (const ws of clients) {
    try {
      ws.send(payload);
    } catch {
      clients.delete(ws);
    }
  }
}

/**
 * What has been worked, for award-aware hunting.
 *
 * Distinct-value queries rather than loading rows: at 26 k QSOs the difference
 * is a few milliseconds against a few hundred, and the auto operator asks for
 * this whenever the cache expires.
 */
// ---------------------------------------------------------------------------
// Decode persistence
// ---------------------------------------------------------------------------

/**
 * Decodes arrive in bursts — an FT8 cycle can produce 30+ in the same instant —
 * so they are queued and flushed together rather than issuing an INSERT each.
 */
const pending: {
  timestamp: Date;
  freqOffset: number;
  snr: number;
  message: string;
  mode: string;
  band: string;
}[] = [];

let flushTimer: NodeJS.Timeout | null = null;

function queueDecode(row: (typeof pending)[number]): void {
  pending.push(row);
  if (flushTimer) return;
  flushTimer = setTimeout(() => void flushDecodes(), 1_000);
}

async function flushDecodes(): Promise<void> {
  flushTimer = null;
  if (pending.length === 0) return;

  const batch = pending.splice(0, pending.length);
  try {
    await prisma.digitalDecode.createMany({ data: batch });
  } catch (err) {
    // Losing decodes is survivable — they are a live feed, not log data — but it
    // must be visible rather than silent.
    console.error(
      `[bridge] failed to persist ${batch.length} decode(s):`,
      err instanceof Error ? err.message : err,
    );
  }
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

function onStatus(msg: StatusMsg): void {
  status.decoderId = msg.id;
  status.dialFrequency = msg.dialFrequency || null;
  status.band = msg.dialFrequency ? freqToBand(msg.dialFrequency) : null;
  status.mode = msg.mode || null;
  status.subMode = msg.subMode || null;
  status.dxCall = msg.dxCall;
  status.deCall = msg.deCall;
  status.deGrid = msg.deGrid;
  status.transmitting = msg.transmitting;
  status.decoding = msg.decoding;
  status.txEnabled = msg.txEnabled;
  status.txMessage = msg.txMessage;
  status.rxDF = msg.rxDF;
  status.txDF = msg.txDF;

  broadcast({ kind: "status", status });
}

async function onDecode(msg: DecodeMsg): Promise<void> {
  // The decoder re-sends its whole list on request; only new lines are logged.
  if (!msg.isNew) return;

  const timestamp = decodeTimeToDate(msg.time);
  const band = status.dialFrequency ? freqToBand(status.dialFrequency) : null;

  // The submode is the useful label: WSJT-X reports FT4 as MFSK/FT4, and a feed
  // showing "MFSK" tells an operator nothing.
  const mode = (msg.mode || status.subMode || status.mode || "FT8").toUpperCase();

  const event = {
    kind: "decode" as const,
    timestamp: timestamp.toISOString(),
    snr: msg.snr,
    deltaTime: msg.deltaTime,
    freqOffset: msg.deltaFrequency,
    mode,
    band,
    message: msg.message,
    callsign: callsignFromMessage(msg.message),
    lowConfidence: msg.lowConfidence,
  };

  recentDecodes.push(event);
  if (recentDecodes.length > RECENT_LIMIT) recentDecodes.shift();

  broadcast(event);

  void decodeCsv?.append([
    {
      at: timestamp,
      band,
      mode,
      snr: msg.snr,
      dt: msg.deltaTime,
      offsetHz: msg.deltaFrequency,
      dialHz: status.dialFrequency,
      message: msg.message,
      callsign: callsignFromMessage(msg.message),
      radio: status.radio?.model ?? null,
    },
  ]);

  // A decode with no resolvable band can't be attributed, and DigitalDecode.band
  // is required — skip persistence rather than inventing one.
  if (band) {
    queueDecode({
      timestamp,
      freqOffset: msg.deltaFrequency,
      snr: msg.snr,
      message: msg.message.slice(0, 128),
      mode: mode.slice(0, 12),
      band,
    });
  }
}

/** Guards against the decoder re-sending a QSOLogged for the same contact. */
const recentlyLogged = new Map<string, number>();
const RESEND_WINDOW_MS = 60_000;

async function onQsoLogged(msg: QSOLoggedMsg): Promise<void> {
  broadcast({
    kind: "logged",
    callsign: msg.dxCall,
    grid: msg.dxGrid,
    mode: msg.mode,
    frequency: msg.txFrequency,
    at: (msg.dateTimeOn ?? new Date()).toISOString(),
  });

  if (!(await getBooleanSetting("wsjtx.autoLog", false))) {
    console.log(
      `[bridge] QSOLogged ${msg.dxCall} ignored — auto-log is off (Settings → External decoder)`,
    );
    return;
  }

  const band = freqToBand(msg.txFrequency || status.dialFrequency || 0);
  if (!band) {
    console.warn(
      `[bridge] cannot auto-log ${msg.dxCall}: ${msg.txFrequency} Hz is in no amateur band`,
    );
    return;
  }

  const key = `${msg.dxCall}|${band}|${msg.mode}`;
  const now = Date.now();
  if (now - (recentlyLogged.get(key) ?? 0) < RESEND_WINDOW_MS) return;
  recentlyLogged.set(key, now);

  // Attribution: prefer a station whose callsign matches the decoder's own, so a
  // multi-station install logs to the right one.
  const myCall = (msg.myCall ?? status.deCall ?? "").toUpperCase();
  const station =
    (myCall
      ? await prisma.station.findFirst({ where: { callsign: myCall } })
      : null) ?? (await prisma.station.findFirst({ orderBy: { createdAt: "asc" } }));

  if (!station) {
    console.warn(
      `[bridge] cannot auto-log ${msg.dxCall}: no station exists — create one first`,
    );
    return;
  }

  const startTime = msg.dateTimeOn ?? new Date();
  // WSJT-X reports MFSK for FT4; the submode is what belongs in the log.
  const mode = normaliseMode(msg.mode);

  try {
    await prisma.qso.create({
      data: {
        callsign: msg.dxCall.toUpperCase(),
        band,
        freqHz: BigInt(msg.txFrequency || 0),
        mode,
        startTime,
        endTime: msg.dateTimeOff ?? null,
        rstSent: msg.reportSent || null,
        rstRcvd: msg.reportReceived || null,
        gridSquare: msg.dxGrid || null,
        // Null on this path unless a native source is also up: an external decoder
        // reports the contact but never says what radio it was driving.
        radio: status.radio?.model ?? null,
        notes: msg.comments || null,
        stationId: station.id,
      },
    });
    // Log the stored mode, not the wire value — "MFSK" here while the log
    // holds "FT4" reads like a bug when it isn't.
    console.log(`[bridge] auto-logged ${msg.dxCall} on ${band} ${mode}`);
  } catch (err) {
    console.error(
      `[bridge] auto-log failed for ${msg.dxCall}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

function normaliseMode(mode: string): string {
  const m = mode.trim().toUpperCase();
  // WSJT-X reports FT4 as MFSK; DigiShack stores what the operator calls it.
  if (m === "MFSK") return "FT4";
  return m.slice(0, 12) || "FT8";
}

// ---------------------------------------------------------------------------
// UDP
// ---------------------------------------------------------------------------

async function startUdp(): Promise<dgram.Socket> {
  const port = await getNumberSetting("wsjtx.udpPort", 2237);
  const host = (await getSetting("wsjtx.udpHost")) ?? "0.0.0.0";

  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });

  socket.on("error", (err) => {
    console.error("[bridge] UDP socket error:", err.message);
    markDisconnected();
  });

  socket.on("message", (buf, rinfo) => {
    const outcome = decodePacket(buf);

    if (!outcome.ok) {
      // bad-magic means something other than the decoder is talking to this port,
      // which is a configuration problem worth saying out loud once in a while.
      if (outcome.reason !== "bad-magic") {
        console.warn(
          `[bridge] undecodable packet from ${rinfo.address}:${rinfo.port} (${outcome.reason}: ${outcome.detail})`,
        );
      }
      return;
    }

    status.peer = { address: rinfo.address, port: rinfo.port };
    markConnected();

    const msg = outcome.message;
    switch (msg.type) {
      case WsjtxType.Heartbeat:
        status.decoderId = msg.id;
        break;
      case WsjtxType.Status:
        onStatus(msg);
        break;
      case WsjtxType.Decode:
        void onDecode(msg);
        break;
      case WsjtxType.QSOLogged:
        void onQsoLogged(msg);
        break;
      case WsjtxType.Close:
        markDisconnected();
        break;
      default:
        break;
    }
  });

  socket.bind(port, host, () => {
    try {
      // WSJT-X can be configured to multicast; joining is harmless when it isn't.
      socket.addMembership("224.0.0.1");
    } catch {
      /* unicast only */
    }
    console.log(`[bridge] listening for a WSJT-X decoder on udp://${host}:${port}`);
  });

  return socket;
}

function markConnected(): void {
  status.lastHeartbeat = Date.now();
  if (!status.connected) {
    status.connected = true;
    console.log("[bridge] external decoder connected");
    broadcast({ kind: "status", status });
  }
}

function markDisconnected(): void {
  if (status.connected) {
    status.connected = false;
    console.log("[bridge] the external decoder went quiet");
    broadcast({ kind: "status", status });
  }
}

// ---------------------------------------------------------------------------
// Control API + WebSocket
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Native FlexRadio source: DAX audio decoded in-process, no external decoder.
 *
 * Feeds the same persistence and broadcast path as the external decoder, so
 * everything downstream — DigitalDecode rows, the WebSocket feed, band/mode
 * handling — is identical whichever source is selected.
 */
/**
 * What happens to a window of decodes, whichever radio produced them.
 *
 * PSKReporter, the websocket broadcast, the recent-decodes ring and the database write.
 * None of it is vendor-specific — it operates on messages — so both the FlexRadio and
 * the Icom hand their decodes here rather than each growing a copy.
 *
 * `depthSetting` only names the setting to blame in the slow-decode warning, which
 * differs per radio.
 */
function onDecodedWindow(
  { windowStart, decodes, decodeMs }: {
    windowStart: Date;
    decodes: { message: string; snr: number; dt: number; freqOffset: number; mode: string }[];
    decodeMs: number;
  },
  depthSetting: string,
): void {
    status.lastHeartbeat = Date.now();

    // Queue for PSKReporter. Uploading is what makes us visible as a receiver on
    // the coverage maps, and it costs one small datagram every five minutes.
    if (pskUploader && status.dialFrequency) {
      for (const d of decodes) {
        const p = parseMessage(d.message);
        const call = p.kind === "cq" ? p.from : p.kind === "directed" ? p.from : null;
        if (!call) continue;
        // Never report ourselves.
        //
        // A backstop, not the fix: the Icom streams receive audio through a transmission,
        // so the decoder heard our own signal and this loop dutifully uploaded it — the
        // coverage map showed K9XYZ spotting K9XYZ. The real fix is muting the decoder
        // while transmitting; this is here because a spot claiming to have heard yourself
        // is wrong on any path, from any cause, and PSKReporter is public.
        if (status.deCall && call.toUpperCase() === status.deCall.toUpperCase()) continue;
        pskUploader.add({
          callsign: call,
          grid: p.kind === "cq" ? p.grid : null,
          freqHz: status.dialFrequency + d.freqOffset,
          snr: d.snr,
          mode: d.mode,
          at: windowStart,
        });
      }
      if (pskUploader.dueToSend()) {
        const up = pskUploader;
        void up
          .flush()
          .then((n) => n > 0 && console.log(`[radio] reported ${n} spot(s) to PSKReporter`))
          .catch((err) =>
            console.error("[radio] PSKReporter upload failed:", err instanceof Error ? err.message : err),
          );
      }
    }

    if (decodeMs > 2_000) {
      // The gap between FT8 cycles is about 2.4 s. Overrunning it means the next
      // window starts before this one finished.
      console.warn(
        `[bridge] decode took ${decodeMs}ms, which risks overrunning the cycle — consider a lower ${depthSetting}`,
      );
    }

    // To disk first, and everything: a decode with no resolvable band never reaches
    // the database (the column is required and a guessed band is worse than none), but
    // it was still heard, and the CSV is the raw record rather than the queryable one.
    if (decodeCsv) {
      const band = status.dialFrequency ? freqToBand(status.dialFrequency) : null;
      void decodeCsv.append(
        decodes.map((d) => ({
          at: windowStart,
          band,
          mode: d.mode,
          snr: d.snr,
          dt: d.dt,
          offsetHz: d.freqOffset,
          dialHz: status.dialFrequency,
          message: d.message,
          callsign: callsignFromMessage(d.message),
          radio: status.radio?.model ?? null,
        })),
      );
    }

    for (const d of decodes) {
      const band = status.dialFrequency ? freqToBand(status.dialFrequency) : null;

      const event = {
        kind: "decode" as const,
        timestamp: windowStart.toISOString(),
        snr: d.snr,
        deltaTime: d.dt,
        freqOffset: d.freqOffset,
        mode: d.mode,
        band,
        message: d.message,
        callsign: callsignFromMessage(d.message),
        lowConfidence: false,
      };

      recentDecodes.push(event);
      if (recentDecodes.length > RECENT_LIMIT) recentDecodes.shift();
      broadcast(event);

      if (band) {
        queueDecode({
          timestamp: windowStart,
          freqOffset: d.freqOffset,
          snr: d.snr,
          message: d.message.slice(0, 128),
          mode: d.mode.slice(0, 12),
          band,
        });
      }
    }
  }

async function startFlexSource(): Promise<() => Promise<void>> {
  const configuredHost = await getSetting("flex.host");
  const autoDiscover = await getBooleanSetting("flex.autoDiscover", true);

  let host = configuredHost ?? "";
  if (!host || autoDiscover) {
    const found = await discoverRadios({ timeoutMs: 8_000 });
    host = configuredHost || found[0]?.ip || found[0]?.address || "";
    if (found[0]) {
      console.log(
        `[bridge] discovered ${found[0].model} (${found[0].callsign ?? "?"}) at ${host}`,
      );
    }
  }

  if (!host) {
    throw new Error(
      "No FlexRadio found and flex.host is not set. Cannot start the native source.",
    );
  }

  const daxChannel = await getNumberSetting("flex.daxChannel", 1);
  const depth = await getNumberSetting("flex.decodeDepth", 2);
  // Which antenna socket, on a radio with more than one. Blank leaves the radio alone.
  // Read here rather than inside the source so the transmitter gets the same answer from
  // the same read — two reads of one setting is how they end up on different antennas.
  const antenna = {
    tx: await getSetting("flex.antenna"),
    rx: await getSetting("flex.rxAntenna"),
  };
  // `digital.mode`, not `flex.mode`: which digital mode to decode is a property of
  // the operating, not of the radio, and the Icom needs the same answer.
  const configuredMode = ((await getSetting("digital.mode")) ?? "auto").toLowerCase();

  // The operating schedule and PA duty tracking. Both read once at start, like every
  // other bridge setting, and both are built before the source so the transmit handler
  // and the window handler can reach them.
  const schedule = await readScheduleConfig();
  const paDuty = schedule.paDuty;

  // Liveness. Built before the source so the window handler can beat it.
  const watchdogEnabled = await getBooleanSetting("bridge.watchdog.enabled", true);
  const watchdogPeriods = await getNumberSetting("bridge.watchdog.periods", 8);
  let watchdog: LivenessWatchdog | null = null;
  let audioWatchdog: LivenessWatchdog | null = null;

  /**
   * State the RF power warning against a known percentage, replacing any earlier one.
   *
   * One function so the two callers cannot disagree: the live `transmit` status handler,
   * which is authoritative and continuous, and the attach-time preflight, which is
   * neither. Filtering by prefix rather than tracking the previous string keeps it correct
   * if the wording ever changes, and stops the list accumulating a warning per adjustment
   * of the power knob.
   */
  const applyPowerWarning = (pct: number): void => {
    status.txWarnings = [
      ...status.txWarnings.filter((w) => !w.startsWith("RF power is")),
      ...(pct > RF_POWER_WARN_PCT
        ? [`RF power is ${pct}% — consider lowering it for a first test`]
        : []),
    ];
  };

  const source: FlexDaxSource = new FlexDaxSource({
    host,
    daxChannel,
    // Refined from the dial frequency below once the slice is known.
    mode: configuredMode === "ft4" ? "FT4" : configuredMode === "ft2" ? "FT2" : "FT8",
    depth,
    // Shared with the Icom: the passband is a property of the operating convention,
    // not of the radio.
    passbandHz: await getNumberSetting("digital.passbandHz", 3_000),
    // Where a bare radio comes up: the source creates its own slice here when
    // nothing else (SmartSDR, AetherSDR) has one open.
    freqHz: await getNumberSetting("flex.defaultFreqHz", 7_074_000),
    // The antenna port, applied only to a slice DigiShack owns. See the option.
    antenna,
    // RF spectrum, a second source alongside the audio waterfall rather than a
    // replacement for it. Off unless asked for: it costs about as much bandwidth
    // from the radio as the audio stream does.
    panadapter: {
      enabled: await getBooleanSetting("flex.panadapter", true),
      // 200 kHz, not 100: at 100 the display held little more than the FT8 window
      // it was already tuned to, which is the "needs to be zoomed out more" report.
      // Adjustable live from the panadapter's own Span buttons, which persist here.
      spanHz: (await getNumberSetting("flex.panadapterSpanKHz", 200)) * 1_000,
      bins: await getNumberSetting("flex.panadapterBins", 2_048),
      fps: await getNumberSetting("flex.panadapterFps", 10),
      // Frame averaging, which is about TIME and not frequency — see PAN_AVERAGE_DEFAULT
      // for why turning it off was not the same decision as taking the strongest bin
      // per pixel, and cost the colour ramp most of its range.
      average: await getNumberSetting("flex.panadapterAverage", 20),
    },
    // The dial, from the connection that actually hears about changes.
    //
    // The source cannot use its own slice cache: the radio does not echo `slice tune`
    // to the connection that issued it, and every tune DigiShack makes goes out over
    // exactly that connection. `status.dialFrequency` is maintained from the separate
    // tracking client below, which is not the originator and so does get the updates.
    dialHz: () => status.dialFrequency,
  });

  // S-meter, straight through to the UI. Not stored: like the waterfall it has
  // no value once it is off the screen.
  source.on("smeter", (m) => {
    broadcast({ kind: "smeter", dbm: m.dbm, fwdDbm: m.fwdDbm, at: m.at });
    // The radio's own forward-power meter, which is the only honest answer to
    // "what power was this contact made with". `fwdDbm` is null on receive, so
    // nothing but real transmissions reaches the tracker.
    activeTxPower?.sample(m.fwdDbm);
    // Receive only: a level taken while transmitting measures our own signal.
    if (!status.transmitting) noiseFloor.sample(m.dbm);
  });

  // Radio health -> UI, and into the guards: SWR and PA temperature are the two
  // readings that should stop unattended transmission on their own.
  source.on("telemetry", (t) => {
    lastTelemetry = t;
    if (activeGuards) {
      activeGuards.onTelemetry({
        swr: t.swr,
        paTempC: t.paTempC,
        transmitting: status.transmitting,
      });
      watchGuardFaults(activeGuards);
    }
    broadcast({ kind: "telemetry", telemetry: t });
  });

  source.on("connected", (i) => {
    status.connected = true;
    status.lastHeartbeat = Date.now();
    console.log(
      `[bridge] FlexRadio audio: stream ${i.streamId} on udp/${i.udpPort}, DAX channel ${i.daxChannel}`,
    );
    broadcast({ kind: "status", status });
  });

  source.on("error", (err) => console.error("[bridge] flex source:", err.message));

  // Waterfall rows. Broadcast only — never stored: this is 2 kB/s of display data
  // with no value once it has scrolled off the screen, and persisting it would
  // grow the database by ~170 MB a day for nothing.
  flexSource = source;

  // Receiver audio to any browser listening. Both radios emit the same event; only the
  // sample rate differs, and a listener is told which at connect.
  source.on("audio", ({ samples }) => {
    // The audio watchdog's only heartbeat, and the reason it is trustworthy: this fires
    // when the RADIO sends samples, so no timer of ours can keep it alive through a dead
    // receiver. See where it is armed.
    audioWatchdog?.beat();
    sendAudio(samples);
  });

  source.on("spectrum", (row) => {
    lastSpectrum = spectrumMessage(row, source.mode, source.periodMs);
    broadcast(lastSpectrum);
  });

  // RF spectrum. A different message from `spectrum`, not a variant of it — one
  // carries offsets inside a 3 kHz passband and the other carries absolute
  // frequencies, and a display that cannot tell them apart will draw one as the
  // other. Broadcast only, never stored: like the waterfall it has no value once it
  // has scrolled off the screen.
  source.on("panadapter", (row) => {
    lastPanadapter = panadapterMessage(row, "FlexRadio");
    broadcast(lastPanadapter);
  });

  // AGC, noise blanker and noise reduction as the radio reports them. Same event the
  // Icom emits, so /rig needs to know nothing about which radio it is watching.
  source.on("receiverControls", (rx) => {
    status.receiver = rx;
    broadcast({ kind: "status", status });
  });

  source.on("window", (w) => {
    // The liveness heartbeat. A window arrives once per T/R period whether or not
    // anything decoded, so it stops only when the machinery stops — which is the
    // distinction PM2 cannot make. See lib/radio/watchdog.ts for what happened on
    // 2 August 2026 that made this necessary.
    watchdog?.beat();

    // A skipped window is normal — DAX RX audio is silent while the radio
    // transmits — so it is not an error, but it is worth seeing.
    if (w.skipped && w.rms > 0) {
      console.log(
        `[bridge] window ${w.windowStart.toISOString().slice(11, 19)} skipped (rms ${w.rms.toExponential(1)})`,
      );
    }
  });

  source.on("decodes", (d) => onDecodedWindow(d, "flex.decodeDepth"));

  // Native transmit: the sequencer drives this through the QSO controller.
  // Shares the source's GUI-client connection and slice — a second GUI client
  // from this process would claim the radio's other slice for nothing.
  const allowTransmit = await isTransmitArmed("flex");
  let qsoController: QsoController | null = null;
  let autoOperator: AutoOperator | null = null;

  const attachTransmitter = async (): Promise<void> => {
    const shared = source.shared;
    if (!shared) {
      console.warn("[radio] transmit unavailable: source has no connection to share");
      return;
    }

    // Identity comes from the logbook's own station record — the radio knows
    // its callsign but not the grid, and the log is the authority anyway.
    const station = await prisma.station.findFirst({ orderBy: { createdAt: "asc" } });
    if (!station) {
      console.warn("[radio] transmit unavailable: no station exists — create one first");
      return;
    }
    status.deCall = station.callsign;
    status.deGrid = station.grid;

    flexGuiClient = shared.client;
    flexSliceIndex = shared.sliceIndex;

    const tx = new FlexDaxTransmitter({
      host,
      daxChannel,
      allowTransmit,
      // Read per transmission, so Settings takes effect immediately.
      isTransmitAllowed: transmitGate("flex"),
      // Ignored in shared mode, which is this path — the slice and its antenna belong to
      // the DAX source above. Passed anyway so the two can never be configured apart if
      // a future caller stops sharing.
      antenna,
      shared,
      // The same estimate the decode windows use, from the DAX source's probe —
      // two estimates of one path is how keying and windows end up disagreeing.
      linkOneWayMs: () => flexSource?.link.oneWayMs() ?? 0,
    });
    await tx.start();
    activeTx = tx;
    console.log(
      `[radio] transmitter attached (slice ${shared.sliceIndex}, allowTransmit=${allowTransmit})`,
    );

    // Ask the RADIO what it thinks, once, at attach.
    //
    // preflight() has existed since the transmit work and had exactly one caller
    // tree-wide: a script. So its checks — transmit inhibited, TX not allowed, DAX
    // not selected as the source, another client holding the transmitter, a
    // non-DIGU slice mode, power over 30% — never ran on the live path, and the
    // operator never saw them. Reported rather than enforced: refusing to attach
    // over a warning would leave someone unable to operate for a reason they
    // cannot see, and `blockers` are re-checked by the radio at keying time anyway.
    try {
      const pre = await tx.preflight();
      status.txBlockers = pre.blockers;
      // Antenna refusals ride along with the preflight warnings, because they are the
      // same kind of thing and /rig already shows this list. A configured port the radio
      // does not have is refused rather than replaced with ANT1 (see resolveAntenna), and
      // a refusal nobody can see is the original fault in a quieter voice.
      status.txWarnings = [...pre.warnings, ...(flexSource?.antennaWarnings ?? [])];
      // preflight's power reading is NOT trusted over the live one.
      //
      // It collects status for 1.5 s after re-issuing `sub tx all`, and on a connection
      // that is already subscribed the radio does not re-dump — so it sees whatever
      // partial updates happen to arrive in that window. Measured against a FLEX-6400
      // reporting rfpower=90: a fresh client collecting the same way reads 90, and the
      // bridge's long-lived one produced a warning saying 100. Whatever it saw, the
      // `transmit` status handler above tracks the real value continuously, so the last
      // word belongs to that.
      if (status.rfPower !== null) applyPowerWarning(status.rfPower);
      for (const b of pre.blockers) console.warn(`[radio] TX BLOCKER: ${b}`);
      for (const w of pre.warnings) console.warn(`[radio] tx warning: ${w}`);
      if (pre.blockers.length === 0 && pre.warnings.length === 0) {
        console.log(
          `[radio] preflight clean (${pre.txSliceMode ?? "?"}, ${pre.rfPower ?? "?"}% power)`,
        );
      }
      broadcast({ kind: "status", status });
    } catch (err) {
      console.warn(
        `[radio] preflight could not run: ${err instanceof Error ? err.message : err}`,
      );
    }

    // The operating layer: guards, the QSO controller, the auto operator.
    //
    // All of this used to be built here, inline, and that is the only reason the Icom
    // could not operate by itself. See services/radio/operating.ts — the FlexRadio
    // supplies two functions and nothing else.
    const operating = await buildOperating({
      kind: "flex",
      source,
      tx,
      station,
      dialHz: () => status.dialFrequency,
      radio: () => status.radio?.model ?? null,
      // The receive noise floor, so the operator can tell a quiet band from a
      // band buried in local noise. Reset on every retune below.
      noiseDbm: () => noiseFloor.dbm(),
      retune: async (band, mode) => {
        const shared = source.shared;
        if (!shared) return false;
        const hz = callingFrequencyHz(band, mode);
        if (hz === null) return false;
        const mhz = (hz / 1_000_000).toFixed(6);
        const reply = await shared.client.command(`slice tune ${shared.sliceIndex} ${mhz}`);
        if (reply.status !== 0) return false;
        // ATU follows the band when the operator has asked it to. `atu start`
        // runs the radio's own low-power tune cycle.
        if (await getBooleanSetting("flex.atuOnBandChange", false)) {
          await shared.client.command("atu start").catch(() => {});
        }
        // A noise floor belongs to the band it was measured on.
        noiseFloor.reset();
        return true;
      },
      tuneHz: async (hz) => {
        const sh = source.shared;
        if (!sh) return false;
        // Which band we were on BEFORE the dial moves.
        //
        // POTA chase retunes through here rather than through `retune`, and it
        // crosses bands — that is the whole reason `chaseHome` exists. So this path
        // could land the radio on a band the ATU had never tuned for, key a
        // transmitter into it, and trip the SWR guard on an antenna that would have
        // loaded perfectly after a two-second tune cycle.
        const wasBand = status.dialFrequency ? freqToBand(status.dialFrequency) : null;
        const mhz = (hz / 1_000_000).toFixed(6);
        const reply = await sh.client.command(`slice tune ${sh.sliceIndex} ${mhz}`);
        if (reply.status !== 0) return false;

        // Only when the BAND actually changed. An ATU cycle between two park
        // frequencies on the same band keys the transmitter for nothing.
        const nowBand = freqToBand(hz);
        if (
          nowBand !== wasBand &&
          (await getBooleanSetting("flex.atuOnBandChange", false))
        ) {
          console.log(`[radio] band ${wasBand ?? "?"} -> ${nowBand ?? "?"} — running the ATU`);
          await shared.client.command("atu start").catch(() => {});
        }
        if (nowBand !== wasBand) noiseFloor.reset();
        return true;
      },
      broadcast,
      log: (line) => console.log(`[radio] ${line}`),
      flushDecodes,
    });
    activeGuards = operating.guards;
    activeTxPower = operating.txPower;
    qsoController = operating.qsoController;
    autoOperator = operating.autoOperator;
    if (operating.pskUploader) pskUploader = operating.pskUploader;
  };

  // Track the dial frequency so decodes can be attributed to a band. The DAX
  // stream carries audio only — it has no idea what the radio is tuned to.
  const rig = new FlexClient(host);
  await rig.connect();
  await rig.subscribe("slice all");
  await rig.subscribe("tx all");

  const applySlice = () => {
    const slice = rig.activeSlice();
    if (!slice?.freqHz) return;

    status.dialFrequency = slice.freqHz;
    status.band = freqToBand(slice.freqHz);
    status.mode = slice.mode;
    // On this radio `mode` IS the modulation, so the two agree — but reported in the shared
    // vocabulary, because SmartSDR says DIGU where this project says USB-D and the CAT panel
    // offers one list. Unmapped, the picker fell through to its placeholder and read "DIGU",
    // which is exactly what a broken control looks like.
    status.radioMode = fromFlexMode(slice.mode);
    status.deCall = rig.state.callsign;
    // What the radio calls itself, from `info` — "FLEX-6400". Set here rather than at
    // connect because readInfo() is what fills it in.
    status.radio = { vendor: "flex", model: rig.state.model ?? "FlexRadio", host };

    // A DIGU slice does not say whether it is carrying FT8 or FT4, and the two
    // have different window lengths — decode one as the other and you get
    // nothing. The dial frequency is the reliable discriminator, so unless the
    // mode is pinned in Settings it is inferred from where the radio is tuned.
    if (configuredMode === "auto") {
      const guess = inferDigitalMode(slice.freqHz);
      if (source.setMode(guess.mode)) {
        console.log(
          `[bridge] ${(slice.freqHz / 1e6).toFixed(3)} MHz -> decoding ${guess.mode}` +
            (guess.certain
              ? ` (${guess.matched?.band} calling frequency)`
              : " (no known calling frequency nearby — defaulting to FT8)"),
        );
      }
      status.subMode = guess.mode;
    } else {
      status.subMode = source.mode;
    }

    broadcast({ kind: "status", status });
  };
  rig.on("slice", applySlice);
  rig.on("transmit", (tx) => {
    status.transmitting = tx;
    // Duty tracking follows the RADIO, not our intent. An ATU tune, a manual key from
    // the front panel or SmartSDR all heat the same finals, and a cooldown that only
    // counted DigiShack's own transmissions would under-report exactly when the
    // operator was busiest.
    if (tx) paDuty.keyed();
    else paDuty.unkeyed();
    broadcast({ kind: "status", status });
  });
  rig.on("status", (st) => {
    // The transmit object carries rfpower; surface it so the UI slider can show
    // the radio's actual setting rather than an optimistic guess.
    if (st.object.split(/\s+/)[0] === "transmit" && st.fields.rfpower !== undefined) {
      const p = Number(st.fields.rfpower);
      if (Number.isFinite(p) && p !== status.rfPower) {
        status.rfPower = p;
        applyPowerWarning(p);
        broadcast({ kind: "status", status });
      }
    }
  });

  flexRig = rig;

  await rig.readInfo();
  await new Promise((r) => setTimeout(r, 1_500));
  applySlice();

  await source.start();

  // Arm liveness once the source is up. The watchdog stays unarmed until the first
  // window arrives, so discovery and the client handshake are not counted against it.
  //
  // Exiting is the cure, not a reconnect: a hung event loop or a socket that stopped
  // delivering cannot be repaired from inside the process that is hung. PM2 restarts
  // us, bounded by min_uptime and max_restarts so a radio that is genuinely off does
  // not become an invisible flap.
  if (watchdogEnabled) {
    watchdog = new LivenessWatchdog({
      timeoutMs: windowTimeoutMs(source.periodMs, watchdogPeriods),
      label: "flex decode pipeline",
      onDead: ({ sinceMs, label }) => {
        console.error(
          `[bridge] WATCHDOG: no ${label} activity for ${Math.round(sinceMs / 1000)}s — ` +
            `the process is running but not working. Exiting so PM2 restarts it.`,
        );
        // The email races a 3 s cap, then the process goes regardless: the restart
        // is the actual remedy and must not wait on a mail server. The alert has no
        // matching clear — a successful restart IS the recovery, and the fresh
        // process has no memory of raising it, which is the correct amnesia.
        void Promise.race([
          raiseAlert(
            "watchdog",
            `Bridge restarted itself (${label} stalled)`,
            [
              `No ${label} activity for ${Math.round(sinceMs / 1000)}s — the process was running but not working, so it exited for PM2 to restart.`,
              "One of these is routine after a network blip. Several in a row means something is genuinely wrong — read the bridge log.",
            ],
            // Every restart mails, cooldown or not. Two in an evening is a materially
            // worse situation than one, and the whole value of the second message is
            // that it is the second.
            { always: true },
          ),
          new Promise((r) => setTimeout(r, 3_000)),
        ]).finally(() => setTimeout(() => process.exit(1), 250));
      },
    });
    watchdog.start();
    console.log(
      `[bridge] liveness watchdog armed: restart if no decode window for ` +
        `${Math.round(windowTimeoutMs(source.periodMs, watchdogPeriods) / 1000)}s`,
    );

    // A SECOND watchdog, on the audio itself.
    //
    // The one above beats on the `window` event, and its own comment says why that was
    // chosen: a window arrives once per T/R period whether or not anything decoded, so it
    // stops only when the machinery stops. That is true and it is not enough, because the
    // windows are driven by a TIMER. On 10 August 2026 the radio stopped sending DAX audio
    // and panadapter frames entirely — the TCP control link stayed up and answered status
    // queries — and the pipeline went on producing empty windows on schedule. The watchdog
    // beat happily through four minutes of a dead receiver, decoding nothing, until it was
    // restarted by hand. A heartbeat taken from our own clock cannot notice that the radio
    // went quiet.
    //
    // So this one beats on ACTUAL AUDIO PACKETS arriving from the radio. Nothing we do can
    // fake it: if the samples stop, this stops.
    //
    // The timeout is generous on purpose. DAX RX audio legitimately goes quiet while the
    // radio transmits, and an FT8 over is about thirteen seconds; a band change or a slice
    // retune pauses it briefly too. 90 s is far longer than any of those and far shorter
    // than the four minutes this was worth catching.
    audioWatchdog = new LivenessWatchdog({
      timeoutMs: AUDIO_STALL_MS,
      label: "receiver audio",
      onDead: ({ sinceMs, label }) => {
        console.error(
          `[bridge] WATCHDOG: no ${label} from the radio for ${Math.round(sinceMs / 1000)}s — ` +
            `the control link may still be up, but nothing is being received. Exiting so PM2 restarts it.`,
        );
        void Promise.race([
          raiseAlert(
            "watchdog-audio",
            "Bridge restarted itself (receiver audio stopped)",
            [
              `No audio arrived from the radio for ${Math.round(sinceMs / 1000)}s.`,
              "The control connection can stay up while the radio stops sending DAX audio and panadapter frames — decoding quietly stops and the waterfall freezes, with nothing in the log to say so.",
              "The bridge exited so PM2 could restart it, which re-creates the DAX stream.",
            ],
            { always: true },
          ),
          new Promise((r) => setTimeout(r, 3_000)),
        ]).finally(() => setTimeout(() => process.exit(1), 250));
      },
    });
    audioWatchdog.start();
    console.log(
      `[bridge] audio watchdog armed: restart if no receiver audio for ${AUDIO_STALL_MS / 1000}s`,
    );
  } else {
    console.log("[bridge] liveness watchdog is OFF (bridge.watchdog.enabled=false)");
  }

  // Attach transmit only once the source is live — it shares the source's
  // GUI-client connection, socket and slice, none of which exist before start().
  try {
    await attachTransmitter();
  } catch (err) {
    console.error(
      "[radio] transmitter failed to attach:",
      err instanceof Error ? err.message : err,
    );
  }
  activeQso = () => qsoController;
  activeAuto = () => autoOperator;

  // The operating schedule. Read once at start, like every other bridge setting.
  //
  const stopSchedule = runSchedule({ ...schedule, auto: () => autoOperator });

  status.commandChannel = true;
  broadcast({ kind: "status", status });

  // Supervision.
  //
  // A dropped TCP command channel does not stop DAX audio, so the failure is
  // invisible: decodes carry on while every command silently fails with the
  // client's own -1 status. Rebuilding the whole source is the right response
  // rather than patching state — the streams, the GUI-client registration, the
  // slice binding and the TX routing all have to be re-established together, and
  // start() already knows how to do that in the right order.
  let restarting = false;
  /**
   * Set by teardown(), and the difference between an outage and a decision.
   *
   * `rig.disconnect()` and `source.stop()` both emit `disconnected`, so releasing the
   * radio ON PURPOSE fired this supervisor and it dutifully brought the radio back:
   *   - FT-0 engaged, tore the source down, and the reconnect undid the panic stop.
   *     The one control that should always work was reconnecting the radio it had just
   *     stopped.
   *   - Switching to the Icom released the FlexRadio, which then rebuilt itself, so both
   *     radios ran at once and the schedule turned hunt back on for the one that was
   *     supposed to be off the air. Observed live, transmitting.
   */
  let releasing = false;
  const onLost = (which: string) => (err: Error | null) => {
    if (releasing) return;
    status.commandChannel = false;
    status.connected = false;
    broadcast({ kind: "status", status });
    console.error(
      `[radio] ${which} connection lost${err ? `: ${err.message}` : ""} — rebuilding`,
    );
    if (restarting) return;
    restarting = true;

    void (async () => {
      holdAutoMode();
      // This sets `releasing` on THIS source's closure, which is right: it is being
      // discarded. The rebuilt one gets its own flag, cleared.
      await teardown().catch(() => {});

      const lostAt = Date.now();
      // How often to nag while the radio stays unreachable, and when the next one is due.
      // Read once, outside the loop: a reconnect loop that hits the database every 41
      // seconds for four days would be its own small fault.
      const reminderMs =
        (await getNumberSetting("alerts.radioDownReminderHours", 12)) * 3_600_000;
      let nextReminderAt = 0;
      for (let attempt = 1; ; attempt++) {
        const wait = Math.min(30_000, 2_000 * attempt);
        await new Promise((r) => setTimeout(r, wait));
        try {
          console.log(`[radio] reconnect attempt ${attempt}…`);
          flexTeardown = await startFlexSource();
          console.log("[radio] reconnected");
          void clearAlert("radio-down", "FlexRadio is back", [
            `Reconnected after ${attempt} attempt(s), down ${Math.round((Date.now() - lostAt) / 60_000)} minute(s).`,
          ]);
          await resumeHeldAutoMode();
          return;
        } catch (e) {
          console.error(
            `[radio] reconnect attempt ${attempt} failed:`,
            e instanceof Error ? e.message : e,
          );
          // Ten attempts is ~4 minutes of backoff — past any restart blip, well
          // before "attempt 300 overnight", which is the incident this line is for.
          //
          // AND THEN KEEP REMINDING. This fired once, at attempt 10, and never again:
          // after a power cut on 11 August the radio did not come back on the network and
          // the bridge retried 8,223 times over 94 hours in complete silence. One email
          // four minutes in, then nothing for four days, while the line below promised to
          // "email again when it is back" — true, and worthless when it never comes back.
          //
          // A radio that is off needs somebody to walk over and switch it on, and the
          // only thing that produces that is a message that keeps arriving.
          if (attempt === 10 || (nextReminderAt !== 0 && Date.now() >= nextReminderAt)) {
            const downMin = Math.round((Date.now() - lostAt) / 60_000);
            nextReminderAt = Date.now() + reminderMs;
            void raiseAlert(
              "radio-down",
              downMin >= 60
                ? `Turn on the radio — unreachable for ${Math.round(downMin / 60)}h`
                : "FlexRadio unreachable",
              [
                `The FlexRadio has been unreachable for ${downMin} minutes (${attempt} reconnect attempts).`,
                `Last error: ${e instanceof Error ? e.message : e}`,
                "Nothing is being decoded and nothing is being logged until it is back.",
                "Check that the radio is powered on — after a mains outage it comes back in standby, not on — and that it is on the network.",
                `This reminder repeats every ${Math.round(reminderMs / 3_600_000)}h until the radio answers.`,
              ],
              // Past the six-hour alert cooldown on purpose: the whole point is repetition.
              { always: true },
            );
          }
        }
      }
    })();
  };

  const guiClient = source.shared?.client;
  guiClient?.once("disconnected", onLost("radio audio/command"));
  rig.once("disconnected", onLost("rig status"));

  const teardown = async (): Promise<void> => {
    // Anything that follows is a release we asked for, not a radio that went away.
    releasing = true;
    // Or the rebuilt source ends up with a second schedule fighting it for the mode.
    stopSchedule();
    // Stop the watchdog FIRST, and this is not tidiness.
    //
    // It was never stopped here, so during a reconnect the old one kept counting
    // against a source that no longer existed and exited the process after two
    // minutes — meaning the rebuild only ever survived if it beat that clock, and a
    // radio that was genuinely away hit PM2's max_restarts and stayed down. The
    // watchdog exists to catch "running but not working"; a rebuild we started
    // ourselves is neither, and the supervisor below is what covers it.
    watchdog?.stop();
    watchdog = null;
    // The audio watchdog goes too, and it matters more than the other: stopping the
    // source stops the audio by definition, so leaving it armed would guarantee a
    // spurious restart every time the bridge tears itself down on purpose.
    audioWatchdog?.stop();
    audioWatchdog = null;
    await source.stop().catch(() => {});
    rig.disconnect();
    flexGuiClient = null;
    flexRig = null;
    flexSliceIndex = null;
    flexSource = null;
  };

  flexTeardown = teardown;
  return teardown;
}

/**
 * Stand the Icom up and hook it to this module's shared state.
 *
 * The dependencies are passed explicitly rather than letting `icom-source.ts` import
 * from here, because that would be a cycle: this file already imports it. Passing them
 * also makes the list of things the bridge actually shares with a radio driver visible
 * in one place, which the FlexRadio path has never had.
 */
async function startIcomBridge(): Promise<() => Promise<void>> {
  const watchdogEnabled = await getBooleanSetting("bridge.watchdog.enabled", true);
  const watchdogPeriods = await getNumberSetting("bridge.watchdog.periods", 8);
  let watchdog: LivenessWatchdog | null = null;

  console.log(`[bridge] Icom at ${await icomTarget()}`);

  // Rebuild the session when it drops, rather than waiting for the watchdog to exit
  // the process and hoping PM2 brings it back.
  //
  // The Icom lives at the end of a VPN here, which is exactly where a session drops for
  // twenty seconds and comes back. Exiting was the only response this path had, and PM2
  // gives up after max_restarts — so a handful of blips took the station off the air
  // until somebody noticed and typed `pm2 start`.
  let restarting = false;
  /** See the FlexRadio's: a release we asked for must not look like an outage. */
  let releasing = false;
  const onLost = (reason: string): void => {
    if (releasing || restarting) return;
    restarting = true;
    console.error(`[radio] Icom session lost (${reason}) — rebuilding`);

    void (async () => {
      holdAutoMode();
      await teardown().catch(() => {});

      const lostAt = Date.now();
      // Same nagging as the FlexRadio loop, and read the same way. See there for why one
      // alert at attempt 10 was not enough.
      const reminderMs =
        (await getNumberSetting("alerts.radioDownReminderHours", 12)) * 3_600_000;
      let nextReminderAt = 0;
      for (let attempt = 1; ; attempt++) {
        const wait = Math.min(30_000, 2_000 * attempt);
        await new Promise((r) => setTimeout(r, wait));
        try {
          console.log(`[radio] Icom reconnect attempt ${attempt}…`);
          flexTeardown = await startIcomBridge();
          console.log("[radio] Icom reconnected");
          void clearAlert("radio-down", "Icom is back", [
            `Reconnected after ${attempt} attempt(s), down ${Math.round((Date.now() - lostAt) / 60_000)} minute(s).`,
          ]);
          await resumeHeldAutoMode();
          return;
        } catch (e) {
          console.error(
            `[radio] Icom reconnect attempt ${attempt} failed:`,
            e instanceof Error ? e.message : e,
          );
          // Same threshold and key as the Flex loop: one radio runs at a time, and
          // "the radio is down" is one condition wherever it happens.
          if (attempt === 10 || (nextReminderAt !== 0 && Date.now() >= nextReminderAt)) {
            const downMin = Math.round((Date.now() - lostAt) / 60_000);
            nextReminderAt = Date.now() + reminderMs;
            void raiseAlert(
              "radio-down",
              downMin >= 60
                ? `Turn on the radio — unreachable for ${Math.round(downMin / 60)}h`
                : "Icom unreachable",
              [
                `The Icom has been unreachable for ${downMin} minutes (${attempt} reconnect attempts).`,
                `Last error: ${e instanceof Error ? e.message : e}`,
                "Nothing is being decoded and nothing is being logged until it is back.",
                "Check that the radio is powered on and on the network.",
                `This reminder repeats every ${Math.round(reminderMs / 3_600_000)}h until the radio answers.`,
              ],
              { always: true },
            );
          }
        }
      }
    })();
  };

  const bridge = await startIcomSource({
    onLost,
    onDecodedWindow,
    broadcast,
    status,
    freqToBand,
    // So a contact's decodes can be found in the database the moment it is logged; the
    // insert is batched on a one-second timer and the last message of the exchange is
    // normally still in the buffer.
    flushDecodes,
    onAudio: (samples) => sendAudio(samples),
    onSpectrum: (row) => {
      lastSpectrum = row as typeof lastSpectrum;
      broadcast(lastSpectrum);
    },
    onTelemetry: (t) => {
      lastTelemetry = t as typeof lastTelemetry;
      broadcast({ kind: "telemetry", telemetry: lastTelemetry });
    },
    noiseDbm: () => noiseFloor.dbm(),
    onSmeter: (m) => {
      broadcast({ kind: "smeter", dbm: m.dbm, fwdDbm: m.fwdDbm, at: m.at });
      // Same path as the FlexRadio: whatever forward power this radio reports.
      activeTxPower?.sample(m.fwdDbm);
      if (!status.transmitting) noiseFloor.sample(m.dbm);
    },
    armWatchdog: (periodMs, label) => {
      if (!watchdogEnabled) {
        console.log("[bridge] liveness watchdog is OFF (bridge.watchdog.enabled=false)");
        return;
      }
      const timeoutMs = windowTimeoutMs(periodMs, watchdogPeriods);
      watchdog = new LivenessWatchdog({
        timeoutMs,
        label,
        onDead: ({ sinceMs, label: l }) => {
          console.error(
            `[bridge] WATCHDOG: no ${l} activity for ${Math.round(sinceMs / 1000)}s — ` +
              `the process is running but not working. Exiting so PM2 restarts it.`,
          );
          setTimeout(() => process.exit(1), 250);
        },
      });
      watchdog.start();
      console.log(
        `[bridge] liveness watchdog armed: restart if no decode window for ${Math.round(timeoutMs / 1000)}s`,
      );
    },
    beatWatchdog: () => watchdog?.beat(),
  });

  // The operating schedule, which this path did not have at all until now: no timed
  // modes, no sleep hours, no PA duty rest. The duty tracker follows the transmitter,
  // which is the only thing on this path that knows when the radio is keyed — the
  // FlexRadio learns it from the radio's own transmit status instead.
  const schedule = await readScheduleConfig();
  const paPoll = setInterval(() => {
    if (bridge.transmitter?.transmitting) schedule.paDuty.keyed();
    else schedule.paDuty.unkeyed();
  }, 1_000);
  paPoll.unref?.();
  const stopSchedule = runSchedule({
    ...schedule,
    auto: () => bridge.operating?.autoOperator ?? null,
  });

  // Hand the operating layer to the control API, exactly as the FlexRadio path does.
  //
  // This is the whole of what used to be missing. Auto Hunt, Auto CQ, Hunt POTA, Chase
  // POTA and the Call button all reach the radio through these four handles, and on the
  // Icom every one of them was still the `() => null` this module starts with.
  const op = bridge.operating;
  icomSource = bridge.source;
  activeQso = () => op?.qsoController ?? null;
  activeAuto = () => op?.autoOperator ?? null;
  activeGuards = op?.guards ?? null;
  activeTxPower = op?.txPower ?? null;
  activeTx = bridge.transmitter;
  if (op?.pskUploader) pskUploader = op.pskUploader;
  if (!op) {
    console.warn(
      "[radio] Icom automatic modes are unavailable — see the transmit warning above",
    );
  }

  broadcast({ kind: "status", status });

  const teardown = async (): Promise<void> => {
    releasing = true;
    stopSchedule();
    clearInterval(paPoll);
    // Same reasoning as the FlexRadio's: a rebuild we started ourselves must not be
    // shot by the liveness watchdog half way through.
    watchdog?.stop();
    watchdog = null;
    activeQso = () => null;
    activeAuto = () => null;
    activeGuards = null;
    activeTxPower = null;
    activeTx = null;
    icomSource = null;
    await bridge.stop();
  };

  flexTeardown = teardown;

  // A session that opened but carries nothing gets rebuilt — AFTER teardown exists.
  //
  // Doing this from inside startIcomSource reached a `teardown` that had not been
  // created yet and killed the process on the first restart that failed to carry, which
  // is precisely the restart this whole change is about. The fact comes back from the
  // source; the decision is made here, where the means to act on it is in scope.
  //
  // Bounded at two: if the CI-V address is genuinely wrong, or the radio is genuinely
  // silent, no number of rebuilds helps and a loop would throw away whichever half does
  // work — and on the failing restarts audio carried perfectly while CI-V did not.
  if (!bridge.carrying.ok) {
    if (streamRecoveryAttempts < MAX_STREAM_RECOVERIES) {
      streamRecoveryAttempts++;
      console.error(
        `[radio] rebuilding the Icom session (attempt ${streamRecoveryAttempts} of ` +
          `${MAX_STREAM_RECOVERIES}) — the radio is probably still holding an older one`,
      );
      onLost("streams opened but carried nothing");
    } else {
      console.error(
        `[radio] Icom still not carrying after ${MAX_STREAM_RECOVERIES} rebuilds. ` +
          `Carrying on with whatever works — check the CI-V address, or power-cycle the ` +
          `radio to release a stuck session.`,
      );
    }
  } else {
    streamRecoveryAttempts = 0;
  }

  return teardown;
}

/**
 * How many times to rebuild an Icom session that opens but does not carry.
 *
 * Module scope because the bridge is rebuilt on each attempt, so a counter inside it
 * would reset every time and loop for ever.
 */
const MAX_STREAM_RECOVERIES = 2;
let streamRecoveryAttempts = 0;

/**
 * The UDP socket, when the external decoder is the source.
 *
 * Module-level so the source can be switched at runtime: it used to be a local in
 * main(), which was fine when the choice was made once at startup and never revisited.
 */
let udpSocket: dgram.Socket | null = null;

/**
 * Bring up whichever source is selected.
 *
 * FT-0's release path used to call `startFlexSource()` unconditionally, so releasing a
 * full stop on the Icom went looking for a FlexRadio on the network and failed. FT-0 is
 * the one control that should always work, on whichever radio.
 */
async function startActiveSource(): Promise<() => Promise<void>> {
  if (status.source === "icom") return startIcomBridge();
  if (status.source === "flex") return startFlexSource();

  udpSocket = await startUdp();
  return async () => {
    udpSocket?.close();
    udpSocket = null;
  };
}

/**
 * Start the operating schedule for whichever radio is running.
 *
 * The logic lives in lib/radio/schedule-runner.ts so it can be tested without a radio,
 * a socket or a database — the two rules that matter (act only on a change, never
 * overwrite the operator mid-block) are exactly what quietly regresses.
 *
 * The PA duty tracker is passed in rather than created here because it follows the
 * RADIO's transmit state, which only the source knows how to observe: an ATU tune or a
 * manual key from the front panel heats the same finals as a CQ.
 */
function runSchedule(opts: {
  cfg: ScheduleConfig;
  errors: string[];
  paDuty: PaDutyTracker;
  /** The schedule's persisted last answer, so a restart is not a fresh change. */
  lastApplied: AutoMode | null;
  auto: () => AutoOperator | null;
}): () => void {
  // A disabled schedule must also CLEAR the display — the setting can be turned off
  // between source rebuilds, and a stale "Scheduled hunt until 22:00" from the
  // previous run would be worse than nothing.
  status.schedule = null;

  const runner = startScheduleRunner({
    cfg: opts.cfg,
    errors: opts.errors,
    paDuty: opts.paDuty,
    auto: opts.auto,
    initialLastScheduled: opts.lastApplied,
    onChanged: (mode) => {
      void persistAutoMode(mode);
      void persistScheduleApplied(mode);
      broadcast({ kind: "status", status });
    },
    onDecision: (d) => {
      const cur = status.schedule;
      // Reasons tick over on their own ("PA cooling down for another 4 min"), so
      // compare content, not identity — and only say something when it changed.
      if (cur && cur.mode === d.mode && cur.reason === d.reason) return;
      status.schedule = { mode: d.mode, reason: d.reason, suppressed: d.suppressed };
      broadcast({ kind: "status", status });
    },
    log: (line) => console.log(`[radio] ${line}`),
    logError: (line) => console.error(`[radio] ${line}`),
  });
  return runner.stop;
}

/** Read the schedule's settings. Shared, because both radios want the same answer. */
async function readScheduleConfig(): Promise<{
  cfg: ScheduleConfig;
  errors: string[];
  paDuty: PaDutyTracker;
  lastApplied: AutoMode | null;
}> {
  const parsed = parseSchedule((await getSetting("schedule.hours")) ?? "");
  const cfg: ScheduleConfig = {
    enabled: await getBooleanSetting("schedule.enabled", false),
    blocks: parsed.blocks,
    sleep: parseRange((await getSetting("schedule.sleep")) ?? ""),
    paAfterMinutes: await getNumberSetting("schedule.paAfterMinutes", 0),
    paRestMinutes: await getNumberSetting("schedule.paRestMinutes", 10),
  };
  const storedLast = (await getSetting(KEY_SCHED_LAST)) ?? "";
  return {
    cfg,
    errors: parsed.errors,
    paDuty: new PaDutyTracker(cfg.paAfterMinutes, cfg.paRestMinutes),
    lastApplied: isAutoMode(storedLast) ? storedLast : null,
  };
}

/**
 * Ask a time server how wrong this machine's clock is, and compensate.
 *
 * FT8 tolerates roughly a second of error before decoding degrades and other stations
 * stop decoding you — and that failure reads exactly like a dead band, which is why it is
 * worth measuring rather than assuming. DigiShack cannot set the system clock (elevation
 * on Windows, root on Linux, and in a container the clock belongs to the host), so it
 * measures the difference and applies it internally instead.
 *
 * Returns what happened so the control API can report it to whoever pressed the button.
 */
async function syncClock(): Promise<{ ok: boolean; detail: string }> {
  const server = ((await getSetting("time.ntpServer")) ?? "").trim();
  if (!server) {
    clearCorrection();
    return { ok: false, detail: "No time server configured (time.ntpServer is blank)" };
  }

  const correct = await getBooleanSetting("time.correct", true);
  const r = await querySntp({ server });
  if (!r.ok) {
    // Not fatal and not even unusual: a station without internet still operates, it just
    // has to trust its own clock.
    console.warn(`[time] could not reach ${server}: ${r.error}`);
    return { ok: false, detail: `Could not reach ${server}: ${r.error}` };
  }

  const outcome = applyMeasurement({
    offsetMs: r.sample.offsetMs,
    delayMs: r.sample.delayMs,
    source: r.sample.server,
    correct,
  });
  console.log(
    `[time] ${server} (stratum ${r.sample.stratum}, ${Math.round(r.sample.delayMs)}ms round trip): ` +
      outcome.reason,
  );
  broadcast({ kind: "clock", clock: clockState() });
  return { ok: true, detail: outcome.reason };
}

/** Measure at startup, then on a timer. */
function startClockSync(intervalMinutes: number): void {
  void syncClock();
  if (intervalMinutes <= 0) return;
  const timer = setInterval(() => void syncClock(), Math.max(1, intervalMinutes) * 60_000);
  timer.unref?.();
}

/**
 * Keep trying to bring the selected source up, in the background.
 *
 * Used when the radio is not there at startup. Backs off to thirty seconds and does not
 * give up, because "the radio is off" and "the VPN is down" both end the same way — the
 * radio comes back — and a bridge that had exited would need someone to notice and
 * restart it. Stops as soon as the operator picks a different source, since switching
 * starts one itself.
 */
let sourceRetry: NodeJS.Timeout | null = null;

function retrySourceInBackground(): void {
  if (sourceRetry) return;
  let attempt = 0;
  const startedAt = Date.now();
  let nextReminderAt = 0;

  const tick = async (): Promise<void> => {
    attempt++;
    if (flexTeardown) {
      // Something else brought a source up — the picker, or FT-0's release.
      sourceRetry = null;
      return;
    }
    try {
      flexTeardown = await startActiveSource();
      console.log(`[bridge] the ${status.source} source came up on attempt ${attempt}`);
      // Say so, but only if the absence was announced. clearAlert already checks that.
      void clearAlert("radio-down", "Radio is back", [
        `The ${status.source} source came up on attempt ${attempt}, after ${Math.round((Date.now() - startedAt) / 60_000)} minute(s) unavailable.`,
      ]);
      broadcast({ kind: "status", status });
      sourceRetry = null;
      return;
    } catch (err) {
      // One line per attempt, not a stack: an unreachable radio is an ordinary state,
      // and a stack trace every thirty seconds buries everything else in the log.
      console.error(
        `[bridge] ${status.source} still unavailable (attempt ${attempt}): ${
          err instanceof Error ? err.message : err
        }`,
      );

      // AND EMAIL ABOUT IT, on the same schedule as the reconnect loop.
      //
      // This is a SECOND path to the same condition and it had no alerting at all, which
      // is how a fixed reconnect loop can still leave an operator uninformed. `onLost`
      // handles a live radio that goes away; this handles a radio that was already gone
      // when the bridge started — which is precisely what a mains outage produces when it
      // takes the server down too, and therefore the likelier of the two after a power
      // cut. Found because restarting the bridge to deploy the reconnect-loop fix put it
      // straight down this path instead.
      const downMin = Math.round((Date.now() - startedAt) / 60_000);
      if (attempt === 3 || (nextReminderAt !== 0 && Date.now() >= nextReminderAt)) {
        const reminderMs =
          (await getNumberSetting("alerts.radioDownReminderHours", 12)) * 3_600_000;
        nextReminderAt = Date.now() + reminderMs;
        void raiseAlert(
          "radio-down",
          downMin >= 60
            ? `Turn on the radio — unreachable for ${Math.round(downMin / 60)}h`
            : `Radio not found at startup (${status.source})`,
          [
            `The ${status.source} radio has not answered since the bridge started, ${downMin} minute(s) ago (${attempt} attempts).`,
            `Last error: ${err instanceof Error ? err.message : err}`,
            "Nothing is being decoded and nothing is being logged until it is back.",
            "Check that the radio is powered on — after a mains outage it comes back in standby, not on — and that it is on the network.",
            `This reminder repeats every ${Math.round(reminderMs / 3_600_000)}h until the radio answers.`,
          ],
          { always: true },
        );
      }

      sourceRetry = setTimeout(() => void tick(), Math.min(30_000, 5_000 * attempt));
      sourceRetry.unref?.();
    }
  };

  sourceRetry = setTimeout(() => void tick(), 5_000);
  sourceRetry.unref?.();
}

/**
 * Switch radios without restarting the process.
 *
 * The alternative is "change the setting, then restart the bridge", which is two steps
 * and a terminal for something an operator does to try the other radio. The order here
 * is the FT-0 order, for the same reason: stop the automatic modes and unkey BEFORE
 * anything is torn down, because a transmitting radio is the urgent part.
 *
 * The setting is written as well as applied. A switch that lasted until the next restart
 * and then silently reverted would be worse than no switch at all.
 */
async function switchSource(
  kind: "flex" | "icom" | "wsjtx",
): Promise<{ ok: boolean; error?: string }> {
  if (kind === status.source) return { ok: true };

  console.log(`[bridge] switching source: ${status.source} -> ${kind}`);
  activeAuto()?.setMode("off");
  autoResumeMode = null;
  await persistAutoMode("off");
  try {
    await activeTx?.unkey();
  } catch {
    /* the teardown below drops the radio anyway */
  }

  await (flexTeardown ?? (async () => {}))().catch(() => {});
  flexTeardown = null;
  udpSocket?.close();
  udpSocket = null;

  // A retry loop for the OLD source must not resurrect it under the new one.
  if (sourceRetry) clearTimeout(sourceRetry);
  sourceRetry = null;

  status.source = kind;
  status.radio = null;
  status.connected = false;
  status.commandChannel = false;
  status.transmitting = false;
  status.dialFrequency = null;
  status.band = null;
  // The external decoder path has no per-radio gate of its own; it keeps reading the
  // FlexRadio's, which is what it has always done.
  activeRadio = kind === "icom" ? "icom" : "flex";

  const user = await prisma.user.findFirst({ select: { id: true } });
  if (user) {
    await writeSettings([{ key: "digital.source", value: kind }], user.id);
    invalidateSettingsCache();
  }

  broadcast({ kind: "status", status });

  try {
    flexTeardown = await startActiveSource();
    console.log(`[bridge] source is now ${kind}`);
    broadcast({ kind: "status", status });
    return { ok: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[bridge] could not start ${kind}: ${error}`);
    broadcast({ kind: "status", status });
    // Keep trying. Picking a radio that is currently off is a perfectly reasonable thing
    // to do — it says which radio you WANT — and it should come up when the radio does.
    retrySourceInBackground();
    return { ok: false, error };
  }
}

async function main(): Promise<void> {
  const configuredSource = ((await getSetting("digital.source")) ?? "wsjtx").toLowerCase();
  // "omega" still means the external decoder.
  //
  // It named one particular fork of WSJT-X and was never a thing DigiShack did. The
  // migration rewrites the stored value, but an install configured from .env, or one
  // restored from an older database, must not silently fall through to a source it was
  // never told to use — and the fall-through here is the external decoder anyway, so
  // the only visible difference would be the log line lying about which it picked.
  const digitalSource = configuredSource === "omega" ? "wsjtx" : configuredSource;
  console.log(
    `[bridge] digital.source = ${digitalSource}` +
      (configuredSource === digitalSource ? "" : ` (stored as "${configuredSource}")`),
  );

  // The raw decode log, if the operator asked for one. Opened before any source, so
  // a bad path is reported at startup rather than once per window forever — and not
  // fatal, because losing a log file is not a reason to take the radio off the air.
  const csvDir = (await getSetting("digital.decodeCsvDir"))?.trim();
  if (csvDir) {
    const log = new DecodeCsvLog(csvDir, (m) =>
      console.error(`[bridge] decode CSV write failed: ${m}`),
    );
    try {
      await log.open();
      decodeCsv = log;
      console.log(`[bridge] logging every decode to ${csvDir}/decodes-YYYY-MM-DD.csv`);
    } catch (err) {
      console.error(
        `[bridge] cannot write decodes to ${csvDir}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // Kept for readability; the live handle is flexTeardown, which the supervisor
  // updates whenever it rebuilds the source.
  let stopFlex: (() => Promise<void>) | null = null;

  status.source = digitalSource === "flex" ? "flex" : digitalSource === "icom" ? "icom" : "wsjtx";
  activeRadio = status.source === "icom" ? "icom" : "flex";

  // A radio that is switched off must not stop the bridge from starting.
  //
  // This used to be a bare `await`, so a radio that did not answer threw out of main(),
  // the process exited, PM2 restarted it, and it threw again — 147 restarts against a
  // FlexRadio whose VPN was down, until PM2 gave up. Meanwhile the web page said "no
  // bridge answering", which is a far worse diagnosis than "the radio is not connected":
  // it points at the wrong machine entirely.
  //
  // There is no reason for it. The control API, the status feed, FT-0 and the radio
  // picker are all useful with no radio attached — the picker especially, since the
  // answer may well be "use the other one". So the failure is reported, retried in the
  // background, and everything else comes up regardless.
  try {
    stopFlex = await startActiveSource();
  } catch (err) {
    console.error(
      `[bridge] the ${status.source} source did not start: ${
        err instanceof Error ? err.message : err
      }`,
    );
    console.error(
      "[bridge] carrying on without a radio — the control API, the status feed and the " +
        "radio picker all work, and the source will be retried in the background.",
    );
    status.connected = false;
    status.commandChannel = false;
    retrySourceInBackground();
  }

  const bridgePort = await getNumberSetting("bridge.port", 3101);
  let token = await getSetting("bridge.token");

  // Self-provision the control-API secret. It only authenticates the web app
  // (same install, same database) to this process, so there is nothing for an
  // operator to decide — a missing token just means first run. Requires an admin
  // user to attribute the settings write to; without one, control stays off.
  if (!token) {
    const admin = await prisma.user.findFirst({ where: { role: "ADMIN" } });
    if (admin) {
      const minted = randomBytes(24).toString("hex");
      const result = await writeSettings(
        [{ key: "bridge.token", value: minted }],
        admin.id,
      );
      if (result.updated.includes("bridge.token")) {
        token = minted;
        console.log("[radio] control API key self-provisioned");
      } else {
        console.warn(
          `[radio] could not self-provision the control key: ${JSON.stringify(result.rejected)}`,
        );
      }
    } else {
      console.warn(
        "[radio] control API disabled: no admin user exists yet to own the access key. It self-provisions on the next start after /setup.",
      );
    }
  }

  // Only meaningful with an external decoder: the native paths have nothing to talk
  // to, and rig control there goes through the radio's own API instead.
  const sendToDecoder = (buf: Buffer): boolean => {
    if (!udpSocket || !status.peer) return false;
    udpSocket.send(buf, status.peer.port, status.peer.address);
    return true;
  };

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://localhost:${bridgePort}`);

      // Unauthenticated: read-only, and the web app polls it for the rig readout.
      if (req.method === "GET" && url.pathname === "/status") {
        refreshLinkStatus();
        sendJson(res, 200, {
          status,
          recentDecodes: recentDecodes.slice(-50),
          qso: activeQso()?.state ?? null,
          auto: activeAuto()?.state ?? null,
          telemetry: lastTelemetry,
          clock: clockState(),
        });
        return;
      }

      if (req.method !== "POST") {
        sendJson(res, 404, { error: "Not found" });
        return;
      }

      // Everything below causes the radio to transmit, so it is token-guarded.
      if (!token) {
        sendJson(res, 503, {
          error: "Control API disabled: bridge.token is not configured",
        });
        return;
      }
      const provided = (req.headers["x-bridge-token"] as string | undefined) ?? "";
      if (provided !== token) {
        sendJson(res, 401, { error: "Bad or missing X-Bridge-Token" });
        return;
      }

      // Native-path QSO control. These reach the QSO controller directly; they
      // exist only when digital.source is flex and a transmitter attached.
      if (url.pathname === "/power") {
        const body = await readJson(req);
        const pct = Math.max(1, Math.min(100, Math.round(Number(body.percent))));
        if (!Number.isFinite(pct)) {
          sendJson(res, 400, { error: "percent must be 1-100" });
          return;
        }

        // The Icom takes one CI-V command. This used to be a SmartSDR-only endpoint, so
        // the power slider on the digital page simply did nothing on the other radio —
        // and power is the control that most wants to work, because FT8 is full duty
        // for 12.6 of every 15 seconds.
        if (status.source === "icom") {
          const src = icomSource;
          if (!src) {
            sendJson(res, 503, { error: "The Icom is not connected" });
            return;
          }
          try {
            await src.setRfPowerPercent(pct);
            status.rfPower = pct;
            broadcast({ kind: "status", status });
            sendJson(res, 200, { ok: true, percent: pct });
          } catch (err) {
            sendJson(res, 502, {
              error: err instanceof Error ? err.message : "The radio would not set power",
            });
          }
          return;
        }

        const powerClient = flexGuiClient ?? flexRig;
        if (!powerClient) {
          sendJson(res, 503, { error: "No radio connection" });
          return;
        }
        const reply = await powerClient.command(`transmit set rfpower=${pct}`);
        status.rfPower = pct;
        broadcast({ kind: "status", status });
        sendJson(res, reply.status === 0 ? 200 : 502, {
          ok: reply.status === 0,
          percent: pct,
        });
        return;
      }

      // POST /ft0 — engage or release FT-0 mode.
      //
      // Engaging is a genuine panic stop, in the order that matters: unkey first,
      // because a transmitting radio is the only urgent part; then stop the
      // automatic modes so nothing re-keys; then persist the master transmit switch
      // off so a restart cannot resume; then drop the radio connection.
      //
      // Releasing does NOT turn transmit back on. Coming out of a full stop should
      // be a deliberate act, and silently re-arming a transmitter because someone
      // pressed the same button twice is exactly the surprise this mode exists to
      // prevent.
      if (url.pathname === "/ft0") {
        const body = await readJson(req);
        const engage = body.engage !== false;
        const user = await prisma.user.findFirst({ select: { id: true } });

        if (engage) {
          const wasAuto = activeAuto()?.state.mode ?? "off";
          try {
            await activeTx?.unkey();
          } catch {
            /* the watchdog and the exit hooks are the backstop */
          }
          activeAuto()?.setMode("off");
          // Nothing may resume it after this — clear the held resume mode too.
          autoResumeMode = null;
          if (user) {
            await writeSettings(
              [{ key: transmitGateKey(activeRadio), value: "false" }],
              user.id,
            );
            invalidateSettingsCache();
          }
          await (flexTeardown ?? stopFlex)?.().catch(() => {});
          flexTeardown = null;
          status.ft0 = true;
          status.connected = false;
          status.commandChannel = false;
          status.transmitting = false;
          status.txEnabled = false;
          broadcast({ kind: "status", status });
          console.log(
            `[ft0] engaged — auto "${wasAuto}" stopped, transmit disabled, radio released. ` +
              `0 baud, 0 Hz, 100% success rate.`,
          );
          sendJson(res, 200, {
            ok: true,
            ft0: true,
            wasAuto,
            detail:
              "FT-0 engaged. Nothing is connected and nothing is transmitting. " +
              "Transmit stays disabled until you turn it back on deliberately.",
          });
          return;
        }

        status.ft0 = false;
        broadcast({ kind: "status", status });
        try {
          flexTeardown = await startActiveSource();
          console.log("[ft0] released — radio reconnected, transmit still disabled");
          sendJson(res, 200, {
            ok: true,
            ft0: false,
            detail:
              "FT-0 released and the radio is back. Transmit is still off — enable it in Settings when you mean to.",
          });
        } catch (err) {
          sendJson(res, 502, {
            ok: false,
            ft0: false,
            error: err instanceof Error ? err.message : "Could not reconnect to the radio",
          });
        }
        return;
      }

      // POST /time/sync — measure the clock now.
      //
      // Worth a button because the alternative on a quiet band is no answer at all: the
      // decode-median estimate needs eight decodes before it will say anything, and a
      // station that cannot hear anybody is exactly the station wondering whether its
      // clock is why.
      if (url.pathname === "/time/sync") {
        const r = await syncClock();
        sendJson(res, r.ok ? 200 : 502, { ok: r.ok, detail: r.detail, clock: clockState() });
        return;
      }

      // POST /tune — move to a band's calling frequency, on whichever radio is live.
      //
      // The band buttons used to post to /api/flex/tune, which opens its own connection
      // to a FlexRadio from the web tier and knows nothing about which radio the bridge
      // is driving. On the Icom that meant going looking for a Flex slice and failing
      // with "the radio has no active slice to tune" — about a radio that was not even
      // selected. Rig control belongs to the process that owns the radio.
      if (url.pathname === "/tune") {
        const body = await readJson(req);
        const band = String(body.band ?? "").toUpperCase();
        const mode = String(body.mode ?? "FT8").toUpperCase() as DigitalMode;
        if (!["FT8", "FT4", "FT2"].includes(mode)) {
          sendJson(res, 400, { error: "mode must be FT8, FT4 or FT2" });
          return;
        }
        const hz = callingFrequencyHz(band, mode);
        if (hz === null) {
          sendJson(res, 404, { error: `No ${mode} calling frequency is listed for ${band}` });
          return;
        }

        if (status.source === "icom") {
          if (!icomSource) {
            sendJson(res, 503, { error: "The Icom is not connected" });
            return;
          }
          try {
            await icomSource.setFrequencyHz(hz);
            // A digital calling frequency implies the mode. The transmitter sets this
            // before every transmission anyway; doing it here means the RECEIVER is
            // right too, which is what decodes depend on.
            await icomSource.setDataMode().catch(() => {});
            sendJson(res, 200, { ok: true, band, mode, freqHz: hz });
          } catch (err) {
            sendJson(res, 502, {
              error: err instanceof Error ? err.message : "The radio would not tune",
            });
          }
          return;
        }

        if (status.source === "flex") {
          const client = flexGuiClient ?? flexRig;
          if (!client) {
            sendJson(res, 503, { error: "The FlexRadio is not connected" });
            return;
          }
          const reply = await client.command(
            `slice tune ${flexSliceIndex ?? 0} ${(hz / 1_000_000).toFixed(6)}`,
          );
          sendJson(res, reply.status === 0 ? 200 : 502, {
            ok: reply.status === 0,
            band,
            mode,
            freqHz: hz,
            error:
              reply.status === 0
                ? undefined
                : `The radio rejected the retune (0x${reply.status.toString(16)})`,
          });
          return;
        }

        sendJson(res, 503, {
          error: "Rig control needs a native radio — the external decoder path has none",
        });
        return;
      }

      // POST /source — change radios without restarting the process.
      if (url.pathname === "/source") {
        const body = await readJson(req);
        const kind = String(body.kind ?? "");
        if (!["flex", "icom", "wsjtx"].includes(kind)) {
          sendJson(res, 400, { error: "kind must be flex | icom | wsjtx" });
          return;
        }
        // Voice mode does not follow a radio change.
        //
        // It promises two things — digital cannot transmit, and the radio is in a microphone
        // mode — and the second is a fact about a specific radio. Switching left the flag set
        // while the new radio came up in DIGU, so the page claimed voice mode on a radio in a
        // data mode. Dropped deliberately, like automatic modes, and the operator re-enters it.
        if (voice.active) {
          voice = idleVoiceState();
          setDigitalTransmitHold(false);
          status.voice = { active: false, mode: null, since: null };
          console.log("[radio] voice mode dropped: it belongs to a radio, and the radio changed");
        }
        // And forget what the OTHER radio reported. AGC, the noise blanker and the filter
        // are per radio, and showing the Icom's readings next to a FlexRadio is worse than
        // showing none.
        status.radioMode = null;
        status.receiver = { ...UNREAD_RECEIVER };

        const r = await switchSource(kind as "flex" | "icom" | "wsjtx");
        sendJson(res, r.ok ? 200 : 502, {
          ok: r.ok,
          source: status.source,
          error: r.error,
          detail: r.ok
            ? `Source is now ${status.source}. Any automatic mode was stopped — turn it back on deliberately.`
            : undefined,
        });
        return;
      }

      // Voice mode on or off.
      //
      // Turning it ON stops digital dead: automatic operation off, the decode pipeline
      // muted so the list stops filling and PSKReporter stops being told about it, and the
      // radio moved out of the data mode that ignores the microphone. Turning it OFF
      // restores the data mode but deliberately does NOT restart automatic operation —
      // same principle as changing radios, because resuming an unattended session is a
      // decision an operator should make in the open.
      if (url.pathname === "/voice") {
        const body = await readJson(req);
        const want = Boolean(body.active);

        if (want === voice.active) {
          sendJson(res, 200, { ok: true, voice, detail: "Already there" });
          return;
        }

        if (want) {
          const dialHz = status.dialFrequency;
          const sideband = conventionalSideband(dialHz);
          // NOT status.mode — that is the digital mode (FT8/FT4), not the radio's
          // modulation, and recording it here produced restoreTo: "FT8". Nothing is
          // recorded instead: what digital needs on the way back is USB-D or DIGU
          // regardless of what the radio happened to be in, so there is nothing to
          // remember and pretending otherwise was the whole error.
          const was = null;

          // Stop the digital operator BEFORE the mode changes, so it cannot start a
          // transmission into a radio that is halfway between two modes.
          activeAuto()?.setMode("off");
          // Close the gate the TRANSMITTERS read, not just the one the endpoints read.
          // Without this a QSO already in flight kept keying and sending FT8 while the
          // operator was switching to voice — see isTransmitArmed.
          setDigitalTransmitHold(true);
          // And stop the transmission that is happening right now. Letting the current
          // waveform finish is the wrong answer for a control whose whole purpose is "the
          // microphone owns the radio from this moment".
          await activeTx?.unkey().catch(() => {});
          voice = { active: true, restoreTo: was, mode: sideband, since: Date.now() };
          status.voice = { active: true, mode: sideband, since: voice.since };
          // Said in the warnings list rather than refused: a radio moved to CW or a data
          // mode from its own front panel while voice is on is not something software
          // should fight, but the symptom otherwise is a radio that keys and sends nothing.
          if (!isVoiceCapableMode(sideband)) {
            status.txWarnings = [...status.txWarnings, `${sideband} does not carry a microphone`];
          }

          // Muted a long way out rather than "forever": a bridge restart clears it anyway,
          // and an unbounded value is the sort of thing that turns into a permanent deaf
          // receiver when a later refactor forgets to clear it.
          icomSource?.muteReceiveUntil(Date.now() + 24 * 3_600_000);
          // And redraw the waterfall for speech rather than for FT8 tones. The digital
          // profile transforms 170 ms of audio to separate tones 6 Hz apart, and 170 ms is
          // most of a spoken syllable — so voice comes out as blobs four times a second.
          icomSource?.setSpectrumProfile("voice");
          flexSource?.setSpectrumProfile("voice");

          let detail = `Voice mode on — ${sideband}`;
          try {
            if (status.source === "icom" && icomSource) {
              await icomSource.setVoiceMode(sideband);
            } else if (status.source === "flex") {
              const shared = flexGuiClient ?? flexRig;
              const idx = flexSliceIndex ?? 0;
              const r = await shared?.command(`slice set ${idx} mode=${sideband}`);
              if (r && r.status !== 0) detail += ` (the radio refused mode=${sideband})`;
            } else {
              detail += " — no native radio, so nothing was switched";
            }
          } catch (err) {
            detail += ` (mode change failed: ${err instanceof Error ? err.message : err})`;
          }
          console.log(`[radio] ${detail}. Digital transmit is closed until voice mode is off.`);
          broadcast({ kind: "status", status });
          sendJson(res, 200, { ok: true, voice, detail });
          return;
        }

        // Leaving. Put the radio back into the mode digital needs — which is a fixed
        // answer, not a remembered one.
        voice = idleVoiceState();
        setDigitalTransmitHold(false);
        icomSource?.setSpectrumProfile("digital");
        flexSource?.setSpectrumProfile("digital");
        status.voice = { active: false, mode: null, since: null };
        let detail = "Voice mode off";
        // Back to the modulation this FREQUENCY wants, not to USB-D whatever the dial says.
        //
        // Blindly restoring the data mode left the radio in USB-D on 7.200 MHz — a data mode
        // in a phone segment, which hears voice badly and cannot legally or usefully transmit
        // FT8 there anyway, since an automatic mode now refuses to start off a digital
        // frequency. The frequency knows what it wants; ask it.
        const back = modulationForFrequency(status.dialFrequency ?? 0) ?? "USB-D";
        try {
          if (status.source === "icom" && icomSource) {
            const set = await icomSource.setModulation(back);
            status.radioMode = set;
            detail += ` — back to ${set}`;
          } else if (status.source === "flex") {
            const shared = flexGuiClient ?? flexRig;
            const idx = flexSliceIndex ?? 0;
            // The modulation the frequency wants, in SmartSDR's spelling.
            const target = back === "USB-D" ? "DIGU" : back === "LSB-D" ? "DIGL" : back;
            const r = await shared?.command(`slice set ${idx} mode=${target}`);
            detail += r && r.status === 0 ? ` — back to ${target}` : ` (the radio refused ${target})`;
          }
        } catch (err) {
          detail += ` (mode change failed: ${err instanceof Error ? err.message : err})`;
        }
        console.log(`[radio] ${detail}. Automatic operation stays OFF — turn it on deliberately.`);
        broadcast({ kind: "status", status });
        sendJson(res, 200, { ok: true, voice, detail });
        return;
      }

      if (url.pathname === "/auto") {
        const auto = activeAuto();
        if (!auto) {
          sendJson(res, 503, { error: "Auto operation needs the native transmit path" });
          return;
        }
        const body = await readJson(req);
        const mode = String(body.mode ?? "off") as AutoMode;
        // Every mode except `off` will eventually key the radio, so enabling one with
        // the gate shut is a request that cannot be honoured. Saying so now beats a
        // status line that reads "hunting K1ABC" forever while nothing transmits.
        if (mode !== "off" && !(await transmitArmed())) {
          // Two different reasons, two different places to go. This said "turn on Allow
          // transmit in Settings" whatever was wrong, and in voice mode that is a wrong
          // instruction — the setting is already on and the thing to change is one click
          // away on this very page.
          sendJson(res, 403, {
            error: voice.active
              ? `${VOICE_REFUSAL} (an automatic mode would never key the radio while it is on)`
              : "Transmit is off, so an automatic mode would never key the radio. Turn on " +
                `"Allow transmit" in Settings → ${gateSettingsTab()} first.`,
          });
          return;
        }
        // Refuse to operate automatically on a frequency that is not a digital one.
        //
        // This station transmitted FT8 on 7.200 MHz once — a phone frequency — because a test
        // left the dial there and CQ mode was enabled without anybody checking where the radio
        // was pointing. Nothing refused it: the gate was open, the guards were happy, the band
        // was legal. An automatic mode is precisely the case where nobody is looking at the
        // dial, so this is where the check belongs.
        //
        // The operator can still transmit there by hand. What is refused is walking away and
        // leaving a machine to do it.
        if (mode !== "off") {
          const dialHz = status.dialFrequency;
          const digitalMode = (status.mode ?? "FT8").toUpperCase();
          const forMode = digitalMode === "FT4" ? "FT4" : digitalMode === "FT2" ? "FT2" : "FT8";
          if (dialHz === null) {
            sendJson(res, 409, {
              error: "The radio has not reported its frequency yet — nothing automatic can start",
            });
            return;
          }
          if (!digitalCallingFrequency(dialHz, forMode)) {
            const near = nearestDigitalFrequency(dialHz, forMode);
            sendJson(res, 409, {
              error:
                `${(dialHz / 1e6).toFixed(3)} MHz is not ${forMode} — an automatic mode here ` +
                `would transmit ${forMode} outside a digital segment` +
                (near ? `. The nearest ${forMode} frequency is ${(near / 1e6).toFixed(3)} MHz.` : "."),
            });
            return;
          }
        }
        if (!["off", "cq", "hunt", "hunt-pota", "pota-chase"].includes(mode)) {
          sendJson(res, 400, { error: "mode must be off | cq | hunt | hunt-pota | pota-chase" });
          return;
        }
        auto.setMode(mode);
        // Enabling a mode re-arms the guards, which closes any announced
        // guard-fault incident the same way an explicit re-arm does.
        if (mode !== "off") guardFaultsCleared();
        // Remember it across a PROCESS restart, not just a radio reconnect.
        //
        // The reconnect path below has held the mode in memory since 0.52.0, which
        // covers a dropped command channel and nothing else. Under PM2 with
        // autorestart, a crash at 2am silently ended the session instead — the same
        // failure that path was written to prevent, one level up.
        void persistAutoMode(mode);
        sendJson(res, 200, { ok: true, auto: auto.state });
        return;
      }

      // Rig control for the CAT panel. All of it goes through the GUI-client
      // connection, for the same reason RF power does: the radio ignores several
      // of these from a non-GUI client, silently.
      if (url.pathname === "/rig") {
        // The CAT panel on the Icom.
        //
        // Everything here except the filter passband now has a CI-V equivalent, and each
        // write waits for the radio's own OK or NG reply — so a sub-command this model
        // does not implement is reported as refused rather than silently doing nothing.
        // That confirmation is the point: nothing reads these back, so without it a wrong
        // command byte would be indistinguishable from success.
        //
        // Still refused by name, each for a reason:
        //   filterLo/filterHi — the Icom selects FIL1/2/3, whose widths live in the
        //     radio's menu, so there is no honest mapping from a passband in Hz. Guessing
        //     one would move the filter to something the operator did not ask for.
        //   agc: "off" — these radios have no AGC-OFF in this command set.
        if (status.source === "icom") {
          const src = icomSource;
          if (!src) {
            sendJson(res, 503, { error: "The Icom is not connected" });
            return;
          }
          const body = await readJson(req);
          // rxAnt/txAnt: these radios have ONE antenna socket, so there is nothing to
          // select. Named rather than ignored, for the same reason as the filter widths —
          // a control that silently does nothing is the failure this list exists to stop.
          const unsupported = ["filterLo", "filterHi", "rxAnt", "txAnt"].filter(
            (k) => body[k] !== undefined,
          );
          if (body.agc !== undefined && String(body.agc).toLowerCase() === "off") {
            unsupported.push("agc=off");
          }
          const results: { cmd: string; status: number }[] = [];
          try {
            if (body.freqHz !== undefined) {
              const hz = Number(body.freqHz);
              if (!Number.isFinite(hz) || hz < 1_800_000 || hz > 1_300_000_000) {
                sendJson(res, 400, { error: "freqHz is outside the amateur spectrum" });
                return;
              }
              await src.setFrequencyHz(hz);
              results.push({ cmd: `setFrequencyHz ${hz}`, status: 0 });
            }
            if (typeof body.mode === "string" && body.mode.trim() !== "") {
              // Was a three-name regex that answered USB, DIGU and USB-D all with
              // setDataMode() — so picking USB gave USB-D, and LSB, CW, AM, FM and RTTY did
              // nothing at all, silently, with the picker springing back.
              const set = await src.setModulation(String(body.mode));
              status.radioMode = set;
              results.push({ cmd: `mode ${set}`, status: 0 });
            }
            if (body.agc !== undefined && String(body.agc).toLowerCase() !== "off") {
              await src.setAgc(String(body.agc));
              results.push({ cmd: `agc ${String(body.agc).toLowerCase()}`, status: 0 });
            }
            if (body.rfGain !== undefined) {
              const pct = Number(body.rfGain);
              if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
                // The FlexRadio's rfGain is dB of attenuation on a -10..+30 scale; the
                // Icom's is a percentage. Rejecting out-of-range rather than clamping,
                // because a -10 silently becoming 0% is the panel lying about the radio.
                sendJson(res, 400, {
                  error: "rfGain is 0-100 on the Icom, not the FlexRadio's dB scale",
                });
                return;
              }
              await src.setRfGainPercent(pct);
              results.push({ cmd: `rfGain ${Math.round(pct)}%`, status: 0 });
            }
            if (body.nb !== undefined) {
              await src.setNoiseBlanker(Boolean(body.nb));
              results.push({ cmd: `nb ${body.nb ? "on" : "off"}`, status: 0 });
            }
            if (body.nr !== undefined) {
              await src.setNoiseReduction(Boolean(body.nr));
              results.push({ cmd: `nr ${body.nr ? "on" : "off"}`, status: 0 });
            }
            if (body.tune !== undefined) {
              // The Icom's equivalent of a tune carrier is the internal ATU's tune cycle,
              // and it keys the radio — so it is gated exactly like the FlexRadio's, and
              // like every other keying path here.
              if (!(await transmitArmed())) {
                sendJson(res, 403, { error: transmitRefusal() });
                return;
              }
              if (body.tune) {
                await src.tuneAtu();
                results.push({ cmd: "atu tune", status: 0 });
              } else {
                // No "stop tuning" on the ATU: the cycle runs a few seconds and ends by
                // itself. Unkeying is still the right answer to being told to stop, and it
                // goes through the transmitter, which is the only thing that keys.
                await activeTx?.unkey();
                results.push({ cmd: "unkey", status: 0 });
              }
            }
          } catch (err) {
            sendJson(res, 502, {
              error: err instanceof Error ? err.message : "The radio would not accept that",
            });
            return;
          }
          if (results.length === 0 && unsupported.length === 0) {
            sendJson(res, 400, { error: "Nothing to change" });
            return;
          }
          sendJson(res, 200, {
            ok: true,
            results,
            unsupported: unsupported.length > 0 ? unsupported : undefined,
            detail:
              unsupported.length > 0
                ? `Not available on the Icom: ${unsupported.join(", ")}`
                : undefined,
          });
          return;
        }

        const rig = flexGuiClient ?? flexRig;
        if (!rig) {
          sendJson(res, 503, { error: "No radio connection" });
          return;
        }
        const sliceIdx = flexSliceIndex ?? 0;
        const body = await readJson(req);
        const cmds: string[] = [];

        if (body.freqHz !== undefined) {
          const hz = Number(body.freqHz);
          if (!Number.isFinite(hz) || hz < 1_800_000 || hz > 1_300_000_000) {
            sendJson(res, 400, { error: "freqHz is outside the amateur spectrum" });
            return;
          }
          cmds.push(`slice tune ${sliceIdx} ${(hz / 1_000_000).toFixed(6)}`);
        }
        if (typeof body.mode === "string" && body.mode.trim() !== "") {
          // Translated, not passed through. The picker speaks one vocabulary for both radios
          // and SmartSDR has its own names for the data modes — and the pattern here used to
          // allow letters only, so "USB-D" was rejected before the radio ever saw it. Every
          // data mode selection on the FlexRadio silently did nothing.
          const flexMode = toFlexMode(body.mode);
          if (!flexMode) {
            sendJson(res, 400, { error: `"${body.mode}" is not a modulation this radio has` });
            return;
          }
          cmds.push(`slice set ${sliceIdx} mode=${flexMode}`);
        }
        if (body.filterLo !== undefined && body.filterHi !== undefined) {
          cmds.push(`filt ${sliceIdx} ${Number(body.filterLo)} ${Number(body.filterHi)}`);
        }
        if (body.agc !== undefined && /^(off|slow|med|fast)$/i.test(String(body.agc))) {
          cmds.push(`slice set ${sliceIdx} agc_mode=${String(body.agc).toLowerCase()}`);
        }
        if (body.rfGain !== undefined) {
          cmds.push(`slice set ${sliceIdx} rfgain=${Math.round(Number(body.rfGain))}`);
        }
        // The antenna port, on a radio with more than one.
        //
        // Validated against the list THE RADIO reported rather than against a table here:
        // a 6400 answers ANT1, ANT2, RX_A, XVTA and a 6300 does not have the same four,
        // and the transmit list is shorter than the receive list because RX_A is a
        // receive-only BNC. Refused with the real list in the message — sending an
        // unknown port would either be ignored by the radio or, worse, accepted.
        let panAnt: string | null = null;
        if (body.rxAnt !== undefined || body.txAnt !== undefined) {
          const ports = rig.state.antennas;
          for (const [field, role, list] of [
            ["rxAnt", "receive", ports.rx],
            ["txAnt", "transmit", ports.tx],
          ] as const) {
            if (body[field] === undefined) continue;
            const choice = resolveAntenna(String(body[field]), list, role);
            if (choice.refused) {
              sendJson(res, 400, { error: choice.refused });
              return;
            }
            if (!choice.ant) continue;
            cmds.push(
              `slice set ${sliceIdx} ${role === "receive" ? "rxant" : "txant"}=${choice.ant}`,
            );
            if (role === "receive") panAnt = choice.ant;
          }
        }
        // The radio accepts these and, in the case of `nb`, never mentions them again —
        // see noteNoiseState. The command is still what changes the radio; the note is
        // what lets the panel show that it happened.
        if (body.nb !== undefined) cmds.push(`slice set ${sliceIdx} nb=${body.nb ? 1 : 0}`);
        if (body.nr !== undefined) cmds.push(`slice set ${sliceIdx} nr=${body.nr ? 1 : 0}`);
        if (body.tune !== undefined) {
          // Explicit tune carrier. Gated like every other keying path.
          if (!(await transmitArmed())) {
            sendJson(res, 403, { error: transmitRefusal() });
            return;
          }
          cmds.push(`transmit tune ${body.tune ? 1 : 0}`);
        }

        if (cmds.length === 0) {
          sendJson(res, 400, { error: "Nothing to change" });
          return;
        }
        const results: { cmd: string; status: number }[] = [];
        for (const cmd of cmds) {
          const r = await rig.command(cmd);
          results.push({ cmd, status: r.status });
        }
        const allOk = results.every((r) => r.status === 0);

        // Record the noise settings the radio will not report back. Only on success, so a
        // refused command never leaves the panel claiming a state the radio is not in.
        if (allOk && flexSource) {
          if (body.nb !== undefined) flexSource.noteNoiseState("nb", Boolean(body.nb));
          if (body.nr !== undefined) flexSource.noteNoiseState("nr", Boolean(body.nr));
          // The panadapter carries its own antenna and does not follow the slice. A
          // receiver moved to ANT2 with the display left on ANT1 shows a spectrum of a
          // socket nobody is listening to, and nothing about the display says so.
          if (panAnt) await flexSource.setPanadapterAntenna(panAnt).catch(() => {});
        }

        sendJson(res, allOk ? 200 : 502, { ok: allOk, results });
        return;
      }

      if (url.pathname === "/pan-span") {
        // Zoom the RF panadapter. Live, so the operator can widen the view to find
        // activity and narrow it to work a station without a bridge restart — the span
        // was previously only reachable as a Setting, which meant it never got changed.
        const body = (await readJson(req)) as { spanHz?: unknown } | null;
        const spanHz = Number(body?.spanHz);
        if (!Number.isFinite(spanHz) || spanHz <= 0) {
          sendJson(res, 400, { error: "spanHz must be a positive number of hertz" });
          return;
        }

        if (activeRadio !== "flex" || !flexSource) {
          // The Icom's spectrum comes from the radio's own scope, whose width is set on
          // the radio. Saying so is better than silently doing nothing.
          sendJson(res, 501, {
            error: "Panadapter zoom is a FlexRadio feature — the Icom's scope span is set on the radio",
          });
          return;
        }

        const applied = await flexSource.setPanSpan(spanHz);
        if (applied === null) {
          sendJson(res, 503, { error: "The panadapter is not running" });
          return;
        }
        // Remembered, so the next bridge start comes up at the span the operator chose
        // rather than back at the default. Best-effort: the zoom has already happened,
        // and failing to persist it is not a reason to report the zoom as failed.
        const spanUser = await prisma.user.findFirst({ select: { id: true } });
        if (spanUser) {
          await writeSettings(
            [{ key: "flex.panadapterSpanKHz", value: String(Math.round(applied / 1000)) }],
            spanUser.id,
          ).catch(() => {});
          invalidateSettingsCache();
        }
        sendJson(res, 200, { ok: true, spanHz: applied });
        return;
      }

      if (url.pathname === "/atu") {
        // Gated before anything else: an ATU cycle is a low-power carrier, and one
        // into a disconnected antenna is exactly as unwise as a CQ into one.
        if (!(await transmitArmed())) {
          sendJson(res, 403, { error: "ATU tune keys the transmitter — enable Allow transmit first" });
          return;
        }

        if (activeRadio === "icom") {
          const src = icomSource;
          if (!src) {
            sendJson(res, 503, { error: "No radio connection" });
            return;
          }
          // Waits for the tuner to finish rather than returning on the acknowledgement.
          // "Tuning started" is not the answer to "is the antenna matched".
          const r = await src.tuneAtu();
          sendJson(res, r.ok ? 200 : 502, {
            ok: r.ok,
            state: r.state,
            detail: r.reason,
          });
          return;
        }

        const atuClient = flexGuiClient ?? flexRig;
        if (!atuClient) {
          sendJson(res, 503, { error: "No radio connection" });
          return;
        }
        const reply = await atuClient.command("atu start");
        sendJson(res, reply.status === 0 ? 200 : 502, {
          ok: reply.status === 0,
          detail: reply.message.trim() || undefined,
        });
        return;
      }

      if (["/call", "/qso-halt", "/qso-skip", "/rearm"].includes(url.pathname)) {
        const qso = activeQso();
        if (!qso) {
          sendJson(res, 503, {
            error:
              "Native transmit is not available — digital.source must be flex or icom, the " +
              "radio must have attached a transmitter, and a station must exist",
          });
          return;
        }
        const body = await readJson(req);
        switch (url.pathname) {
          case "/call": {
            // Refuse here rather than accepting and failing a cycle later.
            //
            // This used to return 200, and the panel would say "Calling — waiting for
            // their report" while nothing keyed. The refusal arrived a cycle later in
            // 12px subtle text, and in auto mode the panel that shows it is not even
            // rendered. /tune and /atu have always answered 403 with a reason; these
            // two were the inconsistency.
            if (!(await transmitArmed())) {
              sendJson(res, 403, {
                error:
                  'Transmit is off. Turn on "Allow transmit" in Settings → ' +
                  `${gateSettingsTab()} before calling anyone.`,
              });
              return;
            }
            const result = await qso.startCall({
              theirCall: String(body.theirCall ?? "").toUpperCase(),
              theirGrid: body.theirGrid ? String(body.theirGrid) : null,
              theirSnr: Number(body.theirSnr ?? 0),
              theirOffsetHz: Number(body.theirOffsetHz ?? 1500),
              theirWindowStart: Number(body.theirWindowStart ?? 0),
              // The decode the operator clicked, so the transcript opens with it.
              // Optional: an older client that does not send it still gets a
              // transcript, just one that starts with our own first transmission.
              theirMessage: body.message ? String(body.message).slice(0, 128) : null,
            });
            sendJson(res, result.ok ? 200 : 409, { ...result, qso: qso.state });
            return;
          }
          case "/qso-halt":
            // HALT means everything: the active QSO and any auto mode.
            activeAuto()?.setMode("off");
            await qso.halt();
            sendJson(res, 200, { ok: true, qso: qso.state });
            return;
          case "/qso-skip":
            // Skip gives up on THIS station only — the auto mode keeps running and
            // picks someone else next window.
            await qso.skip();
            sendJson(res, 200, { ok: true, qso: qso.state });
            return;
          case "/rearm":
            qso.rearm();
            // A re-arm closes any announced guard-fault incident (SWR, PA heat).
            guardFaultsCleared();
            sendJson(res, 200, { ok: true, qso: qso.state });
            return;
        }
      }

      if (!status.decoderId || !status.peer) {
        // On a native path there is no external decoder and never will be; any route
        // that got this far simply doesn't exist there.
        sendJson(res, 404, {
          error: activeQso()
            ? `No such control action: ${url.pathname}`
            : "The external-decoder path (digital.source=wsjtx) has not connected yet",
        });
        return;
      }

      const body = await readJson(req);
      const id = status.decoderId;

      switch (url.pathname) {
        case "/reply": {
          // Must echo the originating decode: the decoder matches the reply against its
          // own decode list and silently ignores a mismatch.
          const ok = sendToDecoder(
            encodeReply({
              id,
              time: Number(body.time ?? 0),
              snr: Number(body.snr ?? 0),
              deltaTime: Number(body.deltaTime ?? 0),
              deltaFrequency: Number(body.freqOffset ?? 0),
              mode: String(body.mode ?? "FT8"),
              message: String(body.message ?? ""),
            }),
          );
          sendJson(res, ok ? 200 : 503, { sent: ok });
          return;
        }
        case "/halt":
          sendJson(res, 200, { sent: sendToDecoder(encodeHaltTx(id, Boolean(body.autoOnly))) });
          return;
        case "/highlight":
          sendJson(res, 200, {
            sent: sendToDecoder(
              encodeHighlightCallsign({
                id,
                callsign: String(body.callsign ?? ""),
                background: (body.background as { r: number; g: number; b: number }) ?? {
                  r: 194,
                  g: 24,
                  b: 7,
                },
                foreground: (body.foreground as { r: number; g: number; b: number }) ?? {
                  r: 255,
                  g: 255,
                  b: 255,
                },
              }),
            ),
          });
          return;
        case "/replay":
          sendJson(res, 200, { sent: sendToDecoder(encodeReplay(id)) });
          return;
        case "/clear":
          sendJson(res, 200, {
            sent: sendToDecoder(encodeClear(id, Number(body.window ?? 0))),
          });
          return;
        case "/free-text":
          sendJson(res, 200, {
            sent: sendToDecoder(
              encodeFreeText(id, String(body.text ?? ""), Boolean(body.send)),
            ),
          });
          return;
        default:
          sendJson(res, 404, { error: "Not found" });
      }
    })().catch((err) => {
      console.error("[bridge] request failed:", err);
      sendJson(res, 500, { error: "Internal error" });
    });
  });

  const wss = new WebSocketServer({ noServer: true });

  /**
   * Browsers listening to receiver audio.
   *
   * Its own socket rather than binary frames on the decode socket, because audio is
   * 96 kB/s at 48 kHz and every open page would receive it whether it wanted to or not.
   * Nobody listening means nothing is converted and nothing is sent — the tee below returns
   * on an empty set before it touches a sample.
   */
  const audioClients = new Set<WebSocket>();
  const audioWss = new WebSocketServer({ noServer: true });

  // The tee itself. Float32 in, 16-bit PCM out — half the bytes, and the format every
  // browser can turn into an AudioBuffer without a codec.
  //
  // Returns on the empty set FIRST, before the conversion, because this is called for every
  // audio frame the radio sends whether anybody is listening or not: at 48 kHz that is a
  // few hundred times a second, on the same thread as the decoder.
  sendAudio = (samples: Float32Array): void => {
    if (audioClients.size === 0) return;
    const pcm = float32ToS16le(samples);
    for (const ws of audioClients) {
      // Drop rather than queue when a listener cannot keep up. Audio is only useful live,
      // and a backlog on a slow socket would grow without bound and eventually take the
      // bridge's memory with it.
      if (ws.bufferedAmount > 400_000) continue;
      try {
        ws.send(pcm);
      } catch {
        audioClients.delete(ws);
      }
    }
  };

  server.on("upgrade", (req, sock, head) => {
    const { pathname } = new URL(req.url ?? "/", `http://localhost:${bridgePort}`);

    if (pathname === "/ws/audio") {
      audioWss.handleUpgrade(req, sock, head, (ws) => {
        audioClients.add(ws);
        ws.binaryType = "nodebuffer";
        // A listener has to be told the sample rate before the first frame means anything:
        // the Icom streams 48 kHz and the FlexRadio 24 kHz, and playing one at the other's
        // rate is a station that sounds like it is under water or on fast forward.
        try {
          ws.send(
            JSON.stringify({
              kind: "audio-hello",
              sampleRate: audioSampleRate(),
              format: "s16le",
              channels: 1,
              source: status.source,
            }),
          );
        } catch {
          /* a socket that died between upgrade and hello */
        }
        ws.on("close", () => audioClients.delete(ws));
        ws.on("error", () => audioClients.delete(ws));
        console.log(`[audio] listener attached (${audioClients.size} now)`);
      });
      return;
    }

    if (pathname !== "/ws/decodes") {
      sock.destroy();
      return;
    }
    wss.handleUpgrade(req, sock, head, (ws) => {
      clients.add(ws);
      // Give a new client the current picture immediately, rather than a blank
      // panel until the next 15-second cycle.
      try {
        ws.send(JSON.stringify({ kind: "status", status }));
        ws.send(JSON.stringify({ kind: "backlog", decodes: recentDecodes.slice(-50) }));
        if (lastSpectrum) ws.send(JSON.stringify(lastSpectrum));
        if (lastPanadapter) ws.send(JSON.stringify(lastPanadapter));
        // The auto and QSO states are otherwise only broadcast when they CHANGE, so a
        // browser opened after the schedule (or another browser) picked a mode showed
        // "Off" until the next change — which, for a station happily hunting all
        // afternoon, could be hours away.
        const auto = activeAuto();
        if (auto) ws.send(JSON.stringify({ kind: "auto", auto: auto.state }));
        const qso = activeQso();
        if (qso) ws.send(JSON.stringify({ kind: "qso", qso: qso.state }));
      } catch {
        /* ignore */
      }
      ws.on("close", () => clients.delete(ws));
      ws.on("error", () => clients.delete(ws));
    });
  });

  // Without this, a port clash raises an unhandled 'error' event and the process
  // dies *after* a DAX stream has been created — leaving the radio streaming
  // audio to a socket nobody owns. Shut down through the normal path instead.
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `[bridge] port ${bridgePort} is already in use — another bridge is probably running.\n` +
          `         Stop it first, or change bridge.port in Settings.`,
      );
    } else {
      console.error("[bridge] HTTP server error:", err.message);
    }

    void (async () => {
      // Release the radio-side resources before exiting.
      await (flexTeardown ?? stopFlex)?.().catch(() => {});
      udpSocket?.close();
      process.exit(1);
    })();
  });

  // Bind LOOPBACK explicitly.
  //
  // Omitting the host made Node listen on 0.0.0.0 while the log line below, the
  // comment in pages/api/bridge/status.ts and deploy/nginx/digishack.conf all
  // assert loopback-only — and GET /status needs no authentication. On any machine
  // with a route to the shack LAN this exposed radio status, and /power and slice
  // tune behind nothing but a bearer token.
  // Loopback by default. See the setting's help text for what opening it exposes — the
  // control API has a shared secret and the WebSockets have nothing.
  const bindAddress = (await getSetting("bridge.bindAddress")) || "127.0.0.1";
  server.listen(bridgePort, bindAddress, () => {
    console.log(
      `[bridge] http+ws on http://${bindAddress}:${bridgePort} (ws /ws/decodes, /ws/audio)` +
        (bindAddress === "127.0.0.1"
          ? " — this machine only, so audio cannot be heard from another device"
          : " — REACHABLE FROM YOUR NETWORK, and the WebSockets are unauthenticated"),
    );
  });

  // No heartbeat for 30s means the external decoder is gone.
  //
  // ONLY there. This check predates the native paths and assumes `connected` means an
  // external decoder is talking to us; on a native radio the heartbeat comes from decode
  // windows, and a genuinely quiet band produces none. Left ungated it fired on the Icom
  // within a minute of connecting and said the decoder had gone quiet about a radio that was
  // decoding perfectly — the liveness watchdog is what covers the native paths, and it
  // watches windows rather than decodes precisely so silence does not look like death.
  if (status.source === "wsjtx") {
    setInterval(() => {
      if (
        status.connected &&
        status.lastHeartbeat !== null &&
        Date.now() - status.lastHeartbeat > 30_000
      ) {
        markDisconnected();
      }
    }, 5_000);
  }

  // Automatic QSL emailing, if it is switched on.
  //
  // On a timer rather than on the qso-logged event: a run of FT8 contacts would
  // otherwise fire a run of mail, and the age floor in runAutoQsl exists precisely
  // to put distance between logging a contact and emailing a stranger about it.
  //
  // The interval is read once at start, like every other bridge setting. Nothing
  // sends unless BOTH qsl.auto.enabled and qsl.auto.approve are on.
  const autoQslMinutes = await getNumberSetting("qsl.auto.intervalMinutes", 30);
  const autoQslEnabled = await getBooleanSetting("qsl.auto.enabled", false);
  if (autoQslEnabled) {
    const approve = await getBooleanSetting("qsl.auto.approve", false);
    console.log(
      `[qsl] automatic QSL emailing on, every ${autoQslMinutes} min` +
        (approve ? " (sending without review)" : " (queue only — review required)"),
    );
    const tick = async () => {
      try {
        const r = await runAutoQsl();
        if (!r.ran) {
          if (r.reason && !/is off/.test(r.reason)) console.log(`[qsl] skipped: ${r.reason}`);
          return;
        }
        if (r.queued > 0 || r.sent > 0 || r.failed > 0) {
          console.log(
            `[qsl] considered ${r.considered}, queued ${r.queued}, no address ${r.noAddress}, ` +
              `sent ${r.sent}, failed ${r.failed}, ${r.remainingToday} left today` +
              (r.samples.length > 0 ? ` — ${r.samples.join(", ")}` : ""),
          );
        }
      } catch (err) {
        console.error(`[qsl] automatic run failed: ${err instanceof Error ? err.message : err}`);
      }
    };
    // First pass shortly after start, so a misconfiguration shows up promptly
    // rather than after the first full interval.
    setTimeout(() => void tick(), 60_000);
    setInterval(() => void tick(), Math.max(5, autoQslMinutes) * 60_000);
  }

  // Logbook of the World, on a timer.
  //
  // It had no schedule at all: `syncLotwConfirmations` was reachable only from the
  // Sync button, so confirmations arrived when somebody remembered to press it. On
  // this station that meant the newest confirmation was nine days old.
  //
  // Hourly, which is what Cloudlog's own cron recommends for the same service, and
  // an incremental run is one small request. Download only — uploading needs the
  // operator's TQSL certificate — so this is read-only against ARRL and cannot
  // damage their LoTW record.
  if (await getBooleanSetting("lotw.autoSync", true)) {
    const lotwMinutes = await getNumberSetting("lotw.syncMinutes", 60);
    let lotwFailures = 0;

    const lotwTick = async () => {
      // Nothing to do without credentials, and saying so once an hour would be
      // noise for an operator who does not use LoTW.
      if (!(await getLotwCredentials())) return;
      try {
        const r = await syncLotwConfirmations({ dryRun: false, full: false });
        if (!r.ok) {
          lotwFailures++;
          console.error(`[lotw] sync failed: ${r.error}`);
          // Only after several. LoTW throttles routinely and a single 503 is not
          // worth an email — a day of them is.
          if (lotwFailures >= 4) {
            void raiseAlert("lotw-sync", "LoTW sync is failing", [
              r.error,
              "",
              `${lotwFailures} attempts in a row have failed. Confirmations are not being downloaded.`,
            ]);
          }
          return;
        }
        if (lotwFailures > 0) {
          void clearAlert("lotw-sync", "LoTW sync is working again", [
            "Confirmations are downloading normally.",
          ]);
        }
        lotwFailures = 0;
        const rep = r.report;
        // Quiet when there is nothing new, which is most hours.
        if (rep.matched > 0 || rep.updated > 0) {
          console.log(
            `[lotw] ${rep.fetched} record(s): ${rep.matched} matched, ${rep.updated} newly confirmed` +
              (rep.enriched > 0 ? `, ${rep.enriched} enriched` : ""),
          );
        }
      } catch (err) {
        lotwFailures++;
        console.error(`[lotw] sync threw: ${err instanceof Error ? err.message : err}`);
      }
    };

    // Five minutes after start, not immediately.
    //
    // The first run on a station with no marker downloads the whole history year by
    // year, and a bridge in a restart loop must not point that at ARRL every time it
    // comes up.
    setTimeout(() => void lotwTick(), 5 * 60_000);
    setInterval(() => void lotwTick(), Math.max(15, lotwMinutes) * 60_000);
    console.log(`[lotw] automatic sync every ${Math.max(15, lotwMinutes)} min`);
  }



  // Verify LoTW kept what we uploaded.
  //
  // An accepted upload is a QUEUE acknowledgement, not a receipt, so `lotwSent` is optimistic
  // and nothing else would ever notice a batch LoTW refused during processing. This asks LoTW
  // what it holds and clears the flag on anything missing, which puts it back in the upload
  // queue. It only ever CLEARS: being wrong costs one redundant upload, which LoTW discards.
  if (await getBooleanSetting("lotw.reconcile", true)) {
    const hours = Math.max(6, await getNumberSetting("lotw.reconcileHours", 24));

    const reconcileTick = async () => {
      if (!(await getLotwCredentials())) return;
      try {
        // A WEEK of receipts, not a day. The window has to be comfortably wider than the
        // interval: a contact uploaded shortly before a run and still in LoTW's queue would
        // otherwise be judged missing exactly once, and a narrow window gives it no second
        // chance to be seen as present.
        const since = new Date(Date.now() - 7 * 86_400_000);
        const r = await reconcileLotwSent({ since });
        if (!r.ok) {
          console.error(`[lotw] reconcile failed: ${r.error ?? "no detail"}`);
          return;
        }
        if (r.missing > 0) {
          console.warn(
            `[lotw] ${r.missing} of ${r.local} contact(s) marked sent are NOT in the LoTW log — ` +
              `${r.cleared} re-queued: ${r.samples.join(", ")}`,
          );
        } else if (r.local > 0) {
          console.log(`[lotw] verified ${r.local} upload(s) against ${r.remote} LoTW record(s)`);
        }
      } catch (err) {
        console.error(`[lotw] reconcile threw: ${err instanceof Error ? err.message : err}`);
      }
    };

    // Twenty minutes after start, well clear of the confirmation sync's five: both hit the
    // same rate-limited endpoint, and although every report request is now serialised, a
    // reconciliation waiting behind a full history download would sit there for minutes.
    setTimeout(() => void reconcileTick(), 20 * 60_000);
    setInterval(() => void reconcileTick(), hours * 3_600_000);
    console.log(`[lotw] upload verification every ${hours} h`);
  }

  // eQSL confirmations, on a timer.
  //
  // `syncEqslInbox` was written, tested and NEVER CALLED BY ANYTHING — the same shape of
  // defect as the LoTW upload that could not run: reachable only from code that did not
  // exist, so the 7,286 eQSL confirmations in the log all arrived through an ADIF import
  // by hand. Asked as "can we just pull eQSL to confirm contacts?", and the answer was
  // yes, except that nothing did.
  //
  // READ ONLY. This downloads the inbox and matches it; it uploads nothing and posts no
  // card to anybody, which is why it defaults to ON while the eQSL upload defaults to off.
  if (await getBooleanSetting("eqsl.autoSync", true)) {
    const eqslMinutes = Math.max(15, await getNumberSetting("eqsl.syncMinutes", 60));
    let eqslFailures = 0;

    const eqslTick = async () => {
      // No credentials means the operator does not use eQSL. Saying so hourly would be noise.
      if (!(await getEqslCredentials())) return;
      try {
        const r = await syncEqslInbox();
        if (!r.ok) {
          eqslFailures++;
          console.error(`[eqsl] inbox sync failed: ${r.error ?? "no detail"}`);
          if (eqslFailures >= 4) {
            void raiseAlert("eqsl-sync", "eQSL inbox sync is failing", [
              r.error ?? "no detail",
              "",
              `${eqslFailures} attempts in a row have failed. Confirmations are not being downloaded.`,
            ]);
          }
          return;
        }
        if (eqslFailures > 0) {
          void clearAlert("eqsl-sync", "eQSL inbox sync is working again", [
            "Confirmations are downloading normally.",
          ]);
        }
        eqslFailures = 0;
        // Quiet when nothing changed, which is most hours.
        //
        // `unmatched` is reported as "not in this log" rather than as something wrong. On an
        // eQSL login that owns several QTHs the inbox is the whole ACCOUNT's — the records
        // carry no station or QTH field at all — so confirmations for another profile's
        // contacts arrive here every time and match nothing. On this station that is 1,799 of
        // 9,427, and phrasing it as a failure made an hourly log line out of normal
        // behaviour.
        if (r.matched > 0) {
          console.log(
            `[eqsl] ${r.found} confirmation(s): ${r.matched} matched` +
              (r.alreadyKnown > 0 ? `, ${r.alreadyKnown} already known` : "") +
              (r.unmatched > 0 ? `, ${r.unmatched} not in this log` : ""),
          );
        }
      } catch (err) {
        eqslFailures++;
        console.error(`[eqsl] inbox sync threw: ${err instanceof Error ? err.message : err}`);
      }
    };

    // Six minutes after start, offset from the LoTW sync's five. Both fetch a whole
    // history on a station with no marker, and a bridge in a restart loop should not aim
    // two of those at two volunteer-funded services in the same second.
    setTimeout(() => void eqslTick(), 6 * 60_000);
    setInterval(() => void eqslTick(), eqslMinutes * 60_000);
    console.log(`[eqsl] automatic inbox sync every ${eqslMinutes} min`);
  }

  // Prune the decode log.
  //
  // 42,000 rows a day on a busy band, and nothing used to delete any of them. Hourly
  // rather than on a schedule the operator has to think about, and the first pass is
  // delayed so a restart loop cannot spend all its time deleting.
  const pruneTick = async () => {
    try {
      const days = await getNumberSetting("digital.decodeRetentionDays", 30);
      if (days <= 0) return;
      const r = await pruneDecodes(days);
      if (r.deleted > 0) {
        console.log(
          `[bridge] pruned ${r.deleted.toLocaleString()} decodes older than ${days}d ` +
            `(${r.keptLinked.toLocaleString()} kept — attached to logged contacts)`,
        );
      }
    } catch (err) {
      // Never fatal. Failing to tidy up must not take the radio down.
      console.error(`[bridge] decode prune failed: ${err instanceof Error ? err.message : err}`);
    }
  };
  /** Consecutive failing sweeps per upload service, for the alert threshold. */
  const uploadFailStreak = new Map<string, number>();
  const uploadTick = async () => {
    try {
      const mins = await getNumberSetting("uploads.intervalMinutes", 10);
      if (mins <= 0) return;
      const r = await runUploads();
      if (!r.ran) return;
      for (const s of r.services) {
        if (s.uploaded > 0 || s.duplicates > 0) {
          console.log(
            `[upload] sweep ${s.service}: ${s.uploaded} sent` +
              (s.duplicates ? `, ${s.duplicates} already there` : "") +
              // The remote end's own words, where it gave any. LoTW replies with its own
              // count, and a log line that states ours without theirs is asserting
              // something the service has not confirmed.
              (s.detail ? ` — ${s.detail.slice(0, 160)}` : ""),
          );
        }
        if (s.skipped) console.warn(`[upload] ${s.service} skipped — ${s.skipped}`);

        // Three consecutive failing sweeps is half an hour of a service refusing —
        // a wrong key or an outage, not a blip. One clean sweep resets the count
        // and, if an alert went out, says so.
        if (s.failed > 0 && s.uploaded === 0) {
          const n = (uploadFailStreak.get(s.service) ?? 0) + 1;
          uploadFailStreak.set(s.service, n);
          if (n === 3) {
            void raiseAlert(`uploads-${s.service}`, `${s.service} uploads are failing`, [
              `${s.service} has failed ${n} sweeps in a row (${s.failed} contact(s) refused on the last one).`,
              ...(s.errors.length ? [`Last errors: ${s.errors.slice(0, 3).join(" | ")}`] : []),
              "Contacts stay queued and nothing is lost — check the service's API key in Settings → Logbooks.",
            ]);
          }
        } else if (s.attempted > 0) {
          uploadFailStreak.set(s.service, 0);
          void clearAlert(`uploads-${s.service}`, `${s.service} uploads are working again`, [
            `The last sweep uploaded ${s.uploaded} contact(s) cleanly.`,
          ]);
        }
      }
    } catch (err) {
      console.error(`[upload] sweep failed: ${err instanceof Error ? err.message : err}`);
    }
  };
  {
    const mins = await getNumberSetting("uploads.intervalMinutes", 10);
    if (mins > 0) {
      setTimeout(() => void uploadTick(), 90_000);
      setInterval(() => void uploadTick(), Math.max(1, mins) * 60_000);
    }
  }

  // Ask PSKReporter who heard us.
  //
  // On a timer rather than after each contact, which is what the setting used to
  // promise. A lookup fired the moment a QSO is logged finds nothing: PSKReporter
  // aggregates reports from receivers that upload on their own five-minute cycles, so a
  // report of a transmission we just made does not exist yet. A sweep with a lookback
  // wide enough to cover the gap since the last query catches them once they land.
  //
  // The rate limit lives in collectReceptionReports against a stored timestamp, so this
  // timer cannot become a way to hammer a free service — and neither can a restart loop.
  const pskTick = async () => {
    try {
      if (!(await getBooleanSetting("pskreporter.enabled", false))) return;
      const r = await collectReceptionReports();
      if (!r.ran) {
        // Only worth a line when it is a refusal rather than the rate limit doing its
        // job, which is the ordinary case on a 5-minute timer.
        if (r.skipped && !/until the next query/.test(r.skipped)) {
          console.warn(`[psk] reception reports skipped — ${r.skipped}`);
        }
        return;
      }
      if (r.attached > 0 || r.fetched > 0) {
        console.log(
          `[psk] ${r.fetched} reception report(s): ${r.attached} in a contact` +
            // Not a fault and usually the majority — a CQ nobody answered produced no
            // contact for the report to belong to. Stored anyway; it is still a receiver
            // that heard us, which is what the coverage view is for.
            (r.unattached ? `, ${r.unattached} outside any contact` : "") +
            (r.duplicates ? `, ${r.duplicates} already stored` : "") +
            (r.foreign ? `, ${r.foreign} for another station (unexpected)` : ""),
        );
      }
    } catch (err) {
      console.error(`[psk] reception report sweep failed: ${err instanceof Error ? err.message : err}`);
    }
  };
  setTimeout(() => void pskTick(), 150_000);
  setInterval(() => void pskTick(), MIN_QUERY_INTERVAL_MS);

  // Poll the gate so the badge is honest without the operator reloading.
  //
  // It is a database setting an admin can change at any moment, and the whole point
  // of showing it is that it reflects reality now rather than at attach time.
  const gateTick = async () => {
    try {
      const on = await transmitArmed();
      if (on !== status.allowTransmit) {
        status.allowTransmit = on;
        console.log(`[radio] transmit gate is now ${on ? "ARMED" : "OFF"}`);
        broadcast({ kind: "status", status });
      }
    } catch {
      /* a settings read failure is not worth taking the radio down for */
    }
  };
  // Resume the mode that was running before this process stopped.
  //
  // Deliberately after the source is up and the gate has been read once. Three
  // things can stop it, and each is the right answer:
  //
  //   * transmit turned off while we were down — that decision wins
  //   * the run's wall-clock budget already elapsed — the session is over, and
  //     resuming would hand a crash loop an unlimited run
  //   * no mode stored — nothing was running
  const resumeAfterRestart = async () => {
    try {
      const stored = (await getSetting(KEY_AUTO_MODE)) as AutoMode | null;
      if (!stored || stored === "off") return;

      if (!(await transmitArmed())) {
        console.log(
          `[radio] not resuming auto "${stored}": ${transmitGateKey(activeRadio)} is off`,
        );
        return;
      }

      const startedRaw = await getSetting(KEY_AUTO_RUN_STARTED);
      const startedAt = startedRaw ? Date.parse(startedRaw) : NaN;
      const maxRunMinutes = await getNumberSetting("auto.maxRunMinutes", 240);
      if (Number.isFinite(startedAt) && maxRunMinutes > 0) {
        const elapsedMin = (Date.now() - startedAt) / 60_000;
        if (elapsedMin >= maxRunMinutes) {
          console.log(
            `[radio] not resuming auto "${stored}": the run started ${Math.round(elapsedMin)} min ago and the limit is ${maxRunMinutes}`,
          );
          await persistAutoMode("off");
          return;
        }
      }

      const a = activeAuto();
      if (!a) return;
      a.setMode(stored);
      activeGuards?.beginRun(Number.isFinite(startedAt) ? startedAt : undefined, 0);
      console.log(
        `[radio] resumed auto "${stored}" after restart (run started ${startedRaw || "now"})`,
      );
    } catch (err) {
      console.error(`[radio] auto resume failed: ${err instanceof Error ? err.message : err}`);
    }
  };
  setTimeout(() => void resumeAfterRestart(), 8_000);

  startClockSync(await getNumberSetting("time.syncMinutes", 60));

  void gateTick();
  setInterval(() => void gateTick(), 10_000);

  setTimeout(() => void pruneTick(), 5 * 60_000);
  setInterval(() => void pruneTick(), 60 * 60_000);

  const shutdown = () => {
    console.log("[bridge] shutting down");
    void flushDecodes()
      .then(() => (flexTeardown ?? stopFlex)?.())
      .finally(() => {
        udpSocket?.close();
        // Close the WebSocket server too, and tell the clients why.
        //
        // Without this, `server.close()` waits on the upgraded connections, which
        // never end on their own — so a restart hung until the process was killed,
        // and every browser sat waiting on a socket that would never answer.
        for (const ws of clients) {
          try {
            ws.close(1001, "bridge shutting down");
          } catch {
            /* already gone */
          }
        }
        wss.close();
        server.close(() => process.exit(0));

        // A client that ignores the close frame must not hold the process open.
        setTimeout(() => process.exit(0), 5_000).unref();
      });
  };
  // An unhandled rejection must not take the station off the air.
  //
  // Node exits on one by default, PM2 restarts, and if the cause is a radio that is simply not
  // there — a VPN down, the rig switched off — the same rejection happens again immediately.
  // That is a crash loop with a healthy-looking log: 187 restarts in an evening, each one
  // announcing that it was carrying on without a radio. The specific bug is fixed (see
  // icom-source's `connected.catch`), but the shape of it will recur, because this process is
  // mostly promises attached to hardware that comes and goes.
  //
  // Logged loudly and in full rather than swallowed. A supervisor that hides faults is worse
  // than one that dies; a supervisor that dies because a radio is unplugged is worse than both.
  process.on("unhandledRejection", (reason) => {
    console.error(
      "[bridge] UNHANDLED REJECTION — staying up rather than crash-looping. This is a bug; " +
        "the stack below is where to start.",
    );
    console.error(reason instanceof Error ? (reason.stack ?? reason.message) : reason);
  });

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[bridge] failed to start:", err);
  process.exit(1);
});
