import type { NextApiRequest, NextApiResponse } from "next";

import { route, sendError, sendJson } from "@/lib/api/respond";
import { hashPassword } from "@/lib/auth/password";
import { createSession, needsSetup } from "@/lib/auth/session";
import { LOCKS, withInvariantLock } from "@/lib/db/invariant-lock";
import { setupSchema } from "@/lib/validation/auth";

// First-run bootstrap. Creates the one initial ADMIN and then closes itself
// permanently: once any user exists, needsSetup() is false forever and this
// endpoint refuses. That is what stops it becoming an open backdoor for account
// creation on a web-facing install.
async function post(req: NextApiRequest, res: NextApiResponse) {
  // A fast refusal for the ordinary case. NOT the guard — that is the lock below.
  if (!(await needsSetup())) {
    sendError(
      res,
      409,
      "DigiShack is already set up. Ask an admin to create your account.",
    );
    return;
  }

  const input = setupSchema.parse(req.body);

  // Hashed BEFORE the lock. scrypt is the slow part of this request and nothing about it
  // needs serialising, so it must not be what a second request waits behind.
  const passwordHash = await hashPassword(input.password);

  // ONE BOOTSTRAP, HOWEVER MANY REQUESTS ARRIVE TOGETHER.
  //
  // This used to be a plain transaction around `user.count()` and the insert, with a comment
  // saying the email unique index made it safe. It did not: two posts with DIFFERENT emails
  // each counted zero in their own snapshot and each created an admin, and the unique index
  // only ever arbitrates two posts using the same address. The count now runs under the
  // admins lock (lib/db/invariant-lock.ts), so a second request waits for the first to commit,
  // then counts its admin and is refused.
  const user = await withInvariantLock(LOCKS.admins, async (tx) => {
    if ((await tx.user.count()) > 0) return null;

    // THE STATION IS CREATED HERE, not by the seed.
    //
    // It used to come from `prisma/seed.ts` with a hardcoded callsign, so anyone who ran
    // the optional sample data inherited another operator's identity — and the transmit
    // path reads this record, so the radio would have called CQ under it. That is an
    // illegal transmission rather than a bad default, and the only safe number of
    // hardcoded callsigns in a logging program is zero.
    //
    // In the same transaction as the admin: a half-finished setup that left a login but no
    // station would be a working GUI attached to a radio with no identity.
    await tx.station.create({
      data: { callsign: input.stationCallsign, grid: input.stationGrid },
    });

    return tx.user.create({
      data: {
        email: input.email,
        name: input.name,
        callsign: input.callsign || null,
        passwordHash,
        role: "ADMIN",
        lastLoginAt: new Date(),
      },
      select: { id: true, email: true, name: true, callsign: true, role: true },
    });
  });

  if (!user) {
    sendError(res, 409, "DigiShack is already set up.");
    return;
  }

  await createSession(user.id, req, res);
  sendJson(res, 201, { user });
}

async function get(_req: NextApiRequest, res: NextApiResponse) {
  sendJson(res, 200, { needsSetup: await needsSetup() });
}

export default route({ POST: post, GET: get });
