import type { NextApiRequest } from "next";

import { prisma } from "@/lib/db/prisma";
import { withStation } from "@/lib/station/scope";

/**
 * Run an API handler's work for the station in `?stationId=`, or for the home station when
 * there is none. An id that names no station is an error, never quietly "home": a test button
 * pressed while editing K9PC must not report on K9XYZ's accounts, and an upload must not run
 * under them.
 */
export async function inStationFromQuery<T>(req: NextApiRequest, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  const raw = req.query.stationId;
  if (typeof raw !== "string" || raw === "") return { ok: true, value: await fn() };
  const st = await prisma.station.findUnique({ where: { id: raw }, select: { id: true } });
  if (!st) return { ok: false };
  return { ok: true, value: await withStation(st.id, fn) };
}
