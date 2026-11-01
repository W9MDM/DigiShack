import { AsyncLocalStorage } from "node:async_hooks";

import { prisma } from "@/lib/db/prisma";

// Which station a piece of work is being done FOR.
//
// One install can hold several stations - K9XYZ, and the club's K9PC - and each has its own
// QRZ logbook, LoTW certificate and location, eQSL, Club Log and Cloudlog accounts. Those
// account settings are "station-scoped": inside `withStation(id, fn)` every read of one
// returns THAT station's value, and a station with nothing set gets nothing. It never
// borrows another station's, because borrowing is exactly how a K9PC contact ends up in
// K9XYZ's QRZ logbook signed with K9XYZ's certificate.
//
// Outside any scope, a station-scoped read means the HOME station: the oldest, the one the
// radio operated as before stations could be chosen. That keeps a single-station install,
// and every settings page and test button written before this, behaving exactly as before.

const store = new AsyncLocalStorage<{ stationId: string }>();

/** Run `fn` with station-scoped settings, downloads and certificates resolved for `stationId`. */
export function withStation<T>(stationId: string, fn: () => Promise<T>): Promise<T> {
  return store.run({ stationId }, fn);
}

/** The station explicitly in scope, or null outside any `withStation`. */
export function scopedStationId(): string | null {
  return store.getStore()?.stationId ?? null;
}

/**
 * Settings that belong to a station rather than the install. Credentials, LoTW location data,
 * and the download cursors - a cursor is "how far through THIS account's records we are",
 * and sharing one between accounts skips or repeats the other's.
 */
const SCOPED = new Set([
  "qrz.logbookApiKey",
  "qrz.lastLogId",
  "lotw.username",
  "lotw.password",
  "lotw.station.state",
  "lotw.station.county",
  "lotw.station.canadian",
  "lotw.station.cqZone",
  "lotw.station.ituZone",
  "lotw.station.iota",
  "lotw.lastQslSince",
  "lotw.lastRunAt",
  "lotw.lastResult",
  "eqsl.username",
  "eqsl.password",
  "eqsl.qthNickname",
  "eqsl.lastSyncAt",
  "eqsl.lastSyncResult",
  "clublog.email",
  "clublog.password",
  "clublog.appPassword",
  "clublog.apiKey",
  "clublog.callsign",
  "cloudlog.url",
  "cloudlog.apiKey",
  "cloudlog.stationProfileId",
]);

export function isStationScoped(key: string): boolean {
  return SCOPED.has(key);
}

export const STATION_SCOPED_KEYS: readonly string[] = [...SCOPED];

/**
 * The home station: the one this install always was, which owns the original account
 * settings, the .env fallbacks and data/lotw/cert.json. Recorded ONCE (by the station-profiles
 * migration, as the `station.homeId` setting) rather than recomputed as "the oldest", so it
 * cannot quietly become another station if rows change. A fresh install that predates any
 * station has no record, and its first (oldest) station is home.
 */
export async function homeStationId(): Promise<string | null> {
  const recorded = await prisma.setting.findUnique({ where: { key: "station.homeId" }, select: { value: true } });
  if (recorded?.value) {
    const st = await prisma.station.findUnique({ where: { id: recorded.value }, select: { id: true } });
    if (st) return st.id;
  }
  const s = await prisma.station.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true } });
  return s?.id ?? null;
}

/** The station in scope, else the home station. Null only when there are no stations at all. */
export async function effectiveStationId(): Promise<string | null> {
  return scopedStationId() ?? (await homeStationId());
}

/** A `where` fragment limiting contacts to the effective station. Empty with no stations. */
export async function stationWhere(): Promise<{ stationId?: string }> {
  const id = await effectiveStationId();
  return id ? { stationId: id } : {};
}

/** Raw read of a station-scoped value that is not in the registry (cursors). */
export async function readStationValue(key: string): Promise<string | null> {
  const stationId = await effectiveStationId();
  if (!stationId) return null;
  const row = await prisma.stationSetting.findUnique({ where: { stationId_key: { stationId, key } } });
  return row?.value ?? null;
}

/** Raw write of a station-scoped, non-secret value (cursors, last-run notes). */
export async function writeStationValue(key: string, value: string): Promise<void> {
  const stationId = await effectiveStationId();
  if (!stationId) return;
  await prisma.stationSetting.upsert({
    where: { stationId_key: { stationId, key } },
    update: { value, encrypted: false },
    create: { stationId, key, value, encrypted: false },
  });
}

/**
 * Run `fn` once per station, oldest first, each inside its own scope. For the scheduled
 * downloads (LoTW, eQSL, reconcile): each station's account is fetched and matched on its
 * own. One station failing does not stop the next.
 */
export async function forEachStation(fn: () => Promise<void>): Promise<void> {
  const stations = await prisma.station.findMany({ orderBy: { createdAt: "asc" }, select: { id: true } });
  for (const s of stations) {
    try {
      await withStation(s.id, fn);
    } catch (e) {
      console.error(`[station ${s.id}]`, e instanceof Error ? e.message : e);
    }
  }
}

/**
 * The station the radio is operating as: the ActiveStation row, read UNCACHED every time,
 * because the bridge must never transmit or log under the previous station after a switch.
 * Falls back to the home station on an install that has never switched (or predates the
 * table's row), which is exactly what every caller did before.
 */
export async function activeStation() {
  const row = await prisma.activeStation.findUnique({ where: { id: 1 }, include: { station: true } });
  return row?.station ?? (await prisma.station.findFirst({ orderBy: { createdAt: "asc" } }));
}
