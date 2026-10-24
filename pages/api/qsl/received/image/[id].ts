import { readFile } from "node:fs/promises";

import type { NextApiRequest, NextApiResponse } from "next";

import { queryParam, sendError } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import { prisma } from "@/lib/db/prisma";
import { sniffImage } from "@/lib/qsl/inbound/classify";
import { imageFile } from "@/lib/qsl/inbound/run";

// GET /api/qsl/received/image/:id — one received card's picture, to a signed-in user.
//
// The file is found from the row and the path is re-derived from a fixed pattern
// (imageFile), so nothing in a request or the database can name another file. The type is
// sniffed from the bytes again on the way out, and served with nosniff, so a file that is not
// one of the four image types is never handed to a browser at all.
//
// `private`: these are other people's cards in the operator's own log, and a shared cache
// between the browser and this server has no business keeping a copy.

async function get(req: NextApiRequest, res: NextApiResponse) {
  const id = queryParam(req, "id");
  if (!id || !/^[0-9a-f]{24}$/.test(id)) {
    sendError(res, 404, "No such image");
    return;
  }
  const row = await prisma.receivedQsl.findUnique({ where: { id }, select: { imagePath: true } });
  const file = imageFile(row?.imagePath ?? null);
  if (!file) {
    sendError(res, 404, "No such image");
    return;
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch {
    sendError(res, 404, "The image file is missing");
    return;
  }
  const check = sniffImage(bytes);
  if (!check.ok) {
    sendError(res, 404, "The stored file is not an image");
    return;
  }
  res.setHeader("Content-Type", check.contentType);
  res.setHeader("Content-Length", String(bytes.length));
  res.setHeader("Cache-Control", "private, max-age=86400");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Disposition", `inline; filename="qsl-${id}.${check.ext}"`);
  res.status(200).end(bytes);
}

export default authedRoute({ GET: { role: "VIEWER", handler: get } });
