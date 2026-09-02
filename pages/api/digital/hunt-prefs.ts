import type { NextApiRequest, NextApiResponse } from "next";
import { z } from "zod";

import { sendError, sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import type { AuthContext } from "@/lib/auth/session";
import { getBooleanSetting, writeSettings } from "@/lib/settings";

// Operating preferences an OPERATOR may change from the digital page.
//
// WHY THIS EXISTS RATHER THAN USING /api/settings. That route is ADMIN-only for both GET
// and PATCH, and deliberately: it exposes the whole registry, including which secrets are
// present. So the decodes page reads no settings at all today, and asking for a checkbox
// there meant one of three things:
//
//   1. loosen the admin gate on the whole registry — a lot of surface for one checkbox,
//      and the wrong trade for a route that lists credentials;
//   2. route the write through the bridge's control endpoint — which already accepts
//      OPERATOR, but makes the bridge the owner of a setting the web tier owns;
//   3. a narrow route that whitelists exactly the keys which are operating decisions.
//
// This is (3). The whitelist is the point: an operator who can already start Auto Hunt and
// key the transmitter can obviously change how Auto Hunt picks stations, and can change
// NOTHING else through here. Adding a key to `ALLOWED` is a deliberate act, and anything
// not on it is rejected by name rather than silently ignored.
//
// GET is VIEWER, because the decode list's filter has to be able to say whether the hunt
// agrees with what it is showing — a page that displays "CQ + just finished" while the
// automatic modes would refuse those stations is the badge/guard disagreement this project
// keeps paying for.

/**
 * The only settings this route can read or write.
 *
 * Operating decisions, not configuration. Each one is something an operator changes during
 * a session, and none of them is a credential, a network address, or a limit that protects
 * a third party.
 */
const ALLOWED = {
  "auto.callFinishedStations": false,
} as const;

type AllowedKey = keyof typeof ALLOWED;

const bodySchema = z
  .object({
    "auto.callFinishedStations": z.boolean().optional(),
  })
  .strict();

async function get(_req: NextApiRequest, res: NextApiResponse) {
  const out: Record<string, boolean> = {};
  for (const [key, fallback] of Object.entries(ALLOWED)) {
    out[key] = await getBooleanSetting(key, fallback);
  }
  sendJson(res, 200, { prefs: out });
}

async function patch(req: NextApiRequest, res: NextApiResponse, auth: AuthContext) {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    // NAMED, not ignored. `.strict()` rejects an unknown key rather than dropping it, so a
    // caller that thinks it is changing something is told it is not.
    sendError(res, 400, "Only operating preferences can be set here", {
      allowed: Object.keys(ALLOWED),
      errors: parsed.error.flatten().fieldErrors,
    });
    return;
  }

  const updates = (Object.entries(parsed.data) as [AllowedKey, boolean][])
    .filter(([, v]) => v !== undefined)
    .map(([key, value]) => ({ key, value: value ? "true" : "false" }));

  if (updates.length === 0) {
    sendError(res, 400, "Nothing to change");
    return;
  }

  const result = await writeSettings(updates, auth.user.id);
  if (result.rejected.length > 0) {
    sendError(res, 400, "The setting was rejected", result.rejected);
    return;
  }

  const out: Record<string, boolean> = {};
  for (const [key, fallback] of Object.entries(ALLOWED)) {
    out[key] = await getBooleanSetting(key, fallback);
  }
  // Echoing the STORED values rather than what was sent, so the page renders what the
  // station will actually do. The bridge re-reads these every window through `huntPrefs`,
  // within the settings cache TTL, so no restart is involved.
  sendJson(res, 200, { prefs: out });
}

export default authedRoute({
  GET: { role: "VIEWER", handler: get },
  PATCH: { role: "OPERATOR", handler: patch },
});
