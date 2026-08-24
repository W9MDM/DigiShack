import type { NextApiRequest, NextApiResponse } from "next";

import { sendError, sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import { fetchPotaSpots } from "@/lib/pota/spots";

// GET /api/pota/spots — current POTA activators on the digital modes.
//
// Proxied and cached rather than fetched from the browser: POTA is a volunteer-
// run service, and one request per operator every 60 s is neighbourly where one
// per open browser tab every few seconds is not.

// Keyed by the query, because the panadapter asks a different question from the POTA page:
// it wants EVERY mode on one band, where the chase list wants the digital modes on all of
// them. A single-slot cache keyed on nothing served whichever arrived first to both.
const cache = new Map<string, { at: number; data: unknown }>();
const CACHE_MS = 60_000;

async function get(req: NextApiRequest, res: NextApiResponse) {
  const bands = typeof req.query.bands === "string"
    ? req.query.bands.split(",").map((b) => b.trim().toUpperCase()).filter(Boolean)
    : undefined;

  // `modes=all` means do not filter by mode at all, which is what a panadapter wants: an
  // SSB operator looking at 40 m needs the voice and CW activators, and the default here
  // is FT8/FT4 because the rest of the application is a digital station.
  const modesParam = typeof req.query.modes === "string" ? req.query.modes.trim() : "";
  const modes =
    modesParam.toLowerCase() === "all"
      ? []
      : modesParam
        ? modesParam.split(",").map((m) => m.trim().toUpperCase()).filter(Boolean)
        : undefined;

  const key = `${bands?.join(",") ?? "*"}|${modes ? modes.join(",") || "all" : "default"}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    sendJson(res, 200, { cached: true, ...(hit.data as object) });
    return;
  }

  try {
    const spots = await fetchPotaSpots(modes ? { bands, modes } : { bands });
    const payload = { spots, fetchedAt: new Date().toISOString() };
    cache.set(key, { at: Date.now(), data: payload });
    sendJson(res, 200, { cached: false, ...payload });
  } catch (err) {
    sendError(
      res,
      502,
      err instanceof Error ? `POTA spots unavailable: ${err.message}` : "POTA spots unavailable",
    );
  }
}

export default authedRoute({ GET: { role: "VIEWER", handler: get } });
