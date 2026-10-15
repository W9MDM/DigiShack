import type { NextApiRequest, NextApiResponse } from "next";

import { sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import { reduceStatus, type BridgeStatusPayload } from "@/lib/radio/api";
import { bridgeStatus } from "@/lib/radio/bridge-client";

// The receiver as the bridge sees it, for a client that is not a browser.
//
// A dial on the desk polls this a few times a second and draws what it says. It is the
// bridge's /status reduced to the contract in lib/radio/api.ts: one receiver, modulation
// and digital mode kept apart, nulls where the radio has not said, and the locks that
// would refuse a command right now - so the dial can show them before the knob is turned
// rather than after. VIEWER, like the status proxy: reading the dial changes nothing.

async function get(_req: NextApiRequest, res: NextApiResponse) {
  const answer = await bridgeStatus();
  const raw: BridgeStatusPayload = answer.reachable
    ? { running: true, ...(answer.body as object) }
    : { running: false, reason: "No bridge answering. Start it with `npm run bridge`, or under PM2 as digishack-bridge." };
  sendJson(res, 200, reduceStatus(raw, new Date()));
}

export default authedRoute({
  GET: { role: "VIEWER", handler: get, allowApiKey: true },
});
