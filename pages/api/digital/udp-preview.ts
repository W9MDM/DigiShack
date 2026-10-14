import type { NextApiRequest, NextApiResponse } from "next";

import { sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import { prisma } from "@/lib/db/prisma";
import {
  adifDatagramBody,
  broadcastConfig,
  type BroadcastTarget,
} from "@/lib/logging/adif-udp";
import { destinationProblem } from "@/lib/logging/broadcast-fields";

async function get(req: NextApiRequest, res: NextApiResponse) {
  const target: BroadcastTarget = req.query.target === "br" ? "br" : "udp";
  const cfg = await broadcastConfig(target);

  const row = await prisma.qso.findFirst({
    orderBy: { startTime: "desc" },
    include: { sigRefs: true, station: true, operator: true },
  });

  if (!row) {
    sendJson(res, 200, {
      target,
      enabled: cfg.enabled,
      datagram: null,
      detail: "No contacts logged yet, so there is nothing to preview.",
    });
    return;
  }

  const body = adifDatagramBody(row, {
    programId: cfg.programId,
    comment: cfg.comment,
    extra: cfg.extra,
  });

  // The FIELDS, split out so the page can list them rather than making the operator parse
  // ADIF by eye. `<EOH>` and `<EOR>` are structure rather than data and are left out.
  const fields = [...body.matchAll(/<([A-Za-z_]+):(\d+)>([^<]*)/g)].map((m) => ({
    name: m[1]!.toUpperCase(),
    value: m[3]!,
  }));

  sendJson(res, 200, {
    target,
    enabled: cfg.enabled,
    datagram: body,
    // THE DESTINATION, AND WHAT IS WRONG WITH IT. A pasted URL used to fail once per contact
    // in a log nobody opens; the panel is where that belongs.
    destination: { host: cfg.host, port: cfg.port, raw: cfg.rawHost.trim() },
    problem: destinationProblem(cfg.rawHost, cfg.port),
    fields,
    // So the operator can see at a glance whether anything names this program. The sender
    // asserts this too; showing it is what makes the assertion worth having to a reader.
    mentionsDigishack: /digishack/i.test(body),
    // WHICH LINES WERE DROPPED AND WHY. A refused field that vanished without comment is
    // the exact failure this panel exists to prevent, so the refusals travel with the
    // preview rather than only reaching a log nobody reads.
    refused: cfg.refused,
    forQso: { callsign: row.callsign, band: row.band, at: row.startTime },
  });
}

export default authedRoute({
  GET: { role: "OPERATOR", handler: get },
});
