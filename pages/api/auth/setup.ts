import type { NextApiRequest, NextApiResponse } from "next";

import { route, sendError, sendJson } from "@/lib/api/respond";
import { hashPassword } from "@/lib/auth/password";
import { createSession, needsSetup } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { setupSchema } from "@/lib/validation/auth";

// First-run bootstrap. Creates the one initial ADMIN and then closes itself
// permanently: once any user exists, needsSetup() is false forever and this
// endpoint refuses. That is what stops it becoming an open backdoor for account
// creation on a web-facing install.
async function post(req: NextApiRequest, res: NextApiResponse) {
  if (!(await needsSetup())) {
    sendError(
      res,
      409,
      "DigiShack is already set up. Ask an admin to create your account.",
    );
    return;
  }

  const input = setupSchema.parse(req.body);

  // The count check and the insert are not atomic on their own, so the unique
  // constraint on email plus this transaction are what prevent two simultaneous
  // setup posts from both creating an admin.
  const user = await prisma.$transaction(async (tx) => {
    if ((await tx.user.count()) > 0) {
      throw new Error("ALREADY_SET_UP");
    }
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
        passwordHash: await hashPassword(input.password),
        role: "ADMIN",
        lastLoginAt: new Date(),
      },
      select: { id: true, email: true, name: true, callsign: true, role: true },
    });
  }).catch((err: unknown) => {
    if (err instanceof Error && err.message === "ALREADY_SET_UP") return null;
    throw err;
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
