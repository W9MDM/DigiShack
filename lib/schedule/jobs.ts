// Everything in DigiShack that runs on a timer, in one place.
//
// WHY THIS EXISTS. Asked for as "a crontab showing all the schedules", and the question comes
// up because there was no answer to it. A dozen timers are started across the bridge, each
// from its own `getNumberSetting` a few hundred lines from the last, several with a floor that
// silently overrides what the operator typed. "How often does the LoTW sync run?" could only
// be answered by reading `services/radio/index.ts`.
//
// It is a DESCRIPTION, not the scheduler. The timers stay where they are used; moving them
// here would be a rewrite of the bridge for the sake of a settings page. The risk that creates
// is obvious and is handled: this list can drift out of step with the code it describes, so
// `scripts/check-schedules.ts` asserts that every `setInterval` in the bridge is accounted for
// and that every setting named here really exists. A schedules page that quietly lies is worse
// than no schedules page at all.
//
// Not listed: protocol keepalives, spectrum frame timers and link probes inside `lib/flex`
// and `lib/icom`. Those are parts of a running connection rather than scheduled work, they
// have no operator-visible cadence, and listing them would bury the eight things that matter
// under twenty that do not.

/** Where the timer lives, which decides what has to restart for a change to take effect. */
export type JobHost = "bridge" | "web";

export interface Job {
  id: string;
  label: string;
  /** What it does, in one line, for someone who has not read the code. */
  what: string;
  host: JobHost;
  /** Setting holding the interval, when the operator can change it. */
  intervalSetting?: string;
  unit?: "minutes" | "hours";
  defaultValue?: number;
  /**
   * Floor the code applies with `Math.max`, where there is one.
   *
   * Surfaced rather than hidden: `lotw.syncMinutes` is clamped to 15, so an operator who sets
   * it to 5 gets 15 and no indication of why. The page says so.
   */
  floor?: number;
  /** Setting that switches it off entirely. */
  enabledSetting?: string;
  enabledDefault?: boolean;
  /** For timers with no setting: the fixed interval, and why it is fixed. */
  fixedMs?: number;
  fixedReason?: string;
  /** A one-off delay before the first run, where there is one. */
  firstRunDelayMs?: number;
  /**
   * False when this job has no `setInterval` of its own.
   *
   * The radio-off reminder is checked inside the connection-monitor loop rather than on a
   * timer, so it has a cadence worth showing an operator and no timer to match it against.
   * Stated here so `check:schedules` can compare timer counts to job counts without being
   * one out.
   */
  ownTimer?: boolean;
}

export const JOBS: Job[] = [
  {
    id: "uploads",
    label: "Upload contacts",
    what: "Sends new contacts to LoTW, QRZ, eQSL, Club Log and Cloudlog.",
    host: "bridge",
    intervalSetting: "uploads.intervalMinutes",
    unit: "minutes",
    defaultValue: 10,
    floor: 1,
    enabledSetting: "uploads.enabled",
    enabledDefault: false,
  },
  {
    id: "lotw-sync",
    label: "Download LoTW confirmations",
    what: "Fetches new confirmations from Logbook of the World and matches them to the log.",
    host: "bridge",
    intervalSetting: "lotw.syncMinutes",
    unit: "minutes",
    defaultValue: 60,
    // LoTW rate-limits heavy use, and this is the number Cloudlog recommends for the same
    // service. Below it the code silently substitutes 15.
    floor: 15,
    enabledSetting: "lotw.autoSync",
    enabledDefault: true,
  },
  {
    id: "eqsl-sync",
    label: "Download eQSL confirmations",
    what: "Pulls the eQSL inbox and matches it to the log. Read only — uploads nothing.",
    host: "bridge",
    intervalSetting: "eqsl.syncMinutes",
    unit: "minutes",
    defaultValue: 60,
    floor: 15,
    enabledSetting: "eqsl.autoSync",
    enabledDefault: true,
    // Six minutes, offset from the LoTW sync's five: both can fetch a whole history on a
    // station with no marker, and a bridge in a restart loop should not aim two of those at
    // two volunteer-funded services at once.
    firstRunDelayMs: 6 * 60_000,
  },
  {
    id: "lotw-reconcile",
    label: "Verify LoTW uploads",
    what: "Asks LoTW what it actually holds and re-queues anything it did not keep.",
    host: "bridge",
    intervalSetting: "lotw.reconcileHours",
    unit: "hours",
    defaultValue: 24,
    floor: 6,
    enabledSetting: "lotw.reconcile",
    enabledDefault: true,
  },
  {
    id: "qsl-queue",
    label: "QSL email queue",
    what: "Finds contacts worth a QSL, queues them, and sends whatever has been approved.",
    host: "bridge",
    intervalSetting: "qsl.auto.intervalMinutes",
    unit: "minutes",
    defaultValue: 30,
    floor: 5,
    enabledSetting: "qsl.auto.enabled",
    enabledDefault: false,
    // First pass a minute after start, so a misconfiguration shows up promptly rather than
    // after a full interval of apparent silence.
    firstRunDelayMs: 60_000,
  },
  {
    id: "pskreporter",
    label: "Collect reception reports",
    what: "Asks PSKReporter who heard us, and records the spots against the log.",
    host: "bridge",
    fixedMs: 5 * 60_000,
    fixedReason:
      "PSKReporter's own stated minimum gap between identical queries. Not ours to change.",
    enabledSetting: "pskreporter.enabled",
    enabledDefault: false,
  },
  {
    id: "clock-sync",
    label: "Check the clock",
    what: "Measures the offset against NTP. FT8 needs the clock inside about a second.",
    host: "bridge",
    intervalSetting: "time.syncMinutes",
    unit: "minutes",
    defaultValue: 60,
    floor: 1,
    enabledSetting: "time.correct",
    enabledDefault: true,
  },
  {
    id: "operating-schedule",
    label: "Operating schedule",
    what: "Applies the band and mode plan, sleep hours and PA duty rest.",
    host: "bridge",
    fixedMs: 30_000,
    fixedReason:
      "A tick rather than an interval: it checks whether the current window still matches " +
      "the plan. 30s is fine granularity for windows measured in hours.",
    enabledSetting: "schedule.enabled",
    enabledDefault: false,
  },
  {
    id: "transmit-gate",
    label: "Transmit gate",
    what: "Re-checks the run limits, SWR, PA temperature and unanswered-call guards.",
    host: "bridge",
    fixedMs: 10_000,
    fixedReason:
      "A safety check, so it is not adjustable. Ten seconds is the longest this station " +
      "should be able to keep transmitting after a guard has tripped.",
  },
  {
    id: "decode-prune",
    label: "Prune old decodes",
    what: "Deletes decodes older than the retention window to keep the table workable.",
    host: "bridge",
    fixedMs: 60 * 60_000,
    fixedReason:
      "Hourly is ample for a daily retention window. How much it keeps is " +
      "digital.decodeRetentionDays; how often it looks is not worth a setting.",
  },
  {
    id: "radio-down-reminder",
    label: "Radio-off reminder",
    what: "Emails a reminder while the radio is unreachable, until it comes back.",
    host: "bridge",
    intervalSetting: "alerts.radioDownReminderHours",
    unit: "hours",
    defaultValue: 12,
    enabledSetting: "alerts.enabled",
    // Checked inside the connection monitor, not on a timer of its own.
    ownTimer: false,
    // False. `raiseAlert` gates on `getBooleanSetting("alerts.enabled", false)`, and the
    // first version of this entry claimed true — caught by check:schedules comparing the
    // list against the registry, which is the entire reason that comparison is in there.
    enabledDefault: false,
  },
];

export interface ResolvedJob extends Job {
  /** True when this job will actually run. */
  enabled: boolean;
  /** The interval the code will really use, in ms, after floors are applied. */
  effectiveMs: number;
  /** What the operator set, before the floor — null when there is no setting. */
  configured: number | null;
  /**
   * Set when the floor overrode what was configured.
   *
   * This is the whole reason for showing an effective value rather than the setting: an
   * operator who typed 5 into the LoTW interval currently has no way to learn that they got
   * 15, and would reasonably conclude the setting does nothing.
   */
  clampedFrom: number | null;
  /** Crontab-ish expression. Approximate by nature — see `cronish`. */
  cron: string;
}

const MS: Record<"minutes" | "hours", number> = { minutes: 60_000, hours: 3_600_000 };

/**
 * A crontab-style expression for an interval.
 *
 * Honest about being approximate. Cron cannot express "every 90 minutes" — `*​/90` is not
 * valid in a minutes field — and cron has no concept of "every 10 seconds" at all. So
 * anything cron cannot say is rendered as a plain interval rather than as a wrong expression
 * that looks authoritative. A page that prints `*​/90 * * * *` would be lying in a format
 * people trust.
 */
export function cronish(ms: number): string {
  if (ms < 60_000) return `every ${Math.round(ms / 1000)}s`;
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return 60 % mins === 0 ? `*/${mins} * * * *` : `every ${mins}m`;
  const hours = mins / 60;
  if (!Number.isInteger(hours)) return `every ${Math.floor(hours)}h ${mins % 60}m`;
  if (hours === 1) return "0 * * * *";
  return 24 % hours === 0 ? `0 */${hours} * * *` : `every ${hours}h`;
}

/** Read one job's live state. `get` supplies settings so this stays testable without a DB. */
export function resolveJob(
  job: Job,
  get: (key: string) => string | null,
): ResolvedJob {
  const enabled = job.enabledSetting
    ? parseBool(get(job.enabledSetting), job.enabledDefault ?? false)
    : true;

  if (job.fixedMs !== undefined) {
    return {
      ...job,
      enabled,
      effectiveMs: job.fixedMs,
      configured: null,
      clampedFrom: null,
      cron: cronish(job.fixedMs),
    };
  }

  const unit = job.unit ?? "minutes";
  const raw = job.intervalSetting ? get(job.intervalSetting) : null;
  const parsed = raw !== null && raw.trim() !== "" ? Number(raw) : NaN;
  const configured = Number.isFinite(parsed) ? parsed : (job.defaultValue ?? 0);
  const floored = job.floor !== undefined ? Math.max(job.floor, configured) : configured;

  return {
    ...job,
    // Zero or less means off wherever the bridge reads one of these — `if (mins <= 0) return`
    // — so it is reported as off rather than as an interval of zero.
    enabled: enabled && floored > 0 && configured > 0,
    effectiveMs: floored * MS[unit],
    configured,
    clampedFrom: floored !== configured ? configured : null,
    cron: cronish(floored * MS[unit]),
  };
}

function parseBool(raw: string | null, fallback: boolean): boolean {
  if (raw === null || raw.trim() === "") return fallback;
  return raw.trim().toLowerCase() === "true";
}

export function resolveJobs(get: (key: string) => string | null): ResolvedJob[] {
  return JOBS.map((j) => resolveJob(j, get));
}
