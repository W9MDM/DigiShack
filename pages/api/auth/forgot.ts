import type { NextApiRequest, NextApiResponse } from "next";

import { route, sendJson } from "@/lib/api/respond";
import { createPasswordReset, RESET_TTL_MS } from "@/lib/auth/reset";
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

  // Same budget as failed logins, and every request spends from it: this endpoint
  // sends mail, and an unthrottled mail-sender aimed at a real inbox is a nuisance
  // weapon regardless of what it discloses.
  const key = `forgot|${clientKey(req)}|${email}`;
  const throttle = checkThrottle(key);
  if (throttle.locked) {
    // Still the neutral answer. A 429 that only appears for real addresses would
    // leak; this one appears for any address asked about too often, which is fine.
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

  sendJson(res, 200, { ok: true, detail: NEUTRAL });
}

/** X-Real-IP first — same reasoning, same trap, as login's clientKey. */
function clientKey(req: NextApiRequest): string {
  const real = req.headers["x-real-ip"];
  const fromProxy = (Array.isArray(real) ? real[0] : real)?.trim();
  return fromProxy || req.socket.remoteAddress || "unknown";
}

export default route({ POST: post });
