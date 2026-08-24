import type { NextApiRequest, NextApiResponse } from "next";

import { queryParam, sendError, sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import { prisma } from "@/lib/db/prisma";
import { QSO_INCLUDE } from "@/lib/db/qso";

async function get(req: NextApiRequest, res: NextApiResponse) {
  const id = queryParam(req, "id");
  if (!id) {
    sendError(res, 400, "Missing id");
    return;
  }

  const qso = await prisma.qso.findUnique({
    where: { id },
    include: {
      ...QSO_INCLUDE,
      spots: { orderBy: { reportedAt: "desc" } },
      decodes: { orderBy: { timestamp: "desc" }, take: 50 },
    },
  });

  if (!qso) {
    sendError(res, 404, `No QSO with id ${id}`);
    return;
  }

  sendJson(res, 200, qso);
}

export default authedRoute({
  GET: { role: "VIEWER", handler: get, allowApiKey: true },
});
