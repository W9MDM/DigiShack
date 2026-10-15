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
    "restart",
    "source",
    "tune",
    "time/sync",
    "voice",
    "pan-span",
    "stream",
    "rtty",
    "rtty-send",
    "text-send",
    "cw",
    "js8-send",
    "js8-cancel",
    "psk",
    "olivia",
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
  /** RTTY tone pair, for action "rtty": centre and shift in Hz audio. */
  centreHz: z.number().min(300).max(5000).optional(),
  /** RTTY: swap mark and space, for action "rtty". */
  reverse: z.boolean().optional(),
  /** RTTY speed, for action "rtty". */
  baud: z.union([z.literal(45.45), z.literal(50), z.literal(75), z.literal(100)]).optional(),
  shiftHz: z.number().min(23).max(1000).optional(),
  /** A line of RTTY or CW to send, for action "text-send". 240 characters is about forty seconds of RTTY. */
  text: z.string().min(1).max(240).optional(),
  /** CW sending speed, for action "cw". */
  wpm: z.number().min(5).max(60).optional(),
  /** Audio offset for action "js8-send", Hz. */
  offsetHz: z.number().min(200).max(2800).optional(),
  /** PSK speed for action "psk": 31, 63 or 125 (baud 31.25, 62.5, 125). */
  speed: z.union([z.literal(31), z.literal(63), z.literal(125)]).optional(),
  /** Olivia size for action "olivia": tones and bandwidth, one of the listed pairs. */
  tones: z.number().int().min(2).max(256).optional(),
  bandwidth: z.number().int().min(125).max(2000).optional(),
  /** Olivia or Contestia, for action "olivia". */
  code: z.enum(["olivia", "contestia"]).optional(),
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
   * Start or stop the YouTube stream, for action "stream".
   *
   * The STREAM KEY IS NOT IN THIS REQUEST and must never be: it lives in encrypted
   * settings and is read by the bridge, the same way the Club Log key is. A browser that
   * could send it is a browser that could be made to leak it.
   */
  enable: z.boolean().optional(),
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
