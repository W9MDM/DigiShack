// GET /api/sstv/<file>.png - one received SSTV picture. See ./index.ts.
import fs from "node:fs";
import path from "node:path";

import type { NextApiRequest, NextApiResponse } from "next";

import { sendError } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";

const DIR = path.join(process.cwd(), "data", "sstv");

async function get(req: NextApiRequest, res: NextApiResponse) {
  const name = String(req.query.name ?? "");
  // The name is the file's, exactly: no paths, nothing but what the bridge writes.
  if (!/^\d{8}-\d{6}-[A-Za-z0-9]+\.png$/.test(name)) {
    sendError(res, 400, "Not a picture name");
    return;
  }
  try {
    const buf = await fs.promises.readFile(path.join(DIR, name));
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "private, max-age=86400, immutable");
    res.status(200).send(buf);
  } catch {
    sendError(res, 404, "No such picture");
  }
}

export default authedRoute({ GET: { role: "VIEWER", handler: get } });
