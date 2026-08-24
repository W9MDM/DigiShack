import type { NextApiRequest, NextApiResponse } from "next";

import { QSO_INCLUDE, toAdifInput } from "@/lib/adif/from-row";
import { adifFilename, adifHeader, adifRecord } from "@/lib/adif/write";
import { authedRoute } from "@/lib/auth/guard";
import { prisma } from "@/lib/db/prisma";
import { buildQsoWhere } from "@/lib/db/qso";
import { qsoListQuerySchema } from "@/lib/validation/qso";

import pkg from "@/package.json";

/** Rows fetched (and written) per batch. */
const PAGE = 500;

// Streams the export rather than building one string in memory: a club log can
// be tens of thousands of QSOs, and buffering the whole ADIF document before
// sending it is what makes an export fall over on the biggest logs that most
// need it.
async function get(req: NextApiRequest, res: NextApiResponse) {
  // Reuses the log view's filter schema, so "export what I'm looking at" is
  // exactly the same query. take/skip are ignored — an export is the whole
  // filtered set.
  const query = qsoListQuerySchema.parse(req.query);
  const where = buildQsoWhere(query);

  const total = await prisma.qso.count({ where });

  res.status(200);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${adifFilename()}"`,
  );
  // The length isn't known up front when streaming.
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Adif-Qso-Count", String(total));

  res.write(
    adifHeader({
      programVersion: pkg.version,
      comment: `DigiShack ADIF export — ${total} QSO${total === 1 ? "" : "s"}`,
    }),
  );

  let skip = 0;
  let written = 0;

  // Ordered by startTime then id so paging is stable — an unstable sort could
  // skip or repeat rows between batches.
  for (;;) {
    const batch = await prisma.qso.findMany({
      where,
      orderBy: [{ startTime: "asc" }, { id: "asc" }],
      take: PAGE,
      skip,
      include: QSO_INCLUDE,
    });

    if (batch.length === 0) break;

    let chunk = "";
    for (const q of batch) {
      chunk += adifRecord(toAdifInput(q));
    }

    // One write per batch rather than per record — far fewer syscalls.
    res.write(chunk);

    written += batch.length;
    skip += PAGE;
    if (batch.length < PAGE) break;
  }

  res.end();
  console.log(`[adif] exported ${written} QSOs`);
}

// Not authedRoute: the streaming response can't use sendJson, and an error after
// headers are sent can't become a JSON body. Errors before the first write still
// produce a normal status.
export default authedRoute({ GET: { role: "VIEWER", handler: get } });

export const config = {
  api: {
    // Streaming a large export past Next's default response size warning.
    responseLimit: false,
  },
};
