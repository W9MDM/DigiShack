// GET /api/sstv - the SSTV pictures received, newest first: file name, mode, time.
// The bridge saves each finished picture under data/sstv (services/radio/index.ts); the
// web tier runs from the same directory on the station and reads them from there.
import fs from "node:fs";
import path from "node:path";

import type { NextApiRequest, NextApiResponse } from "next";

import { sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";

const DIR = path.join(process.cwd(), "data", "sstv");

async function get(req: NextApiRequest, res: NextApiResponse) {
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 48));
  let names: string[] = [];
  try {
    names = (await fs.promises.readdir(DIR)).filter((n) => /^\d{8}-\d{6}-[A-Za-z0-9]+\.png$/.test(n));
  } catch {
    names = [];
  }
  names.sort().reverse();
  const pictures = names.slice(0, limit).map((file) => {
    const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(.+)\.png$/.exec(file)!;
    const mode = m[7]!.replace(/([a-z])([A-Z0-9])/g, "$1 $2").replace(/([A-Za-z])(\d)/g, "$1 $2").replace(/\s+/g, " ").trim();
    return { file, mode, at: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` };
  });
  sendJson(res, 200, { pictures, total: names.length });
}

export default authedRoute({ GET: { role: "VIEWER", handler: get } });
