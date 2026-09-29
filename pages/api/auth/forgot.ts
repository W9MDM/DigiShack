import type { NextApiRequest, NextApiResponse } from "next";

import { route, sendJson } from "@/lib/api/respond";
import { createPasswordReset, RESET_TTL_MS } from "@/lib/auth/reset";
import { clientIp } from "@/lib/auth/client-ip";
import { recordResetAttempt } from "@/lib/auth/reset-audit";
import { checkThrottle, recordFailure } from "@/lib/auth/throttle";
import { prisma } from "@/lib/db/prisma";
import { sendSystemEmail } from "@/lib/qsl/email";
import { forgotSchema } from "@/lib/validation/auth";

// "Forgot password": email a one-time reset link.
//
// THE RESPONSE NEVER VARIES. Unknown address, disabled account, SMTP down, mail
// bounced — the caller sees the same 200 and the same sentence. Anything else turns
// this endpoint into an oracle for which addresses have accounts. The true outcome
// goes to the server log, where the operator debugging "no email arrived" can read
// it; the operator standing at the login page cannot, and that is the point.

const NEUTRAL =
  "If that address has an account, a reset link is on its way. It works once and expires in 30 minutes.";

async function post(req: NextApiRequest, res: NextApiResponse) {
  const { email } = forgotSchema.parse(req.body);

  // ONE EXTRACTION, USED BY BOTH the throttle key and the audit row, so the address the
  // operator sees in the UI is the same one the lockout was applied to. They were different
  // before only because nothing displayed either of them.
  const ip = clientIp({ headers: req.headers, socketAddress: req.socket.remoteAddress });
  const userAgent = (() => {
    const ua = req.headers["user-agent"];
    return (Array.isArray(ua) ? ua[0] : ua) ?? null;
  })();

  // Same budget as failed logins, and every request spends from it: this endpoint
  // sends mail, and an unthrottled mail-sender aimed at a real inbox is a nuisance
  // weapon regardless of what it discloses.
  const key = `forgot|${clientKey(req)}|${email}`;
  const throttle = checkThrottle(key);
  if (throttle.locked) {
    // LOGGED, and it was not — which made this the one branch that could swallow a
    // request without trace. The header above promises the true outcome reaches the
    // server log "where the operator debugging 'no email arrived' can read it", and this
    // path broke that promise in precisely the situation the promise was written for: the
    // caller sees "a reset link is on its way", no mail is sent, and nothing is recorded.
    //
    // It cost an afternoon. "ive entered my email address of k9xyz@example.com twice today"
    // against a log whose last reset line was a month old — and the silence had to be
    // eliminated as a suspect by reasoning about MAX_FAILURES rather than by reading it,
    // because a locked throttle and a request that never arrived look identical from here.
    //
    // Still the neutral RESPONSE. A 429 that only appears for real addresses would leak;
    // logging is server-side and discloses nothing to the caller.
    console.log(
      `[auth] reset requested for ${email} — THROTTLED, nothing sent. ` +
        `${throttle.retryAfterSeconds}s left of the lock; the budget is spent by every ` +
        `request, successful ones included.`,
    );
    await recordResetAttempt({
      email,
      ip,
      outcome: "throttled",
      detail: `${throttle.retryAfterSeconds}s left of the lock`,
      userAgent,
    });
    sendJson(res, 200, { ok: true, detail: NEUTRAL });
    return;
  }
  recordFailure(key);

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, active: true },
  });

  if (!user || !user.active) {
    console.log(`[auth] reset requested for ${email} — no active account, nothing sent`);
    await recordResetAttempt({
      email,
      ip,
      outcome: "no-account",
      // WHICH of the two is deliberately NOT stored. "no account" and "account disabled"
      // are different facts, and a table an admin reads is still a table; but the neutral
      // response exists because that distinction is exactly what must not escape, and an
      // audit row is one screenshot away from escaping. The operator can see the account.
      detail: null,
      userAgent,
    });
    sendJson(res, 200, { ok: true, detail: NEUTRAL });
    return;
  }

  const token = await createPasswordReset(user.id);

  // The link points at the origin the request arrived on — the tunnel hostname
  // when asked through the tunnel, the LAN address when asked on the LAN — so the
  // reader can always open what the mail contains.
  const proto =
    (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim() === "https"
      ? "https"
      : "http";
  const host = req.headers.host ?? "localhost:3000";
  const link = `${proto}://${host}/reset-password?token=${token}`;

  const result = await sendSystemEmail({
    to: user.email,
    subject: "DigiShack password reset",
    text: [
      "Someone (hopefully you) asked to reset the DigiShack password for this address.",
      "",
      `Reset it here: ${link}`,
      "",
      `The link works once and expires in ${Math.round(RESET_TTL_MS / 60_000)} minutes.`,
      "If you didn't ask for this, ignore it — the password has not changed.",
    ].join("\n"),
  });

  console.log(
    result.sent
      ? `[auth] reset link emailed to ${user.email}`
      : `[auth] reset link for ${user.email} NOT sent: ${result.reason} — check Settings → QSL → SMTP`,
  );
  await recordResetAttempt({
    email,
    ip,
    outcome: result.sent ? "sent" : "send-failed",
    detail: result.sent ? null : (result.reason ?? "send failed"),
    userAgent,
  });

  sendJson(res, 200, { ok: true, detail: NEUTRAL });
}

/**
 * The throttle's notion of "who".
 *
 * Delegates to `clientIp` so the address the lockout is keyed on is the same one the audit
 * row shows. It read only `x-real-ip` before, which `cloudflared` does not set — so every
 * request through the tunnel keyed on the loopback address, giving every visitor on the
 * internet one shared budget per email.
 */
function clientKey(req: NextApiRequest): string {
  return clientIp({ headers: req.headers, socketAddress: req.socket.remoteAddress }) ?? "unknown";
}

export default route({ POST: post });
