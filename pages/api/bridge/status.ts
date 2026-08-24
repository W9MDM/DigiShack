import type { NextApiRequest, NextApiResponse } from "next";

import { sendError, sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import { getNumberSetting } from "@/lib/settings";

// Server-side proxy for the bridge's /status.
//
// The bridge listens on 127.0.0.1:3101, which a browser cannot reach directly on
// a deployed install — and shouldn't: the bridge is deliberately not exposed
// through NGINX. Proxying here keeps the browser on one origin, avoids CORS, and
// means the decode page has a working fallback when the WebSocket is unavailable.

async function get(_req: NextApiRequest, res: NextApiResponse) {
  const port = await getNumberSetting("bridge.port", 3101);

  try {
    const upstream = await fetch(`http://127.0.0.1:${port}/status`, {
      // The bridge is local; if it doesn't answer quickly it isn't running.
      signal: AbortSignal.timeout(3_000),
    });

    if (!upstream.ok) {
      sendError(res, 502, `Bridge returned HTTP ${upstream.status}`);
      return;
    }

    sendJson(res, 200, { running: true, ...(await upstream.json()) });
  } catch {
    // Not an error condition worth a 5xx: the bridge simply isn't up, and the UI
    // needs to say so rather than show a failed request.
    sendJson(res, 200, {
      running: false,
      reason: `No bridge answering on 127.0.0.1:${port}. Start it with \`npm run bridge\`, or under PM2 as digishack-bridge.`,
      status: null,
      recentDecodes: [],
    });
  }
}

export default authedRoute({ GET: { role: "VIEWER", handler: get } });
