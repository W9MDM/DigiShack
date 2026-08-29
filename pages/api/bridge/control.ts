import type { NextApiRequest, NextApiResponse } from "next";
import { z } from "zod";

import { sendError, sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import { getNumberSetting, getSetting } from "@/lib/settings";

// Server-side proxy for the radio service's QSO control API.
//
// Two reasons this exists rather than the browser calling the service directly:
// the service listens on 127.0.0.1 only, and its shared token must never reach a
// browser. The proxy reads the token from encrypted settings and attaches it
// server-side, so operating the transmitter requires BOTH a logged-in OPERATOR
// session here and the token there.

const bodySchema = z.object({
  action: z.enum([
    "call",
    "qso-halt",
    "qso-skip",
    "rearm",
    "power",
    "auto",
    "atu",
    "rig",
    "ft0",
    "source",
    "tune",
    "time/sync",
    "voice",
    "pan-span",
  ]),
  /** Which radio to drive. Changing it stops any automatic mode. */
  kind: z.enum(["flex", "icom", "wsjtx"]).optional(),
  /** Band to tune to, for action "tune". */
  band: z.string().trim().toUpperCase().min(2).max(8).optional(),
  // Rig control (CAT panel). Each is optional; only what is sent gets changed.
  freqHz: z.number().optional(),
  mode: z.string().max(8).optional(),
  filterLo: z.number().optional(),
  filterHi: z.number().optional(),
  agc: z.enum(["off", "slow", "med", "fast"]).optional(),
  /**
   * Antenna port, on a radio with more than one socket.
   *
   * Not an enum: the valid names are the RADIO'S, it reports them itself (a FLEX-6400
   * answers ANT1, ANT2, RX_A, XVTA and a 6300 answers something shorter), and a list
   * written here would be a second opinion about hardware this process cannot see. The
   * bridge validates against what the radio said and refuses with the real list.
   */
  rxAnt: z.string().trim().toUpperCase().max(16).optional(),
  txAnt: z.string().trim().toUpperCase().max(16).optional(),
  rfGain: z.number().min(-20).max(60).optional(),
  nb: z.boolean().optional(),
  nr: z.boolean().optional(),
  tune: z.boolean().optional(),
  autoMode: z.enum(["off", "cq", "hunt", "hunt-pota", "pota-chase"]).optional(),
  percent: z.number().min(1).max(100).optional(),
  theirCall: z.string().trim().toUpperCase().max(16).optional(),
  theirGrid: z.string().trim().toUpperCase().max(8).nullish(),
  theirSnr: z.number().min(-50).max(50).optional(),
  theirOffsetHz: z.number().min(0).max(5000).optional(),
  theirWindowStart: z.number().optional(),
  /** The decoded message being answered, verbatim — it opens the QSO's transcript. */
  message: z.string().max(128).optional(),
  /**
   * Call this station NOW, halting the contact in progress.
   *
   * Default (absent) queues them behind the running QSO instead. Explicit because the
   * station mid-exchange is a real person waiting on the next message of a sequence they
   * can see, and dropping them silently is not something a click should do by accident.
   */
  takeOver: z.boolean().optional(),
  /** FT-0: true stops everything, false brings the radio back. */
  engage: z.boolean().optional(),
  /**
   * Panadapter span in hertz, for action "pan-span". Bounded by what the radio itself
   * accepts — the bridge clamps and reports back what was actually applied.
   */
  spanHz: z.number().min(1_000).max(14_000_000).optional(),
  /**
   * Voice mode on or off.
   *
   * Named `active` rather than reusing `engage` so the two cannot be confused in a log or
   * a request: FT-0 is a panic stop, this is a change of what the station is for.
   */
  active: z.boolean().optional(),
});

async function post(req: NextApiRequest, res: NextApiResponse) {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, 400, "Bad control request", parsed.error.flatten().fieldErrors);
    return;
  }
  const { action, autoMode, ...rest } = parsed.data;
  // The service's /auto endpoint expects `mode`; the CAT panel's `mode` means
  // the slice's modulation. Keep them distinct in the API and map here.
  const payload: Record<string, unknown> =
    action === "auto" ? { mode: autoMode } : rest;

  // The shared secret between the web app and DigiShack's own radio service.
  // Self-provisioned by the radio service on startup — nothing to configure; if
  // it is missing the service simply hasn't run yet. (The key says "omega" for
  // historical reasons only; no external software is involved.)
  const token = await getSetting("bridge.token");
  if (!token) {
    sendError(
      res,
      503,
      "Transmit control is not ready: the radio service hasn't started yet (it sets up its own access key on first run). Start it with `npm run bridge`.",
    );
    return;
  }

  const port = await getNumberSetting("bridge.port", 3101);

  try {
    const upstream = await fetch(`http://127.0.0.1:${port}/${action}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Bridge-Token": token,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5_000),
    });
    sendJson(res, upstream.status, await upstream.json());
  } catch {
    sendError(res, 502, "The radio service is not answering. Is it running?");
  }
}

export default authedRoute({ POST: { role: "OPERATOR", handler: post } });
