// Driving the operating schedule, for whichever radio is running.
//
// The decision itself lives in lib/radio/schedule.ts and is pure. This is the part that
// applies it: a timer, and the rule about not fighting the operator.
//
// It used to be inline inside `startFlexSource`, which meant an Icom session had **no
// schedule at all** — no timed modes, no sleep hours, no PA duty rest. For a radio meant
// to run unattended that is not a missing nicety; it is the difference between a station
// that stops at bedtime and one that does not.
//
// Extracted here rather than left in the service so it can be tested. Nothing about
// "apply a schedule to an auto operator" needs a radio, a socket or a database, and the
// two rules that matter — only act on a CHANGE, and never overwrite an operator's own
// choice mid-block — are exactly the kind of thing that quietly regresses.

import {
  decideSchedule,
  formatHhmm,
  type PaDutyTracker,
  type ScheduleConfig,
  type ScheduleDecision,
} from "@/lib/radio/schedule";
import type { AutoMode } from "@/lib/radio/auto-mode";

/** The bit of the auto operator a schedule needs. Narrow on purpose. */
export interface SchedulableAuto {
  readonly state: { mode: AutoMode };
  setMode(mode: AutoMode): void;
}

export interface ScheduleRunnerOptions {
  cfg: ScheduleConfig;
  /** Problems found parsing `schedule.hours`, reported once at start. */
  errors: string[];
  /** Follows the RADIO's transmit state, not our intent. */
  paDuty: Pick<PaDutyTracker, "state">;
  /**
   * The live auto operator, or null while a source is being rebuilt.
   *
   * A function rather than a value because the operator is replaced on every reconnect,
   * and a schedule holding the old one would set modes on a discarded object.
   */
  auto: () => SchedulableAuto | null;
  /** Called after a scheduled change: persist it, and tell the browsers. */
  onChanged: (mode: AutoMode) => void;
  /**
   * Called on EVERY evaluation with the current decision, changed or not.
   *
   * `onChanged` is for acting; this is for showing. A browser opened mid-block needs
   * to see "Scheduled hunt until 22:00" even though the change happened hours ago,
   * so the bridge keeps the latest decision on its status object — and that display
   * must track things `onChanged` never fires for, like the minutes counting down
   * on a PA rest.
   */
  onDecision?: (d: ScheduleDecision) => void;
  log: (line: string) => void;
  logError: (line: string) => void;
  /** How often to re-evaluate. Injected so a test does not wait half a minute. */
  intervalMs?: number;
  /**
   * The schedule's last answer from BEFORE this process started, if the caller
   * persisted one.
   *
   * Without it, every restart is a fresh "change": the first tick re-stamps the
   * block's mode over whatever the operator chose mid-block, because the only
   * memory of "I already applied hunt for this block" was in RAM. Observed live —
   * an operator's hunt-pota reverted to the scheduled hunt on a bridge restart,
   * and the bridge restarts on its own (deploys, the liveness watchdog), so the
   * override rule was only holding between restarts, not until the next boundary
   * as promised.
   */
  initialLastScheduled?: AutoMode | null;
}

export interface ScheduleRunner {
  /** Re-evaluate now. Called by the timer, and directly by tests. */
  tick(now?: Date): void;
  stop(): void;
}

/**
 * Start applying the schedule. Returns a handle; `stop()` must be called on teardown or
 * a rebuilt source ends up with two schedules fighting over the mode.
 *
 * A disabled schedule still returns a working handle that does nothing, so no caller has
 * to branch on it.
 */
export function startScheduleRunner(opts: ScheduleRunnerOptions): ScheduleRunner {
  const { cfg, errors } = opts;
  if (!cfg.enabled) {
    return { tick: () => {}, stop: () => {} };
  }

  const summary = cfg.blocks
    .map((b) => `${formatHhmm(b.startMin)}-${formatHhmm(b.endMin)}=${b.mode}`)
    .join(", ");
  opts.log(
    `schedule on (local time): ${summary || "no blocks"}` +
      (cfg.sleep
        ? `; asleep ${formatHhmm(cfg.sleep.startMin)}-${formatHhmm(cfg.sleep.endMin)}`
        : "") +
      (cfg.paAfterMinutes > 0
        ? `; PA rests ${cfg.paRestMinutes} min after ${cfg.paAfterMinutes} tx-min`
        : ""),
  );
  if (errors.length > 0) opts.logError(`schedule problems: ${errors.join("; ")}`);

  /**
   * The schedule's previous answer.
   *
   * Acting only on a CHANGE is what makes this a schedule rather than a fight: an
   * operator who overrides by hand keeps that override until the next scheduled
   * boundary, instead of having it stamped back over within thirty seconds.
   */
  let lastScheduled: AutoMode | null = opts.initialLastScheduled ?? null;

  const tick = (now: Date = new Date()): void => {
    // Decided (and reported) even while the source is being rebuilt: the decision
    // depends only on the clock and the PA, and the display should not blank out
    // for the seconds a reconnect takes.
    const d = decideSchedule(cfg, now, opts.paDuty.state());
    opts.onDecision?.(d);

    const auto = opts.auto();
    if (!auto) return;

    if (d.mode === lastScheduled) return;
    lastScheduled = d.mode;

    // Already there — nothing to say and nothing to do.
    if (auto.state.mode === d.mode) return;

    opts.log(`schedule: ${d.reason} -> ${d.mode}`);
    auto.setMode(d.mode);
    opts.onChanged(d.mode);
  };

  tick();
  const timer = setInterval(() => tick(), opts.intervalMs ?? 30_000);
  timer.unref?.();

  return { tick, stop: () => clearInterval(timer) };
}
