// Who is signed on at this station's radio right now, for a club dashboard that shows every
// radio at once. Read-only; signing on and off is /api/operators/current, with a login.
import type { NextApiRequest, NextApiResponse } from "next";

import { sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import { currentShift, shiftView } from "@/lib/operators/shift";

async function get(_req: NextApiRequest, res: NextApiResponse) {
  sendJson(res, 200, shiftView(await currentShift()));
}

export default authedRoute({
  GET: { role: "VIEWER", handler: get, allowApiKey: true },
});
