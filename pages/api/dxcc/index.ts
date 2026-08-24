import type { NextApiRequest, NextApiResponse } from "next";

import { BodyTooLargeError, readRawBody } from "@/lib/api/raw-body";
import { sendError, sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import { fetchCtyCsv, parseCtyCsv } from "@/lib/dxcc/cty-csv";
import {
  fetchCty,
  getDxccStatus,
  importCty,
  parseCtyBuffer,
} from "@/lib/dxcc/store";
import { getSetting } from "@/lib/settings";

// GET   status
// POST  import — either an uploaded cty.xml body, or ?fetch=1 to download it
//
// Both are ADMIN: an import replaces the reference data every award figure in the
// logbook is computed from.

async function get(_req: NextApiRequest, res: NextApiResponse) {
  sendJson(res, 200, await getDxccStatus());
}

async function post(req: NextApiRequest, res: NextApiResponse) {
  const wantFetch =
    req.query.fetch === "1" || req.query.fetch === "true";
  // Which source to fetch from. `ad1c` needs no credentials at all, which is why
  // it is the default: waiting on a Club Log key left this installation with 9
  // DXCC entities against 160 actually worked, so award progress was computed
  // against a denominator of 9. `clublog` is still available and is the better
  // file when a key exists — it carries DELETED entities and validity dates,
  // which AD1C's does not.
  const wantClubLog = req.query.source === "clublog";

  let buf: Buffer;
  let source: string;

  if (wantFetch && !wantClubLog) {
    try {
      buf = await fetchCtyCsv();
      source = "ad1c-bigcty-fetch";
    } catch (err) {
      sendError(
        res,
        502,
        err instanceof Error ? err.message : "Could not download cty.csv from country-files.com",
      );
      return;
    }
  } else if (wantFetch) {
    const apiKey = await getSetting("dxcc.ctyApiKey");
    if (!apiKey) {
      sendError(
        res,
        400,
        "No Club Log cty API key configured. Add it under Settings → DXCC reference data, or upload cty.xml instead.",
      );
      return;
    }

    try {
      buf = await fetchCty(apiKey);
      source = "clublog-fetch";
    } catch (err) {
      // A network or credential failure here is expected and actionable, so it
      // gets its own message rather than a generic 500.
      sendError(
        res,
        502,
        err instanceof Error ? err.message : "Could not download cty.xml",
      );
      return;
    }
  } else {
    try {
      buf = await readRawBody(req, { maxBytes: 32 * 1024 * 1024 });
    } catch (err) {
      sendError(
        res,
        413,
        err instanceof BodyTooLargeError ? err.message : "Could not read the upload",
      );
      return;
    }

    if (buf.length === 0) {
      sendError(
        res,
        400,
        "No file uploaded. POST the cty.xml (or cty.xml.gz) contents as the request body, or call with ?fetch=1.",
      );
      return;
    }
    source = "upload";
  }

  let report;
  try {
    // AD1C ships CSV, Club Log ships (possibly gzipped) XML. Sniffing rather than
    // trusting `source` so an uploaded file works either way: an operator who
    // downloads cty.csv by hand and uploads it should not have to know which
    // parser we would have guessed.
    const looksXml = buf.subarray(0, 512).toString("latin1").trimStart().startsWith("<") ||
      (buf[0] === 0x1f && buf[1] === 0x8b);
    const cty = looksXml ? parseCtyBuffer(buf) : parseCtyCsv(buf);
    report = await importCty(cty, looksXml ? source : `${source} (cty.csv)`);
  } catch (err) {
    sendError(
      res,
      400,
      err instanceof Error ? err.message : "Could not parse cty.xml",
    );
    return;
  }

  sendJson(res, 200, { report, status: await getDxccStatus() });
}

export default authedRoute({
  GET: { role: "ADMIN", handler: get },
  POST: { role: "ADMIN", handler: post },
});

export const config = {
  api: {
    // Must be false: Next's parser decodes an unrecognised body to a string,
    // which mangles the gzip magic bytes of a cty.xml.gz upload. readRawBody
    // enforces the size limit itself.
    bodyParser: false,
  },
};
