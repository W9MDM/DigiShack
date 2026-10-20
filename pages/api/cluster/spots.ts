import type { NextApiRequest, NextApiResponse } from "next";

import { sendError, sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import type { ClusterApiResponse, ClusterSnapshot } from "@/lib/cluster/types";
import { getBooleanSetting, getNumberSetting, getSetting } from "@/lib/settings";

// GET /api/cluster/spots — the bridge's DX cluster spots, for the Cluster page.
//
// Proxied for the same reasons as /api/bridge/status: the bridge listens on loopback only.
// Unlike /status, the bridge's /cluster/spots wants the shared token, so it is attached here
// server-side the way /api/bridge/control does — the token never reaches a browser.
//
// `settingEnabled` is read here rather than taken from the bridge, which looks at the
// setting every 15 seconds: an operator who has just ticked the box is told the bridge is
// about to connect, instead of being told the cluster is off.

async function get(_req: NextApiRequest, res: NextApiResponse) {
  const [port, token, settingEnabled] = await Promise.all([
    getNumberSetting("bridge.port", 3101),
    getSetting("bridge.token"),
    getBooleanSetting("cluster.enabled", false),
  ]);

  const answer = (body: Omit<ClusterApiResponse, "settingEnabled">) =>
    sendJson(res, 200, { ...body, settingEnabled } satisfies ClusterApiResponse);

  if (!token) {
    answer({
      running: false,
      cluster: null,
      reason:
        "The radio service has not started yet — it sets up its own access key on first run. Start it with `npm run bridge`.",
    });
    return;
  }

  try {
    const upstream = await fetch(`http://127.0.0.1:${port}/cluster/spots`, {
      headers: { "X-Bridge-Token": token },
      signal: AbortSignal.timeout(3_000),
    });
    if (upstream.status === 404) {
      answer({
        running: true,
        cluster: null,
        reason: "The running bridge predates the DX cluster. Restart digishack-bridge so it runs the current code.",
      });
      return;
    }
    if (!upstream.ok) {
      sendError(res, 502, `Bridge returned HTTP ${upstream.status}`);
      return;
    }
    answer({ running: true, cluster: (await upstream.json()) as ClusterSnapshot });
  } catch {
    answer({
      running: false,
      cluster: null,
      reason: `No bridge answering on 127.0.0.1:${port}. Start it with \`npm run bridge\`, or under PM2 as digishack-bridge.`,
    });
  }
}

export default authedRoute({ GET: { role: "VIEWER", handler: get } });
