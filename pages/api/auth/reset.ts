import type { NextApiRequest, NextApiResponse } from "next";

import { route, sendError, sendJson } from "@/lib/api/respond";
import { consumePasswordReset } from "@/lib/auth/reset";
import { checkThrottle, recordFailure, recordSuccess } from "@/lib/auth/throttle";
import { resetSchema } from "@/lib/validation/auth";

// Redeem an emailed reset link. The token is the credential here, so it gets the
// same brute-force budget a password does.

async function post(req: NextApiRequest, res: NextApiResponse) {
  const { token, password } = resetSchema.parse(req.body);

  const key = `reset|${clientKey(req)}`;
  const throttle = checkThrottle(key);
  if (throttle.locked) {
    res.setHeader("Retry-After", String(throttle.retryAfterSeconds));
    sendError(
      res,
      429,
      `Too many attempts. Try again in ${Math.ceil(throttle.retryAfterSeconds / 60)} minute(s).`,
    );
    return;
  }

  const result = await consumePasswordReset(token, password);
  if (!result.ok) {
    recordFailure(key);
    // One message for expired, used, and never-existed — see consumePasswordReset.
    sendError(res, 400, "That reset link is invalid or has expired. Request a new one.");
    return;
  }

  recordSuccess(key);
  console.log(`[auth] password reset completed for ${result.email}`);
  // No session is created here: the user proves the new password at the login
  // form, which is also what confirms to them that it works.
  sendJson(res, 200, { ok: true });
}

/** X-Real-IP first — same reasoning, same trap, as login's clientKey. */
function clientKey(req: NextApiRequest): string {
  const real = req.headers["x-real-ip"];
  const fromProxy = (Array.isArray(real) ? real[0] : real)?.trim();
  return fromProxy || req.socket.remoteAddress || "unknown";
}

export default route({ POST: post });
