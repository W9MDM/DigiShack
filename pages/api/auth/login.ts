import type { NextApiRequest, NextApiResponse } from "next";

import { route, sendError, sendJson } from "@/lib/api/respond";
import { hashPassword, needsRehash, verifyPassword } from "@/lib/auth/password";
import { createSession, needsSetup } from "@/lib/auth/session";
import { checkThrottle, recordFailure, recordSuccess } from "@/lib/auth/throttle";
import { prisma } from "@/lib/db/prisma";
import { loginSchema } from "@/lib/validation/auth";

// A dummy hash to verify against when the email doesn't exist, so a missing
// account costs the same ~100ms as a wrong password. Without this, response time
// reveals which addresses are registered.
const DUMMY_HASH =
  "scrypt$65536$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

async function post(req: NextApiRequest, res: NextApiResponse) {
  const { email, password } = loginSchema.parse(req.body);

  const key = `${clientKey(req)}|${email}`;
  const throttle = checkThrottle(key);
  if (throttle.locked) {
    res.setHeader("Retry-After", String(throttle.retryAfterSeconds));
    sendError(
      res,
      429,
      `Too many failed attempts. Try again in ${Math.ceil(throttle.retryAfterSeconds / 60)} minute(s).`,
    );
    return;
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      passwordHash: true,
      active: true,
    },
  });

  const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);

  // Deliberately one message for wrong-email, wrong-password and disabled: an
  // attacker learns nothing about which accounts exist or are active.
  if (!user || !ok || !user.active) {
    recordFailure(key);
    sendError(res, 401, "Incorrect email or password");
    return;
  }

  recordSuccess(key);

  // Opportunistic upgrade if the KDF parameters have since been raised.
  if (needsRehash(user.passwordHash)) {
    const upgraded = await hashPassword(password);
    await prisma.user
      .update({ where: { id: user.id }, data: { passwordHash: upgraded } })
      .catch((err) => console.error("[auth] rehash failed:", err));
  }

  await createSession(user.id, req, res);
  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });

  const fresh = await prisma.user.findUniqueOrThrow({
    where: { id: user.id },
    select: { id: true, email: true, name: true, callsign: true, role: true },
  });

  sendJson(res, 200, { user: fresh });
}

async function get(_req: NextApiRequest, res: NextApiResponse) {
  // Lets the login page know whether to send a first-run visitor to /setup.
  sendJson(res, 200, { needsSetup: await needsSetup() });
}

/**
 * Rate-limit key for a request.
 *
 * X-Real-IP, NOT the first element of X-Forwarded-For.
 *
 * The shipped nginx config sets `X-Forwarded-For $proxy_add_x_forwarded_for`,
 * which APPENDS the real address to whatever the client sent. Element 0 is
 * therefore always attacker-chosen, so the 8-failures-per-15-minutes lock could be
 * sidestepped indefinitely by rotating a header. X-Real-IP is set on the preceding
 * line of the same config and cannot be forged through the proxy.
 *
 * Falls back to the socket address, which is correct when nothing is in front.
 */
function clientKey(req: NextApiRequest): string {
  const real = req.headers["x-real-ip"];
  const fromProxy = (Array.isArray(real) ? real[0] : real)?.trim();
  return fromProxy || req.socket.remoteAddress || "unknown";
}

export default route({ POST: post, GET: get });
