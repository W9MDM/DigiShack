import type { NextApiRequest, NextApiResponse } from "next";
import { z } from "zod";

import { sendError, sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import type { AuthContext } from "@/lib/auth/session";
import { BROADCAST_SWITCH, type BroadcastTarget } from "@/lib/logging/adif-udp";
import { stopAutomation } from "@/lib/radio/bridge-client";
import { getBooleanSetting, writeSettings } from "@/lib/settings";

type Switch = BroadcastTarget;

const bodySchema = z
  .object({
    br: z.boolean().optional(),
    udp: z.boolean().optional(),
  })
  .strict();

async function state(): Promise<Record<Switch, boolean>> {
  return {
    br: await getBooleanSetting(BROADCAST_SWITCH.br, false),
    udp: await getBooleanSetting(BROADCAST_SWITCH.udp, false),
  };
}

async function get(_req: NextApiRequest, res: NextApiResponse) {
  sendJson(res, 200, await state());
}

async function patch(req: NextApiRequest, res: NextApiResponse, auth: AuthContext) {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    // NAMED, not ignored. `.strict()` rejects an unknown key rather than dropping it, so a
    // caller that thinks it is changing something is told it is not.
    sendError(res, 400, "Only the broadcast switches can be set here", {
      allowed: Object.keys(BROADCAST_SWITCH),
      errors: parsed.error.flatten().fieldErrors,
    });
    return;
  }

  const updates = (Object.entries(parsed.data) as [Switch, boolean | undefined][])
    .filter((entry): entry is [Switch, boolean] => entry[1] !== undefined)
    .map(([which, on]) => ({ key: BROADCAST_SWITCH[which], value: on ? "true" : "false" }));

  if (updates.length === 0) {
    sendError(res, 400, "Nothing to change");
    return;
  }

  const result = await writeSettings(updates, auth.user.id);
  if (result.rejected.length > 0) {
    sendError(res, 400, "The setting was rejected", result.rejected);
    return;
  }

  const autoOff = parsed.data.br === true ? await stopAutomation() : undefined;

  // The STORED values rather than what was sent, so the page renders what the station will
  // actually do.
  sendJson(res, 200, { ...(await state()), ...(autoOff === undefined ? {} : { autoOff }) });
}

export default authedRoute({
  GET: { role: "VIEWER", handler: get },
  PATCH: { role: "OPERATOR", handler: patch },
});
