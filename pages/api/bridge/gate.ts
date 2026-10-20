import type { NextApiRequest, NextApiResponse } from "next";

import { sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import { GATE_OFFLINE, toStationGate } from "@/lib/radio/station-gate";
import { getNumberSetting } from "@/lib/settings";

// The header's transmit state: armed, FT-0, on the air. Polled by every page, so it
// returns a few fields rather than the bridge's whole /status (see lib/radio/station-gate.ts).

async function get(_req: NextApiRequest, res: NextApiResponse) {
  const port = await getNumberSetting("bridge.port", 3101);
  try {
    const upstream = await fetch(`http://127.0.0.1:${port}/status`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!upstream.ok) {
      sendJson(res, 200, GATE_OFFLINE);
      return;
    }
    const body = (await upstream.json()) as { status?: unknown };
    sendJson(res, 200, toStationGate(body.status ?? null));
  } catch {
    sendJson(res, 200, GATE_OFFLINE);
  }
}

export default authedRoute({ GET: { role: "VIEWER", handler: get } });
