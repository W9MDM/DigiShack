// POST /api/sstv/send - send a picture as SSTV, or { stop: true } to stop one going out.
//
// Its own route rather than an action on /api/bridge/control: a 640x496 picture is 950 kB
// of RGB, 1.27 MB as base64, over that route's 1 MB body limit. The picture arrives already
// at the mode's size with the callsign drawn on (the page does that in a canvas), and the
// bridge checks everything else - the mode, the licence, the transmit gate, the PA.

import type { NextApiRequest, NextApiResponse } from "next";
import { z } from "zod";

import { sendError, sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import { getNumberSetting, getSetting } from "@/lib/settings";

export const config = { api: { bodyParser: { sizeLimit: "4mb" } } };

const bodySchema = z.union([
  z.object({ stop: z.literal(true) }),
  z.object({
    mode: z.string().min(2).max(32),
    width: z.number().int().min(16).max(1024),
    height: z.number().int().min(16).max(1024),
    /** RGB bytes, row by row, base64. */
    rgb: z.string().min(16).max(4_000_000),
  }),
]);

async function post(req: NextApiRequest, res: NextApiResponse) {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 400, "Bad SSTV request", parsed.error.flatten().fieldErrors);
    return;
  }
  const token = await getSetting("bridge.token");
  if (!token) {
    sendError(res, 503, "The radio service hasn't started yet.");
    return;
  }
  const port = await getNumberSetting("bridge.port", 3101);
  const path = "stop" in parsed.data ? "sstv-stop" : "sstv-send";
  try {
    const upstream = await fetch(`http://127.0.0.1:${port}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Bridge-Token": token },
      body: JSON.stringify(parsed.data),
      signal: AbortSignal.timeout(15_000),
    });
    sendJson(res, upstream.status, await upstream.json());
  } catch {
    sendError(res, 502, "The radio service is not answering. Is it running?");
  }
}

export default authedRoute({ POST: { role: "OPERATOR", handler: post } });
