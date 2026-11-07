// GET /api/callsign-lookup?call=KD9XYZ - who a station is, to fill in a contact as it is
// worked: first name, town, grid. QRZ when the station has QRZ credentials (Settings), else
// HamDB, which is free and needs no account but covers the US only. A miss is not an error:
// `found: false`, and the operator types what they hear.
//
// Remembered for an hour per call, so a station worked twice, or typed and retyped, is one
// lookup: QRZ asks to be used politely.
import type { NextApiRequest, NextApiResponse } from "next";

import { sendError, sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import { lookupHamdb } from "@/lib/ham/hamdb";
import { lookupCallsign } from "@/lib/qrz/lookup";

export interface CallsignLookupResult {
  found: boolean;
  source: "qrz" | "hamdb" | null;
  call: string;
  name: string | null;
  firstName: string | null;
  /** "Town, ST" in the US, "Town, Country" elsewhere: what a QTH line says. */
  qth: string | null;
  grid: string | null;
  country: string | null;
  /** Why QRZ was not used, when it was not: no credentials, or its error. */
  note: string | null;
}

const CACHE_MS = 60 * 60_000;
const cache = new Map<string, { at: number; result: CallsignLookupResult }>();

/** "Town, ST" in the US, "Town, Country" elsewhere, whatever parts there are. */
export function qthLine(city: string | null, state: string | null, country: string | null): string | null {
  const us = !country || /united states|^usa?$/i.test(country);
  return [city, us ? state : country].filter(Boolean).join(", ") || null;
}

async function lookup(call: string): Promise<CallsignLookupResult> {
  const miss = (note: string | null): CallsignLookupResult => ({
    found: false,
    source: null,
    call,
    name: null,
    firstName: null,
    qth: null,
    grid: null,
    country: null,
    note,
  });
  let note: string | null = null;
  const q = await lookupCallsign(call);
  if (q.status === "found") {
    const i = q.info;
    return { found: true, source: "qrz", call: i.callsign, name: i.name, firstName: i.firstName, qth: qthLine(i.city, i.state, i.country), grid: i.grid, country: i.country, note: null };
  }
  if (q.status === "no-credentials") note = "No QRZ login in Settings; looked up on HamDB (US calls only)";
  else if (q.status === "error") note = `QRZ: ${q.reason}`;
  else note = "Not on QRZ";
  const h = await lookupHamdb(call);
  if (h) return { found: true, source: "hamdb", call: h.call.toUpperCase(), name: h.name, firstName: h.firstName, qth: qthLine(h.city, h.state, h.country), grid: h.grid, country: h.country, note };
  return miss(note);
}

async function get(req: NextApiRequest, res: NextApiResponse) {
  const call = (typeof req.query.call === "string" ? req.query.call : "").trim().toUpperCase();
  if (!/^[A-Z0-9]{1,4}\/?[A-Z0-9]{2,8}(\/[A-Z0-9]{1,4})?$/.test(call)) {
    sendError(res, 400, "Not a callsign");
    return;
  }
  const hit = cache.get(call);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    sendJson(res, 200, hit.result);
    return;
  }
  // A portable call (KD9XYZ/P, W1/KD9XYZ) is looked up as the base call.
  const base = call.split("/").sort((a, b) => b.length - a.length)[0]!;
  const result = { ...(await lookup(base)), call };
  cache.set(call, { at: Date.now(), result });
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
  sendJson(res, 200, result);
}

export default authedRoute({ GET: { role: "OPERATOR", handler: get } });
