// An operating schedule: what the station should be doing, and when.
//
// Three separate concerns, deliberately kept apart because they fail differently:
//
//   1. WORKING HOURS — which automatic mode to run during which parts of the day.
//   2. SLEEPING HOURS — a period where nothing transmits at all, whatever the schedule
//      says. This is the one that stops the station calling CQ at 3am next to someone's
//      bedroom, so it OVERRIDES rather than merges.
//   3. PA COOLDOWN — a duty-cycle limit. FT8 is a 50% duty mode and an unattended
//      station can transmit for hours; the finals do not enjoy it. Measured against
//      actual transmit time, not wall-clock time, because an hour spent listening is
//      not an hour spent heating the PA.
//
// EVERYTHING HERE IS IN LOCAL TIME, and that is deliberate in a codebase that spent a
// whole version consolidating on UTC. "Sleeping hours" is a fact about the operator's
// house, not about the log. The machine running this is on the shack LAN talking to the
// radio, so its local time is the operator's local time. The UI says so explicitly.

import { AUTO_MODES, type AutoMode, isAutoMode } from "@/lib/radio/auto-mode";

export interface TimeRange {
  /** Minutes past local midnight. */
  startMin: number;
  endMin: number;
}

export interface ScheduleBlock extends TimeRange {
  mode: AutoMode;
}

export interface ScheduleConfig {
  enabled: boolean;
  blocks: ScheduleBlock[];
  sleep: TimeRange | null;
  /** Transmit minutes allowed before a rest. 0 disables the cooldown. */
  paAfterMinutes: number;
  /** How long to rest for. */
  paRestMinutes: number;
}

export interface ScheduleDecision {
  mode: AutoMode;
  /** Shown to the operator, so it says why and not merely what. */
  reason: string;
  /** True when a mode is being suppressed rather than simply not scheduled. */
  suppressed: boolean;
}

// ------------------------------------------------------------------------- parsing

/** `HH:MM` to minutes past midnight, or null. */
export function parseHhmm(s: string): number | null {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export function formatHhmm(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/**
 * Parse a range like `23:00-07:00`.
 *
 * A range whose end is before its start wraps midnight, which is the normal shape for
 * sleeping hours and would otherwise be the single most likely thing to get wrong.
 */
export function parseRange(s: string): TimeRange | null {
  const parts = s.split("-");
  if (parts.length !== 2) return null;
  const startMin = parseHhmm(parts[0] as string);
  const endMin = parseHhmm(parts[1] as string);
  if (startMin === null || endMin === null) return null;
  return { startMin, endMin };
}

export interface ParseResult {
  blocks: ScheduleBlock[];
  /** Human-readable problems. Anything unparseable is reported, never silently dropped. */
  errors: string[];
}

/**
 * Parse the working-hours spec: `08:00-12:00=hunt, 13:00-22:00=cq`.
 *
 * A text field rather than a grid because the settings store is key/value, and because
 * one line an operator can read back is easier to trust than twenty-four checkboxes.
 * Errors are collected rather than thrown: a typo in the third block should not silently
 * discard the first two, and it must be visible rather than mysterious.
 */
export function parseSchedule(spec: string): ParseResult {
  const blocks: ScheduleBlock[] = [];
  const errors: string[] = [];

  for (const raw of spec.split(/[,;\n]/)) {
    const entry = raw.trim();
    if (!entry) continue;

    const eq = entry.lastIndexOf("=");
    if (eq === -1) {
      errors.push(`"${entry}" has no =mode`);
      continue;
    }
    const range = parseRange(entry.slice(0, eq));
    const mode = entry.slice(eq + 1).trim().toLowerCase() as AutoMode;

    if (!range) {
      errors.push(`"${entry.slice(0, eq).trim()}" is not a HH:MM-HH:MM range`);
      continue;
    }
    if (!isAutoMode(mode)) {
      errors.push(`"${mode}" is not one of ${AUTO_MODES.join(", ")}`);
      continue;
    }
    if (range.startMin === range.endMin) {
      errors.push(`"${entry}" starts and ends at the same time, so it covers nothing`);
      continue;
    }
    blocks.push({ ...range, mode });
  }

  return { blocks, errors };
}

// ------------------------------------------------------------------------ evaluating

/** Minutes past local midnight for a Date, in the machine's own timezone. */
export function localMinutes(at: Date): number {
  return at.getHours() * 60 + at.getMinutes();
}

/**
 * Is `minute` inside the range, accounting for a range that wraps midnight?
 *
 * Start is inclusive, end exclusive — so `08:00-12:00` and `12:00-16:00` are adjacent
 * without overlapping, and an operator writing the obvious thing gets the obvious
 * result rather than a one-minute ambiguity at the boundary.
 */
export function inRange(minute: number, r: TimeRange): boolean {
  if (r.startMin === r.endMin) return false;
  return r.startMin < r.endMin
    ? minute >= r.startMin && minute < r.endMin
    : minute >= r.startMin || minute < r.endMin;
}

export interface PaState {
  /** True when the PA is currently resting. */
  resting: boolean;
  /** When the rest ends. */
  restUntil: Date | null;
  /** Transmit minutes accumulated since the last rest. */
  txMinutes: number;
}

/**
 * What should the station be doing right now?
 *
 * Order matters and is not arbitrary. Sleep beats everything, because it is the promise
 * made to whoever else lives in the house. Cooldown beats the schedule, because the
 * schedule does not know how hot the finals are. Only then does the time of day decide.
 */
export function decideSchedule(
  cfg: ScheduleConfig,
  now: Date,
  pa: PaState,
): ScheduleDecision {
  if (!cfg.enabled) {
    return { mode: "off", reason: "The schedule is off", suppressed: false };
  }

  const minute = localMinutes(now);

  if (cfg.sleep && inRange(minute, cfg.sleep)) {
    return {
      mode: "off",
      reason: `Sleeping hours until ${formatHhmm(cfg.sleep.endMin)}`,
      suppressed: true,
    };
  }

  if (pa.resting && pa.restUntil && now < pa.restUntil) {
    const mins = Math.ceil((pa.restUntil.getTime() - now.getTime()) / 60_000);
    return {
      mode: "off",
      reason: `PA cooling down for another ${mins} min`,
      suppressed: true,
    };
  }

  // Last matching block wins, so a later line can override an earlier one and an
  // operator can write a broad rule then carve an exception out of it.
  let chosen: ScheduleBlock | null = null;
  for (const b of cfg.blocks) if (inRange(minute, b)) chosen = b;

  if (!chosen) {
    return { mode: "off", reason: "Nothing scheduled for now", suppressed: false };
  }
  return {
    mode: chosen.mode,
    reason: `Scheduled ${chosen.mode} until ${formatHhmm(chosen.endMin)}`,
    suppressed: false,
  };
}

/**
 * Tracks transmit time and decides when the PA has earned a break.
 *
 * Counts ACTUAL transmit time. An unattended FT8 station alternates transmit and
 * receive, so an hour of operating is roughly half an hour of transmitting — and a
 * cooldown measured on wall-clock time would rest the radio twice as often as needed
 * while an operator who spends the hour listening would be rested for no reason.
 */
export class PaDutyTracker {
  private txMs = 0;
  private restUntil: Date | null = null;
  private keyedAt: number | null = null;

  constructor(
    private readonly afterMinutes: number,
    private readonly restMinutes: number,
  ) {}

  /** Call when the transmitter keys. */
  keyed(at = Date.now()): void {
    if (this.keyedAt === null) this.keyedAt = at;
  }

  /** Call when it unkeys. Safe if it was never keyed. */
  unkeyed(at = Date.now()): void {
    if (this.keyedAt === null) return;
    this.txMs += Math.max(0, at - this.keyedAt);
    this.keyedAt = null;
  }

  get transmitMinutes(): number {
    const live = this.keyedAt === null ? 0 : Date.now() - this.keyedAt;
    return (this.txMs + live) / 60_000;
  }

  /**
   * Should the PA rest, and until when?
   *
   * `afterMinutes` of 0 disables the whole thing — an operator running QRP into a
   * proper amplifier does not need this, and forcing it on them would be a setting
   * that only ever gets worked around.
   */
  state(now = new Date()): PaState {
    if (this.afterMinutes <= 0) {
      return { resting: false, restUntil: null, txMinutes: this.transmitMinutes };
    }

    if (this.restUntil && now >= this.restUntil) {
      // Rest served: start the next accumulation from zero.
      this.restUntil = null;
      this.txMs = 0;
      this.keyedAt = null;
    }

    if (!this.restUntil && this.transmitMinutes >= this.afterMinutes) {
      this.restUntil = new Date(now.getTime() + this.restMinutes * 60_000);
    }

    return {
      resting: this.restUntil !== null,
      restUntil: this.restUntil,
      txMinutes: this.transmitMinutes,
    };
  }

  /** Forget everything — used when the operator takes manual control. */
  reset(): void {
    this.txMs = 0;
    this.keyedAt = null;
    this.restUntil = null;
  }
}
