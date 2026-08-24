import type { NextApiRequest, NextApiResponse } from "next";

import { route, sendJson } from "@/lib/api/respond";
import { destroyCurrentSession } from "@/lib/auth/session";

// Deliberately not wrapped in authedRoute: logging out must succeed even when the
// session is already gone or expired, and it must always clear the cookie.
async function post(req: NextApiRequest, res: NextApiResponse) {
  await destroyCurrentSession(req, res);
  sendJson(res, 200, { ok: true });
}

export default route({ POST: post });
