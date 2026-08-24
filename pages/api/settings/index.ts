import type { NextApiRequest, NextApiResponse } from "next";
import { z } from "zod";

import { sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import type { AuthContext } from "@/lib/auth/session";
import {
  describeSettings,
  settingsKeyProblem,
  writeSettings,
} from "@/lib/settings";
import { SETTING_GROUPS } from "@/lib/settings/registry";

const patchSchema = z.object({
  updates: z
    .array(
      z.object({
        key: z.string().min(1).max(64),
        // null clears the value; "" on a secret means "leave unchanged".
        value: z.string().max(4096).nullable(),
      }),
    )
    .min(1, "No updates supplied")
    .max(200),
});

// ADMIN-only, both directions. Even reading is restricted: the masked values and
// the list of which services are wired up is itself useful reconnaissance.
async function get(_req: NextApiRequest, res: NextApiResponse) {
  const settings = await describeSettings();

  sendJson(res, 200, {
    groups: SETTING_GROUPS,
    settings,
    /** Non-null when secrets can't be stored — the UI shows this prominently. */
    keyProblem: settingsKeyProblem(),
    /**
     * Deliberately not manageable here. Settings live in the database, so the
     * database credentials can't come from it, and the key that decrypts these
     * secrets can't itself be encrypted.
     */
    envOnly: ["DATABASE_URL", "SETTINGS_KEY", "PORT"],
  });
}

async function patch(
  req: NextApiRequest,
  res: NextApiResponse,
  auth: AuthContext,
) {
  const { updates } = patchSchema.parse(req.body);
  const result = await writeSettings(updates, auth.user.id);

  // Re-describe so the client gets fresh masks and sources without a second
  // round trip.
  const settings = await describeSettings();

  sendJson(res, result.rejected.length > 0 ? 207 : 200, {
    ...result,
    settings,
    keyProblem: settingsKeyProblem(),
  });
}

export default authedRoute({
  GET: { role: "ADMIN", handler: get },
  PATCH: { role: "ADMIN", handler: patch },
});
