// Email when the station goes wrong, with a memory of what it already said.
//
// Born from a real night: the bridge sat at "reconnect attempt 300" for hours while
// its log said so every 48 seconds, faithfully, to nobody. Everything here exists to
// convert exactly that kind of line into one email — and not three hundred.
//
// Principles, each load-bearing:
//   * ONE email per condition. A repeating fault re-sends only after the cooldown,
//     so a flapping radio cannot empty the inbox's attention. The gate keys on a
//     short string ("radio-down"), not the message text, which may vary per attempt.
//   * Recovery is only announced for a fault that was announced. "All clear" emails
//     for incidents nobody was told about train the reader to ignore all of them.
//   * Alerting failures are never allowed to become faults themselves: no SMTP, no
//     recipient, send refused — logged and swallowed. The station's job is radio.
//   * Off by default, like everything here that acts on the outside world.

import { sendSystemEmail } from "@/lib/qsl/email";
import { getBooleanSetting, getNumberSetting, getSetting } from "@/lib/settings";
import { prisma } from "@/lib/db/prisma";

/**
 * The pure part: which raise/clear calls get through. Separated from the emailing
 * so check:alerts can assert the debounce without a mail server or a clock stub —
 * `now` is a parameter, never Date.now().
 */
export class AlertGate {
  /** Keys with an announced, un-cleared fault, and when they were last emailed. */
  private active = new Map<string, number>();

  /** Should this raise be announced? True the first time and after each cooldown. */
  raise(key: string, now: number, cooldownMs: number): boolean {
    const lastSent = this.active.get(key);
    if (lastSent !== undefined && now - lastSent < cooldownMs) return false;
    this.active.set(key, now);
    return true;
  }

  /** Clear a fault. True when it had been announced — i.e. a recovery is owed. */
  clear(key: string): boolean {
    return this.active.delete(key);
  }
}

const gate = new AlertGate();

async function recipient(): Promise<string | null> {
  const configured = await getSetting("alerts.email");
  if (configured) return configured;
  // Unset means "the admin", which is who turned the feature on. First active
  // admin by creation order, so the answer is stable rather than arbitrary.
  const admin = await prisma.user.findFirst({
    where: { role: "ADMIN", active: true },
    orderBy: { createdAt: "asc" },
    select: { email: true },
  });
  return admin?.email ?? null;
}

function stamp(lines: string[]): string {
  return [
    ...lines,
    "",
    `— DigiShack on ${process.env.HOSTNAME ?? "this station"}, ${new Date().toISOString()}`,
  ].join("\n");
}

export interface AlertOptions {
  /**
   * Send even if this key alerted inside the cooldown.
   *
   * The cooldown exists for faults that retry in a loop — a failing upload sweep would
   * otherwise email every thirty seconds — and for those it is exactly right. It is
   * wrong for events that are RARE AND INDIVIDUALLY IMPORTANT, where the second one
   * carries more information than the first: two watchdog restarts in an evening is a
   * different and much worse situation than one, and suppressing the second reports it
   * as the better one.
   *
   * Asked for in as many words — "it should email me for every watchdog" — after a
   * six-hour cooldown silently swallowed repeats.
   */
  always?: boolean;
}

/**
 * Announce a fault. Debounced per key; safe to call every retry of a failing loop.
 */
export async function raiseAlert(
  key: string,
  subject: string,
  lines: string[],
  opts: AlertOptions = {},
): Promise<void> {
  try {
    if (!(await getBooleanSetting("alerts.enabled", false))) return;
    const cooldownMs = (await getNumberSetting("alerts.cooldownMinutes", 360)) * 60_000;
    // `always` still marks the key raised, so the matching clearAlert still fires —
    // it only skips the suppression, rather than stepping outside the gate entirely.
    const allowed = gate.raise(key, Date.now(), cooldownMs);
    if (!allowed && !opts.always) return;

    const to = await recipient();
    if (!to) {
      console.warn(`[alerts] ${key}: no recipient — set alerts.email or create an admin`);
      return;
    }
    const r = await sendSystemEmail({ to, subject: `[DigiShack] ${subject}`, text: stamp(lines) });
    console.log(
      r.sent
        ? `[alerts] emailed ${to}: ${subject}`
        : `[alerts] could NOT email "${subject}": ${r.reason}`,
    );
  } catch (err) {
    // See the header: alerting must never become the fault.
    console.error("[alerts] failed:", err instanceof Error ? err.message : err);
  }
}

/**
 * Announce recovery — only for faults that were announced. Always clears the key.
 */
export async function clearAlert(key: string, subject: string, lines: string[]): Promise<void> {
  try {
    if (!gate.clear(key)) return;
    if (!(await getBooleanSetting("alerts.enabled", false))) return;
    const to = await recipient();
    if (!to) return;
    const r = await sendSystemEmail({ to, subject: `[DigiShack] ${subject}`, text: stamp(lines) });
    console.log(
      r.sent
        ? `[alerts] emailed ${to}: ${subject}`
        : `[alerts] could NOT email "${subject}": ${r.reason}`,
    );
  } catch (err) {
    console.error("[alerts] failed:", err instanceof Error ? err.message : err);
  }
}
