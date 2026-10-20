// What one press of Send did, in a sentence.
//
// Kept apart from pages/qsl.tsx so scripts/check-qsl-queue.ts can run it without React.
//
// THE FAULT. The page said "Sent X of Y" with Y = `attempted`. Since 1.231.0 `attempted` is
// `sent + failed` only: a row claimed and then dropped because the recipient had opted out is
// `skipped`, and a row another sender (the radio service's timer) claimed first is
// `contended`. A run that lost every row to the timer reported "Nothing was sent: no approved
// messages were waiting" — while they were being mailed by somebody else — and a run that
// skipped an opted-out recipient said nothing about it at all.

export interface SendResultLike {
  /** On the wire (`sent + failed`) and deliberately not read here — see the note above. */
  attempted?: unknown;
  sent?: unknown;
  failed?: unknown;
  skipped?: unknown;
  contended?: unknown;
  failures?: unknown;
}

export interface SendSummary {
  tone: "ok" | "warn" | "info";
  text: string;
}

function n(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0;
}

function calls(list: string[], max = 5): string {
  return list.length <= max ? list.join(", ") : `${list.slice(0, max).join(", ")} and ${list.length - max} more`;
}

export function describeSendResult(r: SendResultLike): SendSummary {
  const sent = n(r.sent);
  const failed = n(r.failed);
  const skipped = n(r.skipped);
  const contended = n(r.contended);

  if (sent + failed + skipped + contended === 0) {
    return { tone: "warn", text: "Nothing was sent: no approved messages were waiting." };
  }

  const failedCalls = Array.isArray(r.failures)
    ? (r.failures as { callsign?: unknown }[]).map((f) => (typeof f.callsign === "string" ? f.callsign : "?"))
    : [];

  const parts: string[] = [`Sent ${sent}.`];
  if (failed > 0) {
    parts.push(
      `${failed} failed${failedCalls.length ? ` (${calls(failedCalls)})` : ""} — the reasons are on the Failed tab.`,
    );
  }
  if (skipped > 0) {
    parts.push(
      `${skipped} not sent because the recipient opted out before their turn — now on the Skipped tab.`,
    );
  }
  if (contended > 0) {
    parts.push(
      `${contended} ${contended === 1 ? "was" : "were"} no longer this run's to send: another sender ` +
        `(usually the radio service) had already taken ${contended === 1 ? "it" : "them"}, or ` +
        `${contended === 1 ? "it was" : "they were"} changed meanwhile. Check the Sent tab.`,
    );
  }
  // A failure needs the operator; an opt-out or another sender's claim is information.
  const tone = failed > 0 ? "warn" : skipped > 0 || contended > 0 ? "info" : "ok";
  return { tone, text: parts.join(" ") };
}
