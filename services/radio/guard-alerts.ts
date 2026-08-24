// Email when a guard stops transmission for a hardware reason.
//
// The guards already stop the transmitter on high SWR, an overheating PA or a dead
// receiver — but silently, from the operator's point of view: the pause shows on the
// decodes page, which nobody unattended is looking at. That is exactly the situation
// the alerts system exists for (see lib/alerts.ts): the station stopped itself hours
// ago and the operator finds out at breakfast.
//
// Only FAULT pauses email. "Quiet" (nobody answering) is a band condition, not an
// incident, and "runaway" is the station asking for a human on schedule rather than
// something going wrong.

import { clearAlert, raiseAlert } from "@/lib/alerts";
import type { OperatingGuards } from "@/lib/digital/qso";

/**
 * Separate keys per condition so SWR and PA heat debounce independently — a bad
 * antenna and a hot amplifier on the same afternoon are two incidents, not one.
 */
function keyFor(reason: string): { key: string; subject: string } {
  if (/\bSWR\b/i.test(reason)) {
    return { key: "swr-high", subject: "High SWR stopped transmission" };
  }
  if (/PA temperature/i.test(reason)) {
    return { key: "pa-hot", subject: "PA overheating stopped transmission" };
  }
  return { key: "guard-fault", subject: "A hardware guard stopped transmission" };
}

/** Fault keys announced and not yet cleared, so a re-arm can send the recovery. */
const announced = new Set<string>();

/**
 * Call after feeding telemetry to the guards. Debouncing is the alert gate's job —
 * this can and does run on every telemetry frame while a fault pause is in force.
 */
export function watchGuardFaults(guards: OperatingGuards): void {
  const reason = guards.pausedReason;
  if (guards.pauseCause !== "fault" || !reason) return;

  const { key, subject } = keyFor(reason);
  announced.add(key);
  void raiseAlert(key, subject, [
    reason,
    "",
    "Automatic transmission is paused and stays paused until re-armed from the decodes page.",
  ]);
}

/**
 * Call when the operator re-arms. Recovery is only actually emailed for a fault
 * that was announced — lib/alerts' gate guarantees that — so calling this on every
 * re-arm is safe.
 */
export function guardFaultsCleared(): void {
  for (const key of announced) {
    void clearAlert(key, "Transmission re-armed", [
      "The operator re-armed automatic transmission. If the underlying condition is still present, the guard will trip again on the next transmission.",
    ]);
  }
  announced.clear();
}
