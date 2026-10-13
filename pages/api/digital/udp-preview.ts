import type { NextApiRequest, NextApiResponse } from "next";

import { sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import { prisma } from "@/lib/db/prisma";
import { adifDatagramBody, parseExtraFields } from "@/lib/logging/adif-udp";
import { destinationProblem, normaliseHost } from "@/lib/logging/broadcast-fields";
import { getSetting } from "@/lib/settings";

// Exactly what the UDP broadcast sends, for the operator to read before turning it on.
//
// "i want to see every field its sending" — and that is the right thing to ask of a feature
// that puts the station's log onto a network. A settings page that says "broadcast contacts"
// and shows nothing is asking for trust it has not earned.
//
// BUILT THROUGH THE REAL PATH, not a description of it. This calls the same
// `adifDatagramBody` the sender calls, with the same settings, so what is shown cannot drift
// from what is sent — a preview assembled separately would be a second implementation and
// would eventually disagree with the first, which is worse than no preview at all.
//
// The most recent contact is used rather than a synthetic one, so the operator sees their own
// callsigns and their own grid rather than a example that might be hiding a field that is
// empty on their station.

async function get(_req: NextApiRequest, res: NextApiResponse) {
  const row = await prisma.qso.findFirst({
    orderBy: { startTime: "desc" },
    include: { sigRefs: true, station: true, operator: true },
  });

  if (!row) {
    sendJson(res, 200, {
      datagram: null,
      detail: "No contacts logged yet, so there is nothing to preview.",
    });
    return;
  }

  const programId = String((await getSetting("udpLog.programId")) ?? "").trim() || "WSJT-X";
  const comment = String((await getSetting("udpLog.comment")) ?? "").trim();
  const parsed = parseExtraFields(String((await getSetting("udpLog.extraFields")) ?? ""));
  const body = adifDatagramBody(row, { programId, comment, extra: parsed.fields });

  // The FIELDS, split out so the page can list them rather than making the operator parse
  // ADIF by eye. `<EOH>` and `<EOR>` are structure rather than data and are left out.
  const fields = [...body.matchAll(/<([A-Za-z_]+):(\d+)>([^<]*)/g)].map((m) => ({
    name: m[1]!.toUpperCase(),
    value: m[3]!,
  }));

  const rawHost = String((await getSetting("udpLog.host")) ?? "");
  const port = Number((await getSetting("udpLog.port")) ?? 2333);

  sendJson(res, 200, {
    datagram: body,
    // THE DESTINATION, AND WHAT IS WRONG WITH IT. A pasted URL used to fail once per contact
    // in a log nobody opens; the panel is where that belongs.
    destination: { host: normaliseHost(rawHost), port, raw: rawHost.trim() },
    problem: destinationProblem(rawHost, port),
    fields,
    // So the operator can see at a glance whether anything names this program. The sender
    // asserts this too; showing it is what makes the assertion worth having to a reader.
    mentionsDigishack: /digishack/i.test(body),
    // WHICH LINES WERE DROPPED AND WHY. A refused field that vanished without comment is
    // the exact failure this panel exists to prevent, so the refusals travel with the
    // preview rather than only reaching a log nobody reads.
    refused: parsed.refused,
    forQso: { callsign: row.callsign, band: row.band, at: row.startTime },
  });
}

export default authedRoute({
  GET: { role: "OPERATOR", handler: get },
});
