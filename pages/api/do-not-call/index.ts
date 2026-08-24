import type { NextApiRequest, NextApiResponse } from "next";
import { z } from "zod";

import { sendError, sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import type { AuthContext } from "@/lib/auth/session";
import {
  addDoNotCall,
  listDoNotCall,
  normaliseCall,
  removeDoNotCall,
} from "@/lib/digital/do-not-call";

// The do-not-contact list.
//
// OPERATOR to change it, VIEWER to read it. Deliberately not ADMIN: honouring a request
// not to be called is ordinary operating, and a list only an administrator can edit is a
// list that does not get updated when somebody asks on the air at eleven at night.
//
// Every write records who made it. Not for blame — so that a year later the entry can be
// asked about, which is the only thing that stops an unexplained callsign being deleted by
// somebody who assumes it was a mistake.

const addSchema = z.object({
  callsign: z
    .string()
    .trim()
    .min(1, "A callsign is required")
    .max(32)
    // Deliberately permissive. Portable and special-event calls carry slashes and
    // digits anywhere, and a regex tight enough to be "correct" would reject a real
    // request from a real operator — which is the one failure this list must not have.
    .regex(/^[A-Za-z0-9/\-]+$/, "That does not look like a callsign"),
  reason: z.string().trim().max(255).nullish(),
  /**
   * NEVER by default. An entry whose intent was not stated must fail safe toward calling
   * less rather than more — the caller has to ask for the weaker restriction explicitly.
   */
  kind: z.enum(["NEVER", "NO_DUPES"]).default("NEVER"),
});

async function get(_req: NextApiRequest, res: NextApiResponse) {
  const entries = await listDoNotCall();
  sendJson(res, 200, {
    entries: entries.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() })),
  });
}

async function post(req: NextApiRequest, res: NextApiResponse, ctx: AuthContext) {
  const parsed = addSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 400, parsed.error.issues[0]?.message ?? "Invalid request");
    return;
  }
  const callsign = normaliseCall(parsed.data.callsign);
  await addDoNotCall(
    callsign,
    parsed.data.reason?.trim() || null,
    ctx.user?.callsign ?? ctx.user?.email ?? null,
    parsed.data.kind,
  );
  sendJson(res, 200, { ok: true, callsign, kind: parsed.data.kind });
}

async function del(req: NextApiRequest, res: NextApiResponse) {
  const raw = typeof req.query.callsign === "string" ? req.query.callsign : "";
  const callsign = normaliseCall(raw);
  if (!callsign) {
    sendError(res, 400, "A callsign is required");
    return;
  }
  const removed = await removeDoNotCall(callsign);
  if (!removed) {
    sendError(res, 404, `${callsign} is not on the list`);
    return;
  }
  sendJson(res, 200, { ok: true, callsign });
}

export default authedRoute({
  GET: { role: "VIEWER", handler: get },
  POST: { role: "OPERATOR", handler: post },
  DELETE: { role: "OPERATOR", handler: del },
});
