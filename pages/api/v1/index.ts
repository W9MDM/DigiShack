import type { NextApiRequest, NextApiResponse } from "next";

import { sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import type { AuthContext } from "@/lib/auth/session";

import pkg from "@/package.json";

// Discovery document for the public API.
//
// /api/v1 is the stable, documented surface for third-party clients. Everything
// outside it is the app's own internals and may change without notice — which is
// the whole point of versioning this separately.

async function get(
  _req: NextApiRequest,
  res: NextApiResponse,
  auth: AuthContext,
) {
  sendJson(res, 200, {
    name: "DigiShack API",
    version: "v1",
    software: `DigiShack ${pkg.version}`,
    authenticatedAs: {
      name: auth.user.name,
      role: auth.user.role,
      viaApiKey: auth.user.id.startsWith("apikey:"),
    },
    auth: {
      schemes: ["Authorization: Bearer dsk_…", "X-API-Key: dsk_…"],
      note: "Keys are created by an admin under /api-keys. A key may hold VIEWER or OPERATOR — never ADMIN.",
    },
    endpoints: [
      { method: "GET", path: "/api/v1", role: "VIEWER", description: "This document" },
      {
        method: "GET",
        path: "/api/v1/qsos",
        role: "VIEWER",
        description:
          "List QSOs. Query: callsign, band, mode, stationId, operatorId, q, from, to, confirmed, take, skip, sort, dir.",
      },
      {
        method: "POST",
        path: "/api/v1/qsos",
        role: "OPERATOR",
        description:
          "Log one QSO as JSON. freqHz and mode required; band is derived from the frequency when omitted.",
      },
      {
        method: "GET",
        path: "/api/v1/qsos/{id}",
        role: "VIEWER",
        description: "One QSO, including reception reports and linked decodes.",
      },
      {
        method: "POST",
        path: "/api/v1/adif",
        role: "OPERATOR",
        description:
          "Ingest ADIF. Body is the raw ADIF document (text/plain). Query: stationId (required), operatorId, dedupe=0 to disable duplicate skipping, dryRun=1 to validate only. This is the endpoint WSJT-X-adjacent tools should post to.",
      },
      {
        method: "GET",
        path: "/api/v1/stats",
        role: "VIEWER",
        description: "Totals, unique counts, and per-band/per-mode breakdowns.",
      },
      {
        method: "GET",
        path: "/api/v1/awards",
        role: "VIEWER",
        description:
          "DXCC/WAS/WAZ/WAC/grid/IOTA progress. Query: stationId, band, mode.",
      },
      {
        method: "GET",
        path: "/api/v1/dxcc/lookup",
        role: "VIEWER",
        description:
          "Resolve a callsign to a DXCC entity. Query: callsign (required), at (ISO date, for historical entities).",
      },
    ],
    conventions: {
      frequency:
        "freqHz is a JSON number in hertz. Amateur allocations top out around 2.5e11, well inside Number.MAX_SAFE_INTEGER.",
      time: "All timestamps are UTC, ISO-8601.",
      bands: "ADIF 3.x band names, e.g. 20M, 70CM.",
      modes:
        "ADIF-derived mode names. FT4 is stored and accepted as FT4, though ADIF encodes it MODE=MFSK/SUBMODE=FT4 on export.",
      errors:
        "Non-2xx responses are {error: string, details?: object}. Validation failures are 400 with details keyed by field.",
    },
  });
}

export default authedRoute({
  GET: { role: "VIEWER", handler: get, allowApiKey: true },
});
