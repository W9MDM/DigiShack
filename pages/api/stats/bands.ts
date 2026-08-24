import type { NextApiRequest, NextApiResponse } from "next";

import { sendJson } from "@/lib/api/respond";
import { authedRoute } from "@/lib/auth/guard";
import { prisma } from "@/lib/db/prisma";
import {
  estimateUsability,
  fetchPskActivity,
  fetchSolar,
  gridToLatLon,
} from "@/lib/propagation";
import { getSetting } from "@/lib/settings";
import { computeBandActivity } from "@/lib/stats/band-activity";

// GET /api/stats/bands — band conditions from three independent angles.
//
//   heard    what THIS receiver decoded, per band (no network needed)
//   psk      how many stations the whole PSKReporter network is seeing, this mode
//   usable   an ESTIMATE from solar flux and local time, for bands nobody is watching
//
// They are kept separate rather than blended into one score. They answer different
// questions and have wildly different confidence, and a single number would hide which
// of them it came from. Measurement beats estimate every time it exists.
//
// The station's own decode history is computed first and always returned; the two
// network sources are best-effort and come back null when offline.

async function get(req: NextApiRequest, res: NextApiResponse) {
  const current =
    typeof req.query.current === "string" && req.query.current.trim()
      ? req.query.current.trim().toUpperCase()
      : null;
  const mode =
    typeof req.query.mode === "string" && /^FT[0248]$/i.test(req.query.mode.trim())
      ? req.query.mode.trim().toUpperCase()
      : "FT8";

  const heard = await computeBandActivity(current);

  const station = await prisma.station.findFirst({
    orderBy: { createdAt: "asc" },
    select: { callsign: true, grid: true },
  });
  const contact =
    (await getSetting("pskreporter.contact")) ?? (await getSetting("smtp.from")) ?? "digishack";

  const [psk, solar] = await Promise.all([
    fetchPskActivity({ mode, contact, ourCallsign: station?.callsign ?? null }),
    fetchSolar(),
  ]);

  // Longitude only, for day/night. A missing grid just means no estimate.
  const here = station?.grid ? gridToLatLon(station.grid) : null;
  const utcHour = new Date().getUTCHours() + new Date().getUTCMinutes() / 60;

  // The union of every band any source knows about, so a band nobody is watching still
  // gets its estimate and a band only we heard still appears.
  const names = new Set<string>([
    ...heard.bands.map((b) => b.band),
    ...(psk ?? []).map((b) => b.band),
    ...(here ? Object.keys({ "160M": 0, "80M": 0, "40M": 0, "30M": 0, "20M": 0, "17M": 0, "15M": 0, "12M": 0, "10M": 0, "6M": 0 }) : []),
  ]);

  const bands = [...names].map((band) => {
    const h = heard.bands.find((b) => b.band === band) ?? null;
    const p = psk?.find((b) => b.band === band) ?? null;
    return {
      band,
      current: band === current,
      heard: h ? { stations: h.stations, decodes: h.decodes, minutesAgo: h.minutesAgo, state: h.state } : null,
      psk: p
        ? {
            transmitting: p.transmitting,
            receivers: p.receivers,
            entities: p.entities,
            bestSnr: p.bestSnr,
            heardUsBy: p.heardUsBy,
          }
        : null,
      usable: here ? estimateUsability(band, solar, utcHour, here.lon) : "unknown",
    };
  });

  // Busiest on the network first — that is the question being asked. The band we are
  // on stays pinned so it is never hunted for.
  bands.sort((a, b) => {
    if (a.current) return -1;
    if (b.current) return 1;
    return (b.psk?.transmitting ?? -1) - (a.psk?.transmitting ?? -1);
  });

  sendJson(res, 200, {
    bands,
    current,
    mode,
    solar,
    windowHours: heard.windowHours,
    /** PSKReporter returns a bounded slice, so the counts are a floor, not a census. */
    pskIsSample: true,
    pskWindowMinutes: 15,
  });
}

export default authedRoute({ GET: { role: "VIEWER", handler: get } });
