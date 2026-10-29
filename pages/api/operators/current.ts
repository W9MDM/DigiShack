// Who is at the radio now: read it, sign on, sign off. See lib/operators/shift.ts.
//
// Signing on and off takes a login, not an API key: a shift belongs to a person, and an API
// key has no Operator to sign on as.
import type { NextApiRequest, NextApiResponse } from "next";
import { z } from "zod";

import { sendError, sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import type { AuthContext } from "@/lib/auth/session";
import { currentShift, shiftView, signOff, signOn, SignOnError } from "@/lib/operators/shift";

const signOnSchema = z.object({
  operatorId: z.string().min(1).optional(),
  stationId: z.string().min(1).optional(),
});

async function get(_req: NextApiRequest, res: NextApiResponse) {
  sendJson(res, 200, shiftView(await currentShift()));
}

async function post(req: NextApiRequest, res: NextApiResponse, auth: AuthContext) {
  const input = signOnSchema.parse(req.body ?? {});
  try {
    const shift = await signOn({ user: auth.user, ...input });
    sendJson(res, 200, shiftView(shift));
  } catch (err) {
    if (err instanceof SignOnError) {
      sendError(res, 400, err.message);
      return;
    }
    throw err;
  }
}

async function del(_req: NextApiRequest, res: NextApiResponse) {
  await signOff();
  sendJson(res, 200, shiftView(null));
}

export default authedRoute({
  GET: { role: "VIEWER", handler: get },
  POST: { role: "OPERATOR", handler: post },
  DELETE: { role: "OPERATOR", handler: del },
});
