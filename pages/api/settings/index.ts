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
import { SETTING_GROUPS, SETTINGS } from "@/lib/settings/registry";

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
  /**
   * Keys whose `confirm` message the operator has been shown and accepted.
   *
   * Sent on the SECOND request, after the first came back naming them. Deliberately not a
   * single boolean: acknowledging one dangerous setting must not silently carry consent to
   * another that happened to be in the same save.
   */
  acknowledge: z.array(z.string().min(1).max(64)).max(200).optional(),
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
  const { updates, acknowledge } = patchSchema.parse(req.body);

  // CONFIRMATION IS ENFORCED HERE, not in the page. A guard that only exists in the UI is
  // a guard for whoever has not opened the network tab, and this one protects a third
  // party — the station that would be worked repeatedly — rather than this operator.
  //
  // Nothing in the save is written when one of these is unacknowledged. Writing the safe
  // half would leave the operator looking at a page where some of what they typed took
  // effect and some did not, with no way to tell which without re-reading every field.
  const accepted = new Set(acknowledge ?? []);
  const needsConfirmation = updates.flatMap((u) => {
    const def = SETTINGS.find((d) => d.key === u.key);
    if (!def?.confirm || accepted.has(u.key)) return [];
    return def.confirm.when(u.value) ? [{ key: u.key, label: def.label, message: def.confirm.message }] : [];
  });
  if (needsConfirmation.length > 0) {
    // Carried in `details` rather than a field of its own, because that is the one shape
    // the client's error layer preserves — `lib/client/api.ts` keeps `error` and
    // `details` and discards everything else. A bespoke field would arrive as
    // "Request failed (409)" with the explanation thrown away one layer below the page,
    // which is precisely the fault that layer's own comment records.
    sendJson(res, 409, {
      error:
        needsConfirmation.length === 1
          ? `${needsConfirmation[0]!.label} needs confirming`
          : `${needsConfirmation.length} settings need confirming`,
      details: Object.fromEntries(needsConfirmation.map((c) => [c.key, [c.message]])),
    });
    return;
  }

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
