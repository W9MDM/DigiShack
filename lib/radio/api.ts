// The public radio API's contract: what a knob on the desk is told, and what it may say.
//
// WHY THIS IS A FILE OF ITS OWN. The dial (HamLibDial: an M5Stack Dial over USB, a worker on
// the PC, this API, the bridge, the radio) is the first client of DigiShack that is not a
// browser and not a person. Everything it relies on - the shape of the state, the names of
// the locks, which commands exist and what they require - is written here once, pure, and
// asserted in scripts/check-radio-api.ts, so the routes under pages/api/v1/radio/ and the
// bridge agree with each other and a worker written against the doc agrees with both.
//
// THREE RULES THE PLAN SET, kept here so they cannot drift:
//
//   * The dial follows DigiShack's active source and receiver. There is one receiver in
//     this contract, the one the bridge is driving; slices and second radios are not
//     implied by anything below.
//   * Radio MODULATION (DIGU, USB, CW) is a different thing from the digital OPERATING mode
//     (FT8, FT4, WSPR), and the state carries both under different names.
//   * Unknown is unknown. A null here means the radio has not said, never a guess.

import { z } from "zod";

import { MODULATIONS } from "@/lib/radio/modes";

export const RADIO_API_VERSION = 1;

/** The widest single relative move a command may ask for. One megahertz is already absurd. */
export const MAX_DELTA_HZ = 1_000_000;

/**
 * Why the receiver will not take a manual command right now.
 *
 * Names, not sentences, so a worker can switch on them; the detail is for the display.
 * Checked in the BRIDGE before a command is applied (`respectLocks`), and reported in the
 * state so the dial can grey its own controls before anyone turns it.
 */
export interface RadioLock {
  reason: "qso" | "auto" | "transmitting" | "ft0";
  detail: string;
}

export interface LockInputs {
  qsoActive: boolean;
  qsoWith?: string | null;
  autoMode: string | null | undefined;
  transmitting: boolean;
  ft0: boolean;
}

/**
 * The manual-control policy: a contact in progress, an automatic mode, a transmission or
 * FT-0 each own the receiver, and a knob does not take it from them. Stopping automation
 * is the one command that is allowed through a lock, because it is how the lock is lifted.
 */
export function locksFor(s: LockInputs): RadioLock[] {
  const locks: RadioLock[] = [];
  if (s.ft0) locks.push({ reason: "ft0", detail: "FT-0 is engaged: everything is stopped" });
  if (s.transmitting) locks.push({ reason: "transmitting", detail: "The radio is transmitting" });
  if (s.qsoActive) {
    locks.push({
      reason: "qso",
      detail: s.qsoWith ? `A contact with ${s.qsoWith} is in progress` : "A contact is in progress",
    });
  }
  if (s.autoMode && s.autoMode !== "off") {
    locks.push({ reason: "auto", detail: `The automatic operator is running (${s.autoMode})` });
  }
  return locks;
}

/** A command the lock policy lets through even while locked. */
export function bypassesLocks(command: RadioCommandName): boolean {
  return command === "stop-automation";
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** The bridge's /status payload, as much of it as this contract reads. */
export interface BridgeStatusPayload {
  running?: boolean;
  reason?: string;
  status?: {
    connected?: boolean;
    lastHeartbeat?: number | null;
    dialFrequency?: number | null;
    band?: string | null;
    mode?: string | null;
    subMode?: string | null;
    radioMode?: string | null;
    transmitting?: boolean;
    allowTransmit?: boolean;
    rfPower?: number | null;
    source?: string | null;
    radio?: { vendor: string; model: string; host?: string } | null;
    link?: { rttMs: number } | null;
    voice?: { active: boolean; mode: string | null } | null;
    ft0?: boolean;
    receiver?: {
      agc?: string | null;
      nb?: boolean | null;
      nr?: boolean | null;
      filterLo?: number | null;
      filterHi?: number | null;
      rxAnt?: string | null;
      txAnt?: string | null;
    } | null;
  } | null;
  qso?: { active?: boolean; theirCall?: string | null; state?: string | null } | null;
  auto?: { mode?: string | null; lastAction?: string | null } | null;
}

export interface RadioState {
  api: number;
  /** When this snapshot was taken, ISO 8601. The dial shows staleness from it. */
  at: string;
  bridge: { running: boolean; reason: string | null };
  connection: {
    connected: boolean;
    source: "flex" | "icom" | "wsjtx" | null;
    radio: { vendor: string; model: string } | null;
    /** The bridge's last heartbeat from the radio, ISO 8601, or null. */
    lastHeartbeat: string | null;
    linkRttMs: number | null;
  };
  receiver: {
    /** Integer hertz, or null until the radio has said. */
    frequencyHz: number | null;
    band: string | null;
    /** What the radio is demodulating: DIGU, USB, CW... */
    modulation: string | null;
    /** What DigiShack is operating: FT8, FT4, FT2 - or null in voice mode. */
    digitalMode: string | null;
    filterLoHz: number | null;
    filterHiHz: number | null;
    agc: string | null;
    nb: boolean | null;
    nr: boolean | null;
    rxAntenna: string | null;
    txAntenna: string | null;
  };
  transmitter: { transmitting: boolean; armed: boolean; rfPowerPercent: number | null };
  qso: { active: boolean; theirCall: string | null; state: string | null };
  automation: { mode: string; lastAction: string | null };
  voice: { active: boolean; mode: string | null };
  ft0: boolean;
  locks: RadioLock[];
}

const sourceOf = (s: unknown): RadioState["connection"]["source"] =>
  s === "flex" || s === "icom" || s === "wsjtx" ? s : null;

const intOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null;

/** The bridge's status, reduced to the contract. Pure, so the shape is assertable. */
export function reduceStatus(raw: BridgeStatusPayload, now: Date): RadioState {
  const st = raw.status ?? null;
  const running = raw.running !== false && st !== null;
  const autoMode = raw.auto?.mode ?? "off";
  const qsoActive = raw.qso?.active === true;
  return {
    api: RADIO_API_VERSION,
    at: now.toISOString(),
    bridge: { running, reason: running ? null : (raw.reason ?? "The radio service is not running") },
    connection: {
      connected: st?.connected === true,
      source: sourceOf(st?.source),
      radio: st?.radio ? { vendor: st.radio.vendor, model: st.radio.model } : null,
      lastHeartbeat:
        typeof st?.lastHeartbeat === "number" ? new Date(st.lastHeartbeat).toISOString() : null,
      linkRttMs: intOrNull(st?.link?.rttMs),
    },
    receiver: {
      frequencyHz: intOrNull(st?.dialFrequency),
      band: st?.band ?? null,
      modulation: st?.radioMode ?? null,
      digitalMode: st?.voice?.active ? null : (st?.subMode ?? st?.mode ?? null),
      filterLoHz: intOrNull(st?.receiver?.filterLo),
      filterHiHz: intOrNull(st?.receiver?.filterHi),
      agc: st?.receiver?.agc ?? null,
      nb: st?.receiver?.nb ?? null,
      nr: st?.receiver?.nr ?? null,
      rxAntenna: st?.receiver?.rxAnt ?? null,
      txAntenna: st?.receiver?.txAnt ?? null,
    },
    transmitter: {
      transmitting: st?.transmitting === true,
      armed: st?.allowTransmit === true,
      rfPowerPercent: intOrNull(st?.rfPower),
    },
    qso: {
      active: qsoActive,
      theirCall: raw.qso?.theirCall ?? null,
      state: raw.qso?.state ?? null,
    },
    automation: { mode: autoMode ?? "off", lastAction: raw.auto?.lastAction ?? null },
    voice: { active: st?.voice?.active === true, mode: st?.voice?.mode ?? null },
    ft0: st?.ft0 === true,
    locks: locksFor({
      qsoActive,
      qsoWith: raw.qso?.theirCall ?? null,
      autoMode,
      transmitting: st?.transmitting === true,
      ft0: st?.ft0 === true,
    }),
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export const RADIO_COMMANDS = ["tune-relative", "set-frequency", "set-modulation", "stop-automation"] as const;
export type RadioCommandName = (typeof RADIO_COMMANDS)[number];

/**
 * What a worker may send. Every command carries an id the worker chose, so a retry after
 * a lost response is recognised and not applied twice - the difference between a knob
 * that nudged once and one that nudged twice.
 */
export const commandSchema = z
  .object({
    id: z.string().trim().min(1).max(64),
    command: z.enum(RADIO_COMMANDS),
    /** Integer hertz, signed, never zero. */
    deltaHz: z.number().int().min(-MAX_DELTA_HZ).max(MAX_DELTA_HZ).refine((v) => v !== 0, "deltaHz must not be 0").optional(),
    /** Integer hertz. */
    frequencyHz: z.number().int().min(1).optional(),
    modulation: z.enum(MODULATIONS).optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    const need = (field: keyof typeof c, when: boolean) => {
      if (when && c[field] === undefined) ctx.addIssue({ code: "custom", path: [field], message: `${c.command} requires ${field}` });
      if (!when && c[field] !== undefined) ctx.addIssue({ code: "custom", path: [field], message: `${c.command} does not take ${field}` });
    };
    need("deltaHz", c.command === "tune-relative");
    need("frequencyHz", c.command === "set-frequency");
    need("modulation", c.command === "set-modulation");
  });

export type RadioCommand = z.infer<typeof commandSchema>;

export type CommandOutcome = "accepted" | "rejected" | "duplicate";

export interface CommandResult {
  id: string;
  command: RadioCommandName;
  status: CommandOutcome;
  /** Why it was rejected, in a sentence. */
  reason?: string;
  /** The locks that rejected it, when that is why. */
  locks?: RadioLock[];
  /** What the bridge answered, verbatim, for the curious. */
  bridge?: unknown;
}

/**
 * The last few hundred command ids and their outcomes, so a retried id answers with what
 * happened the first time. Bounded, oldest out; per process, which is one web tier.
 */
export class RecentCommands {
  private readonly order: string[] = [];
  private readonly byId = new Map<string, CommandResult>();
  constructor(private readonly limit = 256) {}
  remember(result: CommandResult): void {
    if (!this.byId.has(result.id)) {
      this.order.push(result.id);
      while (this.order.length > this.limit) this.byId.delete(this.order.shift()!);
    }
    this.byId.set(result.id, result);
  }
  seen(id: string): CommandResult | undefined {
    return this.byId.get(id);
  }
  get size(): number {
    return this.byId.size;
  }
}

/** What the bridge is asked to do for a command. Pure, so the mapping is assertable. */
export function bridgeRequestFor(c: RadioCommand): { path: "rig" | "auto"; payload: Record<string, unknown> } {
  switch (c.command) {
    case "tune-relative":
      return { path: "rig", payload: { deltaHz: c.deltaHz, respectLocks: true } };
    case "set-frequency":
      return { path: "rig", payload: { freqHz: c.frequencyHz, respectLocks: true } };
    case "set-modulation":
      return { path: "rig", payload: { mode: c.modulation, respectLocks: true } };
    case "stop-automation":
      return { path: "auto", payload: { mode: "off" } };
  }
}
