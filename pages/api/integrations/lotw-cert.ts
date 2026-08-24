import type { NextApiRequest, NextApiResponse } from "next";

import { sendError, sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import {
  deleteLotwCert,
  LotwCertError,
  lotwCertInfo,
  saveLotwCert,
} from "@/lib/integrations/lotw-cert";

// The LoTW callsign certificate: upload, inspect, remove.
//
// THIS HANDLES SOMEBODY'S LICENCE IDENTITY. The private key in a .p12 is what signs contacts
// as that callsign, and signing under a callsign that is not yours is not a bug, it is a
// violation of the licence. So:
//
//   - ADMIN only. Not OPERATOR, which every other integration endpoint accepts.
//   - The .p12 is never written to disk. It goes to openssl on stdin and the extracted key
//     is stored encrypted; see lib/integrations/lotw-cert.ts.
//   - GET never returns the key or the certificate body, only what the certificate SAYS.
//     There is no read path for the key other than the uploader itself.
//   - The password arrives in a header rather than the query string, because query strings
//     reach access logs and referrers.
//
// Raw body rather than multipart, matching the QSL artwork upload: the file is the whole
// request, so a multipart parser would be wrapping a single field.

export const config = { api: { bodyParser: false } };

/** A LoTW .p12 is a few kB. 512 kB is generous and stops a stream being buffered. */
const MAX_BYTES = 512 * 1024;

async function readBody(req: NextApiRequest): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const b = chunk as Buffer;
    total += b.length;
    if (total > MAX_BYTES) throw new Error("TOO_LARGE");
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

function shape(info: Awaited<ReturnType<typeof lotwCertInfo>>) {
  if (!info) return null;
  return {
    callsign: info.callsign,
    name: info.name,
    dxcc: info.dxcc,
    validFrom: info.validFrom.toISOString(),
    validTo: info.validTo.toISOString(),
    qsoStart: info.qsoStart?.toISOString() ?? null,
    qsoEnd: info.qsoEnd?.toISOString() ?? null,
    uploadedAt: info.uploadedAt.toISOString(),
    expired: info.validTo.getTime() < Date.now(),
    /** Days left, so the page can warn before uploads start being refused. */
    daysLeft: Math.floor((info.validTo.getTime() - Date.now()) / 86_400_000),
  };
}

async function get(_req: NextApiRequest, res: NextApiResponse) {
  sendJson(res, 200, { certificate: shape(await lotwCertInfo()) });
}

async function post(req: NextApiRequest, res: NextApiResponse) {
  let body: Buffer;
  try {
    body = await readBody(req);
  } catch (err) {
    if (err instanceof Error && err.message === "TOO_LARGE") {
      sendError(res, 413, `A LoTW certificate is only a few kB; that file is over ${MAX_BYTES / 1024} kB.`);
      return;
    }
    sendError(res, 400, "Could not read the upload");
    return;
  }
  if (body.length === 0) {
    sendError(res, 400, "No file was uploaded");
    return;
  }

  const header = req.headers["x-p12-password"];
  const password = typeof header === "string" ? header : "";

  try {
    const info = await saveLotwCert(body, password);
    sendJson(res, 200, { ok: true, certificate: shape({ ...info, uploadedAt: new Date() }) });
  } catch (err) {
    if (err instanceof LotwCertError) {
      // 400 with the real reason. Every message in LotwCertError is written to be read by
      // the operator — "that is not a .p12", "that password does not open it" — because the
      // alternative is openssl's own output, which reads like a corrupt file for a typo.
      sendError(res, 400, err.message);
      return;
    }
    sendError(res, 500, err instanceof Error ? err.message : "Could not store the certificate");
  }
}

async function del(_req: NextApiRequest, res: NextApiResponse) {
  const removed = await deleteLotwCert();
  sendJson(res, 200, { ok: true, removed });
}

export default authedRoute({
  GET: { role: "ADMIN", handler: get },
  POST: { role: "ADMIN", handler: post },
  DELETE: { role: "ADMIN", handler: del },
});
