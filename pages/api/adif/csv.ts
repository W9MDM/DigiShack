import type { NextApiRequest, NextApiResponse } from "next";

import { csvFilename, csvHeader, csvRecord } from "@/lib/adif/csv";
import { QSO_INCLUDE, toAdifInput } from "@/lib/adif/from-row";
import { authedRoute } from "@/lib/auth/guard";
import { prisma } from "@/lib/db/prisma";
import { buildQsoWhere } from "@/lib/db/qso";
import { qsoListQuerySchema } from "@/lib/validation/qso";

// CSV export, for spreadsheets.
//
// Streamed in batches for the same reason the ADIF export is: buffering a whole club log
// before sending it is what makes an export fall over on the biggest logs that most need it.
// Same filter schema as the log view, so "export what I am looking at" is literally the same
// query.

const PAGE = 500;

async function get(req: NextApiRequest, res: NextApiResponse) {
  const query = qsoListQuerySchema.parse(req.query);
  const where = buildQsoWhere(query);
  const total = await prisma.qso.count({ where });

  res.status(200);
  // `text/csv` with an explicit charset. Excel opens a UTF-8 CSV as Latin-1 unless told
  // otherwise, which turns any accented name in a log into mojibake.
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${csvFilename()}"`);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Qso-Count", String(total));

  // BOM. Excel needs it to read the file as UTF-8 even when the header says so — without it a
  // German or Spanish name in the Name column arrives mangled, which looks like a database
  // problem rather than an export one. Every other consumer ignores it.
  res.write("\uFEFF");
  res.write(csvHeader());

  let skip = 0;
  for (;;) {
    const batch = await prisma.qso.findMany({
      where,
      // Ordered by startTime then id so paging is stable: an unstable sort can skip or repeat
      // rows between batches.
      orderBy: [{ startTime: "asc" }, { id: "asc" }],
      take: PAGE,
      skip,
      include: QSO_INCLUDE,
    });
    if (batch.length === 0) break;

    let chunk = "";
    for (const q of batch) chunk += csvRecord(toAdifInput(q));
    // One write per batch rather than per record — far fewer syscalls.
    res.write(chunk);

    skip += PAGE;
    if (batch.length < PAGE) break;
  }

  res.end();
}

export default authedRoute({ GET: { role: "VIEWER", handler: get } });
