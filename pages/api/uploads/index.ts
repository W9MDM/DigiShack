import type { NextApiRequest, NextApiResponse } from "next";
import { z } from "zod";

import { sendError, sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import {
  UPLOADABLE,
  runUploads,
  uploadCounts,
  type UploadableService,
} from "@/lib/integrations/upload-runner";
import { getBooleanSetting, getNumberSetting, getSetting } from "@/lib/settings";

// Uploads, from the web side.
//
// This route exists because the upload subsystem had NO WAY IN from a browser. `runUploads`
// was reachable only from the bridge — a sweep timer in services/radio/index.ts and a
// nudge after each logged QSO — and `uploadCounts()` carried the comment "What is waiting,
// for the UI to show before anything is sent" while never being called by anything.
//
// The consequence, reported by an operator: switch uploading on, watch nothing happen,
// and have nowhere to look. If that installation is not running the bridge — a perfectly
// reasonable way to use DigiShack as a logbook — then no sweep exists at all and no
// message anywhere says so.
//
// So: GET says what is waiting AND whether anything is going to send it, and POST sends
// it now without needing a radio process at all.

/** Is the bridge — the only thing that sweeps on a timer — actually up? */
async function sweeper(): Promise<{ running: boolean; detail: string }> {
  const mins = await getNumberSetting("uploads.intervalMinutes", 10);
  if (mins <= 0) {
    return {
      running: false,
      detail: "The sweep interval is 0, which switches automatic sweeps off entirely.",
    };
  }
  const port = await getNumberSetting("bridge.port", 3101);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/status`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) throw new Error(String(res.status));
    return { running: true, detail: `The radio service sweeps every ${mins} min.` };
  } catch {
    return {
      running: false,
      // The whole point of this message. Automatic uploading being "on" is necessary and
      // not sufficient — something has to run the sweep, and only the radio service does.
      detail:
        `Nothing is sweeping. Automatic uploads run inside the radio service, and it is ` +
        `not answering on 127.0.0.1:${port} — so contacts will sit unsent however the ` +
        `settings are configured. Start it (pm2 start digishack-bridge, or npm run bridge), ` +
        `or use Upload now here.`,
    };
  }
}

async function get(_req: NextApiRequest, res: NextApiResponse) {
  const [counts, sweep, enabled, since, interval] = await Promise.all([
    uploadCounts(),
    sweeper(),
    getBooleanSetting("uploads.enabled", false),
    getSetting("uploads.since"),
    getNumberSetting("uploads.intervalMinutes", 10),
  ]);
  sendJson(res, 200, { enabled, since: since ?? null, intervalMinutes: interval, counts, sweeper: sweep });
}

const bodySchema = z.object({
  /** Restrict to one service. Omitted means every service that is switched on. */
  only: z.enum(UPLOADABLE).optional(),
  /**
   * Send contacts older than `uploads.since` too.
   *
   * The back-catalogue path, and it stays an explicit request rather than a default: the
   * cutoff exists so that switching uploading on does not push years of contacts at
   * somebody else's service unasked.
   */
  ignoreCutoff: z.boolean().optional(),
  limit: z.number().int().min(1).max(5_000).optional(),
});

async function post(req: NextApiRequest, res: NextApiResponse) {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendError(res, 400, "Bad upload request", parsed.error.flatten().fieldErrors);
    return;
  }
  const { only, ignoreCutoff, limit } = parsed.data;
  const result = await runUploads({
    only: only as UploadableService | undefined,
    ignoreCutoff,
    limit,
  });
  sendJson(res, 200, result);
}

export default authedRoute({
  GET: { role: "VIEWER", handler: get },
  POST: { role: "OPERATOR", handler: post },
});
