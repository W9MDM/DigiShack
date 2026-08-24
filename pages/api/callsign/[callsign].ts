import type { NextApiRequest, NextApiResponse } from "next";

import { sendError, sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import { computeCallsignHistory } from "@/lib/stats/callsign";

// One station's history with us.
//
// Never 404s for an unworked callsign. "I have never worked them" is a legitimate and useful
// answer — it is in fact the answer that decides whether to call — so it comes back as
// `worked: false` with the do-not-call and opt-out flags still populated. A 404 would make the
// caller guess whether the station is new or the request was wrong.

async function get(req: NextApiRequest, res: NextApiResponse) {
  const raw = req.query.callsign;
  const callsign = (typeof raw === "string" ? raw : "").trim();
  if (!callsign) {
    sendError(res, 400, "No callsign given");
    return;
  }
  // Loose validation on purpose. Portable and special-event callsigns carry slashes and
  // digits in places a strict pattern would reject, and the worst case for a nonsense string
  // is an indexed lookup that finds nothing.
  if (callsign.length > 32) {
    sendError(res, 400, "That is too long to be a callsign");
    return;
  }

  const raw2 = typeof req.query.recent === "string" ? Number(req.query.recent) : NaN;
  sendJson(
    res,
    200,
    await computeCallsignHistory(callsign, {
      recent: Number.isFinite(raw2) ? raw2 : undefined,
    }),
  );
}

export default authedRoute({ GET: { role: "VIEWER", handler: get } });
