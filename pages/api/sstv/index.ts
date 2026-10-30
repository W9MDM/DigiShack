// GET /api/sstv - the SSTV pictures received, newest first: file name, mode, time, and what
// the bridge noted beside each one - the RSV report we would give, where it was heard, the
// callsigns and report read off it, and the contact it was logged as.
// The bridge saves each finished picture under data/sstv (services/radio/index.ts), with a
// .json of the same name; the web tier runs from the same directory on the station and
// reads them from there. A picture from before the notes has none, and lists without them.
import fs from "node:fs";
import path from "node:path";

import type { NextApiRequest, NextApiResponse } from "next";

import { sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import { readSstvMeta } from "@/lib/digital/sstv-meta";

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
  const pictures = await Promise.all(
    names.slice(0, limit).map(async (file) => {
      const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(.+)\.png$/.exec(file)!;
      const mode = m[7]!.replace(/([a-z])([A-Z0-9])/g, "$1 $2").replace(/([A-Za-z])(\d)/g, "$1 $2").replace(/\s+/g, " ").trim();
      const meta = await readSstvMeta(file);
      return {
        file,
        mode,
        at: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`,
        freqHz: meta?.freqHz ?? null,
        rsv: meta?.rsv ?? null,
        read: meta?.read ?? null,
        logged: meta?.logged ?? null,
      };
    }),
  );
  sendJson(res, 200, { pictures, total: names.length });
}

export default authedRoute({ GET: { role: "VIEWER", handler: get } });
