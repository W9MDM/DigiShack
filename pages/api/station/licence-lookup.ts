import type { NextApiRequest, NextApiResponse } from "next";

import { sendError, sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import { prisma } from "@/lib/db/prisma";
import { lookupHamdb } from "@/lib/ham/hamdb";

// Fill the operator's licence class from their callsign, via HamDB.
//
// Read-only: it fetches public licence data and returns it. It writes NO setting — the
// settings page saves whatever value the operator keeps, so a lookup is a suggestion, not a
// change. With no ?call it looks up the station's own callsign (the thing that transmits).
// OPERATOR role: it reaches out to a third party on the station's behalf, and the page that
// calls it is admin-only regardless.
async function get(req: NextApiRequest, res: NextApiResponse) {
  const override = typeof req.query.call === "string" ? req.query.call.trim() : "";
  let call = override;
  if (!call) {
    const station = await prisma.station.findFirst({
      orderBy: { createdAt: "asc" },
      select: { callsign: true },
    });
    call = station?.callsign ?? "";
  }
  if (!call) {
    sendError(res, 400, "No station callsign to look up — create a station first, or pass ?call=");
    return;
  }
  const found = await lookupHamdb(call);
  if (!found) {
    // Not an error: a valid call simply may not be in HamDB (non-US, club, brand new).
    sendJson(res, 200, { call, found: false });
    return;
  }
  sendJson(res, 200, { found: true, ...found });
}

export default authedRoute({ GET: { role: "OPERATOR", handler: get } });
