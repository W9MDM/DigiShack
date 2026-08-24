import type { NextApiRequest, NextApiResponse } from "next";

import { sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import { JOBS, resolveJob } from "@/lib/schedule/jobs";
import { getSetting } from "@/lib/settings";

// What runs on a timer, and how often it really runs.
//
// The settings are read HERE rather than in the browser so the page shows the same values the
// bridge will use, including the floors it applies. A client that fetched the raw settings and
// did its own arithmetic would be a second implementation of the same rules, and the two would
// disagree the first time one of them changed.

async function get(_req: NextApiRequest, res: NextApiResponse) {
  // One read per distinct key, not one per job — several jobs share `alerts.enabled`.
  const keys = new Set<string>();
  for (const j of JOBS) {
    if (j.intervalSetting) keys.add(j.intervalSetting);
    if (j.enabledSetting) keys.add(j.enabledSetting);
  }
  const values = new Map<string, string | null>();
  await Promise.all(
    [...keys].map(async (k) => {
      values.set(k, await getSetting(k));
    }),
  );

  sendJson(res, 200, {
    jobs: JOBS.map((j) => resolveJob(j, (k) => values.get(k) ?? null)),
  });
}

export default authedRoute({ GET: { role: "VIEWER", handler: get } });
