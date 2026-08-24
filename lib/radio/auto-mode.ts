/**
 * What the station is doing on its own.
 *
 * Lives here rather than in `services/radio/auto-operator.ts` because the schedule and
 * the settings layer both need it, and `lib/` must not import from `services/` — the
 * bridge is a process, not a library, and the dependency only runs one way.
 */
export type AutoMode = "off" | "cq" | "hunt" | "hunt-pota" | "pota-chase";

export const AUTO_MODES = ["off", "cq", "hunt", "hunt-pota", "pota-chase"] as const;

export function isAutoMode(s: string): s is AutoMode {
  return (AUTO_MODES as readonly string[]).includes(s);
}
