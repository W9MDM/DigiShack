import type { NextApiRequest, NextApiResponse } from "next";

import { sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import { stationLabel } from "@/lib/station/label";

// The header's "which of the six K9PCs is this" line. VIEWER, like everything
// else the header shows.
async function get(_req: NextApiRequest, res: NextApiResponse) {
  sendJson(res, 200, await stationLabel());
}

export default authedRoute({ GET: { role: "VIEWER", handler: get } });
